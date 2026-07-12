/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { anthropicToCli } from "../adapter/anthropic-to-cli.js";
import type { AnthropicMessagesRequest } from "../adapter/anthropic-to-cli.js";
import { resolveModels } from "../models.js";
import {
  cliResultToOpenai,
  createDoneChunk,
  openaiUsage,
} from "../adapter/cli-to-openai.js";
import { cliResultToAnthropic, anthropicStreamEvents } from "../adapter/cli-to-anthropic.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle POST /v1/messages — Anthropic Messages API.
 *
 * Same CLI backend as the OpenAI endpoint; only the request/response shapes
 * differ. Non-streaming returns a full Messages body; streaming emits the
 * standard Anthropic SSE event sequence (the CLI result as one text_delta).
 */
export async function handleMessages(req: Request, res: Response): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as AnthropicMessagesRequest;
  const stream = body.stream === true;

  const fail = (code: number, type: string, message: string): void => {
    if (!res.headersSent) {
      res.status(code).json({ type: "error", error: { type, message } });
    }
  };

  try {
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      fail(400, "invalid_request_error", "messages is required and must be a non-empty array");
      return;
    }

    const cliInput = anthropicToCli(body);
    const subprocess = new ClaudeSubprocess();

    await new Promise<void>((resolve) => {
      let finalResult: ClaudeCliResult | null = null;

      subprocess.on("result", (result: ClaudeCliResult) => {
        finalResult = result;
      });
      subprocess.on("error", (error: Error) => {
        console.error("[handleMessages] Error:", error.message);
        fail(500, "api_error", error.message);
        resolve();
      });
      subprocess.on("close", (code: number | null) => {
        if (finalResult?.is_error) {
          // The Anthropic streaming path buffers the full result before writing,
          // so headers are still unsent here and a real HTTP error can go out.
          const status = cliErrorStatus(finalResult);
          const type =
            status === 404 ? "not_found_error"
            : status >= 400 && status < 500 ? "invalid_request_error"
            : "api_error";
          fail(status, type, finalResult.result || "Claude CLI reported an error");
        } else if (finalResult) {
          if (stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.write(anthropicStreamEvents(finalResult, requestId, cliInput.model));
            res.end();
          } else {
            res.json(cliResultToAnthropic(finalResult, requestId, cliInput.model));
          }
        } else {
          fail(500, "api_error", `Claude CLI exited with code ${code} without response`);
        }
        resolve();
      });

      subprocess
        .start(cliInput.prompt, { model: cliInput.model, sessionId: cliInput.sessionId })
        .catch((error: Error) => {
          console.error("[handleMessages] start failed:", error.message);
          fail(500, "api_error", error.message);
          resolve();
        });
    });
  } catch (error) {
    fail(500, "api_error", error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 */
function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * The CLI reports failures as a normal result message with is_error=true and
 * exit code 0 (e.g. an unknown/retired model), so exit codes and stderr can't
 * be trusted for error detection — this flag is the only reliable signal.
 * api_error_status carries the upstream HTTP status when the API rejected the
 * request; anything else (timeouts, execution errors) maps to 502.
 */
function cliErrorStatus(result: ClaudeCliResult): number {
  const s = result.api_error_status;
  return s && s >= 400 && s < 600 ? s : 502;
}

/** OpenAI-shaped error body for a failed CLI result. */
function openaiErrorBody(result: ClaudeCliResult): { error: { message: string; type: string; code: string | null } } {
  const status = cliErrorStatus(result);
  return {
    error: {
      message: result.result || "Claude CLI reported an error",
      type: status >= 400 && status < 500 ? "invalid_request_error" : "server_error",
      code: status === 404 ? "model_not_found" : null,
    },
  };
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = cliInput.model;
    let isComplete = false;
    let hasEmittedText = false;
    let toolCallIndex = 0;
    let inToolBlock = false;

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    });

    // DISABLED: Tool call forwarding causes an agentic loop — OpenClaw interprets
    // Claude Code's internal tool_use (Read, Bash, etc.) as calls it needs to
    // handle, triggering repeated requests. Claude Code handles tools internally
    // via --print mode; only the final text result should be forwarded.
    // TODO: Re-enable with a non-tool_calls display mechanism (e.g. inline text).
    //
    // subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const block = event.event.content_block;
    //   if (block?.type !== "tool_use") return;
    //
    //   inToolBlock = true;
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         role: isFirst ? "assistant" : undefined,
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           id: toOpenAICallId(block.id),
    //           type: "function" as const,
    //           function: {
    //             name: block.name,
    //             arguments: "",
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    //   isFirst = false;
    // });
    //
    // subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const delta = event.event.delta;
    //   if (delta?.type !== "input_json_delta") return;
    //
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           function: {
    //             arguments: delta.partial_json,
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // });
    //
    // subprocess.on("content_block_stop", () => {
    //   if (inToolBlock) {
    //     toolCallIndex++;
    //     inToolBlock = false;
    //   }
    // });

    subprocess.on("result", (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        if (result.is_error) {
          // Headers are already sent (SSE), so surface the failure as an error
          // event in the stream instead of a fake completion.
          res.write(`data: ${JSON.stringify(openaiErrorBody(result))}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          resolve();
          return;
        }
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = openaiUsage(result);
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;
    // DISABLED: see tool call forwarding comment in handleStreamingResponse
    // const accumulatedToolCalls: OpenAIToolCall[] = [];
    //
    // subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    //   for (const block of message.message.content) {
    //     if (block.type === "tool_use") {
    //       accumulatedToolCalls.push({
    //         id: toOpenAICallId(block.id),
    //         type: "function",
    //         function: {
    //           name: block.name,
    //           arguments: JSON.stringify(block.input),
    //         },
    //       });
    //     }
    //   }
    // });

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult?.is_error) {
        res.status(cliErrorStatus(finalResult)).json(openaiErrorBody(finalResult));
      } else if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId, cliInput.model));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  // Resolved from CLAUDE_PROXY_MODELS env > models.json (probe-models) >
  // bare-alias fallback (opus/sonnet/haiku/fable) — never empty, so clients
  // that require a model list work before first discovery completes.
  const modelIds = resolveModels();
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
