<div align="center">

# dsh-model

**把多家模型汇成一个 OpenAI 兼容地址，dsh 和你的其他软件都能直接用。**

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/dsh-model" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/dsh-model"><img src="https://img.shields.io/npm/v/dsh-model?color=cb3837&logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.0--rc.2-4176E6" alt="DeepSeek Harness ≥ 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform: macOS / Linux">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white" alt="Node ≥ 20">
  <a href="https://github.com/router-for-me/CLIProxyAPI"><img src="https://img.shields.io/badge/engine-CLIProxyAPI%208.0.13-555" alt="Engine: CLIProxyAPI 8.0.13"></a>
</p>

[English](README.en.md) · 中文

</div>

## 它是什么

你可能同时有好几个模型来源：WorkBuddy 的免费积分、OpenCode Zen 的 key，还有已经付费的 Codex、Kimi 订阅。它们的接口和登录方式各不相同，每个软件都要分别配置。

dsh-model 把它们合成**一个地址、一种 key**：

- **dsh 里**：装好后自动出现在 dsh 的模型列表里，按来源分组，不用手动配置。
- **其他软件**：编辑器、脚本，凡是支持 OpenAI 接口的，填上同一个地址和 key 就能用全部模型。
- **省心**：一条命令装好；始终要求 key，不会出现谁都能用的情况；卸载时把 dsh 的配置原样还原。
- **服务器上**：可以和 [dsh-vps](https://github.com/AIcivilization/dsh-vps) 装在同一台 VPS 上，自动用 dsh 的域名开一个对外地址，你的电脑、手机都能访问。

> 个人自用工具：一个人、每家一个账号，不对外提供服务。

## 快速开始

```bash
npm install -g dsh-model
dsh-model setup
```

服务器上（装了 dsh-vps 的 VPS）用 `sudo dsh-model setup`。

`setup` 可以重复执行，它会依次：

1. 下载并校验引擎，在本机 `127.0.0.1:8317/v1` 上运行，强制 key 鉴权；
2. 接入 OpenCode Zen（输入你的 key，先实测再保存）和 WorkBuddy（dsh-model 自己的 bridge）；
3. 把管理页装进 dsh，把模型同步进 dsh；
4. 在 VPS 上，额外开通对外地址 `https://<dsh 的域名>:9443/v1`（没有域名时用 `<IP>.sslip.io`）。

## 在 dsh 里管理：设置 → dsh-model

| 区块 | 内容 |
|---|---|
| **访问地址** | 本机地址和外网地址，各带「复制」按钮 |
| **来源** | 每家一个开关：打开就接入（没登录会弹出登录框），关闭只停用、保留登录。每行标出「免费 / 免费·额度少 / 需付费」，下面显示套餐用量或剩余积分 |
| **选模型** | 每个来源选哪些模型显示在 dsh 里，默认每家推荐 5 个，其余的经统一地址照样可用 |
| **API key** | OpenAI 格式，每台设备一把。显示 24 小时内的请求数、成功率、延迟和速度，可复制、轮换、吊销 |
| **模型统计** | 按模型显示成功率、延迟和速度 |

登录全由 dsh-model 自己完成，服务器上不装各家的 CLI，也不需要浏览器：

- **WorkBuddy、Codex、Kimi、Grok、Muse**：打开链接授权即可，要验证码的弹窗里会给出；
- **Devin、Claude、Antigravity**：这几家会把浏览器跳到一个固定的本机地址，页面打不开是正常的。把地址栏里的地址带回来，点「从剪贴板粘贴」即可。

已登录但没有可用套餐的来源（比如 Kimi 账号没有开通 Kimi Code），dsh-model 会实测出来，把它的模型从 dsh 里隐藏，并给出开通链接。

> 更新 dsh-model 后，要重启一次 dsh，管理页的新代码才会生效。模型和开关的变化不需要重启。

## 来源与费用

| 来源 | 费用 | 说明 |
|---|---|---|
| WorkBuddy / WorkBuddy AI | 免费 | 账号自带积分 |
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
| `stats` | 按 key、来源、模型的成功率、延迟和速度 |
| `status` / `doctor [--e2e]` | 总览 / 逐项自检 |
| `models [sync]` | 列出模型 / 同步到 dsh |
| `remote enable --via caddy\|ssh\|tailscale` / `remote disable` | 远程访问（VPS 上 setup 已自动开通 caddy） |
| `engine version\|upgrade\|rollback` | 引擎版本 |
| `logs [--bridge]` / `repair` | 日志 / 修复 |
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

- 订阅和 WorkBuddy 的凭据在官方客户端之外使用，可能不符合服务商的条款，账号有风险，请自行判断。
- 支持 macOS 和 Linux，需要 Node ≥ 20。

## License

MIT
