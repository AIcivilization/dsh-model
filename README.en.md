<div align="center">

# dsh-model

**📅 Daily check-in credits claimed for you · 🔁 one address that relays every model · 🧩 free and subscription models, your pick**

Install once and all three are taken care of. dsh gets a management page; without dsh, the command line does everything.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AIcivilization/dsh-model" alt="MIT license"></a>
  <a href="https://www.npmjs.com/package/dsh-model"><img src="https://img.shields.io/npm/v/dsh-model?color=cb3837&logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A5%200.2.0--rc.2-4176E6" alt="DeepSeek Harness ≥ 0.2.0-rc.2">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue" alt="Platform: Windows / macOS / Linux">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white" alt="Node ≥ 20">
  <a href="https://github.com/router-for-me/CLIProxyAPI"><img src="https://img.shields.io/badge/engine-CLIProxyAPI%208.0.13-555" alt="Engine: CLIProxyAPI 8.0.13"></a>
</p>

English · [中文](README.md)

</div>

## 📅 1. Daily check-in: credits land on their own

**The most hands-off part: no more remembering to claim the daily check-in credits.**

| Product | How it connects | Every day |
|---|---|---|
| **Trae** | Detected automatically if Trae is installed and signed in; nothing to do | Check-in credits (200 a day in testing) |
| **Qoder** | Paste a personal access token once (China or international) | That day's check-in credits |
| **WorkBuddy (China)** | Sign in once | Check-in credits |

- **Automatic by default**: done at a random 5–55 minutes after midnight Beijing time; failures retry an hour later; if the computer was off, it catches up within a minute of starting.
- **You can see it**: one line at the top of the settings page, "Checked in today: …", with a one-click "Check in all" for anything missed, plus a one-time notice in the corner of dsh.
- **Check-in only, credits untouched**: they stay on your account for use in each product's own app. Command line: `dsh-model checkin`.

## 🔁 2. Relay: one address, one key, every model

Your model sources each have their own API and sign-in. dsh-model puts them behind **one OpenAI-compatible address**:

