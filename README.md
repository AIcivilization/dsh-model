<div align="center">

# dsh-model

**📅 每天自动签到领积分（11 家，还能自定义）· 🆓 免费池：一把 key 用上各家官方免费额度 · 🔁 一个地址中转所有模型 · 🧩 37 个来源**

装一次，这几件事都替你做好。dsh 里有图形管理页，没有 dsh 也能用命令行。

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

## ✅ 为什么选 dsh-model

| | dsh-model | 常见的「白嫖模型」插件 |
|---|---|---|
| 怎么接模型 | 各家**官方** API、正规订阅登录 | 调各家 IDE 客户端的私有接口，有的还改写请求绕过厂商的拦截 |
| 账号安全 | **不改写请求、不绕过厂商的拦截**，被拦了就停 | 厂商一改协议就断，有封号风险 |
| 能用在哪 | 一个地址给 dsh、编辑器、脚本、别的电脑一起用 | 多数只能在 dsh 里选 |
| 来源 | **36 个**：免费的、订阅的、本机的、按量付费的，还能自己加 | 十几个账号渠道 |
| 免费额度 | **免费池** `free/auto`：各家官方免费额度合起来用，快过期的先用，**会扣钱的默认不进** | — |
| 签到 | Trae、Qoder、WorkBuddy、豆包、OfficeAce、MiniMax Code、WPS 灵犀、DuMate、AStudio、华为 CodeArts、商汤小浣熊，外加**自定义签到服务**；**多账号**，可放 VPS 天天签不漏 | 部分有 |
| 安装 | 插件市场装上就**自动装好**，国内不用连 GitHub | 装完要重启 dsh |
| 透明 | 没有自己的服务器、没有遥测，连哪些地址见[出网清单](docs/EGRESS.md) | — |

## 📅 1. 每日签到：积分自动到账

**最省心的一件事：每天的签到积分，不用再记着去领。**

| 产品 | 怎么接入 | 每天 |
|---|---|---|
| **Trae** | 本机装了 Trae 并登录过，自动识别，什么都不用做 | 签到送积分（实测每天 200） |
| **Qoder** | 粘贴一次个人访问令牌（国内版、国际版都行） | 领当天的签到积分 |
| **WorkBuddy 国内版** | 登录一次（可以加几个账号） | 签到送积分 |
| **豆包**（实验） | Mac / Windows 上点「从本机自动读取」，读豆包电脑版或浏览器里已登录的账号；也可以手动粘贴 Cookie（只支持个人账号） | 「天天领额度」送体验额度 |
| **OfficeAce**（华为云，实验） | 点「+ 添加 OfficeAce」，在浏览器里登录华为云账号（VPS 上也能用） | 领每日积分 |
| **MiniMax Code** | 本机装了并登录过，自动识别 | 签到积分（每天 400） |
| **WPS 灵犀** | 本机装了并登录过，自动识别（Node ≥ 22.5） | 智点（每天 100，第 7 天起 200） |
| **百度 DuMate** | 本机装了并登录过，自动识别 | 签到积分 |
| **AStudio** | 本机装了并登录过，自动识别 | 每日登录积分 |
| **华为 CodeArts** | 点「+ 登录华为 CodeArts」在浏览器里登录（浏览器要在这台电脑上）；VPS 上填 AK/SK | 签到积分 |
| **商汤小浣熊** | 填一次浏览器里的登录（Cookie 里的 `raccoon_refresh_token`），之后自己续期 | 每天 300 积分；当天登录过，有效期从当天延长到 7 天 |
| **你自己加的** | 「+ 自定义签到服务」：复制提示词让 dsh 的 AI 查好接口，粘回它给的 JSON，再填 Cookie / token | 看那家 |

- **自动签到默认打开**：北京时间零点后随机延后 5–55 分钟签好；失败的一小时后重试；电脑关机错过了，开机一分钟内补签。
- **结果看得见**：设置页顶部一行「今日已完成签到：…」，没签上的可以「一键签到」；签完在 dsh 右下角提示一次。
- **这台还能签哪些**：卡片里列出支持、但这台还没设置的，旁边就是「+ 添加」。
- **放到 VPS 上签，不会漏**：「复制签到账号到另一台机器」导出一段加密文本和提取码，到 VPS 的页面里「导入」即可（Qoder、豆包；WorkBuddy、OfficeAce 在 VPS 上各自登录，Trae 留在装了 Trae 的电脑上签）。
- **多账号**：一家可以签几个账号。在签到卡片的「详情」里「+ 添加 WorkBuddy 账号」（打开链接授权）、「+ 再加一个 Qoder 账号」；本机装了几个 Trae 会自动按账号各签一次。
- **手动填凭据，VPS 也能签**：灵犀、DuMate、AStudio、CodeArts、小浣熊和自定义的服务，都能在「+ 手动填签到凭据」里贴 Cookie / token（每家可以加几个账号），不再依赖本机装了那个 App。
- **只签到，不碰积分**：积分留在你的账号里，照常在各家官方软件里用。命令行：`dsh-model checkin`。

