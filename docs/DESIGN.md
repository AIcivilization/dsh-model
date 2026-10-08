# dsh-model 设计文档（原：opencodex 拆解与本地模型网关设计）

> 目标产品 **dsh-model**（npm 包名 `dsh-model`，CLI 命令同名，2026-10-08 核名可用），最终路线（v2 决策，见第十章）：
> **以 CLIProxyAPI 为核心引擎，dsh-model 做 dsh 原生的薄集成层**——安装编排、已装/未装探测、connect-dsh 接线、海外 VPS 中继模式产品化、国内组模型配置；把本机（或 VPS）的 Codex、Claude Code、Grok Build、Muse、Gemini、Kimi 等 OAuth 订阅额度，变成 **OpenAI Chat Completions 兼容的本地 API**，供 DeepSeek Harness（dsh）及任意本地软件直接调用。首发 macOS / Linux(VPS)，Windows 延后。
>
> 注：第四章的自研网关设计（headless 进程封装路线）保留为**备选存档**——生态证据（CLIProxyAPI 与 dsh 头部插件全部收敛于 OAuth 直连）表明该路线维护成本高，仅当 CLIProxyAPI 出现不可用问题时启用。

---

## 一、opencodex 产品拆解

### 1.1 定位与核心价值

opencodex（`@bitkyc08/opencodex`，TypeScript + Bun）是一个本地代理："make codex open!"。它把 OpenAI Codex 的 Responses API 翻译成各家模型提供商的协议，让 Codex、Claude Code、Claude Desktop、Grok Build 四大客户端可以使用任意 LLM（40+ provider），并附加 ChatGPT 账号池管理。

它的本质是**双向协议网关**：

- **客户端侧**：暴露 Responses API（给 Codex）/ 接管 Claude Code、Claude Desktop、Grok Build 的模型调用（配置注入，把客户端的 API 指向本地代理）；
- **上游侧**：把请求翻译成 Anthropic Messages、Gemini 原生、OpenAI 兼容 Chat Completions 等协议，附带凭据管理。

### 1.2 关键机制

| 机制 | 实现方式 |
|---|---|
| 协议翻译 | 双向支持流式输出（SSE）、工具调用（tool calls）、推理 token（reasoning）、图像输入 |
| 配置接管/还原 | `ocx init` 改写客户端配置指向代理；`ocx stop` 恢复原始配置（干净卸载） |
| 账号池 | 线程亲和、配额感知切换（5h/周/30d 窗口）、轮询/填满优先、冷却与熔断 |
| Combos | 一个虚拟模型 ID 跨 provider 故障转移或加权轮询 |
| 服务化 | launchd / systemd / 任务计划；`codex-shim` 按需启动无守护进程 |
| 运维面 | `GET /healthz`、`GET /readyz` 健康检查；Web 仪表盘；`provider/model` 路由语法 |
| 资源治理 | 所有长生命周期缓存/环形缓冲设上限，默认 256 MiB 内存预算 |
| 安全 | 默认只绑 `127.0.0.1`；绑 `0.0.0.0` 强制要求 API token |

### 1.3 模块价值评估（针对 dsh-model 场景）

| opencodex 模块 | 对 dsh-model 的价值 | 结论 |
|---|---|---|
| 协议翻译核心（流式+工具调用+reasoning 透传） | ★★★★★ 网关的立身之本 | **采纳** |
| 登录态/凭据复用（让订阅额度变成 API 可用） | ★★★★★ dsh-model 的核心差异化 | **采纳（单账号形态）** |
| `provider/model` 路由 + 健康检查端点 | ★★★★ 成本低、收益直接 | **采纳** |
| 配置接管 + 干净还原 | ★★★★ dsh 对接与卸载体验 | **采纳** |
| 有界内存管理 | ★★★ 长驻服务的工程底线 | **采纳** |
| 已装检测/状态展示（仪表盘的检测部分） | ★★★★ 契合"已装+未装引导"需求 | **采纳（简化为状态页/CLI 输出）** |
| ChatGPT 账号池（多账号、配额感知切换） | ★ 合规风险大、复杂度高 | **裁剪**（明确不做多账号） |
| Combos / 子代理 / JEV 自动路由 | ★★ dsh 自身已有模型路由 | **裁剪**（仅保留极简失败切换） |
| Web 搜索 & 视觉 sidecar | ★ 锦上添花 | **裁剪** |
| Web 仪表盘（完整版）/ 桌面应用 / WidgetKit | ★ 非核心 | **裁剪**（用 JSON 状态页替代） |
| Docker / 40+ 内置 provider | ★ 与"本地 CLI 上游"定位无关 | **裁剪** |

---

## 二、dsh-model 产品定义

### 2.0 产品命名（2026-10-08 核名定案）

**定名 `dsh-model`**。npm 占用核查结果（registry.npmjs.org，2026-10-08）：

| 名称 | 状态 | 备注 |
|---|---|---|
| **dsh-model** | ✅ 可用（404） | **定名**：最短、语义直白（"dsh 的模型"），CLI 命令 `dsh-model setup/connect-dsh` 顺口 |
| dsh-llm-api | ✅ 可用（404） | 备选；"llm" 的用户搜索量远低于 "model" |
| dsh-model-api / dsh-modelapi / dsh-llmhub | ✅ 可用 | 深备选 |
| dsh-models | ❌ 已占用 | 0.0.1 占位包（"name reserved"，2026-08） |
| dsh-model-gateway / dsh-llm-gateway | ❌ 已占用 | 均为占位包，后者 2026-10-07 刚蹲坑——赛道命名抢注活跃 |
| dsh-gateway / dsh-free-model / dsh-model-router | ❌ 已占用 | 已有实际产品 |

**行动项：建仓后第一时间 `npm publish` 占位（0.0.1 + README）**。**GitHub 仓库同名 `dsh-model`**（用户补充：将新建仓库）。

**搜索关键词调研结论**（源自 dsh-our-free-model 的爆火路径——发布 2 天日增 1100 星）：
- 用户心智词汇集中在：中文「dsh 免费模型」「dsh 插件 推荐」「无需 API key」「免登录」「白嫖大模型」；英文 "free model" / "no api key" / "model provider"；
- 核心情绪词是**"免费"与"无需"**——README 首句应直接写"无需 API key，装上就能用前沿模型"，把传播钩子前置（学 dsh-our-free-model 的 "no login, no sign-up, no API key" 句式）。

### 2.1 一句话定位

**"把你的 CLI 订阅变成 localhost 的 OpenAI 兼容 API。"**

### 2.2 用户故事

