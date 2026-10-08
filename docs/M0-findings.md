# M0 实测结论（2026-10-08）

这份文档记录 DESIGN.md 里 [M0] 待定项的实测结论。依据有两个：本机 dsh 0.2.0-rc.2 的安装包（asar 内源码），以及 CLIProxyAPI `main` 分支源码和 v8.0.21 的发布物。

## CLIProxyAPI

| 项 | 结论 | 来源 |
|---|---|---|
| 发布包 | `CLIProxyAPI_<ver>_<darwin\|linux>_<aarch64\|amd64>.tar.gz`，解压后平铺出 `cli-proxy-api`；同时发布 `checksums.txt`（sha256sum 格式）；MIT 协议 | GitHub Releases API |
| 配置格式 | v8 采用分组结构，并写 `config-version: 8`：`server.{host,port}`、`access.api-keys`、`management.{allow-remote,secret-key,disable-control-panel}`、`oauth.auth-dir`、`routing.strategy`、`observability.logs.*`。v7 的平铺字段名仍兼容，同时出现时以 v8 为准 | `config.example.yaml` |
| client key | 字符串列表。**列表为空时不做任何鉴权**；如果列表里还是示例占位 key，进入 safe mode（返回 `unsafe_example_api_key`） | `internal/api/server_middleware.go` |
| 管理 API | `secret-key: ""` 时管理 API 整体关闭（返回 404）；但设置环境变量 `MANAGEMENT_PASSWORD` 会强制开启 | `internal/api/server_reload.go` |
| CORS | 所有路由都返回 `Access-Control-Allow-Origin: *`，所以必须配置 key | `corsMiddleware` |
| 热重载 | fsnotify 同时监视配置文件和 auth-dir，api-keys 修改即时生效；`trusted-proxies` 改了要重启；host/port 改了按需要重启处理 | `internal/watcher/watcher.go` |
| 启动参数 | `-config` 默认读工作目录下的配置，所以必须传绝对路径；没有 `-version` 参数，版本号印在任意一次运行输出的首行 | `cmd/server/main.go` |
| 登录 | `-codex-login`/`-codex-device-login`、`-claude-login`、`-antigravity-login`、`-kimi-login`、`-xai-login`、`-meta-login`、`-devin-login`；可配合 `-no-browser`、`-oauth-callback-port`。**没有** gemini/qwen/iflow 的登录 | 同上 |
| 回调端口 | Claude 54545、Codex 1455、Antigravity 51121；Kimi、xAI、Meta 走 device-code；Claude/Codex/Antigravity 在 15 秒后接受从 stdin 粘贴回调 URL | `internal/auth/*`、`sdk/auth/*` |
| 端点 | `/healthz` 无需鉴权；`/v1/*` 需要 key；`/v1/models` 返回 `{id,object,created,owned_by}`，id 用上游原名 | `internal/api/server_routes.go` |
| 多凭据 | auth-dir 下的每个 json 都会被加载，同一个上游有多个凭据时轮询使用。dsh-model 自己限制每个上游只放一个 | `sdk/cliproxy` |

## dsh 0.2.0-rc.2

| 项 | 结论 |
|---|---|
| DSH_HOME | 默认 `~/.dsh`。profile：Desktop 版是 `desktop`；dsh-vps 部署的是 `web`，DSH_HOME 为 `/home/dsh/.dsh` |
| 写哪个文件 | `profiles/<p>/cordis.patch.yml`。不写 home 级 patch，因为 home 级覆盖会让 Web UI 无法保存 |
| patch 语义 | 一个条目的 `config` 会**整块替换**原值，所以只能合并进已有的 `llm-pi-ai` 条目；**patch 文件为空或只有注释时启动失败**，最少要写 `[]`；修改后由 dsh-hmr 热加载 |
| provider 字段 | `{displayName, apiKeyEnv, api, baseURL, models[], headers, ...}`。dsh 不自带的路由必须同时有 `api`、`baseURL` 和非空的 `models`；**没有内联 apiKey 字段**；dsh 运行时不会去拉取模型列表 |
| key 存放 | `$DSH_HOME/.credentials.yaml`：`version: 1`、`refs: {NAME: value}`、`records`。文件权限必须是 0600；不允许空值或未知的顶层键；查找顺序是环境变量 > 此文件 > `.env` |
| 版本读取 | Mac：`/Applications/DeepSeek Harness.app/Contents/Info.plist` 里的 `CFBundleShortVersionString`。VPS：`/opt/dsh-vps/dsh/current/node_modules/@deepseek-ai/dsh/package.json` |
| 崩溃恢复 | 可能把 patch 改名为 `cordis.patch.yml.bak-<ms>`，并在 `$DSH_HOME/recovery/` 下存快照 |
| dsh-vps | Caddyfile 内容是 `import /etc/caddy/dsh-site.conf`，`dsh-site.conf` 由 gate 整体重写；`install.sh` 会保留 `^import /etc/caddy/` 开头的行；dsh 监听 3080，gate 监听 3100 |
