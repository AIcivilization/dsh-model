# dsh-model

[English](README.en.md) · 中文

一条命令，把**你自己的** CLI 订阅（Codex 等）接进 dsh：装好引擎、接好线、默认带鉴权、能干净卸载。在 VPS 上可以和 [dsh-vps](https://github.com/AIcivilization/dsh-vps) 组合自部署。

对外暴露的是标准 OpenAI 兼容端点，你自己的编辑器、脚本也能用同一个地址。

> 个人自用工具：不做多账号，不对外提供服务。官方 API key 请直接在 dsh 里配置，dsh-model 不处理。

## 快速开始

```bash
# 尚未发布到 npm，先从 GitHub 安装：
npm install -g https://github.com/AIcivilization/dsh-model/archive/refs/heads/main.tar.gz
dsh-model setup          # 下载并校验引擎、生成 key、注册服务、接入 dsh
dsh-model login codex    # 登录订阅
```

登录后打开 dsh，模型列表里就会出现 dsh-model 提供的模型。dsh 的配置会热加载，不需要重启。

## 在 VPS 上（配合 dsh-vps）

```bash
sudo dsh-model setup
sudo dsh-model login codex --device       # 或者不加 --device，会打印 ssh 隧道命令和授权链接
sudo dsh-model remote enable --via ssh    # 可选：让你自己的其他设备访问
```

引擎以 `dsh` 用户运行，并且始终只监听 `127.0.0.1`。远程访问只有三条路：SSH 隧道、Tailscale，或 dsh-vps 的 Caddy。

## 支持的上游

| 上游 | 登录 |
|---|---|
| `codex` | 浏览器回调，或 `--device` |
| `kimi`、`xai`（Grok）、`meta`（Muse） | device-code |
| `claude`、`antigravity` | 浏览器回调，需加 `--accept-risk` |

每个上游只登录一个账号。要换账号，用 `--replace`。

## 命令

| 命令 | 作用 |
|---|---|
| `setup` | 一键安装并接入 dsh（可重复执行） |
| `login <上游>` / `logout <上游>` | 登录或退出订阅，完成后自动把模型同步到 dsh |
| `status` / `doctor [--e2e]` | 查看总览 / 逐项自检（`--e2e` 会实际测试流式输出和工具调用） |
| `connect-dsh [--dry-run]` / `disconnect-dsh` | 写入或还原 dsh 配置 |
| `models [sync]` | 列出模型 / 同步到 dsh |
| `key list\|add\|revoke\|rotate` | 管理访问 key，建议每台设备一把 |
| `remote enable --via ssh\|tailscale\|caddy` / `remote disable` | 远程访问 |
| `engine version\|upgrade\|rollback` | 引擎版本：升级前先试运行，失败会自动回滚 |
| `service ...` / `repair` / `logs` | 服务管理 / 按台账修复 / 查看日志 |
| `uninstall [--keep-auth]` | 干净卸载：还原 dsh 配置，删除服务和所有文件 |

所有命令都支持 `--lang zh|en`（默认跟随系统语言）和 `--json`。

## 架构

```
dsh · 你的其他工具  ──Bearer key──>  127.0.0.1:8317/v1
                                           │
                               CLIProxyAPI 引擎（锁定版本，系统服务守护）
                                           │
                                       各家订阅上游
```

- 引擎是 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（MIT），负责协议翻译和 OAuth。版本锁定在 [engine-manifest.json](engine-manifest.json)，安装时会做 sha256 校验。
- dsh-model 本身不常驻，只负责安装、生成配置、接入 dsh、管理 key、管理服务、诊断和卸载。
- 写入 dsh 的内容只有两处：`profiles/<p>/cordis.patch.yml` 里的 `providers.dsh-model`，以及 `.credentials.yaml` 里的 `refs.DSH_MODEL_API_KEY`。卸载时，如果这两个文件之后没被改过，会逐字节还原；改过的话，只删掉 dsh-model 写入的部分。

详见 [设计文档](docs/DESIGN.md)、[M0 实测结论](docs/M0-findings.md)、[调研附录](docs/RESEARCH.md)。

## 故障排查

- **dsh 里看不到模型**：先执行 `dsh-model status`，确认至少登录了一个上游；然后执行 `dsh-model models sync`。
- **报"dsh 正处于崩溃恢复状态"**：先正常启动一次 dsh，再重试。
- **报 dsh 版本不在验证区间**：dsh 的配置格式可能变了，可以先用 `connect-dsh --dry-run` 看看会改什么，确认没问题再加 `--force`。
- **引擎没启动**：查看 `dsh-model logs`，再执行 `dsh-model repair`。
- **环境变量 `DSH_MODEL_API_KEY`**：它会覆盖 dsh 凭据文件里的同名值，`doctor` 检测到会提示。

## 注意

- 在官方客户端之外使用订阅凭据，可能不符合部分服务商的条款，有账号风险。Claude 和 Antigravity 必须加 `--accept-risk` 才能登录。请自行判断、自担风险。
- 支持 macOS 和 Linux，暂不支持 Windows。需要 Node ≥ 20。

## License

MIT
