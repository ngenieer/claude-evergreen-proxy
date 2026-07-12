# Claude Evergreen Proxy

> A self-updating fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) (via [wende](https://github.com/wende/claude-max-api-proxy)). Its model registry **discovers** the CLI's current models, **probes** them, and **refreshes daily** — so the model list stays current with no hardcoded names and no manual updates. (Plus OpenClaw integration and improved streaming from upstream.)

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes both an **OpenAI-compatible** (`POST /v1/chat/completions`) and an **Anthropic-compatible** (`POST /v1/messages`) HTTP API, so any OpenAI or Anthropic client can use your Claude Max subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude Max | $200/month flat | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses Max subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Max API Proxy (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from Max subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — `POST /v1/chat/completions` for any OpenAI client
- **Anthropic-compatible API** — `POST /v1/messages` (Messages API) for any Anthropic client
- **Streaming support** — Server-Sent Events for both endpoints (the OpenAI endpoint streams token-by-token; the Anthropic endpoint emits the spec-compliant event sequence once the result is complete)
- **Self-updating model list** — discovered from the CLI and probed daily; bare aliases (`opus`/`sonnet`/`haiku`/`fable`) always work
- **Honest errors** — CLI failures (e.g. unknown/retired model) surface as proper HTTP errors, not fake completions
- **OpenClaw integration** — Automatic tool name mapping and system prompt adaptation (disable with `CLAUDE_PROXY_OPENCLAW=0`)
- **Content block handling** — Proper text block separators for multi-block responses
- **Optional API key** — set `CLAUDE_PROXY_API_KEY` to require auth on `/v1` routes
- **Auto-start service** — LaunchAgent on macOS, systemd user unit on Linux
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — `spawn()` (no shell interpretation), localhost-only binding, CORS off by default

## What's Different from the Original

- **OpenClaw tool mapping** — Maps OpenClaw tool names (`exec`, `read`, `web_search`, etc.) to Claude Code equivalents (`Bash`, `Read`, `WebSearch`)
- **System prompt stripping** — Removes OpenClaw-specific tooling sections that confuse the CLI
- **Content block support** — Handles `input_text` content blocks and multi-block text separators
- **Tool call types** — Full OpenAI tool call type definitions for streaming and non-streaming
- **Improved streaming** — Better SSE handling with connection confirmation and client disconnect detection

## Prerequisites

1. **Claude Max subscription** ($200/month) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/sizlon/claude-evergreen-proxy.git
cd claude-evergreen-proxy

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
npm start
# or
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. Pass a custom port as an argument:

```bash
node dist/server/standalone.js 8080
```

Run `node dist/server/standalone.js --help` for all commands and environment variables. (Installed globally, the same entry point is available as `claude-evergreen`.)

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | OpenAI chat completions (streaming & non-streaming) |
| `/v1/messages` | POST | Anthropic Messages API (streaming & non-streaming) |

## Available Models

Bare aliases resolve to the current model in each family; explicit versioned ids pin an exact version.

| Request | Resolves to |
|---------|-------------|
| `opus` / `sonnet` / `haiku` / `fable` | the current model in that family (resolved by the CLI) |
| `claude-<family>-<version>` — e.g. `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5` | that exact version, passed straight through to the CLI's `--model` |

All ids also accept a `claude-code-cli/` prefix. Requests are **never** restricted to the advertised list — the model string is passed straight to the CLI, which resolves aliases/versions and errors on unknown ids. No model names are hardcoded anywhere.

### Advertised model list (`GET /v1/models`)

The CLI has no machine-readable model list, so the proxy **discovers** ids from the CLI and **probes** each (actually invokes it) to keep only the ones that work. Resolved in priority order:

1. **`CLAUDE_PROXY_MODELS`** env var — comma/space separated, e.g. `CLAUDE_PROXY_MODELS="claude-opus-4-8,claude-sonnet-5"`. Pins the list and disables auto-refresh.
2. **`models.json`** — the discovered+probed cache (git-ignored; environment-specific).
3. bare family aliases (`opus`/`sonnet`/`haiku`/`fable`) — until discovery populates the cache, so clients that require a model list work from the first request.

**Auto-refresh:** on server start, if `models.json` is missing or older than a day, the proxy discovers+probes in the background and writes it, then re-checks once per day. The list self-updates as models are retired/added, with zero hardcoded names. (No-op when pinned via `CLAUDE_PROXY_MODELS`.)

### `probe-models` (manual refresh)

Populate or refresh `models.json` on demand:

```bash
node dist/server/standalone.js probe-models          # discover ids from the CLI, then probe each
node dist/server/standalone.js probe-models claude-opus-4-8 claude-sonnet-5   # probe specific ids
```

With no args it asks the CLI for its current ids, probes each, and writes the working ones (retired/unavailable ids are skipped). `models.json` is **git-ignored** on purpose — it's environment-specific (access varies by account, and the lineup changes over time).

## Configuration with Popular Tools

### OpenClaw

OpenClaw works with this proxy out of the box. The proxy automatically maps OpenClaw tool names to Claude Code equivalents and strips conflicting tooling sections from system prompts.

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "sonnet",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_MODELS` | unset | Pin the advertised model list (comma/space separated); disables auto-refresh |
| `CLAUDE_PROXY_MODELS_FILE` | `./models.json` | Where the discovered model cache lives |
| `CLAUDE_PROXY_API_KEY` | unset | If set, `/v1` routes require it via `Authorization: Bearer <key>` or `x-api-key` |
| `CLAUDE_PROXY_CORS` | off | `1` enables permissive CORS (see [Security](#security)) |
| `CLAUDE_PROXY_OPENCLAW` | on | `0` skips the OpenClaw tool-mapping system prompt (~a few hundred tokens/request) |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code CLI binary |
| `DEBUG` / `DEBUG_SUBPROCESS` | off | Verbose request / subprocess logging |

## Limitations

- OpenAI/Anthropic request parameters that the CLI does not expose — `max_tokens`, `temperature`, `top_p`, penalties, etc. — are accepted but **ignored**.
- Client-defined tools (`tools` / function calling) are not forwarded; the CLI runs its own internal tools and returns the final text.
- The Anthropic `/v1/messages` streaming response emits the full result as a single `text_delta` once the CLI finishes (spec-compliant, but not token-by-token).
- `usage.prompt_tokens` on the OpenAI endpoint includes cache read/creation tokens (matching OpenAI semantics, where `prompt_tokens` covers the whole input).

## Auto-Start as a Service

### Linux (systemd)

See [docs/linux-setup.md](docs/linux-setup.md) for a systemd user unit that starts the proxy on login and restarts it on failure.

### macOS (LaunchAgent)

The proxy can run as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

```bash
# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Check status
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts        # Claude CLI JSON streaming types + type guards
│   └── openai.ts            # OpenAI API types (including tool calls)
├── adapter/
│   ├── openai-to-cli.ts     # Convert OpenAI requests → CLI format
│   ├── cli-to-openai.ts     # Convert CLI responses → OpenAI format
│   ├── anthropic-to-cli.ts  # Convert Anthropic Messages requests → CLI format
│   └── cli-to-anthropic.ts  # Convert CLI responses → Anthropic format
├── subprocess/
│   └── manager.ts           # Claude CLI subprocess + OpenClaw tool mapping
├── server/
│   ├── index.ts             # Express server setup (CORS/auth middleware)
│   ├── routes.ts            # API route handlers
│   └── standalone.ts        # Entry point (`claude-evergreen` bin)
├── models.ts                # Self-updating model registry (discover/probe/refresh)
├── unit.test.ts             # Pure-function tests (free, `npm test`)
├── e2e.test.ts              # Full round-trip tests (burns tokens, `npm run test:e2e`)
└── index.ts                 # Clawdbot plugin + package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks; prompts are passed via stdin, never through a shell
- Binds to `127.0.0.1` only
- **CORS is off by default.** The CLI runs with `--dangerously-skip-permissions`, so an exposed proxy means arbitrary prompt → local tool execution. Only set `CLAUDE_PROXY_CORS=1` if you understand that any web page you visit could then call the proxy from your browser.
- Set `CLAUDE_PROXY_API_KEY` to require a shared secret on `/v1` routes (recommended if anything else on the machine is untrusted)
- No Anthropic credentials stored or transmitted by this proxy — auth is handled by the Claude CLI's keychain storage

## Testing

```bash
npm test          # unit tests — pure adapter/registry logic, free and fast
npm run test:e2e  # end-to-end tests — starts the server and calls the REAL CLI (burns tokens)
npm run test:all  # both
```

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Originally created by [atalovesyou](https://github.com/atalovesyou/claude-max-api-proxy)
- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
