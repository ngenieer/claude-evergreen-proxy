#!/usr/bin/env node
/**
 * Standalone server entry point (also the `claude-evergreen` bin).
 *
 * Usage:
 *   claude-evergreen [port]              start the server (default 3456)
 *   claude-evergreen probe-models [id…]  refresh models.json
 *   claude-evergreen --help | --version
 */

import { createRequire } from "module";
import { startServer, stopServer } from "./index.js";
import { verifyClaude } from "../subprocess/manager.js";

const DEFAULT_PORT = 3456;

const HELP = `claude-evergreen — OpenAI/Anthropic-compatible proxy for the Claude Code CLI

Usage:
  claude-evergreen [port]                Start the server (default: ${DEFAULT_PORT})
  claude-evergreen probe-models [id...]  Discover/probe model ids and write models.json
  claude-evergreen --help                Show this help
  claude-evergreen --version             Show version

Environment variables:
  CLAUDE_PROXY_MODELS       Pin the advertised model list (comma/space separated)
  CLAUDE_PROXY_MODELS_FILE  Path to models.json (default: ./models.json)
  CLAUDE_PROXY_API_KEY      Require this key on /v1 routes (Bearer or x-api-key)
  CLAUDE_PROXY_CORS=1       Enable permissive CORS (off by default)
  CLAUDE_PROXY_OPENCLAW=0   Skip the OpenClaw tool-mapping system prompt
  CLAUDE_BIN                Path to the claude binary (default: claude)
  DEBUG / DEBUG_SUBPROCESS  Verbose request / subprocess logging
`;

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    return require("../../package.json").version;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === "--help" || arg === "-h") {
    console.log(HELP);
    return;
  }
  if (arg === "--version" || arg === "-v") {
    console.log(version());
    return;
  }

  // Subcommand: probe candidate model ids against the CLI and write the working
  // ones to models.json (served at GET /v1/models).
  if (arg === "probe-models") {
    const { probeAndWrite } = await import("../models.js");
    await probeAndWrite(process.argv.slice(3));
    return;
  }

  console.log("Claude Evergreen Proxy - Standalone Server");
  console.log("===========================================\n");

  // Parse port from command line
  const port = parseInt(arg || String(DEFAULT_PORT), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid argument: ${arg}\n`);
    console.error(HELP);
    process.exit(1);
  }

  // Verify Claude CLI
  console.log("Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`Error: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);
  // Credentials live in the CLI's keychain and can't be checked cheaply here;
  // don't pretend otherwise — auth errors surface on the first request.
  console.log("  Authentication: handled by the Claude CLI (verified on first request)\n");

  // Start server
  try {
    await startServer({ port });
    console.log("\nServer ready. Test with:");
    console.log(`  curl -X POST http://localhost:${port}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"model": "sonnet", "messages": [{"role": "user", "content": "Hello!"}]}'`);
    console.log("\nPress Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await stopServer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
