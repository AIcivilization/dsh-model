<div align="center">

# dsh-model

**Many model sources behind one OpenAI-compatible endpoint — for dsh and every other tool you use.**

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/dsh-model" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/dsh-model"><img src="https://img.shields.io/npm/v/dsh-model?color=cb3837&logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.0--rc.2-4176E6" alt="DeepSeek Harness ≥ 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="Platform: macOS / Linux">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white" alt="Node ≥ 20">
  <a href="https://github.com/router-for-me/CLIProxyAPI"><img src="https://img.shields.io/badge/engine-CLIProxyAPI%208.0.13-555" alt="Engine: CLIProxyAPI 8.0.13"></a>
</p>

English · [中文](README.md)

</div>

## What it is

You may have several model sources at once: free WorkBuddy credits, an OpenCode Zen key, paid Codex or Kimi subscriptions. Each has its own API and sign-in, and every tool needs its own setup.

dsh-model turns them into **one address and one kind of key**:

- **In dsh**: the models show up in dsh's model list automatically, grouped by source. Nothing to configure.
- **Everywhere else**: any editor or script that speaks the OpenAI API uses the same address and key to reach every model.
- **Low maintenance**: one command to install; a key is always required; uninstall restores dsh's config exactly.
- **On a server**: runs next to [dsh-vps](https://github.com/AIcivilization/dsh-vps) on the same VPS and opens a public address on dsh's own domain, so your laptop and phone can use it too.

> A personal tool: one person, one account per provider, not a public service.

## Quick start

```bash
npm install -g dsh-model
dsh-model setup
```

On a dsh-vps server, use `sudo dsh-model setup`.

`setup` is safe to re-run. It:

1. downloads and verifies the engine and runs it on `127.0.0.1:8317/v1`, with key auth enforced;
2. connects OpenCode Zen (enter your key; it is tested before being saved) and WorkBuddy (dsh-model's own bridge);
3. installs the management page into dsh and syncs the models into dsh;
4. on a VPS, also opens a public address `https://<dsh's domain>:9443/v1` (or `<IP>.sslip.io` when there is no domain).

## Manage it in dsh: Settings → dsh-model

| Section | What it holds |
|---|---|
| **Endpoint** | Local and public addresses, each with a Copy button |
| **Sources** | One switch per provider: on connects (and signs in if needed), off pauses and keeps the sign-in. Each row is tagged Free / Free · limited / Paid and shows plan usage or remaining credits |
| **Models** | Pick which models of each source appear in dsh (5 suggested per source by default); the rest stay available through the endpoint |
| **API keys** | OpenAI-style, one per device. Requests, success rate, latency and speed over 24 hours; copy, rotate, revoke |
| **Model stats** | Success rate, latency and speed per model |
| **About** | Current and latest npm version; one-click Update and Uninstall (on a VPS these need root, so the commands are shown instead) |

If the service is not set up on this machine yet, the page says what is missing and offers a "Set up now" button, so you can also start by installing dsh-model from the dsh plugin marketplace and finish from this page.

dsh-model does every sign-in itself. No provider CLI is installed and the server needs no browser:

- **WorkBuddy, Codex, Kimi, Grok, Muse**: open the link and approve; if a code is needed, the dialog shows it;
- **Devin, Claude, Antigravity**: these send the browser to a fixed local address that will not load. That is expected: bring the address back and press "Paste from clipboard".

If a source is signed in but has no usable plan (say, a Kimi account without Kimi Code), dsh-model detects it, hides its models in dsh and shows where to subscribe.

> After updating dsh-model, restart dsh once so the management page picks up the new code. Model and switch changes need no restart.

## Sources and cost

| Source | Cost | Notes |
|---|---|---|
| WorkBuddy / WorkBuddy AI | Free | Credits come with the account |
| Codex | Paid | ChatGPT Plus / Pro |
| Kimi | Paid | Kimi Code plan |
| Grok | Paid | SuperGrok / X Premium+ |
| Muse | Paid | Muse Code plan |
| Devin | Paid | The free tier is refused in testing |
| OpenCode Zen | Paid | Pay as you go after a top-up; its free models only work inside the OpenCode app |
| Claude, Antigravity | High risk, hidden by default | The providers have banned third-party use before |

dsh-model only connects; it provides no quota of its own.

## Commands

| Command | What it does |
|---|---|
| `setup` | Install / repair everything (idempotent) |
| `sources` | Sources: switch, cost, sign-in state, usage |
| `source enable\|disable\|logout <source>` | Turn on (signing in if needed) / off / sign out |
| `key list\|add\|revoke\|rotate <name>` | Access keys, one per device |
| `stats` | Success rate, latency and speed by key, source and model |
| `status` / `doctor [--e2e]` | Overview / health checks |
| `models [sync]` | List models / sync them to dsh |
| `remote enable --via caddy\|ssh\|tailscale` / `remote disable` | Remote access (on a VPS, setup already enables caddy) |
| `engine version\|upgrade\|rollback` | Engine version |
| `logs [--bridge]` / `repair` | Logs / repair |
| `update [--to ver]` | Update to the latest npm version: program, dsh plugin and services together |
| `uninstall` | Clean uninstall |

Every command accepts `--lang zh|en` and `--json`.

## Architecture

```
dsh · editors · scripts ──Bearer key──▶ engine 127.0.0.1:8317/v1 (the only entry)
                                          │      ▲ VPS: Caddy https://<dsh domain>:9443
             ┌────────────────────────────┼─────────────────────────┐
             ▼                            ▼                         ▼
   subscription OAuth (Codex, Kimi…)   opencode/* (your key)   workbuddy/* → dsh-model's bridge
```

- The engine is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT), version-pinned and sha256-verified. The WorkBuddy protocol layer is ported from [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT); the usage endpoints follow [CodexBar](https://github.com/steipete/CodexBar) (MIT).
- dsh-model writes only two things into dsh: the model providers and `refs.DSH_MODEL_API_KEY`. On uninstall they are restored byte for byte if nobody changed them.

See the [design doc](docs/DESIGN.md) (Chinese).

## Notes

- Using subscription and WorkBuddy credentials outside the official clients may break the providers' terms and put the account at risk. Decide for yourself.
- macOS and Linux, Node ≥ 20.

## License

MIT
