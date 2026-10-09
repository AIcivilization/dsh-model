# dsh-model 设计文档 v2

> 状态：v2 定稿，2026-10-08。取代 v1（自研 headless 网关），v1 的调研结论见 [RESEARCH.md](RESEARCH.md)。
> [M0] 待定项已全部实测，结论和来源见 [M0-findings.md](M0-findings.md)，本文已按实测结论修订。

---

## 1. 定位

**一条命令把自己的 CLI 订阅接进 dsh：装好、接好线、带鉴权、能干净卸载；VPS 上与 dsh-vps 组合自部署。**

- **个人自用工具**：服务对象是作者本人的设备和本人的账号，不对外提供服务，不做多用户。
- dsh 是一等公民。由于暴露的是标准 OpenAI 兼容端点，本人的其他工具（编辑器、脚本）也可以用同一个端点。
- 协议翻译、OAuth、上游接入全部交给 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（下称"引擎"）。dsh-model 不写网络代码。

### 1.1 目标

| # | 目标 | 验收 |
|---|---|---|
| G1 | `setup` 一条命令从零到 dsh 里能对话 | 新机器上 `npm i -g dsh-model && dsh-model setup && dsh-model login codex`，dsh 刷新模型后能完成一次带工具调用的对话 |
| G2 | 鉴权默认开启、用户无感 | 不带 key 请求端点返回 401；dsh 侧不需要手填 key |
| G3 | 干净卸载 | `dsh-model uninstall` 之后，dsh 配置与 setup 前逐字节一致（除非用户在此期间自己改过），系统服务和文件全部移除 |
| G4 | VPS 自部署 | 在装了 dsh-vps 的 VPS 上完成 setup 和远程登录，浏览器里的 dsh 能用；本人其他设备经 SSH 隧道或 Tailscale 能访问 |
| G5 | 可诊断 | `dsh-model doctor --e2e` 输出每个模型的红绿表（流式输出、tool_call 各测一次） |

### 1.2 非目标

- **官方 API key 上游**：dsh 本身已支持，dsh-model 不重复。
- 多账号、账号池、轮询负载均衡、配额感知切换。
- 免费模型池、冒充其他客户端（改 UA 等）。
- 自建 Web UI（界面就是 dsh），Windows（延后）。
- 自研协议翻译和 headless CLI 封装。v1 已论证 headless 路线做不到 OpenAI 语义的 tool_calls，不作为备选；引擎不可用时的兜底方案是 fork 引擎。

---

## 1.3 默认模型：统一端点（v3，2026-10-08，已确认）

回到原设计的核心主张：**一个网关服务所有软件，dsh 是一等公民**。OpenCode Zen 和 WorkBuddy 的模型，和订阅上游一样从 dsh-model 的统一端点 `127.0.0.1:8317/v1` 出去。dsh 接的是这个端点，你的编辑器、脚本也用同一个地址、同一套模型。

v2.1 的做法（在 dsh 里启用内置 opencode 路由，装第三方 dsh-workbuddy-connect 插件）只服务 dsh，违背"跨软件通用"，**作废**。已经那样装过的，setup 会迁移：移除 dsh-model 自己装的插件和 opencode 路由，改走统一端点。用户自己装的不动。

| 来源 | 实现 | 挂到引擎的方式 |
|---|---|---|
| 订阅（Codex 等） | CLIProxyAPI 原生 OAuth（不变） | 引擎内置 |
| OpenCode Zen | 用户的 Zen API key | 引擎的 `openai-compatibility` 上游：`base-url: https://opencode.ai/zen/v1`，`prefix: opencode`，走 `requests.proxy-url` |
| WorkBuddy / WorkBuddy AI | **dsh-model 自己的常驻组件 bridge**（Node）：读 WorkBuddy App 的登录态，对内提供 OpenAI 兼容接口 | 引擎的 `openai-compatibility` 上游：`base-url: http://127.0.0.1:<bridge 端口>/v1`，`prefix: workbuddy`（国际版为 `workbuddy-ai`），用 bridge 的内部密钥鉴权 |

模型 id 带前缀，比如 `opencode/big-pickle`、`workbuddy/glm-5.3`，避免和订阅模型重名。dsh 里只有一个 provider：`dsh-model`，它的模型清单由 `models sync` 写入。

### 1.3.1 WorkBuddy bridge

WorkBuddy 不是标准 API，是桌面 App 的私有接口。对照 dsh-workbuddy-connect 0.7.1（MIT）源码确认了下面这些事实：

