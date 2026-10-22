<div align="center">

# dsh-model

**一个地址，用上你所有的模型：订阅、免费额度、本机模型，签到积分自动领。**

一个 OpenAI 兼容地址，一把 key，几十个模型。dsh、Cline、Continue、Cherry Studio、脚本……凡是支持 OpenAI 接口的软件都能直接用。

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/dsh-model" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/dsh-model"><img src="https://img.shields.io/npm/v/dsh-model?color=cb3837&logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.0--rc.2-4176E6" alt="DeepSeek Harness ≥ 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform: Windows / macOS / Linux">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white" alt="Node ≥ 20">
  <a href="https://github.com/router-for-me/CLIProxyAPI"><img src="https://img.shields.io/badge/engine-CLIProxyAPI%208.0.13-555" alt="Engine: CLIProxyAPI 8.0.13"></a>
</p>

[English](README.en.md) · 中文

</div>

## 为什么用它

你手上可能有好几样：ChatGPT Plus 带的 Codex、Kimi 的编程套餐、WorkBuddy 的免费积分、Gemini 和 Groq 的免费 key，还有本机的 Ollama。每家接口和登录方式都不一样，每个软件都得分别配置，额度用完了还要手动换。

dsh-model 把它们合成**一个地址、一种 key**：

- 🔌 **一处接入，处处可用**：dsh 里自动出现全部模型，按来源分组；其他软件填上同一个地址和 key 就行。
- 🆓 **把免费的用足**：Gemini / Groq / OpenRouter 免费 key、本机模型、WorkBuddy 积分都能接；每个来源标出「免费 / 免费·额度少 / 需付费」。
- 📅 **每日签到，自动领积分**：WorkBuddy 国内版、Qoder、Trae 每天自动签到，不用记。
- 🔁 **不怕限流**：自己排一个组合（如 Codex → Kimi → WorkBuddy），一个限流或额度用完就自动换下一个；同一个模型在几个来源都有时也会自动切换。
- 📊 **心里有数**：套餐用量和重置倒计时、剩余积分和到期时间、每个模型的成功率和速度、最近失败的原因和建议；额度快用完时提醒。
- 🔒 **默认安全**：始终要求 key，每台设备一把，可随时吊销；登录全在本机完成，不经过第三方。
- 🖥️ **电脑和服务器都行**：Windows、macOS、Linux；装在 VPS 上（配合 [dsh-vps](https://github.com/AIcivilization/dsh-vps)）自动开一个 https 地址，电脑、手机随处用。
- 🧹 **装得上，卸得净**：一条命令安装；卸载时把 dsh 的配置逐字节还原。

没有 dsh 也能用：命令行就能管理全部功能，dsh 里多一个图形管理页而已。

## 快速开始

```bash
npm install -g dsh-model
dsh-model setup
```

服务器上（装了 dsh-vps 的 VPS）用 `sudo dsh-model setup`。Windows 上在普通的 PowerShell 或命令提示符里执行即可，不需要管理员。

`setup` 可以重复执行，它会依次：

1. 下载并校验引擎，在本机 `127.0.0.1:8317/v1` 上运行，强制 key 鉴权；
2. 接入 WorkBuddy（dsh-model 自己的 bridge）。安装时不问任何 key，OpenCode Zen 等要 key 的来源，需要时在管理页里打开；
3. 把管理页装进 dsh，把模型同步进 dsh；
4. 在 VPS 上，额外开通对外地址 `https://<dsh 的域名>:9443/v1`（没有域名时用 `<IP>.sslip.io`）。

## 在 dsh 里管理：设置 → dsh-model

| 区块 | 内容 |
|---|---|
| **访问地址** | 本机地址和外网地址，各带「复制」按钮 |
| **来源** | 每家一个开关：打开就接入（没登录会弹出登录框），关闭只停用、保留登录。每行标出「免费 / 免费·额度少 / 需付费」，下面显示套餐用量和重置倒计时，或剩余积分和最近到期的一批；额度用完会标出多久后恢复 |
| **选模型** | 每个来源选哪些模型显示在 dsh 里，默认每家推荐 5 个，其余的经统一地址照样可用；每个模型旁边有「测一下」 |
| **组合切换** | 把几个模型按顺序排成一个组合，在 dsh 里就是一个模型：先用第一个，限流、额度用完或出错就换下一个。其他软件用模型名 `combo/<id>` |
| **自动切换** | 同一个模型在几个来源都有时，dsh 里多一组「自动切换（多来源）」，一个来源限流或出错就自动换另一个 |
| **每日签到** | WorkBuddy 国内版、Qoder、Trae 每天自动签到（也可一键签到），卡片显示今天领了多少 |
| **最近失败** | 最近 24 小时失败的请求：哪个模型、为什么、该怎么办（不记录对话内容） |
| **API key** | OpenAI 格式，每台设备一把。显示 24 小时内的请求数、成功率、延迟和速度，可复制、轮换、吊销 |
| **模型统计** | 按模型显示成功率、延迟和速度 |
| **关于** | 当前版本和 npm 上的最新版本；「更新」「卸载」一键完成（VPS 上要 root，这里给出命令） |

还没在这台机器上装好服务时，这一页会说明缺什么，并提供「一键安装」按钮，安装过程实时显示。刚装好时有「开始使用」向导；插件更新后还没重启 dsh 时页面顶部会提示（dsh-vps 上可一键重启）；额度快用完时，dsh 任何页面的右下角都会提醒。所以也可以先从 dsh 的插件市场装 dsh-model，再在这一页里点安装。

登录全由 dsh-model 自己完成，服务器上不装各家的 CLI，也不需要浏览器：

- **WorkBuddy、Codex、Kimi、Grok、Muse**：打开链接授权即可，要验证码的弹窗里会给出；
- **Devin、Claude、Antigravity**：这几家会把浏览器跳到一个固定的本机地址，页面打不开是正常的。把地址栏里的地址带回来，点「从剪贴板粘贴」即可。

已登录但没有可用套餐的来源（比如 Kimi 账号没有开通 Kimi Code），dsh-model 会实测出来，把它的模型从 dsh 里隐藏，并给出开通链接。

> 更新 dsh-model 后，要重启一次 dsh，管理页的新代码才会生效。模型和开关的变化不需要重启。

## 来源与费用

| 来源 | 费用 | 说明 |
|---|---|---|
| WorkBuddy / WorkBuddy AI | 免费 | 账号自带积分。**2026-10 起 WorkBuddy 会认出 dsh 发出的对话并拦下**，在 dsh 里基本用不了；签到照常 |
| Ollama / LM Studio | 免费 | 本机运行的模型。装好并启动后自动出现，不用登录 |
| Gemini（Google AI Studio）、Groq | 免费·额度少 | 填免费 API key 即可，每天 / 每分钟有上限 |
| OpenRouter | 免费·额度少 | 名字带 `:free` 的模型免费（每天约 50 次） |
| 硅基流动 | 免费·额度少 | 实名认证后部分小模型免费 |
| DeepSeek 官方、其他 OpenAI 兼容服务 | 需付费 | 填 API key（其他服务还要填地址） |
| Codex | 需付费 | ChatGPT Plus / Pro |
| Kimi | 需付费 | Kimi Code 套餐 |
| Grok | 需付费 | SuperGrok / X Premium+ |
| Muse | 需付费 | Muse Code 套餐 |
| Devin | 需付费 | 免费档实测调用会被拒 |
| OpenCode Zen | 需付费 | 充值后按量计费；它的免费模型只能在 OpenCode 软件里用 |
| Claude、Antigravity | 高风险，默认隐藏 | 服务商有封禁第三方使用的先例 |

dsh-model 只负责转接，不提供额度。

## 常用命令

| 命令 | 作用 |
|---|---|
| `setup` | 安装 / 修复全部（可重复执行） |
| `sources` | 来源列表：开关、费用、登录状态、用量 |
| `source enable\|disable\|logout <来源>` | 打开（需要时登录）/ 关闭 / 退出登录 |
| `key list\|add\|revoke\|rotate <名称>` | 访问 key，每台设备一把 |
| `checkin` | 现在签到一次（WorkBuddy 国内版、Qoder、Trae；默认每天自动签） |
| `combo list\|add <名称> <模型…>\|remove <id>` | 组合切换：按顺序试几个模型 |
| `failures` | 最近 24 小时失败的请求和建议 |
| `stats` | 按 key、来源、模型的成功率、延迟和速度 |
| `status` / `doctor [--e2e]` | 总览 / 逐项自检 |
| `models [sync]` | 列出模型 / 同步到 dsh |
| `remote enable --via caddy\|ssh\|tailscale` / `remote disable` | 远程访问（VPS 上 setup 已自动开通 caddy） |
| `engine version\|upgrade\|rollback` | 引擎版本 |
| `logs [--bridge]` / `repair` | 日志 / 修复 |
| `update [--to 版本]` | 更新到 npm 上的最新版：程序、dsh 插件和服务一起更新 |
| `uninstall` | 干净卸载 |

所有命令都支持 `--lang zh|en` 和 `--json`。

## 架构

```
dsh · 编辑器 · 脚本 ──Bearer key──▶ 引擎 127.0.0.1:8317/v1（唯一入口）
                                      │      ▲ VPS：Caddy https://<dsh 域名>:9443
             ┌────────────────────────┼────────────────────────┐
             ▼                        ▼                        ▼
   订阅 OAuth（Codex、Kimi…）   opencode/*（你的 key）   workbuddy/* → dsh-model 的 bridge
```

- 引擎是 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（MIT），版本锁定并校验 sha256。WorkBuddy 协议层移植自 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT），订阅用量的查询接口参考了 [CodexBar](https://github.com/steipete/CodexBar)（MIT）。
- dsh 里只写两样东西：模型 provider 和 `refs.DSH_MODEL_API_KEY`。卸载时，如果这两处没被改过，就逐字节还原。

详见 [设计文档](docs/DESIGN.md)。

## 注意

- 适合个人使用：每家用自己的一个账号，不要拿来对外提供服务。
- 订阅和 WorkBuddy 的凭据在官方客户端之外使用，可能不符合服务商的条款，账号有风险，请自行判断。
- 支持 Windows 10 / 11（x64、ARM64）、macOS、Linux，需要 Node ≥ 20。
- Windows：后台服务登录后自动运行、不弹窗口。如果被杀毒软件拦下（程序不见了或启动不了），把 `%USERPROFILE%\.dsh-model` 加入信任，再执行 `dsh-model repair`。

## License

MIT
