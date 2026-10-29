<div align="center">

# dsh-model

**📅 每天自动签到领积分（Trae、Qoder、WorkBuddy、豆包）· 🔁 一个地址中转所有模型 · 🧩 免费和订阅模型随你接**

装一次，三件事都替你做好。dsh 里有图形管理页，没有 dsh 也能用命令行。

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

## 📅 1. 每日签到：积分自动到账

**最省心的一件事：每天的签到积分，不用再记着去领。**

| 产品 | 怎么接入 | 每天 |
|---|---|---|
| **Trae** | 本机装了 Trae 并登录过，自动识别，什么都不用做 | 签到送积分（实测每天 200） |
| **Qoder** | 粘贴一次个人访问令牌（国内版、国际版都行） | 领当天的签到积分 |
| **WorkBuddy 国内版** | 登录一次（可以加几个账号） | 签到送积分 |
| **豆包**（实验） | 从浏览器复制一次登录 Cookie（只支持个人账号） | 「天天领额度」送体验额度 |

- **自动签到默认打开**：北京时间零点后随机延后 5–55 分钟签好；失败的一小时后重试；电脑关机错过了，开机一分钟内补签。
- **结果看得见**：设置页顶部一行「今日已完成签到：…」，没签上的可以「一键签到」；签完在 dsh 右下角提示一次。
- **这台还能签哪些**：卡片里列出支持、但这台还没设置的，旁边就是「+ 添加」。
- **放到 VPS 上签，不会漏**：「复制签到账号到另一台机器」导出一段加密文本和提取码，到 VPS 的页面里「导入」即可（Qoder、豆包；WorkBuddy 在 VPS 上各自登录，Trae 留在装了 Trae 的电脑上签）。
- **多账号**：一家可以签几个账号。在签到卡片的「详情」里「+ 添加 WorkBuddy 账号」（打开链接授权）、「+ 再加一个 Qoder 账号」；本机装了几个 Trae 会自动按账号各签一次。
- **只签到，不碰积分**：积分留在你的账号里，照常在各家官方软件里用。命令行：`dsh-model checkin`。

## 🔁 2. 中转：一个地址、一把 key，用上所有模型

你手上的模型来源，各家接口、登录方式都不一样。dsh-model 把它们合成**一个 OpenAI 兼容地址**：

- **dsh 里自动出现**：全部模型按来源分组，不用手动配置。
- **其他软件也能用**：Cline、Continue、Cherry Studio、脚本……凡是支持 OpenAI 接口的，填同一个地址和 key 就行。
- **不怕限流**：自己排一个组合（如 Codex → Kimi → Gemini），一个限流、额度用完或出错，就自动换下一个。
- **心里有数**：套餐用量和重置倒计时、每个模型的成功率和速度、最近失败的原因和该怎么办；额度快用完时提醒。
- **默认安全**：始终要求 key，每台设备一把，可随时吊销；登录全在本机完成。
- **电脑和服务器都行**：Windows、macOS、Linux；装在 VPS 上（配合 [dsh-vps](https://github.com/AIcivilization/dsh-vps)）自动开一个 https 地址，电脑、手机随处用。卸载时把 dsh 的配置逐字节还原。

## 🧩 3. 模型提供：免费的、订阅的都能接

| 类型 | 来源 |
|---|---|
| **免费（推荐）** | **硅基流动**（国内直连，实名后部分模型免费）、**Gemini**（能上外网，免费模型里质量最好） |
| 免费 · 额度少 | **智谱 GLM**（Flash 系列免费）、**讯飞星火**（Spark Lite 免费）、百度千帆（ERNIE Speed / Lite）、Groq、OpenRouter（`:free` 模型） |
| 本机 | Ollama、LM Studio：启动后自动出现，不用登录 |
| 订阅 | Codex（ChatGPT Plus / Pro）、Kimi Code、Grok、Muse、Devin：在管理页里登录即可 |
| 按量付费 | DeepSeek 官方、OpenCode Zen、任意 OpenAI 兼容服务 |

每个来源都标出「免费 / 免费·额度少 / 需付费」，详见下面的[来源与费用](#来源与费用)。dsh-model 只负责转接，不提供额度。

> WorkBuddy：2026-10 起它会认出 dsh 发出的对话并拦下，所以 dsh-model 只用它来签到，模型默认不接进 dsh。


## 快速开始

```bash
npm install -g dsh-model
dsh-model setup
```

服务器上（装了 dsh-vps 的 VPS）用 `sudo dsh-model setup`。Windows 上在普通的 PowerShell 或命令提示符里执行即可，不需要管理员。

`setup` 可以重复执行，它会依次：

1. 下载并校验引擎，在本机 `127.0.0.1:8317/v1` 上运行，强制 key 鉴权；
2. 启动 dsh-model 的守护进程（管理页、签到、登录都靠它）。安装时不问任何 key：免费来源推荐**硅基流动**（国内直连）或 **Gemini**（能上外网），装好后在管理页里填 key。WorkBuddy 只用来签到，模型默认不接进 dsh；
3. 把管理页装进 dsh，把模型同步进 dsh；
4. 在 VPS 上，额外开通对外地址 `https://<dsh 的域名>:9443/v1`（没有域名时用 `<IP>.sslip.io`）。

## 在 dsh 里管理：设置 → dsh-model

| 区块 | 内容 |
|---|---|
| **每日签到** | WorkBuddy 国内版、Qoder、Trae 每天自动签到（也可一键签到），卡片显示今天领了多少 |
| **访问地址** | 本机地址和外网地址，各带「复制」按钮 |
| **来源** | 每家一个开关：打开就接入（没登录会弹出登录框），关闭只停用、保留登录。每行标出「免费 / 免费·额度少 / 需付费」；没登录的、关掉的收进折叠列表。下面显示套餐用量和重置倒计时，或剩余积分和最近到期的一批；额度用完会标出多久后恢复 |
| **选模型** | 每个来源选哪些模型显示在 dsh 里，默认每家推荐 5 个，其余的经统一地址照样可用；每个模型旁边有「测一下」 |
| **组合切换** | 把几个模型按顺序排成一个组合，在 dsh 里就是一个模型：先用第一个，限流、额度用完或出错就换下一个。其他软件用模型名 `combo/<id>` |
| **自动切换** | 同一个模型在几个来源都有时，dsh 里多一组「自动切换（多来源）」，一个来源限流或出错就自动换另一个 |
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
| 智谱 GLM | 免费·额度少 | Flash 系列（如 GLM-4.7-Flash）免费，国内直连 |
| 讯飞星火 | 免费·额度少 | Spark Lite 免费不限量，每秒 2 次；key 填控制台的 APIPassword |
| 百度千帆 | 免费·额度少 | ERNIE Speed / Lite 长期免费（限速） |
| 火山方舟（豆包大模型）、MiniMax 开放平台、华为云 ModelArts | 需付费 | 官方 API，填 key 即可；火山方舟、华为云有新用户免费额度 |
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
- 下载引擎要连 GitHub：setup 会自动用上系统代理（Windows、macOS）或 `HTTPS_PROXY`；连不上时会说明原因，可以用 `--proxy <地址>` 指定代理，或手动下载后设置 `DSH_MODEL_ENGINE_ARCHIVE`。
- Windows：后台服务登录后自动运行、不弹窗口。如果被杀毒软件拦下（程序不见了或启动不了），把 `%USERPROFILE%\.dsh-model` 加入信任，再执行 `dsh-model repair`。

## License

MIT