- **凭据**：macOS 上是 `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`（国际版另有路径）。从 WorkBuddy 5.6 起，`accessToken` / `refreshToken` **加密存储**。
  - 解密需要先**以 `ELECTRON_RUN_AS_NODE=1` 运行 WorkBuddy 自己的 Electron 二进制**，经它的私有绑定 `workbuddyStorage` 取出 `atRestSecretKey`；
  - 再用 `sha256(secret)` 作 AES-256-GCM 的密钥，AAD 照搬 App 的 `buildAuthenticatedContextAad`。
- **请求**：发到 `{base}/v2/chat/completions`（OpenAI 形态），必须带官方客户端那套请求头（`X-IDE-Type: WorkBuddy`、`X-IDE-Version`、按 App 版本拼的 User-Agent、`X-User-Id` / `X-Enterprise-Id` / `X-Domain`，或对应的 `X-No-*`）。
- **刷新**：`/v2/plugin/auth/token/refresh`，带 `X-Refresh-Token`。刷新结果**只存 dsh-model 自己的副本**，**从不改写** App 的凭据文件。
- **模型目录**：`/v3/config`，目录内容随 User-Agent 区分。

bridge 的职责只有一件：把"WorkBuddy 私有接口 + App 登录态"变成本机 OpenAI 兼容接口。
- 只绑 `127.0.0.1`，要求内部密钥；
- 支持流式输出和工具调用透传，上游中断时补发 `[DONE]`；
- 401/402/429 按类别映射；
- 发现会话失效时提示"请在 WorkBuddy App 里重新登录"；
- 目录变化时由 dsh-model 重写引擎配置（引擎热重载），再同步到 dsh。

**代码来源（已定）**：凭据解密、请求头身份、刷新这三块是 dsh-workbuddy-connect 逆向出来的协议细节。方案是**按 MIT 协议移植**这部分到 `src/bridge/workbuddy/`，保留版权声明并锁定来源 commit；bridge 的服务端、生命周期、目录同步、接线都由我们自己写。另一个选项是不看它、完全重写，但结果只会一样，还更容易出错。

**限制与风险**：
- **Mac**：读 WorkBuddy / WorkBuddy AI 桌面 App 的登录态（已实现）；也可以用下面的 `workbuddy login`。
- **任何平台，含 Linux / VPS：`dsh-model workbuddy login [cn|ai]`**（v0.4.0）。dsh-model 自己走 WorkBuddy 内置 CLI 的 `cli-external-link` 登录流程，所以服务器上不需要 App，也不需要 CodeBuddy CLI。2026-10-09 对照真实服务端确认的细节：
  - `POST {base}/v2/plugin/auth/state?platform=<p>`，带 `X-No-Authorization/User-Id/Enterprise-Id/Department-Info: true`，返回 `{code:0,data:{state,authUrl}}`。国内版是 `https://www.workbuddy.cn` + `workbuddy`，国际版是 `https://www.workbuddy.ai` + `workbuddy-ai`（取自 App 内置 CLI 的 product.json）。
  - 用户在**任意设备**的浏览器打开 `authUrl` 授权，没有本地回调。
  - 轮询 `GET /v2/plugin/auth/token?state=`：授权前返回 `code 11217 "login ing..."`，授权后 `data` 里是令牌。
  - 再调 `GET /v2/plugin/login/account?state=`（带 Bearer）拿 uid、企业、昵称，这几项决定请求头。
  - 令牌按移植凭据库的自有副本格式写入 `$DSH_MODEL_HOME/workbuddy/<ownFilename>`（0600，vps 模式下归 dsh 用户）。bridge 直接使用；刷新照旧走移植的逻辑。
  - 非 macOS 平台上 bridge 不读桌面凭据：CodeBuddy CLI 在 Linux 上也是加密存储，密钥来源未知，而有了自己的登录也就不需要它。
  - 网络请求用 curl，认 `-x` 代理；国内版域名强制直连。
- 注意：npm 上的 `@workbuddy/cli` 与腾讯 WorkBuddy **无关**。它对接 `*.workbuddy.com` 租户的 OAuth2 client_credentials，同名而已。
- 会读取并解密另一个 App 的登录凭据，并以它的客户端身份发请求：这是在绕开 WorkBuddy 自己的凭据保护，可能违反其服务条款，账号存在风险。
- WorkBuddy 改了加密方式、AAD 或请求头校验，bridge 就会失效，需要跟进。
- **默认启用**（已定）：setup 检测到 App 就启用，第一次启用时打印一次风险说明，不需要 `--accept-risk`。