1. 我装了 Claude Code（Pro/Max 订阅）和 Codex（ChatGPT 订阅），希望在 dsh 的 Web UI 里直接选 `claude-code/claude-sonnet`、`codex/gpt-5` 这类模型，不用再买 API key；
2. 我在国内，没有 OpenAI/Anthropic 账号也没有国际信用卡：装 Qwen Code / iFlow CLI / Kimi CLI，登录即用，dsh 里照样有模型可选；
3. **海外中继（核心场景三）**：我有一台海外 VPS，网络畅通——在 VPS 上装 dsh-model 并登录 Codex/Claude 等 CLI，国内这边连 VPS 没问题，VPS 连各家大模型也没问题。于是这台 VPS 成了我在国内使用 Claude/GPT 的媒介：国内任何软件把 API 地址指向 VPS 上的 dsh-model 即可（`http(s)://<vps>:8317/v1` + token），无需任何国内侧代理；
4. 任意本地软件（编辑器插件、脚本、其他 Agent 框架）只要支持“自定义 OpenAI endpoint”，填 dsh-model 地址即可用上这些模型；
5. `dsh-model status` 一条命令看到：哪些 CLI 已装且已登录、哪些没装（附安装命令）、当前可用模型列表——在 mac 与 VPS 上行为一致。

### 2.3 设计原则

- **上游分两组、总量封顶**：
  - **国际组**：OpenAI Codex、Claude Code、Claude Desktop、Grok Build、Muse Code；
  - **国内组**：opencode、Qwen Code、iFlow CLI（心流）、Kimi CLI——解决国内无法直连 OpenAI/Anthropic、也缺国际支付手段的现实问题，登录即用、国内直连；
  - 只做这两组 CLI 上游，不做通用 provider 聚合；
- **单账号、单用户**：不做账号池，规避合规红线；
- **上游优先走 CLI 的官方 headless 接口**（进程封装），而不是逆向私有 API；
- **对下游只暴露一套协议**：OpenAI Chat Completions（`/v1/chat/completions` + `/v1/models`）；
- **首发两平台**：macOS / Linux(VPS)；Windows 延后（Muse Code 等上游不支持原生 Windows，需要 WSL2，产品价值打折扣，等上游生态补齐再做）。

---

## 三、系统架构

### 3.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                   本机 (localhost) / VPS                      │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   消费方           │
│  │ dsh WebUI│  │编辑器插件 │  │脚本/Agent│ ←── 任何支持       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘    OpenAI 兼容     │
│       │    OpenAI Chat Completions (SSE)     endpoint 的软件  │
│       └─────────────┼──────────────┘                          │
│                     ▼                                        │
│  ┌──────────────────────────────────────────────┐            │
│  │              dsh-model 网关 (Node.js, 127.0.0.1)     │            │
│  │  ┌────────────┐  ┌────────────────────────┐  │            │
│  │  │ /v1/models │  │ /v1/chat/completions   │  │            │
│  │  │ /healthz   │  │ /status (JSON 状态页)   │  │            │
│  │  └────────────┘  └────────────────────────┘  │            │
│  │  ┌────────────────────────────────────────┐  │            │
│  │  │ Router：模型名→上游；失败切换；并发闸门  │  │            │
│  │  └────────────────────────────────────────┘  │            │
│  │  ┌────────────────────────────────────────┐  │            │
│  │  │ Adapter 层（进程封装 + 协议翻译）        │  │            │
│  │  │  ├─ 国际组: claude-code / codex /       │  │            │
│  │  │  │   grok-build / muse-code /           │  │            │
│  │  │  │   claude-desktop                     │  │            │
│  │  │  └─ 国内组: opencode / qwen-code /      │  │            │
│  │  │          iflow / kimi-cli               │  │            │
│  │  └────────────────────────────────────────┘  │            │
│  │  ┌────────────────────────────────────────┐  │            │
│  │  │ Detector：CLI 已装/未装/登录态探测        │  │            │
│  │  │ Installer Guide：安装命令生成与引导       │  │            │
│  │  └────────────────────────────────────────┘  │            │
│  └──────────────────────┬───────────────────────┘            │
│                         ▼  子进程 (headless)                  │
│    国际组：Claude Code · Codex · Grok Build · Muse Code · Claude Desktop
│    国内组：opencode · Qwen Code · iFlow CLI · Kimi CLI
└─────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 职责 | 借鉴自 opencodex |
|---|---|---|
| **Server** | OpenAI 兼容端点、SSE 流式、CORS、可选 token 鉴权 | 协议层设计、healthz/readyz |
| **Router** | `provider/model` 解析、默认模型、极简失败切换、每上游并发闸门 | 路由语法、熔断思路 |
| **Adapter 层** | 每个 CLI 一个适配器：管理子进程生命周期、消息格式↔CLI 输入输出翻译、工具调用映射 | 协议翻译的双向流式实现经验 |
| **Detector** | 探测 CLI 安装（which/npm -g）、登录态（`~/.codex/auth.json`、`~/.claude/` 等配置目录）、订阅状态 | 仪表盘的探测能力 |
| **Installer Guide** | 未装 CLI 时输出平台对应安装命令，可 `dsh-model install claude-code` 一键安装 | `ocx init` 的引导式体验 |
| **Config** | 单一配置文件 `~/.dsh-model/config.json`；`dsh-model stop/uninstall` 干净还原 dsh 配置 | 干净卸载设计 |

---

## 四、关键技术设计

### 4.1 上游适配器（核心难点）

**方案：进程封装（headless 子进程），不逆向私有 API。**

各家 CLI 均提供官方或事实标准的无头模式（已验证可用）：

