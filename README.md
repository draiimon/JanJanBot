# Yuma — Discord AI Bot

A self-hosted Discord bot with persistent AI memory, voice channel integration, live audio streaming, and a terminal-style web dashboard. Built for 24/7 deployment on Render (Docker).

---

## Features

- **AI Chat** — Context-aware replies powered by Groq (LLaMA / Mixtral). Per-user memory stored in PostgreSQL — the bot remembers conversation history across sessions.
- **Voice — TTS & STT** — Speaks responses aloud in voice channels via TTS. Listens and transcribes speech via Groq Whisper (STT).
- **24/7 Voice Persistence** — Saves the last joined voice channel to the database. Auto-rejoins on restart, disconnect, or kick. Configurable auto-rejoin toggle per server.
- **Live Audio Stream** — Web dashboard at `/listen` streams the bot's voice channel audio in real-time over WebSocket to any browser.
- **Image Generation** — Generates images via Leonardo AI on command.
- **Web Research** — Pulls live search results via Tavily and summarizes them.
- **Channel Summarizer** — Backread and summarize recent chat history on demand.
- **Health Endpoints** — `/health` provides a minimal public liveness check, `/ready` reports dependency readiness, and authenticated `/diagnostics` provides operational detail.
- **Cosmetic Voice State** — Bot appears muted and deafened in Discord while still fully functional internally.

---

## Requirements

- Node.js 22+
- Python 3.11+
- FFmpeg
- PostgreSQL database
- Discord bot token
- Groq API key (supports key rotation: `GROQ_API_KEY1` through `GROQ_API_KEY6`)

Optional:
- `TAVILY_API_KEY` — web research
- `LEONARDO_API_KEY` — image generation
- `DEEPSEEK_API_KEY` — fallback AI model

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `GROQ_API_KEY` | ✅ | Groq API key (or use `GROQ_API_KEY1`–`GROQ_API_KEY6`) |
| `TAVILY_API_KEY` | ❌ | For web research commands |
| `LEONARDO_API_KEY` | ❌ | For image generation |
| `DEEPSEEK_API_KEY` | ❌ | Fallback AI model |
| `WEB_ENABLED` | ❌ | Set to `true` to enable the web dashboard |
| `LISTEN_PASSKEY` | If web enabled | Strong listener access passphrase, at least 16 characters |
| `SESSION_SECRET` | If web enabled | Unique session signing secret, at least 32 characters |
| `GROQ_STARTUP_PROBE_ENABLED` | ❌ | Defaults to `false`; if enabled, sends one small billable request per configured Groq key at each startup |

Never commit `.env` or paste secret values into logs or issue reports. Use Render's environment settings for deployment secrets. The example file contains placeholders only.

---

## Running Locally

```bash
npm ci
npm test
npm run check
npm start
```

The bot connects to Discord and optionally starts a web server on port `3000` (or `PORT` env var). Unit tests use fakes and do not connect to Discord or call paid providers. `npm run test:groq-keys` is an optional real API smoke test and may use provider credits.

---

## Deploying to Render

A `render.yaml` is included for Docker deployment; `render.fast.yaml` is the native Node alternative and installs exactly from the lockfile.

1. Create a Render web service from `render.yaml` (Docker) or `render.fast.yaml` (native Node).
2. Set `DISCORD_TOKEN`, `DATABASE_URL`, at least one `GROQ_API_KEY` slot, `SESSION_SECRET`, and `LISTEN_PASSKEY` in Render's environment settings. Add optional API keys only for features you use.
3. Deploy. The service needs outbound access to Discord and the configured providers; Render sets `PORT` automatically.

The included manifests select Render's free plan. Free services can spin down when idle, so they are not suitable for a Discord bot that must maintain a continuous gateway/voice connection. Use an always-on paid instance for reliable 24/7 operation; do not enable self-pinging as a workaround for free-tier idling. Local/container filesystems are not durable storage, so keep persistent state in PostgreSQL.

Web endpoints (when `WEB_ENABLED=true`):

| Endpoint | Description |
|---|---|
| `/` | Terminal-style status dashboard |
| `/listen` | Passkey sign-in for live voice audio; listener WebSocket and control APIs require a signed session |
| `/health` | Minimal public liveness check for Render |
| `/ping` | Uptime check |
| `/ready` | Discord, database, and shutdown readiness check |
| `/diagnostics` | Detailed runtime diagnostics; requires listener session |
| `/voice-status` | Voice stream status; requires listener session |

---

## Commands

| Command | Description |
|---|---|
| `j!join` | Join your current voice channel |
| `j!leave` | Leave the voice channel |
| `j!vc <text>` | Speak text aloud in the voice channel (TTS) |
| `j!autotts on/off` | Toggle automatic TTS for all messages |
| `j!ask <question>` | Ask the bot a question (STT-aware) |
| `j!listen` | Start listening / transcribing voice |
| `j!stop` | Stop listening or TTS |
| `j!chat <message>` | Direct AI chat message |
| `j!research <query>` | Web search + AI summary |
| `j!summarize` | Summarize recent channel messages |
| `j!img <prompt>` | Generate an image |
| `j!portray <prompt>` | Generate a portrait-style image |
| `j!view [@user]` | View user profile and memory summary |
| `j!status <text>` | Set bot status/activity |
| `j!stats` | Server statistics |
| `j!ping` | Latency check |
| `j!help` | Full command list |
| `j!admin` | Admin panel (restricted) |

---

## Project Structure

```
index.js              # Main bot entry — all Discord logic, commands, event handlers
src/
  voice/              # Voice connection, TTS, STT, live audio streaming
  server/             # HTTP web server and dashboard
scripts/              # Utility and setup scripts
public/               # Static assets (background, etc.)
data/                 # Runtime data (gitignored)
docs/                 # Additional documentation
```

---

## License

MIT