### 1.3.2 OpenCode Zen

- 实测发现：不带 key 和带无效 key，返回的都是 403 `FreeTierError`；`/zen/v1/models` 是公开的，验证不了 key。
- 所以写入前先用这把 key 向一个免费模型发 1 token 请求，**返回 200 才写入**。
- **待你的 key 实测**：有效 key 能否从第三方调用免费档。如果不能，就只有付费模型（需要 Zen 余额）能用。

### 1.3.3 运行形态的变化

- 常驻进程从一个变成两个：引擎（launchd `com.dsh-model.engine`）和 bridge（`com.dsh-model.bridge`，仅在检测到 WorkBuddy App 时注册）。两者都只绑回环地址。
- `setup` 默认安装引擎（OpenCode 也要走引擎），并接入 OpenCode Zen 和 WorkBuddy；订阅上游照旧用 `login`。
- dsh 插件版 WorkBuddy 的界面能力（积分卡片、徽章、模型显隐）不再提供，改由 `dsh-model status` 显示账号和积分。

## 2. 架构

```
┌──────────────────────────── 本机 ────────────────────────────┐
│                                                              │
│  dsh ─┐                                                      │
│  编辑器┼── Bearer <key> ──> 引擎 127.0.0.1:8317/v1（唯一入口） │
│  脚本 ─┘                     │                               │
│                ┌─────────────┼──────────────────┐            │
│                ▼             ▼                  ▼            │
│        订阅 OAuth       openai-compat       openai-compat     │
│      (Codex/Grok/…)    opencode/*  ──>     workbuddy/*        │
│                        opencode.ai/zen      │                 │
│                                             ▼                 │
│                              bridge 127.0.0.1:<端口>（内部密钥）│
│                              读 WorkBuddy App 登录态 → 私有接口 │
│                                                              │
│  dsh-model CLI（非常驻）：生成引擎配置 · 管理两个服务 ·        │
│    写/还原 dsh 配置 · 登录引导 · 目录同步 · 诊断 · 卸载        │
└──────────────────────────────────────────────────────────────┘
```

关键决策：

1. **对外只有一个入口**：所有模型都经引擎的 `127.0.0.1:8317/v1`，统一用 key 鉴权。bridge 不对外，只接受引擎带内部密钥的请求。
2. **引擎和 bridge 只绑 `127.0.0.1`，任何场景都不例外**。远程访问通过 SSH 隧道、Tailscale 或 Caddy 进入（见 §7）。
3. **端点强制 API key**。浏览器跨站请求和 DNS rebinding 拿不到 key，自然失败（见 §5）。

---

## 3. 上游

只接入锁定版本引擎支持登录的 **OAuth 订阅类**上游。每个上游最多一个账号。账号数量由 dsh-model 自己保证：引擎对同一上游的多份凭据会轮询使用。

| 上游 | 引擎登录参数 | 登录方式 | 默认 |
|---|---|---|---|
| codex（ChatGPT 订阅） | `-codex-login` / `-codex-device-login` | 回调端口 1455，或 device-code | 可直接 `login` |
| kimi | `-kimi-login` | device-code | 可直接 `login` |
| xai（Grok） | `-xai-login` | device-code | 可直接 `login` |
| meta（Muse） | `-meta-login` | device-code | 可直接 `login` |
| claude（Pro/Max 订阅） | `-claude-login` | 回调端口 54545 | **需加 `--accept-risk`**：Anthropic 条款限定订阅凭据只能在官方客户端使用 |
| antigravity | `-antigravity-login` | 回调端口 51121 | **需加 `--accept-risk`** |

引擎**不支持** Gemini、Qwen、iFlow 的 OAuth 登录。这几家走官方 API key 的话，dsh 自带支持，dsh-model 不处理。

回调式登录在 15 秒后可以从 stdin 粘贴回调 URL，所以在 VPS 上即使不开 SSH 隧道也能完成登录。

---

## 4. 本地状态

所有状态集中放在 `$DSH_MODEL_HOME`（默认 `~/.dsh-model/`），目录权限 `0700`：

```
~/.dsh-model/
├── config.json              # dsh-model 自身配置（§4.1）
├── state.json               # 安装记录：服务管理器、端口、引擎版本、dsh 接线位置、生成过的文件清单
├── engine/
│   ├── versions/<ver>/cli-proxy-api
│   └── current -> versions/<ver>     # 升级和回滚只切这个软链
├── engine.yaml              # 由 config.json 生成，禁止手改（文件头写注释说明）
├── auth/                    # 引擎的 auth-dir（OAuth 凭据），0700，文件 0600
├── keys.json                # 客户端 key，0600（§5）
├── backups/                 # dsh 配置原件备份，按时间戳存放
├── logs/engine.log
└── .lock                    # dsh-model 命令的互斥锁，防止两个 setup 并发
```

