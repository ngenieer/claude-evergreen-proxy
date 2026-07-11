# Claude Evergreen Proxy

> A self-updating fork of [atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy) (via [wende](https://github.com/wende/claude-max-api-proxy)). Its model registry **discovers** the CLI's current models, **probes** them, and **refreshes daily** — so the model list stays current with no hardcoded names and no manual updates. (Plus OpenClaw integration and improved streaming from upstream.)

**Use your Claude Max subscription ($200/month) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like OpenClaw, Continue.dev, or any OpenAI-compatible client to use your Claude Max subscription instead of paying per-API-call.

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

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku with flexible model aliases
- **OpenClaw integration** — Automatic tool name mapping and system prompt adaptation
- **Content block handling** — Proper text block separators for multi-block responses
- **Session management** — Maintains conversation context via session IDs
- **Auto-start service** — Optional LaunchAgent for macOS
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — Uses `spawn()` to prevent shell injection

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
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

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
3. empty — until one of the above is populated.

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
    "model": "claude-sonnet-4",
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
    model="claude-sonnet-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start on macOS

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
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards
│   └── openai.ts          # OpenAI API types (including tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess + OpenClaw tool mapping
├── session/
│   └── manager.ts         # Session ID mapping
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation

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