| 上游 | 无头接口 | 形态 | 优先级 |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --input-format stream-json` | 支持流式输入输出、工具调用、system prompt 注入，官方文档化的 headless 模式 | **P0** |
| OpenAI Codex | `codex exec --json` | JSON 事件流输出，非交互执行 | **P0** |
| Grok Build | xAI 侧 CLI 较新，接口需在 M0 阶段实测（很可能同样有 exec/json 模式） | 待调研 | **P1** |
| Claude Desktop | 无 headless 接口；桌面应用形态。可行路径有限（复用其凭据直连 API 属灰色地带），先不承诺；无 GUI 的 VPS 上自动禁用 | 实验性 | **P2** |
| opencode | `opencode run "<prompt>"` | 开源多 provider agent，非交互单次执行 + JSON 输出（已验证），自带 provider 配置体系，国内可直连其支持的国内 provider | **P0**（国内组首选） |
| Qwen Code | `qwen -p`（Gemini CLI 系） | 阿里官方 CLI，官方文档化的 headless 模式（已验证），支持 Qwen OAuth 免费登录或 DashScope API key，国内直连 | **P0** |
| iFlow CLI（心流） | `iflow` | 心流官方 CLI，登录即用；headless 输出格式待 M0 实测 | 待验证 | **P1** |
| Kimi CLI | `kimi` | Moonshot 官方 CLI，支持登录态；headless 输出格式待 M0 实测 | 待验证 | **P1** |
| Muse Code（Meta） | `muse exec --json` | Meta 官方终端智能体（Rust 二进制，`dev.meta.ai/install.sh` 安装，**无 npm 包**）；`muse exec --json` 输出 JSONL 事件流（已验证文档化）；`muse login` 走 OAuth device-code（SSH/VPS 友好），或 `META_API_KEY`；默认模型 `muse-spark-1.2`（1M 上下文）。**限制**：仅 macOS/Linux，Windows 需 WSL2；`--disable-write --disable-shell` 只读模式适合网关代理 | 接口已验证 | **P1** |

**适配器公共契约**（所有适配器实现同一接口）：

```ts
interface UpstreamAdapter {
  id: string;                        // "claude-code" | "codex" | ...
  detect(): Promise<DetectResult>;   // installed / loggedIn / subscriptionHint
  listModels(): Promise<ModelInfo[]>;
  // 把 OpenAI ChatCompletionRequest 翻译为 CLI 调用，
  // 以 AsyncGenerator<OpenAIChunk> 形式回吐（已归一化为 OpenAI 格式）
  chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<Chunk>;
}
```

**进程与会话管理要点：**

- **进程池 + 复用**：对支持会话续接的 CLI（如 Claude Code 的 session resume），同一对话的后续请求路由到同一子进程，避免重复冷启动与上下文重建；
- **并发闸门**：订阅本身有并发/速率限制（如 Claude Max 的同时会话数），每适配器设并发上限，超限请求排队而非打爆上游；
- **超时与清理**：空闲进程 N 分钟后回收；每请求 wall-clock 超时 + `AbortSignal` 全链路传递；僵尸进程检测；
- **版本兼容矩阵**：CLI headless 输出格式无稳定性承诺，适配器声明 `compatibleRange`，启动时读取 CLI 版本并告警。

**翻译层（OpenAI ↔ CLI）关键映射：**

| OpenAI 侧 | CLI 侧处理 |
|---|---|
| `messages[].role: system/developer` | 映射为 CLI 的 system prompt / `--append-system-prompt` |
| `tools` / `tool_calls` | 透传 JSON Schema；CLI 的工具调用事件反向归一化为 OpenAI `tool_calls` chunk |
| `stream: true` | SSE：CLI 的 JSON 事件流 → `chat.completion.chunk` 帧 |
| `reasoning_effort` | 映射为各家思考强度参数（不支持的忽略并在响应元数据标注） |
| `max_tokens` / `temperature` | 能映射则映射，否则忽略并记录 |
| `usage` | 从 CLI 事件中的 token 统计回填；缺失时估算并标注 `estimated: true` |

### 4.2 OpenAI 兼容服务层

```
GET  /v1/models                # 汇总所有可用上游的模型（含 provider 前缀）
POST /v1/chat/completions      # SSE 流式 / 非流式
GET  /healthz                  # 存活（即时）
GET  /readyz                   # 至少一个上游就绪（供 dsh/监控探活）
GET  /status                   # JSON：各 CLI 安装/登录状态、并发占用、近 N 次请求摘要
```

- 默认绑定 `127.0.0.1:8317`（可配）；**默认无鉴权**（仅本机），显式配置 `0.0.0.0` 时强制要求 token（照搬 opencodex 的安全策略）；
- `/v1/models` 直接服务 dsh 的"获取可用模型"功能（dsh 会调用 OpenAI 兼容的 `GET /models` 自动列出模型，免手动录入）；
- 模型 ID 规范：`claude-code/claude-sonnet-4.5`、`codex/gpt-5.2-codex`，省略前缀时按模型名自动匹配唯一上游。

### 4.3 路由与降级（刻意做薄）

- 显式指定：`model = "claude-code/claude-opus-4"`；
- 自动匹配：`model = "gpt-5"` → codex；`"claude-*"` → claude-code；
- **极简失败切换**：仅当请求前的健康检查显示首选上游不可用（未登录/进程崩溃/并发满）时，降级到配置的 `fallback` 链（默认关闭）。不做加权轮询、不做 Combos——dsh 自身的模型路由已覆盖高级场景，dsh-model 不重复造轮子。

### 4.4 检测与安装引导

**Detector 探测项：**

| 探测 | 方法 |
|---|---|
| 是否安装 | `which claude` / `which codex`；npm 全局列表兜底；记录版本号 |
| 是否登录 | 存在性检查 `~/.claude/.credentials.json`、`~/.codex/auth.json`、`~/.opencode/`、`~/.qwen/`、`~/.iflow/`、`~/.kimi/`、`~/.config/muse/auth.json` 等（只判断存在与基本结构，**不解析、不外传 token 内容**） |
| 可用性 | 健康检查时以 1 token 级别的极小请求实测（低频、可关） |

**Installer Guide：**

- `dsh-model status` 对未安装项输出对应平台安装命令（如 `npm install -g @anthropic-ai/claude-code`、`npm install -g @openai/codex` 或 brew 等），并提示登录步骤；
- `dsh-model install <cli>` 封装执行 + 登录引导（登录态涉及 OAuth 浏览器流程，只引导不代填）；
- Claude Desktop 无 CLI 安装路径，检测到 .app 存在即显示"检测到，支持等级：实验性"。

### 4.5 与 dsh 的集成

**方式 A（MVP，零 dsh 侧改动）——自定义模型 API：**

dsh 原生支持自定义 OpenAI 兼容提供商，`dsh-model connect-dsh` 一条命令写入配置（借鉴 `ocx init` 的接线体验）：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: llm-pi-ai
  config:
    providers:
      dsh-model-local:
        api: openai-completions
        baseURL: http://127.0.0.1:8317/v1
        models:
          - id: claude-code/claude-sonnet-4.5
          - id: codex/gpt-5.2-codex
```

- 不设 `apiKeyEnv` 或用占位值（dsh-model 本机不鉴权）；
- dsh 侧"获取可用模型"按钮会调 dsh-model 的 `/v1/models` 自动填充；
- `dsh-model disconnect-dsh` / `dsh-model uninstall` 负责干净还原（对应 opencodex 的 clean uninstall）。

**方式 B（进阶）——dsh 插件化：**

dsh 是 everything-is-a-plugin 架构，LLM 接入本身有插件位（`dsh-llm-*`）。远期可将 dsh-model 打包为 dsh 插件（`dsh-plugin` topic），实现"装插件即得本地 CLI 模型"。但 dsh 处于开发者预览期、明确会有破坏性变更，**插件化放在 M3 之后评估**，避免被上游 API 变动拖着走。

### 4.6 配置与运行形态

```jsonc
// ~/.dsh-model/config.json
{
  "bind": "127.0.0.1",              // 中继模式改为 "0.0.0.0"（强制要求 apiToken）
  "port": 8317,
  "apiToken": null,                 // bind 非 127.0.0.1 时必须设置（`dsh-model relay enable` 自动生成）,
  "upstreams": {
    "claude-code": { "enabled": true, "maxConcurrency": 3, "sessionReuse": true },
    "codex":       { "enabled": true, "maxConcurrency": 2 },
    "opencode":    { "enabled": true, "maxConcurrency": 2 },
    "qwen-code":   { "enabled": true, "maxConcurrency": 2 },
    "grok-build":  { "enabled": false },
    "muse-code":   { "enabled": false, "readOnlyDefault": true },
    "iflow":       { "enabled": false },
    "kimi-cli":    { "enabled": false },
    "claude-desktop": { "enabled": false }
  },
  "defaultModel": "claude-code/claude-sonnet-4.5",
  "fallbackChain": [],              // 默认关闭
  "limits": {
    "memoryBudgetMB": 128,          // 日志环形缓冲等有界资源（借鉴 opencodex）
    "idleProcessTTLSeconds": 300,
    "requestTimeoutSeconds": 600
  }
}
```