`state.json` 是卸载和 repair 的唯一依据：**所有写到 home 之外的文件（plist/unit、dsh 配置块、Caddy 片段）都要登记在这里**，卸载时按清单逆序处理。

### 4.1 config.json

```jsonc
{
  "port": 8317,                       // 被占用时 setup 自动顺延并写回
  "engine": { "version": "x.y.z" },   // 锁定版本，只有 engine upgrade 会改
  "upstreams": {
    "codex":  { "enabled": true },
    "claude": { "enabled": false, "riskAcceptedAt": null }
  },
  "dsh": { "home": null, "providerId": "dsh-model" },  // null = 自动探测
  "remote": { "mode": "off" }         // off | ssh | tailscale | caddy
}
```

### 4.2 生成的 engine.yaml（v8 格式）

```yaml
# GENERATED BY dsh-model — DO NOT EDIT. Run `dsh-model setup` to regenerate.
config-version: 8
server: { host: "127.0.0.1", port: 8317 }
management: { allow-remote: false, secret-key: "", disable-control-panel: true }  # secret 留空 = 管理 API 关闭（404）
access: { api-keys: [<key-dsh>, <key-laptop>] }   # = keys.json 中所有未吊销的 key；为空时生成失败（空列表 = 引擎不鉴权）
oauth: { auth-dir: <home>/auth }
routing: { strategy: fill-first }
observability: { logs: { logging-to-file: true, logs-max-total-size-mb: 50, request-log: false } }
```

生成时先写临时文件，再原子 rename。引擎通过 fsnotify 热重载，改 key 不需要重启；只有改端口时才执行 `service restart`。

---

## 5. 鉴权

- `setup` 生成第一个 key `dsh`：32 字节随机数，base64url 编码，加 `dshm_` 前缀，存进 `keys.json`。
- 本人其他设备或工具各自领一个 key：`dsh-model key add <name>`；用 `key list` 查看，用 `key revoke <name>` 吊销，吊销后重新生成 engine.yaml。
- `key rotate dsh`：轮换 dsh 用的那把 key，同时改写 dsh 配置。
- **localhost 也不例外**：本机任何网页、任何进程没有 key 都调不了。
- 日志和 `status` 输出里的 key 只显示前缀加后 4 位。

---

## 6. dsh 接线（connect-dsh / disconnect-dsh）

### 6.1 写入内容

dsh 的 patch 条目的 `config` 是**整块替换**，provider 里也**没有内联 apiKey 字段**，运行时也**不会拉取模型列表**。因此要写两处：

```yaml
# $DSH_HOME/profiles/<desktop|web>/cordis.patch.yml —— 合并进已有的 llm-pi-ai 条目（不存在就新建），只占 providers.dsh-model 这一个键
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      dsh-model:
        displayName: dsh-model
        apiKeyEnv: DSH_MODEL_API_KEY       # 这里写的是引用名，不是 key 本身
        api: openai-completions
        baseURL: http://127.0.0.1:8317/v1
        models: [{ id: gpt-5, name: gpt-5 }, ...]   # 取 /v1/models 的快照；结果为空时整块 provider 不写（dsh 不接受空 models）
```

```yaml
# $DSH_HOME/.credentials.yaml（0600）
refs:
  DSH_MODEL_API_KEY: dshm_...
```

识别靠 provider 键 `dsh-model`，不靠注释标记，因为 Web UI 保存时可能会丢掉 config 里的注释。`login`/`logout` 之后会自动执行 `models sync` 刷新快照。

### 6.2 写入流程

1. 探测 `DSH_HOME`（环境变量 → 常见路径 → `config.json.dsh.home`），读取 dsh 版本，不在兼容区间就拒绝写入并提示 `--force`；
2. 原件备份到 `backups/<ts>/`，并在 `state.json` 记录原件的 sha256；
3. 已有 `providers.dsh-model` 就原地替换（保证幂等）；`llm-pi-ai` 条目不存在就新建，并记下 `createdLlmEntry`；credentials 里的 ref 已存在、但值不是我们的 key 时拒绝写入；patch 文件不存在、但有 `.bak-*` 文件（说明 dsh 处于崩溃恢复中）时也拒绝写入；
4. 写临时文件再原子 rename；
5. `--dry-run` 只打印 diff，不落盘。

