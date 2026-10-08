# 调研附录（v1 → v2 的决策依据）

> 这里只保留对设计有影响的结论。数据截至 2026-10，星数等数字没有逐条核实，仅供参考。

## 1. opencodex（`@bitkyc08/opencodex`）

本地双向协议网关：Codex 的 Responses API ↔ 各家 provider，附带账号池。

**v2 采纳的做法**
- 配置接管和干净还原（`ocx init` / `ocx stop`）→ 对应 `connect-dsh` / `disconnect-dsh`；
- 状态集中在一个 home 目录、单写者锁、launchd/systemd 用户级服务；
- 健康检查和状态命令。

**不采纳**：账号池、Combos、40+ provider、桌面应用、Web 仪表盘。

## 2. dsh 生态里的订阅接入插件

调研对象：dsh-workbuddy-connect、dsh-codex-subscription、dsh-codex-connect 等。

- 它们的共同架构是 **dsh → loopback shim → 上游**，每个插件内部都各自实现了一个本地网关。这说明"一个通用网关服务所有工具"的抽象是成立的。
- 头部插件不走 CLI 封装，而是 **OAuth 直连**。这也是 v2 改用 CLIProxyAPI 的原因之一。
- 值得借鉴的工程细节：shim 只绑回环，使用进程内随机 key 并做常数时间比较；上游中断时补发 `[DONE]`；按错误类别映射 HTTP 状态码（402/429/401）；严格声明兼容版本区间；失败时明确报错，不静默切换。
- 反例：深度集成 dsh 的插件代码量膨胀到 86–128 个文件（配额 UI、图片查看器等）。dsh-model 待在网关位置，不做这些。

## 3. CLIProxyAPI（router-for-me/CLIProxyAPI，Go，MIT）

和 dsh-model 的核心命题几乎重合：把多家 CLI 订阅的 OAuth 包装成 OpenAI / Anthropic / Gemini 兼容 API，支持流式输出、工具调用和多模态，活跃度高。

**结论**：协议层不自研，直接用它当引擎。dsh-model 的价值在它不做的部分：一条命令完成安装、接线、鉴权和卸载，以及与 dsh-vps 组合的自部署。

## 4. 为什么放弃 v1 的 headless CLI 封装

- `claude -p`、`codex exec` 都是 agent，工具在 CLI 内部执行，**无法把客户端传来的 `tools` 原样交给模型、再把 `tool_calls` 返还给客户端**，而 dsh 恰恰需要这个语义；
- 每次请求冷启动要几秒，OpenAI 的无状态 messages 与 CLI 会话对不上；
- 各家 CLI 的事件格式没有稳定性承诺。

所以 headless 路线连兜底都做不了。引擎出问题时的兜底方案是 fork 引擎。

## 5. cc-switch

AI CLI 的配置切换器。借鉴它"切换时只替换连接信息、保留用户自定义内容"的最小侵入原则，体现在 v2 的 managed block 和哈希还原设计上。
