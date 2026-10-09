# dsh-model

[English](README.en.md) · 中文

一个本机统一端点，把 **OpenCode Zen**、**WorkBuddy** 和你自己的 CLI 订阅（Codex 等）的模型汇到一起：dsh 用它，你的编辑器、脚本也用它。全程默认鉴权，可干净卸载；VPS 上可与 [dsh-vps](https://github.com/AIcivilization/dsh-vps) 组合自部署。

> 个人自用工具：不做多账号，不对外提供服务。

## 快速开始

```bash
# 尚未发布到 npm，先从 GitHub 安装：
npm install -g https://github.com/AIcivilization/dsh-model/archive/refs/heads/main.tar.gz && dsh-model --version
dsh-model setup
```

setup 依次完成下面几件事，可重复执行：

1. **统一端点**：下载并校验引擎（CLIProxyAPI，锁定版本），在 `127.0.0.1:8317/v1` 上运行，强制 key 鉴权。
2. **OpenCode Zen**：提示输入你的 API key（opencode.ai 免费注册），先用一个免费模型实测，通过后才保存。模型名带前缀 `opencode/`。
3. **WorkBuddy**：启动 dsh-model 自己的 **bridge**，模型名带前缀 `workbuddy/` 或 `workbuddy-ai/`。账号来源有两种：
   - Mac 上装了 WorkBuddy / WorkBuddy AI 桌面 App，就直接复用 App 的登录态，App 要先登录好；
   - 服务器上或者没装 App 时，执行 `dsh-model workbuddy login`（国际版加 `ai`）。它会打印一个链接，你在任意设备的浏览器里打开并授权即可，服务器上不需要浏览器。
4. **接进 dsh**：dsh 里只多出一个 provider `dsh-model`，上面所有模型都在这里。

其他软件填 `http://127.0.0.1:8317/v1`，key 用 `dsh-model key add <名称>` 领取。订阅上游另外用 `dsh-model login codex` 等命令登录。

## 命令

| 命令 | 作用 |
|---|---|
| `setup` | 安装统一端点并接入 OpenCode Zen、WorkBuddy 和 dsh（可重复执行） |
| `opencode [status\|key\|remove]` | 设置 / 更换 OpenCode Zen key，或移除（`--stdin` 从管道读 key） |
| `workbuddy login [cn\|ai]` / `logout` | 用 dsh-model 自己登录 WorkBuddy（打印链接，在任意浏览器授权，服务器可用） |
| `workbuddy [status\|enable\|refresh\|disable]` | WorkBuddy bridge。在 App 里换了账号或重新登录后，执行 `refresh` |
| `login <上游>` / `logout <上游>` | 订阅上游（codex、kimi、xai、meta；claude、antigravity 需加 `--accept-risk`） |
| `status` / `doctor [--e2e]` | 总览 / 逐项自检（`--e2e` 会对每组模型实测流式输出和工具调用） |
| `models [sync]` | 列出模型 / 同步到 dsh |
| `key list\|add\|revoke\|rotate` | 访问 key，建议每台设备一把 |
| `remote enable --via ssh\|tailscale\|caddy` | 远程访问 |
| `engine version\|upgrade\|rollback` | 引擎版本 |
| `service ...` / `repair` / `logs [--bridge]` | 服务 / 修复 / 日志 |
| `uninstall` | 干净卸载：还原 dsh 配置，移除两个服务和所有文件 |

所有命令都支持 `--lang zh|en` 和 `--json`。

## 架构

```
dsh · 编辑器 · 脚本 ──Bearer key──> 引擎 127.0.0.1:8317/v1（唯一入口）
                                        │
              ┌─────────────────────────┼──────────────────────────┐
              ▼                         ▼                          ▼
      订阅 OAuth（codex…）       opencode/*（你的 key）      workbuddy/* → bridge（127.0.0.1，内部密钥）
                                                                     → WorkBuddy App 登录态
```

- 引擎：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（MIT）。bridge 的 WorkBuddy 协议层移植自 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) v0.7.1（MIT），见 `src/bridge/workbuddy/`。
- dsh 里只写两样东西：`providers.dsh-model` 和 `refs.DSH_MODEL_API_KEY`。卸载时如果没被改过，逐字节还原。

详见 [设计文档](docs/DESIGN.md)。

## 注意

- WorkBuddy：bridge 会读取并解密 WorkBuddy App 本机保存的登录凭据，并以它的客户端身份调用接口。这可能不符合其服务条款，账号有风险；WorkBuddy 升级加密方式时可能失效。刷新后的令牌只存 dsh-model 自己的副本，不改写 App 的文件。Linux 服务器用 `dsh-model workbuddy login`。
- OpenCode Zen：免费档能否从第三方调用，以你的 key 实测结果为准。
- 订阅凭据在官方客户端之外使用，可能不符合部分服务商的条款。
- 支持 macOS 和 Linux，需要 Node ≥ 20。

## License

MIT