## 🆓 免费池：一把 key，用上各家官方的免费额度

魔搭每天的免费次数、Cloudflare 每天的 Neurons、OpenRouter 的 `:free` 模型、智谱 / 星火 / 千帆 / 混元的免费模型、Gemini 和 Groq 的免费档……各家都有，但分散在十几个平台。dsh-model 把它们合成**三个模型**：

| 模型 | 用哪些 |
|---|---|
| `free/auto` | 全部免费模型，强的在前 |
| `free/smart` | 只用大模型 |
| `free/fast` | 只用小而快的 |

- **快过期的先用**：每天重置的 → 每月重置的 → 有截止日的 → 长期免费的 → 本机模型兜底。
- **一家用完自动换**：限流或额度用完的那家冷却到它重置（每天的到北京时间 0 点，每月的到 1 号），换下一家。
- **绝不替你花钱**：新人代金券、「用完转付费」的额度默认**不进**免费池；要放进来，得你设一个 token 上限，用到 90% 自动移出。
- **还能领什么，一目了然**：设置页「免费额度」卡片列出每一份额度（周期、数量、门槛、截止日、折合金额），没领的点「去领」打开官方页面、「填 key」就进池。
- **自动发现新的**：每天检查一次额度目录有没有新条目、已接入的平台有没有上新免费模型，**问过你**再加。
- **自己加**：任何 OpenAI 兼容服务都能手动加（可以加很多个），勾「免费额度」就进池。

只能在产品里用的签到积分（Trae、Qoder、MiniMax Code……）不进 key，由上面的签到替你领。命令行：`dsh-model free`。

## 🔁 2. 中转：一个地址、一把 key，用上所有模型

你手上的模型来源，各家接口、登录方式都不一样。dsh-model 把它们合成**一个 OpenAI 兼容地址**：

