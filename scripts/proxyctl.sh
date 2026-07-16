#!/usr/bin/env bash
# proxyctl — start/stop/status the proxy without a systemd unit.
#
# Handy when node is managed by a version manager (fnm/nvm) whose shims are not
# on the system PATH a bare systemd `ExecStart=node ...` sees. Resolves node
# (PATH → fnm), keeps the Claude CLI reachable (CLAUDE_BIN → PATH →
# ~/.local/bin/claude), and manages one background instance with a health gate.
#
# Usage:
#   scripts/proxyctl.sh start [port]     # default port 3456 (or CLAUDE_PROXY_PORT)
#   scripts/proxyctl.sh stop
#   scripts/proxyctl.sh restart [port]
#   scripts/proxyctl.sh status
#
# Env: CLAUDE_PROXY_PORT, CLAUDE_BIN, and any CLAUDE_PROXY_* the server reads
# (e.g. CLAUDE_PROXY_API_KEY, CLAUDE_PROXY_MODELS) are passed through.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO/dist/server/standalone.js"
PORT="${2:-${CLAUDE_PROXY_PORT:-3456}}"
LOG="${CLAUDE_PROXY_LOG:-${TMPDIR:-/tmp}/claude-evergreen-proxy.log}"

resolve_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  # fnm: activate its env, whether fnm is on PATH or at its default install dir.
  local fnm_bin=""
  command -v fnm >/dev/null 2>&1 && fnm_bin="fnm"
  [ -z "$fnm_bin" ] && [ -x "$HOME/.local/share/fnm/fnm" ] && fnm_bin="$HOME/.local/share/fnm/fnm"
  if [ -n "$fnm_bin" ]; then
    eval "$("$fnm_bin" env 2>/dev/null)" || true
    command -v node >/dev/null 2>&1 && { command -v node; return 0; }
  fi
  return 1
}

is_up() { curl -s -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

# Match the node process running THIS entry on THIS port — not the manager shell.
proc_pattern() { printf 'standalone.js %s' "$PORT"; }

case "${1:-status}" in
  start)
    if is_up; then echo "proxy already up on :$PORT"; exit 0; fi
    [ -f "$ENTRY" ] || { echo "build missing ($ENTRY) — run: npm run build" >&2; exit 1; }
    NODE="$(resolve_node)" || { echo "node not found (PATH or fnm) — install Node >=20" >&2; exit 1; }
    CLAUDE="${CLAUDE_BIN:-}"
    [ -z "$CLAUDE" ] && command -v claude >/dev/null 2>&1 && CLAUDE="$(command -v claude)"
    [ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"
    [ -n "$CLAUDE" ] || { echo "claude CLI not found — set CLAUDE_BIN or install @anthropic-ai/claude-code" >&2; exit 1; }
    mkdir -p "$(dirname "$LOG")"
    ( cd "$REPO" && CLAUDE_BIN="$CLAUDE" setsid nohup "$NODE" "$ENTRY" "$PORT" > "$LOG" 2>&1 < /dev/null & )
    for _ in $(seq 1 20); do is_up && { echo "proxy up on :$PORT (node=$NODE)"; exit 0; }; sleep 0.5; done
    echo "proxy failed to start — see $LOG" >&2; tail -5 "$LOG" >&2; exit 1 ;;
  stop)
    pids="$(pgrep -f "$(proc_pattern)" || true)"
    if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; echo "proxy stopped"; else echo "proxy not running"; fi ;;
  restart) "${BASH_SOURCE[0]}" stop; sleep 1; "${BASH_SOURCE[0]}" start "$PORT" ;;
  status) if is_up; then echo "proxy UP on :$PORT"; else echo "proxy DOWN"; fi ;;
  *) echo "usage: proxyctl.sh <start|stop|restart|status> [port]"; exit 1 ;;
esac
