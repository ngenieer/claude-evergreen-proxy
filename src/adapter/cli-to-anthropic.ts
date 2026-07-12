/**
 * Converts Claude CLI output into Anthropic Messages API responses (non-streaming
 * body and the streaming SSE event sequence).
 */
import type { ClaudeCliResult } from "../types/claude-cli.js";

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<{ type: "text"; text: string }>;
  stop_reason: "end_turn";
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

/** Non-streaming Anthropic Messages response from a finished CLI result. */
export function cliResultToAnthropic(
  result: ClaudeCliResult,
  requestId: string,
  model: string
): AnthropicMessageResponse {
  return {
    id: `msg_${requestId}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: result.result ?? "" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: result.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: result.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

/**
 * The Anthropic streaming SSE event sequence for a completed result. The CLI
 * gives us the full text, so we emit it as a single text_delta wrapped in the
 * standard message_start → content_block_* → message_delta → message_stop events.
 * Spec-compliant; clients accumulate the delta the same way as token streaming.
 */
export function anthropicStreamEvents(
  result: ClaudeCliResult,
  requestId: string,
  model: string
): string {
  const text = result.result ?? "";
  const inputTokens = result.usage?.input_tokens ?? 0;
  const outputTokens = result.usage?.output_tokens ?? 0;

  const sse = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  return (
    sse("message_start", {
      type: "message_start",
      message: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    }) +
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens },
    }) +
    sse("message_stop", { type: "message_stop" })
  );
}
