# dsh-model

English · [中文](README.md)

One local endpoint that brings together models from **OpenCode Zen**, **WorkBuddy**, and your own CLI subscriptions (Codex and others). dsh uses it, and so can your editors and scripts. Auth is on by default and it uninstalls cleanly. On a VPS it pairs with [dsh-vps](https://github.com/AIcivilization/dsh-vps) for self-hosting.

> A personal tool: no multi-account, no serving other people.

## Quick start

```bash
# Not on npm yet; install from GitHub:
npm install -g https://github.com/AIcivilization/dsh-model/archive/refs/heads/main.tar.gz && dsh-model --version
dsh-model setup
```

setup does the following, in order, and is safe to re-run:

1. **Unified endpoint**: downloads and verifies the engine (CLIProxyAPI, pinned), runs it on `127.0.0.1:8317/v1`, and requires a key.
2. **OpenCode Zen**: prompts for your API key (free sign-up at opencode.ai), tests it against a free model, and saves it only if the test passes. Models are prefixed `opencode/`.
3. **WorkBuddy**: when the WorkBuddy / WorkBuddy AI desktop app is found, starts dsh-model's own **bridge**, which reads the app's sign-in. Models are prefixed `workbuddy/` or `workbuddy-ai/`. Sign in to the app first.
4. **dsh**: adds a single provider, `dsh-model`, that carries all of the models above.

Other software uses `http://127.0.0.1:8317/v1` with a key from `dsh-model key add <name>`. Log in to subscription upstreams with `dsh-model login codex` and so on.

## Commands

| Command | Purpose |
|---|---|
| `setup` | Install the unified endpoint and connect OpenCode Zen, WorkBuddy and dsh (safe to re-run) |
| `opencode [status\|key\|remove]` | Set / change the OpenCode Zen key, or remove it (`--stdin` reads the key from a pipe) |
| `workbuddy [status\|enable\|refresh\|disable]` | WorkBuddy bridge. Run `refresh` after switching accounts or signing in again in the app |
| `login <up>` / `logout <up>` | Subscription upstreams (codex, kimi, xai, meta; claude and antigravity need `--accept-risk`) |
| `status` / `doctor [--e2e]` | Overview / health checks (`--e2e` tests streaming and tool calls for one model per group) |
| `models [sync]` | List models / sync them to dsh |
| `key list\|add\|revoke\|rotate` | Access keys, ideally one per device |
| `remote enable --via ssh\|tailscale\|caddy` | Remote access |
| `engine version\|upgrade\|rollback` | Engine version |
| `service ...` / `repair` / `logs [--bridge]` | Services / repair / logs |
| `uninstall` | Clean uninstall: restore dsh config, remove both services and all files |

Every command accepts `--lang zh|en` and `--json`.

## How it works

```
dsh · editors · scripts ──Bearer key──> engine 127.0.0.1:8317/v1 (single entry)
                                             │
            ┌────────────────────────────────┼─────────────────────────────┐
            ▼                                ▼                             ▼
  subscription OAuth (codex…)     opencode/* (your key)      workbuddy/* → bridge (127.0.0.1, internal secret)
                                                                         → WorkBuddy app sign-in
```

- Engine: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT). The bridge's WorkBuddy protocol layer is ported from [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) v0.7.1 (MIT); see `src/bridge/workbuddy/`.
- dsh gets exactly two entries: `providers.dsh-model` and `refs.DSH_MODEL_API_KEY`. If neither has changed by uninstall time, both are restored byte-for-byte.

See the [design doc](docs/DESIGN.md) (in Chinese).

## Notes

- WorkBuddy: the bridge reads and decrypts the WorkBuddy app's locally stored sign-in and calls its API as the WorkBuddy client. This may conflict with its terms and puts the account at risk; it may break when WorkBuddy changes its encryption. Refreshed tokens are kept only in dsh-model's own copy; the app's files are never rewritten. macOS only for now; Linux servers (CodeBuddy Code CLI) are still to be tested.
- OpenCode Zen: whether the free tier works from third-party tools depends on what your key's test shows.
- Using subscription credentials outside the official clients may conflict with some providers' terms.
- macOS and Linux, Node ≥ 20.

## License

MIT
