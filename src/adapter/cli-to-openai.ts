/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk, OpenAIToolCall } from "../types/openai.js";

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(message.message.model),
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, model: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(model),
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * OpenAI-style usage from a CLI result. OpenAI's prompt_tokens covers the whole
 * input, whereas the CLI (Anthropic-style) splits cache reads/writes into
 * separate fields — fold them back in so prompt_tokens isn't misleadingly ~0
 * on cache hits.
 */
export function openaiUsage(result: ClaudeCliResult): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const u = result.usage;
  const promptTokens =
    (u?.input_tokens || 0) +
    (u?.cache_read_input_tokens || 0) +
    (u?.cache_creation_input_tokens || 0);
  const completionTokens = u?.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  model?: string,
  toolCalls?: OpenAIToolCall[]
): OpenAIChatResponse {
  // Echo the requested/resolved model. Fall back to modelUsage only if not given.
  // (modelUsage's first key can be a sub-task model like haiku, so it is unreliable.)
  const modelName =
    model || (result.modelUsage ? Object.keys(result.modelUsage)[0] : "");

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: result.result,
  };

  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModelName(modelName),
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    usage: openaiUsage(result),
  };
}

/**
 * Echo the actual model the CLI reported, verbatim — do not collapse the version.
 * The CLI's modelUsage/message.model already carries the real id (e.g.
 * "claude-sonnet-5"), so returning it as-is keeps the response's `model` field
 * honest for observability.
 */
function normalizeModelName(model: string | undefined): string {
  return model || "";
}