### 6.3 还原流程

- 当前文件哈希 == 写入后记录的哈希：直接恢复备份原件（逐字节还原）；
- 不一致（用户在此期间改过）：只删除 `providers.dsh-model`，如果 `llm-pi-ai` 条目是我们新建的且已经空了，就删掉整个条目；patch 删空后写入 `[]`（空文件会让 dsh 启动失败）；credentials 只删除我们写的 ref。最后提示用户。

---

## 7. VPS 与远程访问

### 7.1 与 dsh-vps 同机（主场景）

```
浏览器 ─HTTPS─> Caddy ─> dsh-gate ─> dsh (127.0.0.1:3080) ─> 引擎 (127.0.0.1:8317)
```

dsh 走本机回环，引擎不暴露任何端口。dsh-vps 已经负责浏览器侧的 TLS 和登录，dsh-model 什么都不用加。

### 7.2 本人其他设备访问引擎：`dsh-model remote enable --via <mode>`

| 模式 | 做法 | 推荐度 |
|---|---|---|
| `ssh`（默认） | 不改服务端，只打印客户端要执行的 `ssh -N -L 8317:127.0.0.1:8317 <vps>` 和对应的 baseURL | 首选，零暴露 |
| `tailscale` | 用 `tailscale serve` 把 tailnet 内的 HTTPS 转到 127.0.0.1:8317，引擎仍然只绑回环 | 多设备常连时用 |
| `caddy` | 往 dsh-vps 的 Caddy 里加一个子域名片段（`dsh-model.<domain>` → 127.0.0.1:8317），复用它的 TLS，片段登记到 `state.json` | 只在前两种不可行时用 |

- 每台设备一把 key（`key add laptop`），设备丢了就 `key revoke`；
- `remote disable` 按 `state.json` 删掉生成过的片段，并 reload Caddy。

### 7.3 VPS 上登录（无浏览器）

- 支持 device-code 的上游：直接在 SSH 里完成；
- 只支持本地回调的上游：`dsh-model login <id>` 检测到没有 GUI 时，打印两条命令：本地终端执行的 `ssh -N -L <callbackPort>:127.0.0.1:<callbackPort> <vps>`，以及要在本地浏览器打开的授权 URL。回调经隧道落到 VPS 上的引擎；
- 也可以手动粘贴回调 URL：引擎等待 15 秒后会在 stdin 提示，用户在本地浏览器授权后，把跳转到的地址粘贴进来即可。
- 提示：账号的登录和日常使用尽量走同一个网络出口，避免频繁变换触发上游风控。

---

## 8. 引擎分发与升级

自用场景不发布分平台子包，引擎在 `setup` 时从 GitHub Release 下载：

- 仓库内维护 `engine-manifest.json`：`{ version, assets: { "darwin-arm64": { url, sha256 }, "linux-amd64": {...}, ... } }`；
- 下载 → **sha256 校验，不匹配直接失败** → 解压到 `engine/versions/<ver>/` → 切换 `current`；
- **不使用 npm postinstall**，`npm i -g` 只装 dsh-model 本身；
- 检测到本机已有 CLIProxyAPI 实例占用端口时，不复用也不接管，端口顺延并提示；
- `dsh-model engine upgrade [<ver>]`：显式升级，先在临时端口启动新版本跑一遍 `doctor --e2e`，通过后才切换 `current`；`engine rollback` 切回上一个版本。不做自动升级。
- 需要改引擎时，fork 到 `AIcivilization/CLIProxyAPI`，manifest 指向 fork 的 release，其余流程不变。
- 引擎是 MIT 协议，manifest 和 README 注明来源。

---

## 9. 系统服务

| 模式 | 机制 | 文件 |
|---|---|---|
| local / macOS | launchd 用户 agent，`KeepAlive` | `~/Library/LaunchAgents/com.dsh-model.engine.plist` |
| local / Linux | systemd user unit + linger | `~/.config/systemd/user/dsh-model-engine.service` |
| vps（检测到 `/opt/dsh-vps`） | systemd 系统 unit，`User=dsh` | `/etc/systemd/system/dsh-model-engine.service` |