- **Shows up in dsh**: every model, grouped by source, with nothing to configure.
- **Works in other tools**: Cline, Continue, Cherry Studio, scripts: anything that speaks the OpenAI API uses the same address and key.
- **Rate limits are not the end**: build a combo (say Codex → Kimi → Gemini) and the next model takes over on a rate limit, used-up quota or error.
- **Know where you stand**: plan usage with reset countdowns, success rate and speed per model, recent failures with what to do, and a notice when quota runs low.
- **Secure by default**: a key is always required, one per device, revocable any time; every sign-in happens on your own machine.
- **Laptop or server**: Windows, macOS, Linux; on a VPS (with [dsh-vps](https://github.com/AIcivilization/dsh-vps)) it opens an https address you can use from anywhere. Uninstall restores dsh's config byte for byte.

## 🧩 3. Models: free or subscription, connect what you have

| Kind | Sources |
|---|---|
| **Free (suggested)** | **SiliconFlow** (reachable from China; some models free after identity verification), **Gemini** (if you can reach Google; the best free models) |
| Free · limited | Groq, OpenRouter (`:free` models) |
| Local | Ollama, LM Studio: appear once started, no sign-in |
| Subscription | Codex (ChatGPT Plus / Pro), Kimi Code, Grok, Muse, Devin: sign in from the management page |
| Pay as you go | DeepSeek official, OpenCode Zen, any OpenAI-compatible service |

Every source is tagged Free / Free · limited / Paid; see [Sources and cost](#sources-and-cost) below. dsh-model only connects; it provides no quota of its own.

> WorkBuddy: since 2026-10 it recognises conversations sent by dsh and blocks them, so dsh-model uses it for check-in only and does not connect its models by default.


## Quick start

```bash
npm install -g dsh-model
dsh-model setup
```

On a dsh-vps server, use `sudo dsh-model setup`. On Windows, run it in a normal PowerShell or Command Prompt; no administrator rights needed.

`setup` is safe to re-run. It:

1. downloads and verifies the engine and runs it on `127.0.0.1:8317/v1`, with key auth enforced;
2. starts dsh-model's daemon (the management page, check-in and sign-ins run on it). Setup asks for no keys: for a free source we suggest **SiliconFlow** (reachable from China) or **Gemini** (if you can reach Google), added from the management page. WorkBuddy is used for check-in only; its models are not connected to dsh by default;
3. installs the management page into dsh and syncs the models into dsh;
4. on a VPS, also opens a public address `https://<dsh's domain>:9443/v1` (or `<IP>.sslip.io` when there is no domain).

## Manage it in dsh: Settings → dsh-model

| Section | What it holds |
|---|---|
| **Daily check-in** | WorkBuddy (China), Qoder and Trae are checked in automatically every day (or with one click); the card shows what you got today |
| **Endpoint** | Local and public addresses, each with a Copy button |
| **Sources** | One switch per provider: on connects (and signs in if needed), off pauses and keeps the sign-in. Each row is tagged Free / Free · limited / Paid and shows plan usage with reset countdowns, or remaining credits and the next batch to expire; a used-up plan shows when it comes back |
| **Models** | Pick which models of each source appear in dsh (5 suggested per source by default); the rest stay available through the endpoint; a "Test" button per model |
| **Combos** | Put several models in order and it becomes one model in dsh: the first is used, and the next takes over on a rate limit, used-up quota or error. Other tools use the model name `combo/<id>` |
| **Auto switch** | When a model is offered by several sources, dsh gets an "Auto switch (multiple sources)" group that moves to another source when one is rate-limited or failing |
| **Recent failures** | Failed requests in the last 24 hours: which model, why, and what to do (no conversation content kept) |
| **API keys** | OpenAI-style, one per device. Requests, success rate, latency and speed over 24 hours; copy, rotate, revoke |
| **Model stats** | Success rate, latency and speed per model |
| **About** | Current and latest npm version; one-click Update and Uninstall (on a VPS these need root, so the commands are shown instead) |

If the service is not set up on this machine yet, the page says what is missing and offers a "Set up now" button with live progress. A "Getting started" guide appears on a fresh install; a banner shows when the plugin was updated but dsh not restarted (one-click restart on dsh-vps); a low-quota notice appears in the corner of any dsh page. so you can also start by installing dsh-model from the dsh plugin marketplace and finish from this page.

dsh-model does every sign-in itself. No provider CLI is installed and the server needs no browser:

- **WorkBuddy, Codex, Kimi, Grok, Muse**: open the link and approve; if a code is needed, the dialog shows it;
- **Devin, Claude, Antigravity**: these send the browser to a fixed local address that will not load. That is expected: bring the address back and press "Paste from clipboard".

If a source is signed in but has no usable plan (say, a Kimi account without Kimi Code), dsh-model detects it, hides its models in dsh and shows where to subscribe.

> After updating dsh-model, restart dsh once so the management page picks up the new code. Model and switch changes need no restart.

## Sources and cost

| Source | Cost | Notes |
|---|---|---|
| WorkBuddy / WorkBuddy AI | Free | Credits come with the account. **Since 2026-10 WorkBuddy recognises conversations sent by dsh and blocks them**, so it barely works inside dsh; check-in still works |
| Ollama / LM Studio | Free | Models running on this machine; they appear once installed and started, no sign-in |
| Gemini (Google AI Studio), Groq | Free · limited | Paste a free API key; daily / per-minute limits apply |
| OpenRouter | Free · limited | `:free` models are free (about 50 requests a day) |
| SiliconFlow | Free · limited | Some small models are free after identity verification |
| DeepSeek official, any OpenAI-compatible service | Paid | Paste an API key (and a URL for other services) |
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
| `checkin` | Check in now (WorkBuddy China, Qoder, Trae; automatic daily by default) |
| `combo list\|add <name> <model…>\|remove <id>` | Combos: try several models in order |
| `failures` | Failed requests in the last 24 hours, with advice |
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

- Meant for personal use: one account of your own per provider; do not use it to serve others.
- Using subscription and WorkBuddy credentials outside the official clients may break the providers' terms and put the account at risk. Decide for yourself.
- Windows 10 / 11 (x64, ARM64), macOS and Linux, Node ≥ 20.
- Windows: the background services start at sign-in with no window. If an antivirus blocks them (the program is gone or will not start), trust `%USERPROFILE%\.dsh-model` and run `dsh-model repair`.

## License

MIT
