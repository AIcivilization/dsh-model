# dsh-model

> **无需 API key，装上就能用前沿模型。** No login, no sign-up, no API key — the models are just there.

一条命令，把你本机（或海外 VPS）的 Codex、Claude Code、Grok Build、Muse 等 CLI 订阅，变成 dsh 和所有本地软件都能用的模型——OpenAI 兼容，填个地址就行。

## 它解决什么

- 装了 Claude Code / Codex 订阅，却没法在 dsh 里直接用；
- 想在编辑器插件、脚本、其他 Agent 框架里用订阅模型，到处买 API key；
- 国内连不上国际模型：海外 VPS 部署 dsh-model 作中继，国内直连 VPS 即可；
- 一个 key 都没有：内置免费模型池（DeepSeek V4 Flash、MiMo、Hy3、Muse Spark 等），开箱即聊。

## 快速开始

```bash
npm install -g dsh-model
dsh-model setup        # 安装引擎 + 内置免费模型，接入 dsh
```

打开 dsh → 获取可用模型 → 直接对话。想用 GPT/Claude 再增量登录：

```bash
dsh-model login codex  # device-code 登录，按提示在浏览器完成
```

海外中继（国内用户推荐）：

```bash
# 在海外 VPS 上
dsh-model setup && dsh-model relay enable
# 国内任何软件填 https://<vps>/v1 + token
```

## 架构

```
dsh · 编辑器 · 脚本 · 任意 OpenAI 兼容软件
        │
        ▼
  dsh-model（薄集成层：setup / connect-dsh / relay / status）
        │
        ▼
  CLIProxyAPI 引擎（成熟核心：各家 OAuth 直连 + 全协议出口）
```

- 引擎：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（Go，MIT），上游 OAuth 直连 Codex / Claude Code / Grok Build / Muse / Gemini / Kimi 等；
- dsh-model 自身只做安装编排、dsh 接线（`connect-dsh` / 干净卸载）、已装探测、海外中继产品化、免费模型池；
- 不自建界面——模型选择与使用全部发生在 dsh 的 Web UI（VPS 场景配合 [dsh-vps](https://github.com/AIcivilization/dsh-vps)）。

完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 命令

| 命令 | 作用 |
|---|---|
| `dsh-model setup` | 安装引擎、内置免费模型、接入 dsh |
| `dsh-model connect-dsh` / `disconnect-dsh` | 接线 / 干净还原 dsh 配置 |
| `dsh-model login <cli>` | device-code 登录各家订阅 |
| `dsh-model relay enable` | 海外中继模式（公网 + token） |
| `dsh-model status` / `doctor` | 已装/登录状态 / 自检 |
| `dsh-model uninstall` | 干净卸载，不留痕 |

## 状态

开发中（M0 验证阶段）。平台：macOS / Linux（VPS）优先，Windows 延后。

## 免责声明

个人学习研究用途。dsh-model 是将你本人已授权的 CLI 订阅封装为本地 API 的工具，请遵守各家服务商的服务条款，自行承担账号风险。不支持也不鼓励多账号、配额规避等行为。

## License

MIT
