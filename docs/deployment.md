# 部署 Flare Stack Blog

可以通过 **GitHub + Cloudflare Workers Builds** 首次部署；本仓库已有的 `qiqid-blog` 生产站点使用 [GitHub Actions 手动更新](#github-actions-手动更新生产博客)。

## 前置条件

- 一个 GitHub 账号。
- 一个 Cloudflare 账号，已经绑定付款方式并开通 R2。
- 一个已在 Cloudflare 托管、状态为 **Active（有效）** 的域名。

下文以 `blog.example.com` 为博客域名、`flare-blog` 为 Worker 名称，部署时替换成自己的值即可。建议使用空闲子域名，并在托管域名的 Cloudflare 账号下创建所有资源。

## 开始操作

1. [Fork 仓库](#1-fork-仓库)
2. [准备两份变量清单](#2-准备两份变量清单)
3. [创建 GitHub OAuth App](#3-创建-github-oauth-app)
4. [创建 Cloudflare 资源](#4-创建-cloudflare-资源)
5. [可选：开启图片优化](#5-可选开启图片优化)
6. [创建 Worker 并部署](#6-创建-worker-并部署)
7. [登录博客，成为管理员](#7-登录博客成为管理员)
8. [以后如何更新](#8-以后如何更新)

### 1. Fork 仓库

打开 [du2333/flare-stack-blog](https://github.com/du2333/flare-stack-blog)，点击右上角 **Fork**。

![GitHub 仓库右上角的 Fork 入口](./assets/deployment/01-fork.png)

在创建页面中，Owner 选择自己的 GitHub 账号，仓库名保留 `flare-stack-blog`，勾选 **Copy the main branch only**，点击 **Create fork**。

创建后会进入 `github.com/你的用户名/flare-stack-blog`，后续使用这份仓库部署。

### 2. 准备两份变量清单

在 Fork 的仓库根目录中打开下面两个文件，点击 **Raw** 复制内容，分别保存到电脑上的两个文本文件中。也可以从下面的链接查看本项目模板：

| 项目模板 | 建议保存为 | 用途 | 最后填到哪里 |
| --- | --- | --- | --- |
| [.env.example](../.env.example) | `.env` | **构建时变量**：告诉部署程序使用哪个域名和哪些资源 | Cloudflare 的构建设置 |
| [.dev.vars.example](../.dev.vars.example) | `.dev.vars` | **运行时变量**：博客运行时使用的认证配置等 | Worker 的运行时变量与机密 |

将这两份清单保存在本地，随着后续步骤补齐变量，最后填入 Cloudflare。其中的密钥请妥善保管。

#### 构建时必填项

| 变量 | 示例 / 从哪里获取 | 作用 |
| --- | --- | --- |
| `WORKER_NAME` | `flare-blog` | Worker 应用名称，第 6 步的 Project name 必须与它一致 |
| `DOMAIN` | `blog.example.com` | 博客的纯域名 |
| `D1_DATABASE_ID` | 第 4 步复制的 Database ID / UUID | 找到存放文章、用户等数据的数据库 |
| `BUCKET_NAME` | `blog-media` | 找到存放图片等文件的 R2 存储桶 |
| `QUEUE_NAME` | `blog-queue` | 找到处理通知等异步任务的队列 |
| `KV_NAMESPACE_ID` | 第 4 步复制的 Namespace ID | 找到博客使用的缓存空间 |

构建清单保留上面六项，先填好 `WORKER_NAME` 和 `DOMAIN`，其余值在第 4 步补齐。模板中的可选项和本地工具变量可以跳过。

#### 运行时必填项

| 变量 | 应该填什么 | 作用 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | 自己生成的一串随机密钥，至少 32 个字符 | 保护登录会话等认证数据；生成后妥善保存 |
| `BETTER_AUTH_URL` | `https://blog.example.com` | 博客完整访问地址，用于登录和回调 |
| `DOMAIN` | `blog.example.com` | 运行时使用的域名，与构建时一致 |
| `GITHUB_CLIENT_ID` | 第 3 步获取的 Client ID | 标识你的 GitHub 登录应用 |
| `GITHUB_CLIENT_SECRET` | 第 3 步获取的 Client Secret | GitHub 登录应用的密钥 |

将模板中的本地开发配置改为线上配置：

- `BETTER_AUTH_URL=http://localhost:3000` 改成自己的完整 HTTPS 地址。
- `ENVIRONMENT=dev` 改成 `ENVIRONMENT=prod`。

两份清单中的 `DOMAIN` 填相同的值，分别用于部署时绑定域名和博客运行时读取。

`BETTER_AUTH_SECRET` 可以用密码管理器生成 64 位随机字母数字。也可以在任意可信 HTTPS 页面打开浏览器开发者工具的 Console（控制台），执行下面这段代码，复制结果，不包含两边引号：

```js
Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
```

### 3. 创建 GitHub OAuth App

这个应用让你和读者能够通过 GitHub 登录博客。

打开 GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**，也可以直接打开 [创建 OAuth App 页面](https://github.com/settings/applications/new)。

| 表单项 | 填写内容 |
| --- | --- |
| Application name | 自己的博客名称，例如 `Flare Stack Blog` |
| Homepage URL | `https://blog.example.com` |
| Application description | 可留空 |
| Redirect URI / Authorization callback URL | `https://blog.example.com/api/auth/callback/github` |

![GitHub OAuth App 示例：博客主页与完整登录回调地址](./assets/deployment/02-oauth.png)

将示例域名换成自己的域名，回调地址末尾的 **`/api/auth/callback/github`** 保持不变，其余选项保留默认值。

点击 **Register application**。在应用详情页：

1. 复制 **Client ID**，填入运行时清单的 `GITHUB_CLIENT_ID`。
2. 点击 **Generate a new client secret**，按 GitHub 提示完成身份确认。
3. 立即复制新生成的 **Client secret**，填入 `GITHUB_CLIENT_SECRET`；离开页面后可能无法再次查看完整值。

### 4. 创建 Cloudflare 资源

打开 [Cloudflare 控制台](https://dash.cloudflare.com/)，选择托管域名的账号。下面四种资源各创建一个，名称可以自定。

| 资源 | 左侧菜单入口 | 示例名称 | 写入构建清单的内容 |
| --- | --- | --- | --- |
| D1 数据库 | Storage & databases → D1 SQLite Database | `blog-db` | **ID** → `D1_DATABASE_ID` |
| R2 存储桶 | Storage & databases → R2 Object Storage | `blog-media` | **名称** → `BUCKET_NAME` |
| Queue 队列 | Compute → Queues | `blog-queue` | **名称** → `QUEUE_NAME` |
| KV 命名空间 | Storage & databases → Workers KV | `blog-cache` | **ID** → `KV_NAMESPACE_ID` |

#### D1：存放文章和用户数据

进入 **D1 SQLite Database**，点击 **Create Database**，填写名称，例如 `blog-db`。位置选项保留默认，点击 **Create**。

![创建 D1 数据库：填写名称，位置保留默认](./assets/deployment/03-d1-create.png)

返回数据库列表，找到刚创建的数据库，在 **UUID** 一栏点击复制，将完整 ID 填入 `D1_DATABASE_ID`。也可以在数据库详情中查看 **Database ID**。

![D1 数据库列表中的 UUID](./assets/deployment/04-d1-id.png)

部署时会自动初始化数据库。

#### R2：存放图片等文件

进入 **R2 Object Storage**，点击 **Create bucket**，填写名称，例如 `blog-media`。Location 保留 **Automatic**，Default Storage Class 保留 **Standard**，点击页面底部的 **Create bucket**。

![R2 存储桶的名称填写示例](./assets/deployment/05-r2.png)

把存储桶**名称**填入 `BUCKET_NAME`，其余设置保留默认值。

#### Queue：处理通知等异步任务

进入 **Compute → Queues**，点击 **Create Queue**，填写名称，例如 `blog-queue`，再点击 **Create**。

![创建队列：名称填写完成后记入 QUEUE_NAME](./assets/deployment/07-queue.png)

把队列**名称**填入 `QUEUE_NAME`。

#### KV：存放缓存

进入 **Storage & databases → Workers KV**，点击 **Create Instance**（部分界面显示 Create namespace），填写 Namespace name，例如 `blog-cache`，点击 **Create**。

返回列表，复制这一行 **ID** 列中的完整值，填入 `KV_NAMESPACE_ID`。

![KV 命名空间列表中的 ID](./assets/deployment/06-kv-id.png)

### 5. 可选：开启图片优化

开启 Cloudflare **Image Transformations（图片转换）** 后，博客会按需要对图片进行缩放和压缩。

在 Cloudflare 账号侧栏打开 **Images & Stream → Transformations**（部分界面位于 Images 下），找到博客所属的根域名，例如 `example.com`，为该域名启用转换。

进入域名的转换设置，Sources 选择 **This zone only**，允许本域名及其子域名作为图片来源，点击 **Save** 保存修改。

![已启用图片转换的域名设置，Sources 选择 This zone only](./assets/deployment/08-images.png)

域名列表显示 **Enabled**，或设置页显示 **Disable for zone**，即表示已启用。跳过此步骤时，博客使用原图。转换额度及价格见 [Cloudflare Images 定价](https://developers.cloudflare.com/images/pricing/)。

### 6. 创建 Worker 并部署

#### 连接自己的 Fork

打开 **Compute → Workers & Pages → Create application**，选择 **Continue with GitHub**。

![创建 Worker 应用，选择 Continue with GitHub](./assets/deployment/09-workers-github.png)

首次连接时，按页面提示授权 Cloudflare 访问你的 Fork 仓库。然后选择自己的 GitHub 账号，搜索 `flare-stack-blog`，选中仓库并点击 **Next**。

#### 填写构建设置

在 **Set up your application** 中，按下面填写：

| 设置项 | 填写内容 |
| --- | --- |
| Project name / Worker name | 与 `WORKER_NAME` 相同，例如 `flare-blog` |
| Build command | `bun run build` |
| Deploy command | `bun run deploy` |
| Path / Root directory | `/`，即仓库根目录 |
| Builds for non-production branches | 首次部署建议取消勾选 |

![构建和部署命令的填写示例](./assets/deployment/10-build-commands.png)

展开 **Advanced settings**，添加构建清单中的六个变量：**Variable name** 填等号左边的名称，**Variable value** 填等号右边的值，点击 **Add variable** 继续添加下一项。

![构建变量示例：WORKER_NAME 的值必须与应用名称一致](./assets/deployment/11-build-vars.png)

可在这里额外添加 `BUN_VERSION=1.3.5`，指定构建环境使用的 Bun 版本。构建环境的 Node 版本由仓库根目录的 `.node-version` 指定，无需额外设置。

确认生产分支为 Fork 的 `main`。有些界面在创建时使用仓库默认分支，可在创建后的 **Settings → Builds → Branch control / Production branch** 中核对。后续自动部署监听的就是这个分支。

点击 **Deploy**，等待构建和部署成功。上述命令会自动完成资源绑定、数据库迁移和 Worker 发布，并通过 **Custom Domain（自定义域）** 绑定博客域名。

#### 添加运行时变量

第一次部署成功后，继续打开该 Worker 的 **Settings → Runtime variables and secrets**（部分界面显示 Variables and Secrets），点击 **Add variable**。

![运行时变量弹窗：Key、Value、Secret 和保存部署按钮](./assets/deployment/12-runtime.png)

添加运行时清单中已填好的变量。可以逐项填写 Key / Value，也可以将 `KEY=value` 格式的变量行粘贴到 **Key** 输入框，批量导入。

- **所有运行时变量都必须勾选 Secret**（包括 `BETTER_AUTH_URL`、`DOMAIN`、`GITHUB_CLIENT_ID`、`ENVIRONMENT`）。部署程序会保留机密，但会在每次部署时丢弃没有写进配置文件的普通文本变量，导致博客报 `Invalid environment variables`。
- `ENVIRONMENT` 使用第 2 步设置的 `prod`。

点击 **Add variable and deploy**（保存并部署），等待变量生效。

最后在 Worker 的 **Domains**（部分界面为 Settings → Domains & Routes）中确认自己的域名已绑定；DNS 和证书生效后，通过 `https://blog.example.com` 访问。

### 7. 登录博客，成为管理员

打开自己的博客域名，点击右上角的登录入口，选择 **GitHub 登录**，完成 GitHub 授权。第一次登录会自动创建博客用户。

**新数据库中第一个创建的用户会自动成为管理员。** 配置好后先完成自己的首次登录，再把地址分享给别人。

登录后，点击右上角头像，应当能看到 **管理后台**；也可以直接访问 `https://blog.example.com/admin`。

![管理员登录后可从头像菜单进入管理后台](./assets/deployment/13-admin-entry.png)

进入后台后，可以设置博客名称、介绍和外观，上传一张图片并发布第一篇文章。GitHub 登录不依赖邮件配置；邮箱注册、找回密码和通知邮件需要之后在后台配置邮件发送服务。

### 8. 以后如何更新

以下步骤适用于已经连接 **Cloudflare Workers Builds** 的站点。本仓库生产站点使用后面的 [GitHub Actions 手动更新流程](#github-actions-手动更新生产博客)，同步代码后不会自动发布。

上游有新代码时，先阅读 [更新说明](https://github.com/du2333/flare-stack-blog/releases)，然后：

1. 打开**自己的 Fork 仓库**，切换到 Cloudflare 监听的生产分支，本文为 `main`。
2. 点击文件列表上方的 **Sync fork → Update branch**，将上游更新同步到自己的仓库。
3. 打开 Cloudflare 对应 Worker 的 **Deployments / Builds**，等待这次提交的构建和部署成功。
4. 刷新博客，检查首页和后台是否正常。

同步产生新提交后，Cloudflare Workers Builds 会自动部署，并执行数据库迁移，已有资源和运行时机密会保留。

> **从使用 `wrangler.jsonc` 的旧版本升级（v2.x → v3）时**，同步之前请先完成两件事，否则第一次自动部署就会出问题：
>
> 1. 打开 Worker 的 **Settings → Runtime variables and secrets**，把仍是普通文本的运行时变量（例如 `BETTER_AUTH_URL`、`DOMAIN`、`GITHUB_CLIENT_ID`、`ENVIRONMENT`）删除后以 **Secret** 类型重新添加。新版部署程序不再保留普通文本变量。
> 2. 把 **Build command** 改为 `bun run build`。旧的 `bun run wrangler:prepare && bun run build` 在本版本仍可运行（`wrangler:prepare` 只会打印一条废弃提示），但之后的版本会移除它。
>
> 另外，Durable Object 的声明方式已改为 `exports`。部署成功后，无法再回退到旧的基于 `migrations` 的 Wrangler 配置，回退需要把 DO 同样声明在旧配置的 `exports` 里。

若更新说明要求新增变量或调整配置，请一并完成。自行修改过代码的仓库，可能需要先解决同步冲突。

## GitHub Actions 手动更新生产博客

本仓库提供 [发布生产博客](../.github/workflows/deploy-production.yml) 任务，使用 Cloudflare 官方支持的 [GitHub Actions 部署方式](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)。任务只接受 `main` 分支的手动运行；推送、同步 Fork、提交 PR 和本地 `git pull` 都不会触发生产发布。

工作流文件需要先进入 GitHub 默认分支 `main`，才能在 Actions 中看到 **Run workflow**。同一时间只执行一个生产发布，新运行不会自动取消正在迁移或发布的任务；执行中也不要手动取消任务。代码检查与测试不接收 Cloudflare 凭据，只有配置校验和生产操作步骤读取部署凭据。

### 配置 GitHub Secrets 和 Variables

在自己的仓库打开 **Settings → Secrets and variables → Actions**。使用仓库级配置；不要把凭据提交到代码、日志或普通 Variables 中。

在 **Secrets** 添加：

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 专门用于此仓库发布的 Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 当前 `Qiqi` 账号 ID：`cc207962bbf5ae08fb1cc12c99131ce6` |

Token 以 **Edit Cloudflare Workers** 权限模板为基础，限定到此账号及 `qiqid.com` 域名，并按本应用需要添加 **D1 Edit**、**Queues Edit**。确认包含 **Workers Scripts Edit**、**Workers KV Storage Edit**、**Workers R2 Storage Edit**、**Workers Routes Edit** 和 **Zone Read**，以及模板中的账号读取权限。不要使用 Global API Key。Token 权限不足时任务会停止，应核对失败步骤对应的权限后再运行。

在 **Variables** 添加以下六项；任务会核对这些已存在的生产资源，不接受替代名称或其他资源 ID：

| 名称 | 固定生产值 |
| --- | --- |
| `WORKER_NAME` | `qiqid-blog` |
| `DOMAIN` | `qiqid.com` |
| `D1_DATABASE_ID` | `b601d73a-0208-402d-a5dd-ff6439c21c9f` |
| `BUCKET_NAME` | `qiqid-blog-assets` |
| `QUEUE_NAME` | `blog-queue` |
| `KV_NAMESPACE_ID` | `76a56dce539a4aa590ea5a029fcfb494` |

原部署已启用 Umami 时，还要添加原来的 `VITE_UMAMI_WEBSITE_ID`；已启用 Turnstile 时添加原来的 `VITE_TURNSTILE_SITE_KEY`。这些值是前端公开配置，不要填写 Umami 密码、API Token 或 Turnstile Secret。如果历史部署已将这两项公开配置放在同名仓库 Secrets 中，任务会在缺少 Variable 时继续读取已有 Secret，无需重新获取值；同名 Variable 优先。

`BETTER_AUTH_SECRET`、`GITHUB_CLIENT_SECRET`、`TURNSTILE_SECRET_KEY` 等运行时密钥继续保存在 **Cloudflare Worker → Settings → Runtime variables and secrets**。现有普通运行时变量由 `keep_vars` 保留，发布流程不重新上传运行时密钥。

### 手动运行与首次升级

1. 将需要发布的代码同步或合并到 GitHub `main`，阅读对应版本的更新说明。
2. 打开 **Actions → 发布生产博客 → Run workflow**，分支选择 `main`。
3. 首次从旧版本升级时，先确认生产 D1 的备份/Time Travel 可用，阅读下表的数据转换影响，再勾选 **confirm_legacy_upgrade**。以后 `0011–0021` 已全部应用时，无需勾选。
4. 点击 **Run workflow**，依次查看配置校验、代码检查与测试、构建、部署预检、只读生产预检、D1 迁移和 Worker 发布结果。
5. 在任务 **Summary** 保存迁移前的 Worker 部署/版本 ID、D1 Time Travel 书签、待执行迁移清单和提交 SHA。书签写入失败、缺少配置或预检失败都会阻止后续迁移与发布。
6. 发布后访问 `https://qiqid.com`，检查历史文章、GitHub 登录和后台；首页、登录页及后台入口的 HTTP 响应由任务自动检查，真实登录和后台操作需人工确认。
7. 首次升级后，在后台 **设置 → 维护 → 重建搜索索引**，再搜索一篇已发布的历史文章。迁移 `0019` 只创建搜索表，不自动为历史文章填充索引。

| 升级迁移 | 对已有数据的影响 |
| --- | --- |
| `0011` | 为已发布文章建立公开快照，并移除旧正文副本、阅读时长字段 |
| `0012–0013` | 待审核/验证中的评论转为公开，旧富文本评论转换为纯文本，移除 AI 审核原因 |
| `0014` | 删除旧 `page_views` 访问统计表；新统计依赖 Umami |
| `0020` | 保留站点配置并增加修改版本；旧配置多于一行或 JSON 无效时停止 |
| `0021` | 删除友链独立联系邮箱，后续通知使用申请人的账号邮箱 |

只读预检使用 `SELECT` 检查迁移记录和系统配置，不调用会尝试创建记录表的 `wrangler d1 migrations list`。若 `d1_migrations` 缺失、历史 `0000–0010` 未完整记录、迁移存在断层或未知记录，任务停止；先核对真实数据库的迁移历史，不要清库、删除历史记录或直接补记迁移。勾选升级确认不能跳过这些检查。

本流程使用 Node.js 24、Bun 1.3.14 和 `bun ci` 按锁文件安装依赖；Wrangler 使用仓库锁定版本。构建和 `wrangler deploy --dry-run` 都通过后才检查生产；生产预检只记录恢复信息，后续才执行已有 D1 迁移及 `wrangler deploy --keep-vars`。业务数据库与 Worker 发布不是一个原子事务，迁移后的短时间内旧 Worker 可能与新表结构不兼容，首次升级安排在低访问时段并暂停后台编辑。

### 失败处理与恢复

构建、测试或只读预检失败时，不会执行生产迁移和发布。迁移失败时，不继续发布；此前已经成功执行的迁移可能保留，先核对日志和迁移记录。生产任务不会自动重试迁移、恢复数据库或切回旧代码。

如果数据库迁移成功而 Worker 发布失败，应优先解决发布错误并部署匹配的新代码。**只回滚 Worker 不会回滚数据库**，旧代码可能无法使用已经删除的字段。需要恢复旧系统时，先暂停写入，核对 Summary 保存的书签和原版本，再按 [D1 Time Travel 文档](https://developers.cloudflare.com/d1/reference/time-travel/) 恢复数据库并部署与之匹配的旧 Worker。恢复会覆盖恢复点之后的写入，需要由管理员明确执行。

Time Travel 的可恢复窗口依 Cloudflare 套餐而定，书签不是永久 SQL 备份；首次大版本升级前可另行导出数据库并安全保存，禁止将含用户数据和密钥的 SQL 文件上传到公开仓库或发布日志。Workflows、Durable Objects 等资源变化还需单独核对；数据库恢复不能恢复已删除的 Durable Object 存储。

生产发布成功也不等于后台完整验收。若最后的 HTTP 检查失败，Worker 可能已经发布，先检查线上状态和 Cloudflare 日志，再决定修复或恢复。

## 可选配置

先完成基本部署，再按需添加。所有变量的完整说明以 [.env.example](../.env.example) 和 [.dev.vars.example](../.dev.vars.example) 为准。

| 功能 | 构建时变量 | 运行时变量 | 补充说明 |
| --- | --- | --- | --- |
| Turnstile 人机验证 | `VITE_TURNSTILE_SITE_KEY` | `TURNSTILE_SECRET_KEY`（Secret） | 在 Cloudflare 创建站点并添加博客域名；Site Key 与 Secret Key 成对使用 |
| Umami 访问统计 | `VITE_UMAMI_WEBSITE_ID` | `UMAMI_WEBSITE_ID`、`UMAMI_SRC` | 两边 Website ID 填同一个，`UMAMI_SRC` 填服务地址，例如 `https://cloud.umami.is` |
| Umami 文章热度同步 | 同上 | Cloud 使用 `UMAMI_API_KEY`；自托管使用 `UMAMI_USERNAME`、`UMAMI_PASSWORD` | API Key 和密码设为 Secret；两种认证方式二选一。API 地址可按模板配置 `UMAMI_API_URL` |
| 减少后台更新检查的 GitHub API 限流 | 无 | `GITHUB_TOKEN`（Secret） | 按模板链接创建 Fine-grained token，权限保留默认的公共仓库只读访问 |

修改**构建时变量**后，需要重新触发构建，新值才会进入部署产物。修改**运行时变量**后，使用保存并部署使其生效。

## 常见问题

### 构建失败，提示缺少变量或找不到资源

打开失败记录的构建日志，先查看具体缺少哪一项，再检查 **Settings → Builds** 中的变量：

- 六个构建必填项是否齐全，名称是否拼写正确，值前后是否混入空格。
- D1 和 KV 填的是完整 **ID**，R2 和 Queue 填的是**名称**。
- Worker 和资源是否位于同一 Cloudflare 账号，`WORKER_NAME` 是否与应用名一致。
- Build command 是否为 `bun run build`，Deploy command 是否为 `bun run deploy`。

如果日志提示权限不足，检查 Builds 使用的 Cloudflare API token 是否有权部署 Worker、访问对应存储和队列资源、配置域名。构建授权说明见 [Workers Builds 配置文档](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。修正后重新构建。

### 部署成功，但域名打不开或页面报错

检查域名是否已在同一账号托管并处于 Active，Worker 的 Domains 中是否出现该域名，DNS 和证书是否已生效。如果选的子域名已有其他 DNS 记录或绑定，先确认冲突来源，或换一个空闲子域名。

如果已经能访问 Worker 但页面报错，检查五个运行时必填项是否已保存并部署，并到 **Observability → Logs** 查看错误。

### GitHub 登录后提示回调地址错误，或回不到博客

逐项对照，下面三个值中的域名必须一致：

```text
博客访问地址：                 https://blog.example.com
BETTER_AUTH_URL：             https://blog.example.com
GitHub OAuth Redirect URI：   https://blog.example.com/api/auth/callback/github
```

同时确认 Client ID 和 Client Secret 来自同一个 OAuth App，运行时 `DOMAIN` 是纯域名，并通过配置的博客域名登录。

### 登录了，但没有管理员权限

管理员判断依据是数据库里的**第一个用户**。如果复用了已有用户的数据库，请使用原来的管理员账号登录。

### 同步了 Fork，但没有自动部署

检查更新是否进入 Cloudflare 监听的生产分支，以及 **Settings → Builds** 中的 GitHub 连接、生产分支和自动构建设置。如果配置了 Build watch paths，还要检查本次改动是否被排除。没有新提交，或仅同步到其他分支，都不会触发生产分支部署。

### 图片能显示，但没有优化效果

确认博客所属域名的 Transformations 已启用，Sources 允许博客域名及其子域名，并且转换额度可用。本地环境、GIF、原图请求不会转换，转换失败也会回退原图。应使用博客公开页面中请求了宽度或质量参数的图片检查效果。

---

[返回项目 README](../README.md)
