# dsh-model

English · [中文](README.md)

One command to wire **your own** CLI subscriptions (Codex and others) into dsh. It installs the engine, connects it to dsh, turns on auth by default, and uninstalls cleanly. On a VPS it pairs with [dsh-vps](https://github.com/AIcivilization/dsh-vps) for self-hosting.

It exposes a standard OpenAI-compatible endpoint, so your own editors and scripts can use the same address.

> A personal tool: no multi-account, no serving other people. For official API keys, configure them in dsh directly; dsh-model does not handle them.

## Quick start

```bash
npm install -g dsh-model
dsh-model setup          # download + verify engine, create key, register service, connect dsh
dsh-model login codex    # log in to your subscription
```

Once you log in, open dsh and the dsh-model models appear in the model list. dsh hot-reloads its config, so there is no need to restart it.

## On a VPS (with dsh-vps)

```bash
sudo dsh-model setup
sudo dsh-model login codex --device       # without --device it prints an ssh tunnel command and an auth URL
sudo dsh-model remote enable --via ssh    # optional: access from your other devices
```

The engine runs as the `dsh` user and only ever listens on `127.0.0.1`. Remote access goes through an SSH tunnel, Tailscale, or dsh-vps's Caddy, and nothing else.

## Upstreams

| Upstream | Login |
|---|---|
| `codex` | browser callback, or `--device` |
| `kimi`, `xai` (Grok), `meta` (Muse) | device code |
| `claude`, `antigravity` | browser callback, requires `--accept-risk` |

You can log in to one account per upstream. To switch accounts, use `--replace`.

## Commands

| Command | Purpose |
|---|---|
| `setup` | One-step install and dsh wiring (safe to re-run) |
| `login <up>` / `logout <up>` | Log in or out; models are then synced to dsh automatically |
| `status` / `doctor [--e2e]` | Overview / health checks (`--e2e` tests streaming and tool calls for real) |
| `connect-dsh [--dry-run]` / `disconnect-dsh` | Write or restore dsh config |
| `models [sync]` | List models / sync them to dsh |
| `key list\|add\|revoke\|rotate` | Access keys, ideally one per device |
| `remote enable --via ssh\|tailscale\|caddy` / `remote disable` | Remote access |
| `engine version\|upgrade\|rollback` | Engine version: trial run before switching, automatic rollback on failure |
| `service ...` / `repair` / `logs` | Service control / repair from the ledger / view logs |
| `uninstall [--keep-auth]` | Clean uninstall: restore dsh config, remove the service and all files |

Every command accepts `--lang zh|en` (defaults to your system language) and `--json`.

## How it works

```
dsh · your other tools  ──Bearer key──>  127.0.0.1:8317/v1
                                               │
                                 CLIProxyAPI engine (pinned, run as a service)
                                               │
                                     subscription upstreams
```

- The engine is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT). It handles protocol translation and OAuth. Its version is pinned in [engine-manifest.json](engine-manifest.json) and verified by sha256 at install time.
- dsh-model itself does not keep running. It only installs, generates config, connects dsh, manages keys and the service, runs diagnostics, and uninstalls.
- It writes exactly two things into dsh: `providers.dsh-model` in `profiles/<p>/cordis.patch.yml`, and `refs.DSH_MODEL_API_KEY` in `.credentials.yaml`. On uninstall, if neither file has changed since, both are restored byte-for-byte. If they have changed, only dsh-model's own entries are removed.

See the [design doc](docs/DESIGN.md), [M0 findings](docs/M0-findings.md), and [research notes](docs/RESEARCH.md) (in Chinese).

## Troubleshooting

- **No models in dsh**: run `dsh-model status` and make sure at least one upstream is logged in, then run `dsh-model models sync`.
- **"dsh is in crash recovery"**: start dsh once normally, then retry.
- **dsh version outside the verified range**: dsh's config format may have changed. Preview the change with `connect-dsh --dry-run`, then add `--force` if it looks right.
- **Engine not running**: check `dsh-model logs`, then run `dsh-model repair`.
- **`DSH_MODEL_API_KEY` env var**: it overrides the value in dsh's credentials file. `doctor` warns when it finds it.

## Notes

- Using subscription credentials outside the official clients may conflict with some providers' terms and puts your account at risk. Logging in to Claude or Antigravity requires `--accept-risk`. Decide for yourself; the risk is yours.
- macOS and Linux only; no Windows yet. Requires Node ≥ 20.

## License

MIT
