/**
 * Express HTTP Server
 *
 * Provides OpenAI-compatible API endpoints that wrap Claude Code CLI
 */

import express, { Express, Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";
import { handleChatCompletions, handleMessages, handleModels, handleHealth } from "./routes.js";
import { scheduleModelRefresh } from "../models.js";

export interface ServerConfig {
  port: number;
  host?: string;
}

let serverInstance: Server | null = null;

/**
 * Create and configure the Express app
 */
function createApp(): Express {
  const app = express();

  // Middleware: use raw body parser + manual JSON parse for better error diagnostics
  app.use(express.raw({ type: "application/json", limit: "10mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      const raw = req.body.toString("utf8");
      if (process.env.DEBUG) {
        console.log("[Body raw]:", raw.substring(0, 200));
      }
      try {
        req.body = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Body parse error]:", msg);
        if (process.env.DEBUG) {
          console.error("[Body raw]:", raw.substring(0, 300));
        } else {
          console.error("[Body metadata]:", {
            length: raw.length,
            method: req.method,
            url: req.originalUrl,
          });
        }
        return next(err);
      }
    }
    next();
  });

  // Request logging (debug mode)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (process.env.DEBUG) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    }
    next();
  });

  // CORS is OPT-IN (CLAUDE_PROXY_CORS=1). With it on, any web page the user
  // visits can call this proxy from the browser — and the proxy runs the CLI
  // with --dangerously-skip-permissions — so wide-open CORS by default would
  // let arbitrary sites burn the Max subscription and touch local files.
  if (process.env.CLAUDE_PROXY_CORS === "1") {
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
      next();
    });
    app.options("*", (_req: Request, res: Response) => {
      res.sendStatus(200);
    });
  }

  // Health stays unauthenticated (liveness checks)
  app.get("/health", handleHealth);

  // Optional shared-secret auth: set CLAUDE_PROXY_API_KEY to require it on all
  // /v1 routes, via Authorization: Bearer <key> (OpenAI) or x-api-key (Anthropic).
  const apiKey = process.env.CLAUDE_PROXY_API_KEY;
  if (apiKey) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const header = req.headers["x-api-key"];
      if (bearer === apiKey || header === apiKey) return next();
      res.status(401).json({
        error: {
          message: "Invalid or missing API key",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
    });
  }

  // Routes
  app.get("/v1/models", handleModels);
  app.post("/v1/chat/completions", handleChatCompletions);
  app.post("/v1/messages", handleMessages);

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Server Error]:", err.message);
    res.status(500).json({
      error: {
        message: err.message,
        type: "server_error",
        code: null,
      },
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
export async function startServer(config: ServerConfig): Promise<Server> {
  const { port, host = "127.0.0.1" } = config;

  if (serverInstance) {
    console.log("[Server] Already running, returning existing instance");
    return serverInstance;
  }

  const app = createApp();

  return new Promise((resolve, reject) => {
    serverInstance = createServer(app);

    serverInstance.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    serverInstance.listen(port, host, () => {
      console.log(`[Server] Claude Code CLI provider running at http://${host}:${port}`);
      console.log(`[Server] OpenAI-compatible endpoint: http://${host}:${port}/v1/chat/completions`);
      // Keep the advertised /v1/models list current: refresh on start if stale,
      // then at most once per day. No-op when pinned via CLAUDE_PROXY_MODELS.
      scheduleModelRefresh();
      resolve(serverInstance!);
    });
  });
}

/**
 * Stop the HTTP server
 */
export async function stopServer(): Promise<void> {
  if (!serverInstance) {
    return;
  }

  return new Promise((resolve, reject) => {
    serverInstance!.close((err) => {
      if (err) {
        reject(err);
      } else {
        console.log("[Server] Stopped");
        serverInstance = null;
        resolve();
      }
    });
  });
}

/**
 * Get the current server instance
 */
export function getServer(): Server | null {
  return serverInstance;
}