- 运行形态：`dsh-model start`（前台）/ `dsh-model service`（launchd/systemd 用户级服务，实现思路同 opencodex，但只覆盖三平台的原生服务注册，不引入 WinSW 等额外依赖）；
- 按需启动（可选）：像 `codex-shim` 一样监听端口、首请求时拉起进程，降低常驻开销。

### 4.7 部署形态：首发 macOS / Linux(VPS)，Windows 延后

**统一基础**：npm 全局包分发（`npm i -g dsh-model`），Node ≥ 18，零原生编译依赖（不引入 node-gyp），平台行为一致；`dsh-model doctor` 自检平台差异（路径、终端、服务管理器、GUI 有无）。

**状态收敛（借鉴 opencodex 的核心做法）**：所有自有状态集中到单一 home 目录——设 `DSH_MODEL_HOME` 环境变量则用它，否则 `~/.dsh-model/`。所有平台差异（服务管理器、路径规则）都被隔离在服务注册层，状态层完全统一：

| 路径 | 内容 |
|---|---|
| `<home>/config.json` | 全部配置 |
| `<home>/service.log` | 后台服务 stdout/stderr |
| `<home>/service-state.json` | 记录由哪个服务管理器安装、端口是多少（status/repair 的依据） |
| `<home>/.lock` | 单写者锁：第二个 dsh-model 实例启动即拒绝，防止双实例争抢端口与子进程 |

**服务注册（各平台原生机制，文件位置照搬 opencodex 的成熟选择）**：

| 平台 | 机制 | 落盘位置 |
|---|---|---|
| macOS | launchd 用户级 agent | `~/Library/LaunchAgents/com.dsh-model.proxy.plist` |
| Linux VPS | systemd 用户级 unit | `~/.config/systemd/user/dsh-model-proxy.service` |
| Windows（延后） | 任务计划程序（隐藏窗口）；`--native` + WinSW 列为可选增强 | 名为 `dsh-model-proxy` 的计划任务 |

配套 `dsh-model service install|start|stop|status|repair|uninstall` 命令组；`status` 检测冲突状态并给出修复命令。卸载时先 `service uninstall` + 还原 dsh 配置，再删除 `<home>`，全程可逆。

**按需启动（借鉴 codex-shim）**：`dsh-model shim install` 让代理在首次请求到达端口时才拉起，无常驻守护进程——适合不重启就想用完即走的场景；与 `service` 常驻模式（崩溃自动重启）二选一，shim 卸载同样干净。

| 平台 | 桌面类上游 |
|---|---|
| macOS | 可用（Claude Desktop 可探测；Muse Code 原生支持） |
| Linux VPS | 无桌面环境，自动禁用桌面类，status 标注“需要 GUI”；Muse Code 原生支持且登录走 device-code，SSH 友好 |

**VPS 场景的三层设计**：

1. **网络模式（两种，覆盖"纯本地"与"海外中继"）**：
   - **回环模式（默认）**：只绑 `127.0.0.1`，服务本机软件，免鉴权；
   - **中继模式（海外 VPS 核心）**：`bind: 0.0.0.0` + **强制 `DSH_MODEL_API_TOKEN`**（Bearer 鉴权，请求级校验）+ 建议 TLS 反代（caddy/nginx，dsh-model 自身不做证书）。国内软件填 `https://<vps域名>/v1` + token 直连。此模式下 dsh-model 的价值 = **海外网络的合规出口**：登录在 VPS 上完成（device-code 天然适配，VPS 直连各家 OAuth 无障碍），模型调用全程走 VPS 网络路径，国内侧零代理配置。配套 `dsh-model relay enable` 一条命令完成"绑公网 + 生成强随机 token + 打印接入示例"；
2. **登录（无浏览器的 OAuth）**：
   - 方案 A（首选）：`dsh-model login <cli>` 在 VPS 上打印授权 URL，用户在本地（或任何有网络的）浏览器完成登录后回贴 code；或对 OAuth 回调端口做 SSH 隧道（`ssh -L`）把回调落到本地；
   - 方案 B（借鉴 dsh-codex-connect）：远程设备浏览器完成授权后，通过手动回调表单回贴；
   - 方案 C（兜底）：`dsh-model auth export`（口令加密的凭据包）→ 上传 VPS → `dsh-model auth import`，导出时显著提示安全风险；
3. **与 dsh 同机部署（搭配 dsh-vps）**：dsh-vps（github.com/AIcivilization/dsh-vps）负责 VPS 上 dsh 的部署与公网安全访问（Caddy + dsh-gate 登录网关），dsh-model 与 dsh 同机，两种组网：
   - **私有组网**：dsh-model 只绑 `127.0.0.1:8317` 供 dsh 使用，公网暴露统一交给 dsh-vps 链路（Caddy → dsh-gate → dsh:3080 → dsh-model:8317），全程不出明文；
   - **混合组网（推荐）**：dsh-model 同时开中继模式——dsh 走本机回环，其他国内软件（编辑器、脚本等）直连 dsh-model 公网端点，各走各的鉴权；若用同一个 caddy 实例，可把 `dsh-model.<域名>` 反代到 8317，复用 TLS。

**刻意不搬的部分**：opencodex 的桌面应用（DMG/MSI/AppImage + 托盘 + 签名公证）、Docker Compose（digest 固定 + 非 root + token 卷）、Windows WinSW 默认化——这些是它作为大众产品的发行工程，dsh-model 以 npm 包 + 原生服务注册为终点即可，复杂度砍掉 90%。

### 4.8 界面策略：不自建 UI，界面就是 dsh 的

dsh-model **不做自己的 Web 控制台**。理由：产品矩阵里已经有 dsh（自带完整 Web UI）和 dsh-vps（把 dsh 部署到 VPS、浏览器安全访问）——模型选择、聊天、设置全部发生在 dsh 的界面里，dsh-model 的模型通过 `dsh-model connect-dsh` 出现在 dsh 的模型下拉中，用户在 dsh 界面上完成一切。用户用本地浏览器或 dsh 内置浏览器访问均可，dsh-model 不感知。

**界面职责划分**：

| 界面 | 承担的内容 |
|---|---|
| dsh Web UI（本地或经 dsh-vps 访问） | 模型选择与使用、对话、dsh 侧全部设置 |
| `dsh-model` CLI（含 SSH 场景） | dsh-model 自身的全部操作：status / install / login / service / connect-dsh / 日志 |
| `GET /status`（JSON） | 供脚本与未来集成消费的机器可读状态，非人机界面 |

**与 dsh-vps 的组合（VPS 场景的完整拼图）**：

```
国内浏览器 ──HTTPS──> Caddy ──> dsh-gate（登录网关）──> dsh Web (127.0.0.1:3080)
（网络可达：国内→VPS ✓）                                  │ 自定义 provider
                                                           ▼
                                             dsh-model (127.0.0.1:8317)
                                             │（中继模式：0.0.0.0 + token）
                                             ▼
                          国内其他软件 ──直接填 dsh-model 地址──┘
                                             │（网络可达：VPS→OpenAI/Anthropic ✓）
                                             ▼
                                    CLI 子进程 → Codex / Claude / ...
```

