# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `prepare` script: the package now builds automatically on install, enabling
  `npm install -g github:sizlon/claude-evergreen-proxy` (documented in the README).

## [1.1.0] - 2026-07-12

### Changed

- **BREAKING:** CORS is now **off by default**. The CLI runs with
  `--dangerously-skip-permissions`, so wide-open CORS let any web page call the
  proxy from the browser. Browser-based clients must now opt in with
  `CLAUDE_PROXY_CORS=1`.
- `usage.prompt_tokens` on the OpenAI endpoint now includes cache read/creation
  tokens (OpenAI semantics — previously ~0 on cache hits); the Anthropic
  endpoint passes `cache_read_input_tokens` / `cache_creation_input_tokens`
  through in `usage`.
- `npm test` now runs only the free unit tests; the token-burning end-to-end
  suite moved to `npm run test:e2e` (`npm run test:all` runs both).

### Fixed

- CLI failures (e.g. an unknown or retired model) are returned as real HTTP
  errors (`404 model_not_found`, `502`, etc.) on all endpoints. Previously they
  came back as HTTP 200 "completions" with the error text as assistant content
  and zero usage.
- End-to-end tests no longer hardcode retired model ids; they assert against
  the live registry and bare aliases.

### Added

- `GET /v1/models` falls back to the bare family aliases
  (`opus`/`sonnet`/`haiku`/`fable`) until discovery populates `models.json`,
  so clients that require a model list work from the first request.
- Optional shared-secret auth: set `CLAUDE_PROXY_API_KEY` to require
  `Authorization: Bearer <key>` or `x-api-key` on `/v1` routes.
- `CLAUDE_PROXY_OPENCLAW=0` skips the OpenClaw tool-mapping system prompt.
- `--help` / `--version` flags on the `claude-evergreen` entry point.
- Unit test suite for the adapter/registry logic (`src/unit.test.ts`).
- Linux systemd setup guide (`docs/linux-setup.md`); environment variable and
  limitations documentation in the README.

### Removed

- Unused session manager module (`src/session/manager.ts`) and its
  module-load side effects.

## [1.0.0] - 2026-07-12

Baseline release as **claude-evergreen-proxy** (fork of
[claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)):

- Self-updating model registry — ids discovered from the CLI, probed, and
  refreshed daily; no hardcoded model names (`probe-models` subcommand,
  `CLAUDE_PROXY_MODELS` / `CLAUDE_PROXY_MODELS_FILE` / `CLAUDE_BIN` env vars).
- Anthropic Messages endpoint (`POST /v1/messages`) alongside the
  OpenAI-compatible `POST /v1/chat/completions`, both with streaming.
- OpenClaw integration: tool-name mapping and system-prompt adaptation.

[Unreleased]: https://github.com/sizlon/claude-evergreen-proxy/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/sizlon/claude-evergreen-proxy/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sizlon/claude-evergreen-proxy/releases/tag/v1.0.0
