# dsh-model 会连哪些地址（出网清单）

[English](#english) · 中文

> 结论：**dsh-model 没有自己的服务器，也没有遥测**。它只在你用到某个功能时，直接连那一家的官方地址；你的 key、登录和对话不会发给我们或任何第三方。
>
> 本清单按 0.30.0 的代码整理。可以自己复核：
> `grep -rhoE "https?://[a-zA-Z0-9.-]+" src plugin/index.js | sort -u`

## 1. 本机

| 地址 | 做什么 |
|---|---|
| `127.0.0.1:8317`（可改） | 统一端点：引擎在这里提供 OpenAI 兼容接口，**始终要求 key** |
| `127.0.0.1:18317`（默认） | 守护进程：设置页的控制接口（要密钥，只有本机用户读得到）和 WorkBuddy 等的转接 |
| `127.0.0.1:11434`、`127.0.0.1:1234` | 打开 Ollama / LM Studio 来源时，读本机模型 |

对外监听只有在你主动开启远程访问时才有：VPS 上经 Caddy 开 https，或你自己执行 `remote enable`。

## 2. 模型来源（只有你打开、登录了那一家才会连）

| 来源 | 地址 |
|---|---|
| Codex、Claude、Kimi、Grok、Muse、Devin、Antigravity | 由引擎 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（开源）直连各家官方接口 |
| Gemini | `generativelanguage.googleapis.com` |
| Groq | `api.groq.com` |
| OpenRouter | `openrouter.ai` |
| Mistral | `api.mistral.ai` |
| NVIDIA | `integrate.api.nvidia.com` |
| 硅基流动 | `api.siliconflow.cn` |
| 智谱 GLM | `open.bigmodel.cn` |
| 讯飞星火 | `spark-api-open.xf-yun.com` |
| 百度千帆 | `qianfan.baidubce.com` |
| 火山方舟 | `ark.cn-beijing.volces.com` |
| MiniMax | `api.minimaxi.com` |
| 华为云 ModelArts | `api.modelarts-maas.com` |
| 魔搭 ModelScope | `api-inference.modelscope.cn` |
| 腾讯混元 | `api.hunyuan.cloud.tencent.com` |
| 阿里云百炼 | `dashscope.aliyuncs.com` |
| Moonshot | `api.moonshot.cn` |
| 阶跃星辰 | `api.stepfun.com` |
| DeepSeek 官方 | `api.deepseek.com` |
| Cloudflare Workers AI | `api.cloudflare.com` |
| 超算互联网 | `api.scnet.cn` |
| 蚂蚁百灵 | `api.ant-ling.com` |
| 腾讯云 TokenHub | `tokenhub.tencentmaas.com` |
| 书生 InternLM | `chat.intern-ai.org.cn` |
| WorkBuddy / WorkBuddy AI | `copilot.tencent.com`、`www.codebuddy.cn` 等 WorkBuddy 自己的地址 |
| OpenCode Zen | `opencode.ai` |
| 自定义 | 你填的地址 |

国内平台直连，不走你设置的代理；其他的按你的代理设置走。

## 3. 用量查询（只查你登录了的订阅）

| 来源 | 地址 |
|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` |
| Kimi | `api.kimi.com/coding/v1/usages` |
| Grok | `cli-chat-proxy.grok.com/v1/billing` |
| Codex、WorkBuddy | 各自的官方用量接口 |

## 4. 每日签到（只签你添加了的账号）

| 产品 | 地址 |
|---|---|
| Trae | `api.trae.cn` |
| Qoder | `openapi.qoder.com.cn` / `openapi.qoder.sh` |
| WorkBuddy | WorkBuddy 自己的地址 |
| 豆包 | `www.doubao.com` |
| MiniMax Code | `agent.minimax.cn` / `agent.minimax.io`（签到）、`account.minimax.cn` / `account.minimax.io`（登录快过期时续期，和 App 一样） |
| WPS 灵犀 | `lingxi.wps.cn` |
| 百度 DuMate | `console.bce.baidu.com` |
| AStudio | `agent.xfyun.cn` |
| OfficeAce（华为云） | `auth.huaweicloud.com`（你在浏览器里登录）、`agentarts.cn-southwest-2.myhuaweicloud.com`（取回登录）、`sts.cn-north-4.myhuaweicloud.com`（换临时密钥）、`officeace.cn-southwest-2.huaweicloud-agentarts.com`（领积分） |
| 华为 CodeArts | `auth.huaweicloud.com`、`devcloud.cn-north-4.huaweicloud.com`（你在浏览器里登录，回调到本机 `127.0.0.1:8791`）、`snap-access.cn-north-4.myhuaweicloud.com`（换临时密钥、查积分、签到） |
| 你自己加的签到服务 | 你导入的那份定义里写的地址（导入前页面会列出来让你确认） |

## 5. 安装与更新

| 地址 | 做什么 |
|---|---|
| `registry.npmjs.org`（或你配置的 npm 镜像） | 安装、检查新版本、引擎平台包 |
| `registry.npmmirror.com`，不通再 `cdn.jsdelivr.net` | 每天拉一次 npm 上最新 dsh-model 包里的免费额度目录（`free-catalog.json`，一个公开的 JSON 文件），不带任何你的信息 |
| `github.com/router-for-me/CLIProxyAPI/releases` | 只在 npm 上没有你这个平台的引擎包时，回退下载引擎；按仓库里锁定的 sha256 校验 |

## 不做的事

- **不伪装客户端、不改写请求去绕过厂商的拦截**。比如 WorkBuddy 认出并拦下 dsh 的对话后，dsh-model 就只用它签到，不去规避。
- **不调各家 IDE 的私有对话接口**（Qoder、Trae 等只签到）。
- **不读你电脑上别的软件的登录**，例外只有下面几处，都只为签到、只在你本机使用：
  - Trae 签到读 Trae 自己的登录；
  - MiniMax Code、WPS 灵犀、百度 DuMate、AStudio 签到读它们各自 App 的登录（MiniMax 快过期时按 App 的规矩续期并写回）；
  - Mac 上 WorkBuddy 读 WorkBuddy App 的登录；
  - 你点「从本机自动读取」时，读豆包电脑版或浏览器里 doubao.com 的登录（macOS 会弹窗问你）。
- 签到账号「复制到另一台机器」是你自己发起的：加密的文本加提取码，不经过任何服务器。

---

## English

**dsh-model has no server of its own and no telemetry.** It talks to a vendor's official address only when you use that feature; your keys, sign-ins and conversations are never sent to us or to any third party. Sections above:
1. **Local**: the endpoint (always needs a key), the daemon's control port and the local model apps.
2. **Model sources**: each provider's official API, only for sources you turned on.
3. **Usage checks**: only for subscriptions you signed in to.
4. **Check-in**: only for the accounts you added.
5. **Install and update**: the npm registry, with GitHub only as the engine fallback (checked against pinned sha256); once a day the free-quota catalog (`free-catalog.json`) from the latest npm package via npmmirror or jsDelivr.

What dsh-model will not do:
- disguise itself as another client, or rewrite requests to get past a vendor's blocking;
- call IDEs' private chat APIs;
- read other apps' sign-ins. The exceptions are check-in only, on this machine: Trae, WorkBuddy, MiniMax Code, WPS Lingxi, Baidu DuMate and AStudio, and Doubao when you click "Read from this computer".