- **海外 VPS 的网络位置是这个场景的全部价值**：国内连 VPS 畅通，VPS 连各家大模型畅通，dsh-model 站在中间完成协议翻译与鉴权，两侧都不需要任何额外网络配置；
- 用户在 dsh-vps 部署的 dsh 界面里点”获取可用模型”，即可看到 dsh-model 上报的全部 CLI 模型；
- `dsh-model login` 在 VPS 上以 device-code 完成（VPS 直连 OAuth 无障碍），化解国内无法访问各家登录页的问题。

**远期（M3+，可选）**：dsh-vps 本身以 dsh 插件形态在 dsh 内提供"VPS 部署”管理页，dsh-model 可循同样模式做一个轻插件页（上游总览/日志）内嵌进 dsh——但仅在 CLI 不足以覆盖需求时才做，默认不做。

---

## 五、生态对比：dsh 已有的模型接入插件

dsh 插件生态（官方 `dsh-plugin` topic，1.8 万+ 仓库；目录聚合在 awesome-dsh-plugin，收录 4200+）中，"订阅/额度 → dsh 模型"已是成熟品类，且头部产品已有相当规模。按实现路线选取六个代表性产品对比（星数为 2026-10 时点）：

| 维度 | dsh-workbuddy-connect | dsh-connect-workbuddy | dsh-codex-subscription | dsh-codex-connect | dsh-codebuddy-plugin | dsh-deepseek-web-login | **dsh-model（本产品）** |
|---|---|---|---|---|---|---|---|
| 星数 | **328** | —（fork 重写版） | **147** | **138** | 7 | — | — |
| 接入对象 | WorkBuddy 桌面 App（国内/国际版） | 同左（前者重写，加账号池/积分读数） | ChatGPT/Codex 订阅 | ChatGPT/Codex 订阅 | 腾讯 CodeBuddy/TRAE/Qoder | chat.deepseek.com 网页版 | 9 家 CLI（Codex/Claude Code/Grok/Muse/opencode/Qwen Code 等） |
| 实现路线 | 复用桌面 App 凭据文件（AES 加密则调 App 自身解密）+ loopback shim | 同左 + 账号池自动换号 | **OAuth 直连后端**（无需 CLI） | **vendored pi-ai OAuth 库直连**，明确不动 `~/.codex/auth.json`、不冒充 Codex Desktop | 本地流式桥 + OAuth + 翻译网关 | Electron 凭据旁路捕获 + PoW 对抗 | **CLI 官方 headless 进程封装** |
| 账号策略 | 单账号（跟随 App 登录） | **多账号池**（积分排序/换号/签到） | 多账号管理 | 最多 16 账号，手动切换 | 多 Key 轮换冷却 | 多账号库 + 风控节流 | **单账号**（红线） |
| dsh 集成深度 | 深（设置卡/模型显隐/倍率显示） | 深（输入框积分常驻读数） | 深（OAuth 入口在设置页） | 深（配额窗口显示） | 深（四区块设置卡） | 中 | 浅（标准 OpenAI provider，无设置卡） |
| 接口稳定性 | 依赖 App 私有接口+加密格式跟随 | 同左 | OAuth 按官方 App Server 文档、标明 clientInfo | 同左，声明合规边界 | 自述"未公开内部形态，随时可能失效" | 私有接口+PoW 对抗 | 官方文档化 headless 接口 |
| 服务范围 | 仅 dsh | 仅 dsh | 仅 dsh | 仅 dsh | 仅 dsh | 仅 dsh | **任何 OpenAI 兼容客户端** |

### 对比结论

1. **市场已被验证，且竞争密度比预想高**。"订阅/额度变模型"在 dsh 生态不是空白——WorkBuddy/Codex 两条线的头部插件已到 100–330★、release 几十个、issue 区活跃。dsh-model 若只在 dsh 内部竞争，面对的是集成更深（设置卡、配额显示、多账号）的对手，**纯 dsh 场景打不赢也不必打**。
2. **dsh-model 的护城河重新聚焦为两条**：
   - **跨软件通用**：这六个插件全部只服务 dsh；dsh-model 是唯一让同一批 CLI 订阅同时供 dsh、编辑器插件、脚本、其他 Agent 框架使用的网关。装了 WorkBuddy 插件的用户，其模型在 dsh 之外不可见；dsh-model 用户处处可用；
   - **聚合九家上游 + 官方接口路线**：一家插件管一家来源，用户要装一堆；dsh-model 一次接入全部，且 headless 官方接口的稳定性档位高于"私有接口+解密程序"路线。
3. **实现路线的重要新知——OAuth 直连是成熟替代路线**：dsh-codex-subscription 与 dsh-codex-connect 均不封装 CLI，而是 vendored OAuth 库直连 OpenAI 后端（后者还刻意声明不冒充客户端、不动 `~/.codex/auth.json`）。这比 dsh-model 原定的进程封装**更轻、延迟更低**，但依赖对后端私有协议的持续跟进。**对 dsh-model 的调整**：适配器接口不变，Codex/Claude 两家可做"headless 进程封装（默认，稳）+ OAuth 直连（可选，快）"双通道，由配置切换。
4. **值得抄的实现细节（新增）**：
   - dsh-connect-workbuddy 的 **loopback shim 加固**：每区域随机端口 + 进程内随机 secret，真实 token 不交给 pi-ai——dsh-model 网关与子进程间的凭据隔离照此办理；
   - dsh-codex-connect 的**远程设备 OAuth 回调表单**：VPS 上不等 localhost 回调，用户在任何浏览器完成授权后手动回贴——与我们 device-code 方案互为补充，实现成本极低；
   - workbuddy 系的**版本兼容严格区间声明**（插件 0.7.1 ↔ DSH 0.2.0-rc.2）——dsh-model 虽非 dsh 插件，但 `connect-dsh` 写入的配置也应声明并校验 dsh 版本区间；
   - dsh-codex-subscription 的**"失败明确报错，不静默切换付费路由"**——与 dsh-model 的失败切换设计原则一致，互相印证。
5. **风险前车之鉴（维持并加强）**：web-login 的账号风控遭遇，以及 workbuddy 系多账号池的高风险姿态（积分换号、批量签到），反向验证 dsh-model 的克制路线——单账号、排队不规避、不做配额感知切换。生态里激进方案已有人做，dsh-model 做稳的那一档。
6. **互补品**：dsh-llm-opencode（OpenCode Zen 9 个免费模型、零配置）证明免费路线有真实需求，可作为 dsh-model 未来"开箱即用"默认上游（M3 后增长项，不影响核心架构）。

### 代码级拆解（读源码后确认）

四家共享同一架构模式：**dsh (pi-ai 适配层) → loopback shim（本地回环网关）→ 真实上游**。每个插件内部都内嵌了一个"迷你版 dsh-model"——这从代码层面证实了 dsh-model 抽象的正确性：它们各自重复实现了回环网关，dsh-model 把这个网关解放出来、通用化。

**dsh-workbuddy-connect 的 shim.ts（328★，代码最干净，25 文件）**：

