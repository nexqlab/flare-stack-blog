import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Resource identifiers are not credentials. Pin these to avoid creating a new
// Worker or migrating another database when a GitHub variable is mistyped.
export const productionTarget = {
  CLOUDFLARE_ACCOUNT_ID: "cc207962bbf5ae08fb1cc12c99131ce6",
  WORKER_NAME: "qiqid-blog",
  DOMAIN: "qiqid.com",
  D1_DATABASE_ID: "b601d73a-0208-402d-a5dd-ff6439c21c9f",
  BUCKET_NAME: "qiqid-blog-assets",
  QUEUE_NAME: "blog-queue",
  KV_NAMESPACE_ID: "76a56dce539a4aa590ea5a029fcfb494",
} as const;

type EnvMap = Record<string, string | undefined>;
type JsonRecord = Record<string, unknown>;
type RunJson = (args: string[]) => unknown;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected Wrangler JSON response; refusing deployment.");
  }
  return value as JsonRecord;
}

function nonemptyString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing value in Wrangler response; refusing deployment.");
  }
  return value;
}

export function validateProductionEnvironment(env: EnvMap): void {
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error("生产发布只能从 main 手动运行。");
  }
  for (const [key, expected] of Object.entries(productionTarget)) {
    if (!env[key]?.trim()) throw new Error(`缺少 GitHub 配置：${key}`);
    if (env[key] !== expected) {
      throw new Error(`${key} 与固定生产资源不匹配；拒绝发布。`);
    }
  }
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error("缺少 GitHub Secret：CLOUDFLARE_API_TOKEN");
  }
}

export function pendingMigrations(
  local: string[],
  applied: string[],
  confirmed: boolean,
): string[] {
  const sorted = [...local].sort();
  if (
    !sorted.length ||
    sorted.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) ||
    new Set(sorted).size !== sorted.length ||
    new Set(applied).size !== applied.length ||
    applied.some((name) => !sorted.includes(name))
  ) {
    throw new Error("迁移记录与仓库不一致；拒绝自动修复或继续发布。");
  }
  const appliedSet = new Set(applied);
  const pending = sorted.filter((name) => !appliedSet.has(name));
  const firstPending = sorted.findIndex((name) => !appliedSet.has(name));
  if (
    sorted.some(
      (name, index) =>
        firstPending >= 0 && index > firstPending && appliedSet.has(name),
    ) ||
    sorted.some(
      (name) => Number(name.slice(0, 4)) <= 10 && !appliedSet.has(name),
    ) ||
    !sorted.some((name) => name.startsWith("0010_"))
  ) {
    throw new Error(
      "历史迁移记录缺失或存在断层；请先核对，不能直接初始化生产数据库。",
    );
  }
  if (
    !confirmed &&
    pending.some((name) => {
      const number = Number(name.slice(0, 4));
      return number >= 11 && number <= 21;
    })
  ) {
    throw new Error(
      "0011–0021 升级尚未确认。请阅读数据转换说明、确认备份后，手动勾选 confirm_legacy_upgrade。",
    );
  }
  return pending;
}

