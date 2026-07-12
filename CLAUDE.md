# Claude Evergreen Proxy

OpenAI- and Anthropic-compatible API proxy that wraps the Claude Code CLI.

## Build & Test

```bash
npm run build     # Compile TypeScript
npm run dev       # Watch mode for development
npm test          # Unit tests (pure functions, free)
npm run test:e2e  # End-to-end tests — calls the REAL Claude CLI and burns tokens
```

## Service Management

**Linux:** systemd user unit `claude-evergreen-proxy` — see `docs/linux-setup.md`.

```bash
systemctl --user restart claude-evergreen-proxy
journalctl --user -u claude-evergreen-proxy -f
```

**macOS:** the proxy runs as a LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

**Logs:**
- stdout: `~/.openclaw/logs/claude-max-proxy.log`
- stderr: `~/.openclaw/logs/claude-max-proxy.err.log`

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Stop the service

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Start the service (after stop or plist change)

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Reload after plist changes

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Check status

```bash
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/adapter/anthropic-to-cli.ts` - Converts Anthropic Messages requests to CLI input
- `src/adapter/cli-to-anthropic.ts` - Converts CLI output to Anthropic responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/models.ts` - Self-updating model registry (discover, probe, daily refresh)
- `src/server/index.ts` - Express setup, opt-in CORS, optional API-key auth
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.ts` - Server entry point (`claude-evergreen` bin)

## Conventions

- CLI failures arrive as a `result` message with `is_error: true` and **exit code 0** — always check the flag, never the exit code, when detecting errors.
- No hardcoded model version ids anywhere (tests included); bare family aliases (`opus`/`sonnet`/`haiku`/`fable`) are the only acceptable literals.