| 机制 | 实现 |
|---|---|
| 监听 | `server.listen(0, '127.0.0.1')` 随机端口，只绑回环 |
| 进程内密钥 | `randomBytes(32).toString('base64url')`，pi-ai 拿到的 apiKey 即此密钥，真实 token 不出 shim；校验用 `timingSafeEqual` 常数时间比较 |
| 入站加固 | Host 回环（防 DNS rebinding）+ Origin 回环 + Content-Type 校验 + bearer 匹配，四重 |
| 流式 | SSE 管道透传不解析；探测 `[DONE]`，上游中断则补发 `data: [DONE]` 让客户端正常收尾 |
| 错误映射 | 类别→HTTP 状态：额度尽 402 / 限流 429 / 会话死 401，统一 `writeOpenAIError` |
| 生命周期 | `ready` Promise（listening resolve / error reject）；关闭时 `server.closeAllConnections()` 强制清场 |

**其 adapter.ts 是"组装式"**：pi-ai 的 `createProvider` + `openAICompletionsApi()` 把 provider 指向自己的 shim，继承 `PiAiAdapter` 只覆写 `listModels`/`resolveModel`（促销徽章、积分倍率等展示层），全部流式翻译委托基类——**因为 shim 说标准 OpenAI 协议，所以适配层薄如纸**。另有亮点：`getModels` 实时读 catalog（刷新即生效，无需重建 provider）；catalog 缺项时"membership is advisory"原样放行不丢弃；隐藏模型只影响展示不影响路由（resolveModel 故意不过滤，防在用会话解析失败）。

**其余三家**：dsh-codex-subscription 为 JS 平铺 128 文件（配额预测、图片查看器、Sketch 画板，功能面极大）；dsh-codex-connect 86 个 TS 文件 + vendored pi-ai-oauth + adaptive-task 子代理体系；dsh-connect-workbuddy 为前者重写（22 文件，加账号池/dsml-recovery/at-rest 加密）。

**对 dsh-model 设计的代码级收获**：

1. **架构同构验证**：shim 与 dsh-model 网关职责完全同构——dsh-model 相当于把 shim 从"每插件一个、只服务 dsh"解放为"一个网关、服务一切"。pi-ai 适配层那部分代码 dsh-model 完全不需要（dsh 走标准自定义 provider 接入），**dsh-model 的代码量可以比插件更少**；
2. **直接照搬的工程细节**：`[DONE]` 补发治愈、错误类别→HTTP 状态映射、`timingSafeEqual` 鉴权、`closeAllConnections()` 清场、`streamIdleTimeoutMs`（300s）流空闲超时、随机端口 + Host/Origin 双门；
3. **借鉴的设计判断**：catalog "advisory" 容错（模型列表缺项不硬失败）、展示层与路由层分离、`getModels` 实时化；
4. **规模反例**：codex-subscription 128 文件、codex-connect 86 文件——per-source 插件在"深度集成 dsh"的路上代码量失控。dsh-model 站在网关位置，天然不需要这些（配额 UI、图片查看器、Sketch、子代理全部与 dsh-model 无关），印证"1/10 功能量"的可行性。

### 生态外对标：cc-switch 与 CLIProxyAPI（通用工具侧）

dsh 生态之外，通用工具侧有两个必须对标的产品（用户补充线索）：

**cc-switch**（farion1231/cc-switch，Tauri 2 + Rust + React）：
- **定位**：AI CLI 的"配置管理器"——90+ 供应商预设一键切换 Claude Code/Codex/Gemini CLI/Grok Build/OpenCode 等工具的配置文件（settings.json / TOML / .env），切换只替换连接信息、保留用户自加的 MCP/hooks/注释；
- 三种模式：Direct（直连）/ Routing（本机转发 + API 格式转换 + 故障转移）/ Aggregation（多供应商模型合并进一个列表）；
- 统一管理 MCP/Skills/Prompts、会话阅读视图、用量配额追踪、Apps 版本管理；
- 社区极活跃（~1.7k open issues、1k PR，多语言、签名公证、多渠道分发）；
- **与 dsh-model 的关系**：它管"配置文件的切换"，不自带模型通道（Routing 模式的转发是轻量附赠）；其赞助商列表几乎全是 API 中转平台，它实质是中转服务的接入口。**对 dsh-model 的参考价值**：其"切换只替换连接信息、保留用户自定义"的侵入最小化原则，以及"接管什么/还原什么"的边界划分，值得 `connect-dsh`/`disconnect-dsh` 借鉴。

**CLIProxyAPI**（router-for-me/CLIProxyAPI，Go）——**与 dsh-model 核心命题几乎完全重合的直接对标品**：
- **定位**："把 Antigravity、ChatGPT Codex、Claude Code、Grok Build 包装成 OpenAI/Gemini/Claude/Codex 兼容 API 服务"——这就是 dsh-model 的国际组部分；
- 上游：Codex OAuth、Claude Code OAuth、Grok Build OAuth、Gemini（CLI/AI Studio/Vertex/Antigravity）、Muse（Meta 登录）、Kimi OAuth、Devin、以及任意 OpenAI 兼容上游；**多账户 OAuth + 轮询负载均衡**（Gemini/OpenAI/Claude/Grok 均支持）；
- 下游：OpenAI 兼容（含 Responses）、Anthropic 兼容、Gemini 兼容、Codex/Grok 协议，流式/非流式/WebSocket、工具调用、多模态；
- 工程：Go 单二进制 + 可复用 Go SDK（执行器/翻译器/凭据 watcher 分层清晰）、613 open PR、40+ 第三方生态项目（托盘、面板、Dashboard、用量统计），极活跃；
- **与 dsh-model 的差异**：
  1. **多账户轮询**——dsh-model 单账号红线，CLIProxyAPI 无此约束（这也是它的"卖点"但合规姿态更激进）；
  2. **路线为 OAuth 直连**（同 dsh 头部插件），非 CLI headless 进程封装；不依赖本机装 CLI；
  3. **生态重**——用户实际使用往往搭配桌面客户端/面板/托盘/统计等一堆生态件；dsh-model 定位 npm 一装即用；
  4. **无 dsh 深度集成**——dsh 只能当一个普通 OpenAI endpoint 接它；无 connect-dsh、无国内 CLI 组（opencode CLI/Qwen Code/iFlow 不在其上游列表）、无中继模式产品化（虽然技术上可部署 VPS）；
  5. **国内组是 dsh-model 的结构性空位**：CLIProxyAPI 的上游清一色国际系 + Kimi；Qwen Code/iFlow/opencode CLI（订阅/免费额度）未被覆盖。

### 战略修正

原结论"dsh 插件们是 dsh-model 的下游用户"需修正为：**dsh 内部，per-source 插件已是成熟方案，dsh-model 不与之正面竞争**。dsh-model 的目标用户画像是：① 同时用 dsh 之外的软件、想让订阅处处可用的；② 想一家网关管全部 CLI、不想装一堆插件的；③ dsh 生态插件没覆盖的上游（Claude Code、Grok、Muse 等头部国际 CLI——现有头部插件集中在 WorkBuddy/Codex/CodeBuddy 国内系）。据此，M1 的 dsh 内验收场景不变（自定义 provider 即可），但对外叙事从"给 dsh 提供模型"调整为"**给本机所有软件提供模型，dsh 是一等公民**"。