- **dsh 里自动出现**：全部模型按来源分组，不用手动配置。
- **其他软件也能用**：Cline、Continue、Cherry Studio、脚本……凡是支持 OpenAI 接口的，填同一个地址和 key 就行。
- **不怕限流**：自己排一个组合（如 Codex → Kimi → Gemini），一个限流、额度用完或出错，就自动换下一个。
- **心里有数**：套餐用量和重置倒计时；每个模型的成功率、延迟、速度、token 用量和缓存命中；「最近请求」逐条列出，失败的直接写原因和该怎么办；额度快用完时提醒。
- **默认安全**：始终要求 key，每台设备一把，可随时吊销；登录全在本机完成。
- **电脑和服务器都行**：Windows、macOS、Linux；装在 VPS 上（配合 [dsh-vps](https://github.com/AIcivilization/dsh-vps)）自动开一个 https 地址，电脑、手机随处用。卸载时把 dsh 的配置逐字节还原。

## 🧩 3. 模型提供：免费的、订阅的都能接

| 类型 | 来源 |
|---|---|
| **免费（推荐）** | **硅基流动**（国内直连，实名后部分模型免费）、**Gemini**（能上外网，免费模型里质量最好） |
| 免费 · 额度少 | **魔搭 ModelScope**（每天约 2000 次）、**智谱 GLM**（Flash 系列免费）、**讯飞星火**（Spark Lite 免费）、腾讯混元（hunyuan-lite）、百度千帆（ERNIE Speed / Lite）、Mistral、NVIDIA、Groq、OpenRouter（`:free` 模型） |
| 本机 | Ollama、LM Studio：启动后自动出现，不用登录 |
| 订阅 | Codex（ChatGPT Plus / Pro）、Kimi Code、Grok、Muse、Devin：在管理页里登录即可 |
| 免费 · 每天 | **Cloudflare Workers AI**（每天 1 万 Neurons，超额即停）、**书生 InternLM**（测试期每月送额度）、**商汤日日新 SenseNova**（公测积分池，滚动 5 小时 / 每周上限） |
| 新人 / 每月额度（用完扣钱） | 超算互联网（1 亿 Token）、蚂蚁百灵（每月 10 元）、腾讯云 TokenHub（100 万 Token）、阿里云百炼、火山方舟 |
| 按量付费 | DeepSeek 官方、阿里云百炼（新用户每个模型约 100 万 token 免费）、Moonshot、阶跃星辰、火山方舟、MiniMax、华为云 ModelArts、OpenCode Zen、任意 OpenAI 兼容服务（可加多个） |

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
| **每日签到** | 11 家每天自动签到（也可一键签到），卡片显示今天领了多少 |
| **免费额度** | 免费池 `free/auto` 里有哪些模型、每份额度的状态（在用 / 冷却到几点 / 会扣钱没进池 / 还没领），「去领」「填 key」、「探测新额度」、「+ 手动添加来源」 |
| **访问地址** | 本机地址和外网地址，各带「复制」按钮 |
| **来源** | 每家一个开关：打开就接入（没登录会弹出登录框），关闭只停用、保留登录。每行标出「免费 / 免费·额度少 / 需付费」；没登录的、关掉的收进折叠列表。下面显示套餐用量和重置倒计时，或剩余积分和最近到期的一批；额度用完会标出多久后恢复 |
| **选模型** | 每个来源选哪些模型显示在 dsh 里，默认每家推荐 5 个，其余的经统一地址照样可用；每个模型旁边有「测一下」 |
| **组合切换** | 把几个模型按顺序排成一个组合，在 dsh 里就是一个模型：先用第一个，限流、额度用完或出错就换下一个。其他软件用模型名 `combo/<id>` |
| **自动切换** | 同一个模型在几个来源都有时，dsh 里多一组「自动切换（多来源）」，一个来源限流或出错就自动换另一个 |
| **最近失败** | 最近 24 小时失败的请求：哪个模型、为什么、该怎么办（不记录对话内容） |
| **API key** | OpenAI 格式，每台设备一把。显示 24 小时内的请求数、成功率、延迟和速度，可复制、轮换、吊销 |
| **模型统计** | 按模型显示成功率、延迟和速度 |
| **关于** | 当前版本和 npm 上的最新版本；「更新」「卸载」一键完成（VPS 上要 root，这里给出命令） |

从插件市场装好后，dsh 一加载插件就会在后台自动安装（引擎随 npm 一起装好，不用连 GitHub），约 1 分钟；这时打开这一页能看到进度，没装成会显示原因，点「一键安装」再试。执行过 `dsh-model uninstall` 的机器不会被自动装回去。刚装好时有「开始使用」向导；插件更新后还没重启 dsh 时页面顶部会提示（dsh-vps 上可一键重启）；额度快用完时，dsh 任何页面的右下角都会提醒。所以从 dsh 的插件市场装好 dsh-model、打开这一页，就装好了。

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
| 魔搭 ModelScope | 免费·额度少 | 每天约 2000 次（单个模型另有上限，北京时间 0 点重置），要先绑定阿里云账号；key 填魔搭的访问令牌 |
| 腾讯混元 | 免费·额度少 | hunyuan-lite 免费（限并发），新用户送一笔 token |
| Mistral | 免费·额度少 | Experiment 档免费，验证手机号即可；免费档请求可能被用来训练 |
| NVIDIA（build.nvidia.com） | 免费·额度少 | 开发者试用免费，按每分钟次数限速 |
| 阿里云百炼、Moonshot、阶跃星辰 | 需付费 | 官方 API；百炼新用户每个模型约 100 万 token 免费（北京地域，约 90 天） |
| 火山方舟（豆包大模型）、MiniMax 开放平台、华为云 ModelArts | 需付费 | 官方 API，填 key 即可；火山方舟、华为云有新用户免费额度 |
| Cloudflare Workers AI | 免费·额度少 | 免费计划每天 1 万 Neurons，超额即停不扣钱；地址要填带账户 ID 的 |
| 书生 InternLM | 免费·额度少 | 测试期每月送额度 |
| 商汤日日新 SenseNova | 免费·额度少 | 公测期积分池（滚动 5 小时、每周上限），以账户页为准；没写用完会不会转付费，所以默认不进免费池。商汤小浣熊本身没有对外 API，它的积分只能在小浣熊里用，dsh-model 只替你签到 |
| 超算互联网、蚂蚁百灵、腾讯云 TokenHub | 需付费 | 新人 / 每月送额度，用完扣余额，所以默认不进免费池 |
| DeepSeek 官方、其他 OpenAI 兼容服务 | 需付费 | 填 API key（其他服务还要填地址；可以加多个，勾「免费额度」就进免费池） |
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
| `checkin` | 现在签到一次（11 家和自定义的服务；默认每天自动签） |
| `free [discover\|optin <来源> <上限>\|optout <来源>\|add <名字> <地址> <key> [--free <周期>]]` | 免费额度：总览、探测新额度、会扣钱的额度放进免费池、手动添加来源 |
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
- 引擎随 npm 一起装，国内免代理：引擎（CLIProxyAPI）按平台拆成了几个 npm 包，装 dsh-model 时只把当前平台那一个带下来（npm 国内有镜像），setup 不用再连 GitHub。npm 上没有对应平台的包时，才回退到从 GitHub 下载：这时 setup 会自动用上系统代理（Windows、macOS）或 `HTTPS_PROXY`，也可以用 `--proxy <地址>` 指定代理，或手动下载后设置 `DSH_MODEL_ENGINE_ARCHIVE`。
- Windows：后台服务登录后自动运行、不弹窗口。如果被杀毒软件拦下（程序不见了或启动不了），把 `%USERPROFILE%\.dsh-model` 加入信任，再执行 `dsh-model repair`。

## License

MIT