- 服务执行 `engine/current/cli-proxy-api -config <绝对路径>/engine.yaml`。必须写绝对路径，因为引擎默认读工作目录下的配置。
- vps 模式要 `sudo dsh-model setup`：注册系统服务和修改 Caddy 都需要 root。引擎以 dsh 用户身份运行，home 在 `/home/dsh/.dsh-model`，dsh-model 写出的文件全部 chown 为 dsh:dsh。
- local/Linux 模式下，setup 会检查 linger，没开就提示用户执行 `sudo loginctl enable-linger $USER`。
- 命令：`service install|start|stop|restart|status|uninstall`。`status` 会比对 `state.json` 和服务实际状态，不一致时建议执行 `dsh-model repair`。

## 9.1 界面语言（中英双语）

dsh-model 的所有输出都提供中英两份文案，包括提示、报错、`status`/`doctor` 表格、风险说明和生成文件里的注释。

- 写法：`L('中文', 'English')`，两种文字写在一起，与 dsh-vps 的 i18n 用法一致；
- 语言选择优先级：`--lang zh|en` > 环境变量 `DSH_MODEL_LANG` > `LC_ALL`/`LC_MESSAGES`/`LANG` > `Intl` 区域设置 > 默认 `zh`；
- `--json` 输出里的字段名和错误码（`code`）是语言无关的稳定值，只有 `message` 跟随语言；
- 文档提供中文版和英文版：`README.md` + `README.en.md`。

---

## 10. 命令

| 命令 | 作用 |
|---|---|
| `setup` | 下载校验引擎 → 生成 key 和 engine.yaml → 注册并启动服务 → connect-dsh → 跑一遍 doctor。可重复执行（幂等） |
| `login <upstream> [--accept-risk]` | 引导登录；之后自动 `connect-dsh --refresh` |
| `logout <upstream>` | 删除 `auth/` 里该上游的凭据 |
| `connect-dsh [--dry-run] [--refresh]` / `disconnect-dsh` | §6 |
| `key add|list|revoke|rotate` | §5 |
| `remote enable --via ssh|tailscale|caddy` / `remote disable` | §7 |
| `engine upgrade|rollback|version` | §8 |
| `service ...` / `repair` | §9 |
| `status` | 引擎版本和运行状态、端口、已登录上游、可用模型数、dsh 接线状态、远程模式 |
| `doctor [--e2e] [--json]` | 静态检查（权限、端口、服务、dsh 配置哈希）；`--e2e` 对每个模型发一条最小请求，测流式输出和一次 tool_call |
| `uninstall [--keep-auth]` | 按 `state.json` 逆序执行：remote disable → disconnect-dsh → service uninstall → 删除 home。`auth/` 删除前二次确认 |

---

## 11. 技术选型与目录

- TypeScript，Node ≥ 20（用 `fetch` 和 `util.parseArgs`，不引入 CLI 框架）；
- 运行时依赖只有 `yaml`（读写 dsh 配置和 engine.yaml，需要能保留注释）；
- 测试用 Vitest：dsh 配置读写和还原的 fixture 测试是重点；另有引擎契约测试（锁定版本，跑真实二进制，不访问上游，只测 401、`/v1/models` 和配置热重载）。

```
dsh-model/
├── bin/dsh-model.js
├── engine-manifest.json
├── src/
│   ├── cli.ts                # 参数解析与分发
│   ├── commands/             # setup, login, connect, key, remote, engine, service, status, doctor, uninstall
│   ├── engine/               # 下载校验、版本切换、engine.yaml 生成、进程探测
│   ├── dsh/                  # DSH_HOME 探测、版本校验、managed block 读写、备份还原
│   ├── service/              # launchd.ts, systemd.ts
│   ├── remote/               # ssh.ts, tailscale.ts, caddy.ts
│   ├── upstreams.ts          # §3 映射表
│   ├── keys.ts
│   ├── state.ts              # state.json + .lock
│   └── util/                 # atomicWrite, sha256, redact, paths
└── tests/
    ├── fixtures/dsh/         # 各种 dsh 配置样本（空的、已有其他 provider、用户改过的）
    └── engine-contract/
```

---

## 12. 路线图

| 阶段 | 周期 | 内容 | 完成标准 |
|---|---|---|---|
| **M0 实测** | 已完成 | 见 M0-findings.md | — |
| **M1 本机** | 1 周 | setup / login / connect-dsh / key / service / status / doctor / uninstall（macOS） | G1、G2、G3、G5 |
| **M2 VPS** | 1 周 | Linux systemd、无 GUI 登录、remote 三种模式、engine upgrade/rollback | G4；完整走一遍 setup → uninstall，确认 VPS 上不留痕 |

---

## 13. 风险