**海外中继进一步强化差异化（生态插件做不到的）**：dsh 的 per-source 插件必须跑在"能直连上游"的机器上——国内用户若本机连不上 OpenAI/Anthropic，插件装了也用不了。dsh-model 的海外 VPS 中继模式把这个结构性限制变成了自己的主场景：**dsh-model 部署在网络畅通的那一侧（VPS），用户在网络受限的这一侧（国内）**，中间只隔一个 token。这是所有仅服务 dsh、仅跑在本机的插件都无法覆盖的位置，也是 dsh-model 对国内用户最锐利的卖点。

**结合 CLIProxyAPI 的最终修正（已定案）**：CLIProxyAPI 的存在证明"CLI 订阅 → 统一 API"市场规模巨大、路线已被 Go 生态做透。**决策（2026-10-08）：不重写网关核心，dsh-model 定位为"CLIProxyAPI 之上的 dsh 原生集成层"**。理由：① 该领域已极为成熟，自研 headless 进程封装的坑（CLI 版本漂移、事件格式不稳定、进程管理、私有协议跟进）生态已替我们踩过并放弃；② dsh-model 的真实价值不在协议翻译，而在 dsh 集成、部署编排与场景产品化——这些 CLIProxyAPI 恰恰不做；③ 工程量再降一个数量级，聚焦做出差异化。最终架构见第十章。

---

## 六、合规与风险

| 风险 | 等级 | 对策 |
|---|---|---|
| **ToS 风险**：将订阅登录态的额度通过 API 供其他软件调用，可能违反 Anthropic/OpenAI 的服务条款 | 高 | ① 定位明确为单机个人使用的协议适配工具，README 显著声明；② 不做多账号、不做配额规避（明确与 opencodex 账号池划清界限）；③ 用户自担风险提示 |
| CLI headless 接口非公开 API，格式可能随版本变动 | 高 | 适配器隔离 + 版本兼容矩阵 + 事件格式快照测试；CLI 升级破坏时快速发版 |
| Claude Desktop 无 headless 能力 | 中 | 降级为 P2 实验性，不写进核心承诺 |
| dsh 预览期破坏性变更 | 低（MVP 不依赖） | MVP 走自定义 provider 路线，只依赖稳定的 OpenAI 兼容配置面 |
| 本地端口被扫 | 低 | 默认仅绑 127.0.0.1；开放外部绑定强制 token |
| VPS 公网暴露 / 凭据导出转移 | 中 | 非 localhost 强制 token；`auth export` 口令加密 + 显著风险提示；推荐 SSH 隧道访问 |
| 国内 CLI 接口变动（iFlow / Kimi 等无稳定性承诺） | 中 | 同 Claude Code/Codex 策略：适配器隔离 + 版本兼容矩阵 + 事件格式快照测试 |

---

## 七、实施路线图

| 阶段 | 周期 | 交付 | 验收标准 |
|---|---|---|---|
| **M0 接口验证** | 1–2 周 | Claude Code / Codex / opencode / Qwen Code headless 事件格式实测记录；Grok Build、iFlow、Kimi CLI 接口调研结论 | 4 个 CLI 各跑通一次“请求→流式输出→工具调用” |
| **M1 MVP** | 2–3 周 | dsh-model 核心：claude-code + codex + opencode + qwen-code 四个适配器 + `/v1/chat/completions`（SSE）+ `/v1/models` + `dsh-model connect-dsh`（macOS 优先验证） | 在 dsh Web UI 中选用四家上游模型完成对话与工具调用 |
| **M2 完整体验** | 2 周 | Detector + `dsh-model status/install/login`、并发闸门与会话复用、`dsh-model service`、干净卸载 | mac + VPS 两平台端到端验收（VPS 上与 dsh-vps 组合，在浏览器 dsh 界面中完成对话）；VPS 上完成 device-code 登录 |
| **M3 扩展** | 按需 | Muse Code / iFlow / Kimi CLI / Grok Build 适配器、失败切换链、Windows 支持（视上游生态）、dsh 插件化预研 | — |

---

## 八、技术选型与目录结构

- **TypeScript + Node.js ≥ 18**：与 dsh 同栈（便于未来插件化），不强制 Bun；
- HTTP：`fastify`（或 Node 原生 `http`，保持零依赖可选）；子进程管理自研薄层；
- 测试：Vitest（同 dsh 生态），对每个 CLI 的事件格式做快照测试。

```
dsh-model/
├── src/
│   ├── cli/               # dsh-model start/status/install/connect-dsh/service
│   ├── server/            # OpenAI 兼容端点、SSE、鉴权
│   ├── router/            # 模型解析、并发闸门、fallback
│   ├── adapters/
│   │   ├── base.ts        # UpstreamAdapter 接口 + 公共翻译工具
│   │   ├── claude-code.ts
│   │   ├── codex.ts
│   │   ├── grok-build.ts
│   │   └── claude-desktop.ts
│   ├── detect/            # CLI 探测、版本、登录态
│   ├── install/           # 安装命令生成与执行
│   └── config.ts
├── tests/                 # 单测 + CLI 事件格式快照
└── package.json
```

---

## 十、最终架构（v2）：CLIProxyAPI 引擎 + dsh-model 薄集成层

### 10.1 架构

```
┌────────────────────────────────────────────────────────────┐
│                     本机 / 海外 VPS                          │
│                                                            │
│  消费方：dsh Web UI（组合 dsh-vps）· 编辑器 · 脚本 · 任意软件  │
│      │ OpenAI 兼容 (http://127.0.0.1:8317/v1)              │
│      ▼                                                     │
│  ┌──────────────────────────────────────────┐              │
│  │ dsh-model 薄集成层（TypeScript / npm / dsh-model CLI） │              │
│  │  · 安装编排：下载/升级 CLIProxyAPI 引擎     │              │
│  │  · connect-dsh / disconnect-dsh：配置接线  │              │
│  │  · 探测：已装/未装/登录状态（CLI + 引擎）    │              │
│  │  · relay enable：中继模式产品化（绑公网+    │              │
│  │    token+caddy 配置生成+接入示例）          │              │
│  │  · 国内组：生成 CLIProxyAPI 的 OpenAI 兼容  │              │
│  │    上游配置（DashScope/DeepSeek/Kimi 等）   │              │
│  │  · 服务注册：launchd/systemd 用户级         │              │
│  │  · dsh-model status/doctor/logs                  │              │
│  └──────────────┬───────────────────────────┘              │
│                 ▼ 配置生成 / 进程守护                        │
│  ┌──────────────────────────────────────────┐              │
│  │ CLIProxyAPI 引擎（Go，成熟核心，不自研）     │              │
│  │  上游 OAuth 直连：Codex · Claude Code ·     │              │
│  │  Grok Build · Muse · Gemini · Kimi · Devin │              │
│  │  下游协议：OpenAI / Anthropic / Gemini /    │              │
│  │  Codex / Grok 全兼容                       │              │
│  └──────────────────────────────────────────┘              │
└────────────────────────────────────────────────────────────┘
```

### 10.2 dsh-model 要写的代码（对比自研路线的削减）

