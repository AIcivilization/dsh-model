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

## 1.3 默认模型（v2.1，2026-10-08）

`setup` 默认只在 dsh 里接入两样东西，不安装订阅引擎：

| 来源 | 做法 | 写入 dsh 的内容 |
|---|---|---|
| OpenCode Zen | 用户提供的 API key。先用一个免费模型发 1 token 请求实测，通过才写入。实测发现：无 key 和无效 key 都返回 403 FreeTierError，模型列表接口是公开的，验不了 key | `refs.OPENCODE_API_KEY` + `providers.opencode: {apiKeyEnv}`（启用 pi-ai 内置路由，不写 api/baseURL/models） |
| WorkBuddy | 检测到 WorkBuddy / WorkBuddy AI 桌面 App 时，通过 `dsh plugin --profile <p> add dsh-workbuddy-connect@0.7.1` 安装。dsh 会自己做兼容检查并登记 bundle | profile 的 package.json 依赖与 `dsh.profile.bundles`（由 dsh 插件管理写入） |

- 不选 dsh-connect-workbuddy：它带多账号池、自动换号签到，不符合单账号原则。
- dsh 自带的 pnpm 11 会把被拦下的依赖构建脚本当成安装失败。涉及的 `@google/genai` preinstall 是 no-op，`protobufjs` postinstall 只打印版本提醒，所以安装时加 `--config.strict-dep-builds=false`：不执行这些脚本，也不判失败。安装失败时，回滚半装状态。
- 已有的配置（用户自己配的 OpenCode、自己装的插件）一律不动，也不在卸载时移除。dsh-model 只移除台账里自己拥有的项（`state.dsh.ownedProviders/ownedRefs`、`state.plugins[].installedByUs`）。
- 订阅引擎改为按需安装：第一次 `login` 时安装，或执行 `setup --engine`。

## 2. 架构

```
┌──────────────────────── 本机 / VPS ────────────────────────┐
│                                                            │
│  dsh Web UI ──┐                                            │
│  编辑器/脚本 ──┼── Bearer <key> ──> 127.0.0.1:8317/v1       │
│               │                        │                   │
│               │              ┌─────────▼──────────┐        │
│               │              │ CLIProxyAPI 引擎    │        │
│               │              │ (Go 单二进制，锁定版本)│       │
│               │              │ 由 launchd/systemd 守护│     │
│               │              └─────────┬──────────┘        │
│               │                        │ 上游 OAuth         │
│  dsh-model CLI（Node，非常驻）          ▼                   │
│   · 生成引擎配置  · 写/还原 dsh 配置    Codex / Grok / ...  │
│   · 下载校验引擎  · 注册系统服务                             │
│   · 登录引导      · 诊断                                    │
└────────────────────────────────────────────────────────────┘
```

关键决策：

1. **dsh-model 不常驻**。常驻进程只有引擎本身，由系统服务直接拉起。dsh-model 只是一个配置编排 CLI，跑完就退出，因此没有内存预算、进程池这类问题。
2. **引擎只绑 `127.0.0.1`，任何场景都不例外**。远程访问通过 SSH 隧道、Tailscale 或 Caddy 进入（见 §7），引擎自己永远不监听公网。
3. **端点强制 API key**。浏览器跨站请求和 DNS rebinding 拿不到 key，自然失败，所以不需要额外写一层 Host/Origin 校验代理（见 §5）。

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