| 风险 | 对策 |
|---|---|
| 订阅凭据在官方客户端之外使用，可能违反服务条款，有封号风险（Claude 最明显） | 仅限自用；Claude 默认关闭，需要 `--accept-risk`；不做多账号、不做配额规避；README 写明 |
| 引擎配置格式或行为变化 | 锁定版本加 sha256；升级前先跑 e2e；引擎配置只由 dsh-model 生成 |
| dsh 配置格式变化（预览期） | 校验版本区间；managed block 加哈希还原；fixture 测试 |
| 引擎项目停更或改协议 | fork 兜底（§8） |
| 本机凭据泄漏 | home 目录 0700、auth 和 keys 文件 0600；日志脱敏；不提供凭据导出功能 |

---

## 14. dsh 插件页（v0.6 计划，待确认）

用户要的只有两块，其余配置一律用默认值，不暴露给用户：

1. **来源开关**：列出可以接入的大模型 CLI 或 IDE，每个一个开关。打开就接入，还没登录就弹出登录；关闭就断开，模型从 dsh 消失，但登录保留，下次打开不用重新登录。
2. **本产品的 key**：OpenAI 格式。每把 key 显示状态：速度、稳定程度、最近错误。

界面做成 **dsh 插件页**，在 dsh「设置」里加一个「dsh-model」分区，写法照搬 dsh-vps-manager 的 `settings.section`。本机和 VPS 都在 dsh 里操作。

### 14.1 架构

```
浏览器（dsh 页面）──> dsh 插件宿主端 /api-dsh-model/*（在 dsh 自己的鉴权之后）
                         │  带控制密钥
                         ▼
                 dsh-model 守护进程（现在的 bridge 扩展而来，127.0.0.1）
                  ├─ 来源开关 / 登录：调引擎管理接口（OAuth）或自己的 WorkBuddy 登录
                  ├─ key 增删、统计：轮询引擎用量队列并累计
                  └─ 改写 engine.yaml（引擎热重载）与 dsh 的 provider（dsh 热加载）
                         │
                         ▼
                 引擎 127.0.0.1:8317/v1（统一端点，不变）
```

- 守护进程用的是 bridge 现有的常驻服务。所有操作都不需要 root：引擎配置和 dsh 配置在 VPS 模式下都归 dsh 用户，引擎也会热重载。
- 浏览器始终看不到任何密钥：控制密钥、管理密钥都只在宿主端和守护进程之间传递。
- 命令行（`dsh-model ...`）保留，能做的事情和页面一样。

### 14.2 来源与登录方式（服务器上不装任何 CLI）

| 来源 | 登录方式 | 用户要做的 |
|---|---|---|
| WorkBuddy / WorkBuddy AI | 自己的登录流程：链接 + 轮询（已实现） | 打开链接，授权 |
| Codex、Kimi、Grok（xAI）、Muse（Meta） | 引擎管理接口 `oauth/auth-url` 返回链接和 `user_code`，轮询 `oauth/status` | 打开链接，输码，授权 |
| Claude、Antigravity、Devin | 同上，但授权后浏览器会跳到一个本机回调地址 | 把那个打不开的地址粘贴回页面，由 `POST oauth/callback` 提交 |
| OpenCode Zen | 只能用 key | 粘贴 key，写入前实测 |

开关的含义：
- **打开**：已登录的话，启用凭据（引擎 `credentials/status`），WorkBuddy 让 bridge 服务这个产品，OpenCode 恢复它的 key；没登录就进入登录流程。
- **关闭**：只停用，不删登录。另有单独的「退出登录」按钮。
- 每家上游只登录一个账号，重新登录会替换旧账号。

### 14.3 key 状态

- 引擎打开用量统计（`usage-statistics-enabled`）。守护进程每 5 秒从管理接口取一次用量记录（引擎只保留 60 秒），按**客户端 key**、**来源**、**模型**累计，存到 `stats.json`，保留 1 小时和 24 小时两个统计窗口。
- 每把 key 显示：请求数、成功率、平均延迟、输出速度（output_tokens / 延迟）、最后使用时间、最近一次错误。
- 每个来源和模型显示：成功率、平均延迟、输出速度，方便挑模型。

### 14.4 安全上的变化

- **引擎管理接口改为打开**：只监听本机，`allow-remote: false`，网页控制台保持关闭。管理密钥是 32 字节随机值，存在 `$DSH_MODEL_HOME`（权限 0600），只有守护进程使用。原先的"管理接口完全关闭"作废。
- 守护进程的控制接口也只监听本机，并且要求控制密钥。插件宿主端只在 dsh 自己的鉴权之后转发请求：VPS 上 dsh 在 dsh-gate 登录之后，本机 Desktop 本来就是本人。