| 模块 | 自研路线 | v2 路线 |
|---|---|---|
| 协议翻译/SSE/工具调用/多模态 | 全部自写 | **零**（引擎负责） |
| OAuth 流程 ×N 家 | 自写或 vendor | **零**（引擎负责） |
| 进程封装/会话管理/并发闸门 | 自写 | **零**（引擎多账户管理） |
| 上游探测（哪些 CLI 可用） | 自写 | 自写（但只为引导安装，非调用必需——OAuth 直连不依赖本机 CLI） |
| 安装编排（引擎 + CLI 引导） | — | **自写（核心工作 ①）** |
| connect-dsh / 配置接线与还原 | 自写 | **自写（核心工作 ②）** |
| relay enable 中继产品化 | 自写 | **自写（核心工作 ③）** |
| 国内组上游配置生成 | 适配器自写 | 生成引擎的 OpenAI 兼容上游 YAML（Qwen DashScope、DeepSeek 官方等天然兼容；需订阅登录的国内 CLI 视引擎支持度补薄适配） |
| 服务注册/状态/诊断 | 自写 | 自写（薄） |

### 10.3 v2 路线的风险与对策

| 风险 | 对策 |
|---|---|
| 依赖第三方引擎（router-for-me 组织） | Go 单二进制 + 版本锁定（digest）；dsh-model 探测引擎版本并声明兼容区间；MIT 协议允许 vendor/魔改兜底；极端情况启用第四章自研存档路线 |
| 引擎配置格式漂移 | dsh-model 作为唯一配置入口（不鼓励手改 YAML），格式变更由 dsh-model 适配层吸收 |
| 国内组覆盖不全（引擎无 Qwen Code/iFlow/opencode CLI 的 OAuth） | 短期走 OpenAI 兼容上游配置（DashScope API key 等）；长期评估贡献 PR 或薄适配 |
| 多账户轮询与单账号红线冲突 | dsh-model 默认配置单账户；不暴露轮询编排（用户自行深入引擎配置属其个人选择） |

### 10.5 零配置免费模型（开箱即用，v2 新增需求）

**目标**：安装 dsh-model 后，用户即使一个 API key 都没有、一家账号都没登，重启或刷新 dsh 就能直接用上免费模型——"零门槛尝鲜，尝完再登录增强"。

**实现分层**：

1. **内置免费上游注册表**（dsh-model 静态维护，写入引擎的 OpenAI 兼容上游配置）：
   - **首选：OpenCode Zen 免费模型**（9 个，无需任何凭据，已被 dsh-llm-opencode 插件验证）：DeepSeek V4 Flash Free、Nemotron 3 Ultra Free、MiMo V2.5 Free、Hy3 Free、Muse Spark 1.2 Free 等。注意网关要求 `User-Agent: opencode/1.0.0`（官方 UA 会被拒），引擎的自定义上游需支持 header 覆写；不支持则由 dsh-model 在引擎前置一个极薄的 UA 改写转发（这是 dsh-model 唯一可能需要自写的网络件，<100 行）；
   - 其他零凭据源按探测结果陆续收录；
2. **探测增强**：Detector 发现已登录的来源（如本机已登录的 WorkBuddy/各家 CLI）时，其模型自动并入免费池（跟随登录态，退出登录即消失）——"免费模型 = 内置零凭据源 ∪ 已登录源"；
3. **dsh 侧自动匹配与加载**：
   - `dsh-model connect-dsh` / `dsh-model setup` 写入 dsh 配置时，**免费池模型直接写入 models 清单**，并把 provider 的 apiKey 设为占位值（dsh-model 本机免鉴权，dsh 不强制要求真 key）；
   - dsh 的配置"改动在下次请求时生效，无需重启"；用户在 dsh 设置页点"获取可用模型"会拉 dsh-model 的 `/v1/models` 自动刷新——**重启/刷新即自动匹配到最新免费池**，新增探测到的源无需重装；
   - dsh-model 侧引擎配置由 dsh-model 唯一维护，免费池变化只改引擎 YAML + 引擎热重载，dsh 侧经 `/v1/models` 动态上报，两侧都不需要用户手动同步。

**用户体验链**：`npm i -g dsh-model && dsh-model setup` → dsh 里点一次"获取可用模型" → 模型下拉里出现 DeepSeek V4 Flash 等 9 个免费模型 → 直接对话。想用 GPT/Claude 时再 `dsh-model login codex`（device-code）——增量付费/登录，不设门槛。

**边界**：免费模型的质量/限速由上游决定，dsh-model 在模型描述中如实标注"Free"；不承诺 SLA，不做免费源的配额规避。

### 10.6 v2 路线图（更新）

| 阶段 | 周期 | 交付 | 验收 |
|---|---|---|---|
| **M0 验证** | 3 天 | mac 与 VPS 各装一份 CLIProxyAPI，接通 dsh 自定义 provider，验证 Codex/Claude/Grok/Muse 四家 OAuth 与流式/工具调用；顺带验证 OpenCode Zen 免费上游（UA 覆写）能否经引擎接入 | dsh 里完成四家订阅模型 + 至少一家免费模型的对话 |
| **M1 薄层 MVP** | 1–2 周 | `dsh-model setup/connect-dsh`：引擎安装/升级/守护、配置接线与还原、**内置免费上游注册表（OpenCode Zen 优先）+ 免费池写入 dsh 模型清单**、status/doctor、服务注册 | **零 key 用户**一条命令从零到 dsh 能用免费模型对话 |
| **M2 场景产品化** | 1–2 周 | `dsh-model relay enable`（中继模式）、国内组上游配置生成、探测登录源自动并入免费池、dsh-vps 组合文档 | mac 本地 + VPS 中继两场景端到端；登录新 CLI 后 dsh 刷新即可见其模型 |
| **M3 增强** | 按需 | 国内 CLI 薄适配、Windows、dsh 插件页 | — |

---

## 结论（v2）

调研全程的价值链条：opencodex 给了产品洞察（订阅登录态 → API 可用 + 配置接管/干净还原）；dsh 头部插件给了架构验证（loopback shim + OAuth 直连，且代码量在深度集成的路上失控）；CLIProxyAPI 则证明通用网关赛道已被 Go 生态做透。**因此最终决策是站在成熟核心之上：CLIProxyAPI 做引擎，dsh-model 做 dsh 原生薄集成层。**

dsh-model 的最终产品主张：**一条命令，零 API key 也能在 dsh 里用上模型**——`dsh-model setup` 装引擎并内置免费模型池（OpenCode Zen 等，开箱即聊），`dsh-model connect-dsh` 接线，`dsh-model login <cli>` 增量解锁订阅模型，`dsh-model relay enable` 开海外中继，干净卸载不留痕。差异化不在功能广度，而在：**零门槛开箱体验**、dsh 集成深度（组合 dsh-vps 的完整 VPS 叙事）、海外中继场景的产品化、国内组模型开箱配置、npm 轻安装。协议翻译、OAuth、多协议出口这些最重的活全部交给久经考验的引擎，dsh-model 自己保持"一个 CLI 命令 + 一层配置编排"的极简体量。M0 三天即可验证，两周内可见成效。
