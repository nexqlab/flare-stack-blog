import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  inspectProduction,
  pendingMigrations,
  productionTarget,
  validateProductionEnvironment,
  validateRuntimeSecrets,
} from "./deploy-production-preflight";

const migrations = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();
const baseline = migrations.filter((name) => Number(name.slice(0, 4)) <= 10);
const env = {
  ...productionTarget,
  CLOUDFLARE_API_TOKEN: "test-only-token",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
};
const secrets = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "DOMAIN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
].map((name) => ({ name, type: "secret_text" }));

function queryResult(results: Record<string, unknown>[]) {
  return [{ success: true, results }];
}

function fixture({
  applied = migrations,
  tables = [
    "d1_migrations",
    "posts",
    "comments",
    "friend_links",
    "system_config",
  ],
  config = { row_count: 1, invalid_json_count: 0 },
  bookmark = "00000001-00000001-00000001-test-bookmark",
}: {
  applied?: string[];
  tables?: string[];
  config?: Record<string, unknown>;
  bookmark?: string;
} = {}) {
  return vi.fn((args: string[]): unknown => {
    if (args[1] === "deployments") {
      return {
        deployments: [
          {
            id: "current-deployment",
            versions: [{ version_id: "current-version" }],
          },
          { id: "old-deployment", versions: [{ version_id: "old-version" }] },
        ],
      };
    }
    if (args[1] === "secrets") return secrets;
    if (args[1] === "time-travel") return { bookmark };
    const sql = args[args.indexOf("--sql") + 1];
    if (sql?.includes("sqlite_schema")) {
      return queryResult(tables.map((name) => ({ name })));
    }
    if (sql?.includes("FROM d1_migrations")) {
      return queryResult(applied.map((name) => ({ name })));
    }
    if (sql?.includes("FROM system_config")) return queryResult([config]);
    throw new Error("Unexpected command in read-only preflight.");
  });
}

describe("production deployment guards", () => {
  it.each([
    { GITHUB_REF: "refs/heads/dev" },
    { GITHUB_REF: "refs/tags/v2.2.0" },
    { GITHUB_EVENT_NAME: "push" },
    { WORKER_NAME: "other-worker" },
    { DOMAIN: "other.example.com" },
    { D1_DATABASE_ID: "another-database" },
    { KV_NAMESPACE_ID: "another-kv" },
    { BUCKET_NAME: "another-bucket" },
    { QUEUE_NAME: "another-queue" },
    { CLOUDFLARE_ACCOUNT_ID: "another-account" },
    { CLOUDFLARE_API_TOKEN: "" },
    { WORKER_NAME: "" },
  ])(
    "rejects unsafe configuration before contacting Cloudflare: %j",
    (overrides) => {
      const runJson = fixture();
      expect(() =>
        inspectProduction({
          env: { ...env, ...overrides },
          migrations,
          runJson,
        }),
      ).toThrow();
      expect(runJson).not.toHaveBeenCalled();
    },
  );

  it("validates the intended target without exposing the token", () => {
    expect(() => validateProductionEnvironment(env)).not.toThrow();
    expect(() =>
      validateProductionEnvironment({ ...env, CLOUDFLARE_API_TOKEN: " " }),
    ).toThrow("CLOUDFLARE_API_TOKEN");
  });
});

describe("v3 runtime secrets", () => {
  it("accepts the required runtime variables as secrets without reading values", () => {
    expect(() => validateRuntimeSecrets(secrets)).not.toThrow();
  });

  it.each(secrets.map((binding) => binding.name))(
    "refuses a missing or plain-text runtime variable: %s",
    (name) => {
      expect(() =>
        validateRuntimeSecrets(
          secrets.filter((binding) => binding.name !== name),
        ),
      ).toThrow(name);
      expect(() =>
        validateRuntimeSecrets(
          secrets.map((binding) =>
            binding.name === name
              ? { ...binding, type: "plain_text" }
              : binding,
          ),
        ),
      ).toThrow(name);
    },
  );

  it("rejects malformed secret metadata", () => {
    for (const response of [null, {}, [null]]) {
      expect(() => validateRuntimeSecrets(response)).toThrow();
    }
  });
});

describe("migration history and upgrade confirmation", () => {
  it("requires confirmation for the real 1.x migration history", () => {
    expect(() => pendingMigrations(migrations, baseline, false)).toThrow(
      "confirm_legacy_upgrade",
    );
    expect(pendingMigrations(migrations, baseline, true)).toEqual(
      migrations.slice(baseline.length),
    );
  });

  it("does not require legacy confirmation after upgrading", () => {
    expect(pendingMigrations(migrations, migrations, false)).toEqual([]);
  });

  it("requires confirmation when only the last legacy migration remains", () => {
    expect(() =>
      pendingMigrations(migrations, migrations.slice(0, -1), false),
    ).toThrow("confirm_legacy_upgrade");
  });

  it.each([
    { applied: [] },
    { applied: baseline.slice(1) },
    { applied: [...baseline, migrations[12]] },
    { applied: [...baseline, baseline[0]] },
    { applied: [...baseline, "9999_foreign_history.sql"] },
  ])(
    "rejects missing, noncontiguous, duplicated or unknown history: %j",
    ({ applied }) => {
      expect(() => pendingMigrations(migrations, applied, true)).toThrow();
    },
  );

  it("rejects a repository without the expected legacy baseline", () => {
    expect(() => pendingMigrations(["0022_new.sql"], [], true)).toThrow();
  });
});