function queryRows(runJson: RunJson, sql: string): JsonRecord[] {
  const response = runJson([
    "d1",
    "execute",
    "DB",
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  if (!Array.isArray(response) || response.length !== 1) {
    throw new Error("Unexpected D1 query response; refusing deployment.");
  }
  const result = record(response[0]);
  if (result.success !== true || !Array.isArray(result.results)) {
    throw new Error("D1 只读查询失败；拒绝发布。");
  }
  return result.results.map(record);
}

export function inspectProduction({
  env,
  migrations,
  runJson,
}: {
  env: EnvMap;
  migrations: string[];
  runJson: RunJson;
}) {
  validateProductionEnvironment(env);
  const deployments = runJson(["deployments", "list", "--json"]);
  if (!Array.isArray(deployments) || !deployments.length) {
    throw new Error("未找到现有生产 Worker 部署；拒绝创建新 Worker。");
  }
  const previous = record(deployments[deployments.length - 1]);
  const deploymentId = nonemptyString(previous.id);
  if (!Array.isArray(previous.versions) || !previous.versions.length) {
    throw new Error("无法记录现有 Worker 版本；拒绝发布。");
  }
  const versionIds = previous.versions.map((version) =>
    nonemptyString(record(version).version_id),
  );

  // `wrangler d1 migrations list` runs CREATE TABLE IF NOT EXISTS. Only
  // SELECT queries belong in this preflight, including when the ledger is absent.
  const tables = queryRows(
    runJson,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('d1_migrations', 'posts', 'comments', 'friend_links', 'system_config');",
  ).map((row) => nonemptyString(row.name));
  if (
    [
      "d1_migrations",
      "posts",
      "comments",
      "friend_links",
      "system_config",
    ].some((name) => !tables.includes(name))
  ) {
    throw new Error(
      "生产数据库缺少业务表或 d1_migrations；请先核对历史，预检不会创建表。",
    );
  }
  const applied = queryRows(
    runJson,
    "SELECT name FROM d1_migrations ORDER BY id;",
  ).map((row) => nonemptyString(row.name));
  const pending = pendingMigrations(
    migrations,
    applied,
    env.CONFIRM_LEGACY_UPGRADE === "true",
  );
  const configRows = queryRows(
    runJson,
    "SELECT count(*) AS row_count, coalesce(sum(CASE WHEN json_valid(coalesce(config_json, '{}')) THEN 0 ELSE 1 END), 0) AS invalid_json_count FROM system_config;",
  );
  const config = configRows.length === 1 ? configRows[0] : undefined;
  if (
    !config ||
    !Number.isInteger(config.row_count) ||
    Number(config.row_count) < 0 ||
    Number(config.row_count) > 1 ||
    config.invalid_json_count !== 0
  ) {
    throw new Error(
      "system_config 必须至多一行且包含有效 JSON；请先人工核对数据。",
    );
  }
  const bookmark = nonemptyString(
    record(runJson(["d1", "time-travel", "info", "DB", "--json"])).bookmark,
  );
  return { pending, bookmark, deploymentId, versionIds };
}

function runWranglerJson(args: string[]): unknown {
  let output: string;
  try {
    output = execFileSync(
      resolve("node_modules/.bin/wrangler"),
      [...args, "--config", "wrangler.jsonc"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: 60_000,
      },
    );
  } catch {
    throw new Error(
      `Wrangler ${args.slice(0, 3).join(" ")} 失败；检查权限与上方错误。`,
    );
  }
  return JSON.parse(output);
}

if (import.meta.main) {
  try {
    const mode = process.argv[2];
    validateProductionEnvironment(process.env);
    if (mode === "--check-config") {
      console.log("生产入口及 GitHub 配置已校验；未访问或修改生产资源。");
    } else if (mode === "--preflight") {
      const result = inspectProduction({
        env: process.env,
        migrations: readdirSync("migrations").filter((name) =>
          name.endsWith(".sql"),
        ),
        runJson: runWranglerJson,
      });
      const summary = [
        "### 生产迁移前记录",
        `- 提交：\`${process.env.GITHUB_SHA}\``,
        `- Worker：\`${productionTarget.WORKER_NAME}\``,
        `- 原部署：\`${result.deploymentId}\``,
        `- 原版本：${result.versionIds.map((id) => `\`${id}\``).join(", ")}`,
        `- D1 Time Travel 书签：\`${result.bookmark}\``,
        `- 待执行迁移：${result.pending.length ? result.pending.map((name) => `\`${name}\``).join(", ") : "无"}`,
        "- 预检只有只读查询；后续迁移或发布失败不会自动恢复数据库。",
        "",
      ].join("\n");
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      }
    } else {
      throw new Error("Use --check-config or --preflight.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "生产预检失败。");
    process.exitCode = 1;
  }
}