### 14.5 分发

dsh-model 这个包同时声明成 dsh bundle（`dsh.bundle.patch` + `./client` 导出），可以在 dsh 插件页通过 GitHub 链接安装，也可以执行 `dsh-model setup` 自动装进 dsh。命令行和插件是同一个包。

### 14.6 订阅用量（每个来源一行）

**放在哪**：放在「来源开关」列表里每个来源的那一行。行头是开关、来源名、账号、套餐；已登录且已打开的来源，下面展开显示用量：

```
[●] Codex        you@mail.com   Plus
    5 小时窗口 ███████░░░ 68%  · 2 小时 13 分后重置
    每周窗口   ███░░░░░░░ 31%  · 4 天后重置
[●] WorkBuddy    莫名            剩余 1,234 积分 · 本期 6 天后重置
[ ] Claude       未登录          [登录]
```

开关、账号和额度在同一处，一眼就能决定今天用哪家。key 的速度和稳定性单独放在「API key」区块（§14.3），两者不混在一起。

**怎么取**：参考 steipete 的 **CodexBar**（MIT，22k★，"Every AI coding limit, in your menu bar"），它用已有的登录凭据去调各家自己的额度接口。我们的情况更直接：引擎的 auth 目录和 bridge 的自有副本里本来就存着各来源的 OAuth 令牌，守护进程拿它们**主动查询**，每 5 分钟一次，打开页面时也会立即刷新一次。不必等到真有请求经过才知道额度。引擎自带的被动额度观测（只覆盖 claude / codex / devin，信息来自响应头）作为补充。

| 来源 | 额度接口（来自 CodexBar 文档） | 用现有令牌 | 显示内容 |
|---|---|---|---|
| Codex | `GET chatgpt.com/backend-api/wham/usage` | ✓ 引擎的 Codex 令牌 | 5 小时 / 每周窗口百分比、重置时间、credits |
| Claude | `GET api.anthropic.com/api/oauth/usage` | ✓ 引擎的 Claude 令牌 | 5 小时 / 每周窗口百分比 |
| Kimi | `GET api.kimi.com/coding/v1/usages` | 待实测 | 每周额度 + 5 小时限额 |
| Grok | `cli-chat-proxy.grok.com/v1/billing?format=credits` | 待实测 | credits |
| Antigravity | `POST cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` | 待实测 | 按模型的额度 |
| Devin | `GET app.devin.ai/api/<org>/billing/quota/usage` | 待实测 | 每日 / 每周额度 |
| WorkBuddy / WorkBuddy AI | 移植来的 `fetchCredits` | ✓ | 剩余积分、本期重置时间 |
| OpenCode Zen | 只有浏览器 cookie 能查，API key 查不了 | ✗ | 显示"暂不支持" |
| Muse（Meta） | CodexBar 也不支持 | ✗ | 显示"暂不支持" |

每一家的请求头和返回字段，照 CodexBar 对应的 `docs/<provider>.md` 和源码实现，代码里注明来源。查询失败时只在那一行显示"用量暂不可用"，不影响开关和模型。

### 14.7 费用标签（2026-10 核实）

dsh-model 只是转接口，不产出额度：一个来源能不能用，取决于你在那家有没有可用的套餐。管理页每个来源名后面标「免费 / 免费·额度少 / 需付费」，未登录时下面一行写明要什么、附开通链接；`dsh-model sources` 同样多一列「费用」。数据写在 `src/sources.ts` 的 `pricing`。

| 来源 | 标签 | 说明 |
|---|---|---|
| WorkBuddy / WorkBuddy AI | 免费 | 账号自带免费积分 |
| Devin | 免费·额度少 | 有 Free 档，额度很少；Pro $20/月 |
| Antigravity | 免费·额度少 | Google 账号有免费额度（高风险，默认隐藏） |
| OpenCode Zen | 需付费 | 充值拿 key 按量计费；免费模型实测只能在 OpenCode 软件里用（API 返回 FreeTierError） |
| Codex | 需付费 | ChatGPT Plus / Pro |
| Kimi | 需付费 | Kimi Code 套餐；普通账号实测 403 |
| Grok | 需付费 | SuperGrok / X Premium+ |
| Muse | 需付费 | Muse Code 套餐（$5/月起） |
| Claude | 需付费 | Pro / Max（高风险，默认隐藏） |