describe("read-only production preflight", () => {
  it("records the latest deployment and bookmark using only reads", () => {
    const runJson = fixture();
    const result = inspectProduction({ env, migrations, runJson });
    expect(result).toEqual({
      pending: [],
      deploymentId: "current-deployment",
      versionIds: ["current-version"],
      bookmark: "00000001-00000001-00000001-test-bookmark",
    });
    for (const [args] of runJson.mock.calls) {
      if (args[1] === "query") {
        expect(args[args.indexOf("--sql") + 1]).toMatch(/^SELECT /);
        expect(args[2]).toBe(productionTarget.D1_DATABASE_ID);
        expect(args).not.toContain("--local");
      } else {
        expect([
          "workers deployments list",
          "workers secrets list",
          "d1 time-travel get-bookmark",
        ]).toContain(args.slice(0, 3).join(" "));
      }
    }
  });

  it("stops before querying D1 when runtime secrets have not been converted", () => {
    const runJson = fixture();
    runJson.mockImplementationOnce(() => ({
      deployments: [{ id: "current", versions: [{ version_id: "v1" }] }],
    }));
    runJson.mockImplementationOnce(() =>
      secrets.filter((binding) => binding.name !== "DOMAIN"),
    );
    expect(() => inspectProduction({ env, migrations, runJson })).toThrow(
      "DOMAIN",
    );
    expect(runJson).toHaveBeenCalledTimes(2);
  });

  it("refuses a database without its migration ledger without creating one", () => {
    const runJson = fixture({
      tables: ["posts", "comments", "friend_links", "system_config"],
    });
    expect(() => inspectProduction({ env, migrations, runJson })).toThrow(
      "d1_migrations",
    );
    expect(runJson).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "false", "yes"])(
    "does not treat %j as legacy confirmation",
    (confirmed) => {
      const runJson = fixture({ applied: baseline });
      expect(() =>
        inspectProduction({
          env: { ...env, CONFIRM_LEGACY_UPGRADE: confirmed },
          migrations,
          runJson,
        }),
      ).toThrow("confirm_legacy_upgrade");
      expect(runJson).toHaveBeenCalledTimes(4);
    },
  );

  it("allows explicitly confirmed legacy migrations", () => {
    const runJson = fixture({ applied: baseline });
    expect(
      inspectProduction({
        env: { ...env, CONFIRM_LEGACY_UPGRADE: "true" },
        migrations,
        runJson,
      }).pending,
    ).toEqual(migrations.slice(baseline.length));
  });

  it.each([
    { row_count: 2, invalid_json_count: 0 },
    { row_count: 1, invalid_json_count: 1 },
    { row_count: "1", invalid_json_count: 0 },
  ])("refuses ambiguous or corrupt System Config: %j", (config) => {
    const runJson = fixture({ config });
    expect(() => inspectProduction({ env, migrations, runJson })).toThrow(
      "system_config",
    );
  });

  it("allows an empty System Config", () => {
    expect(() =>
      inspectProduction({
        env,
        migrations,
        runJson: fixture({ config: { row_count: 0, invalid_json_count: 0 } }),
      }),
    ).not.toThrow();
  });

  it("refuses missing Time Travel recovery information", () => {
    expect(() =>
      inspectProduction({
        env,
        migrations,
        runJson: fixture({ bookmark: "" }),
      }),
    ).toThrow("Missing value");
  });

  it("stops on permission/network errors or malformed responses", () => {
    const denied = vi.fn(() => {
      throw new Error("Permission denied");
    });
    expect(() =>
      inspectProduction({ env, migrations, runJson: denied }),
    ).toThrow("Permission denied");
    expect(denied).toHaveBeenCalledTimes(1);
    for (const response of [
      null,
      {},
      [],
      { deployments: [] },
      { deployments: [{ id: "no-version" }] },
    ]) {
      expect(() =>
        inspectProduction({ env, migrations, runJson: () => response }),
      ).toThrow();
    }
  });

  it("refuses a failed D1 SELECT response", () => {
    const runJson = fixture();
    runJson.mockImplementationOnce(() => ({
      deployments: [{ id: "current", versions: [{ version_id: "v1" }] }],
    }));
    runJson.mockImplementationOnce(() => secrets);
    runJson.mockImplementationOnce(() => [{ success: false, results: [] }]);
    expect(() => inspectProduction({ env, migrations, runJson })).toThrow(
      "只读查询失败",
    );
  });
});
