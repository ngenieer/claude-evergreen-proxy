/**
 * Unit tests for the pure adapter/registry logic. No server, no Claude CLI,
 * no tokens burned — safe to run anywhere (`npm test`).
 *
 * The full HTTP round-trip against a real CLI lives in e2e.test.ts
 * (`npm run test:e2e`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractModel, messagesToPrompt, openaiToCli } from "./adapter/openai-to-cli.js";
import { anthropicToCli } from "./adapter/anthropic-to-cli.js";
import { cliResultToOpenai, createDoneChunk, openaiUsage } from "./adapter/cli-to-openai.js";
import { cliResultToAnthropic, anthropicStreamEvents } from "./adapter/cli-to-anthropic.js";
import type { ClaudeCliResult } from "./types/claude-cli.js";

function fakeResult(overrides: Partial<ClaudeCliResult> = {}): ClaudeCliResult {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 900,
    num_turns: 1,
    result: "pong",
    session_id: "s-1",
    total_cost_usd: 0,
    usage: {
      input_tokens: 4,
      output_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 3000,
    },
    modelUsage: {},
    ...overrides,
  };
}

// ─── openai-to-cli ──────────────────────────────────────────────────

describe("extractModel", () => {
  it("strips provider prefixes", () => {
    assert.equal(extractModel("claude-code-cli/sonnet"), "sonnet");
    assert.equal(extractModel("claude-max/claude-opus-4-8"), "claude-opus-4-8");
  });

  it("passes everything else through verbatim", () => {
    assert.equal(extractModel("sonnet"), "sonnet");
    assert.equal(extractModel("claude-fable-5"), "claude-fable-5");
  });
});

describe("messagesToPrompt", () => {
  it("wraps system and assistant turns, keeps user turns bare", () => {
    const prompt = messagesToPrompt([
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
    assert.ok(prompt.includes("<system>\nBe terse.\n</system>"));
    assert.ok(prompt.includes("<previous_response>\nhello\n</previous_response>"));
    assert.ok(prompt.includes("hi"));
    assert.ok(prompt.endsWith("again"));
  });

  it("extracts text from content block arrays", () => {
    const prompt = messagesToPrompt([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "input_text", text: "b" }] },
    ]);
    assert.equal(prompt, "a\nb");
  });

  it("strips OpenClaw tooling sections from system prompts", () => {
    const prompt = messagesToPrompt([
      {
        role: "system",
        content: "Intro.\n\n## Tooling\nexec, web_search\n\n## Style\nBe kind.",
      },
    ]);
    assert.ok(!prompt.includes("web_search"));
    assert.ok(prompt.includes("Be kind."));
  });
});

describe("openaiToCli", () => {
  it("maps model and user->sessionId", () => {
    const cli = openaiToCli({
      model: "claude-code-cli/haiku",
      messages: [{ role: "user", content: "hi" }],
      user: "conv-42",
    });
    assert.equal(cli.model, "haiku");
    assert.equal(cli.sessionId, "conv-42");
    assert.equal(cli.prompt, "hi");
  });
});

// ─── anthropic-to-cli ───────────────────────────────────────────────

describe("anthropicToCli", () => {
  it("flattens system + turns into one prompt", () => {
    const cli = anthropicToCli({
      model: "claude-max/sonnet",
      system: [{ type: "text", text: "Be terse." }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: "again" },
      ],
      metadata: { user_id: "u-1" },
    });
    assert.equal(cli.model, "sonnet");
    assert.equal(cli.sessionId, "u-1");
    assert.ok(cli.prompt.startsWith("<system>\nBe terse.\n</system>"));
    assert.ok(cli.prompt.includes("<previous_response>\nhello\n</previous_response>"));
    assert.ok(cli.prompt.endsWith("again"));
  });
});

// ─── cli-to-openai ──────────────────────────────────────────────────

describe("openaiUsage", () => {
  it("folds cache tokens into prompt_tokens (OpenAI semantics)", () => {
    const usage = openaiUsage(fakeResult());
    assert.equal(usage.prompt_tokens, 4 + 100 + 3000);
    assert.equal(usage.completion_tokens, 2);
    assert.equal(usage.total_tokens, 4 + 100 + 3000 + 2);
  });
});

describe("cliResultToOpenai", () => {
  it("builds a valid chat.completion body", () => {
    const body = cliResultToOpenai(fakeResult(), "req1", "sonnet");
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "sonnet");
    assert.equal(body.choices[0].message.content, "pong");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.ok(body.usage.prompt_tokens > 0);
  });
});

describe("createDoneChunk", () => {
  it("carries finish_reason stop and an empty delta", () => {
    const chunk = createDoneChunk("req1", "sonnet");
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(chunk.choices[0].finish_reason, "stop");
    assert.deepEqual(chunk.choices[0].delta, {});
  });
});

// ─── cli-to-anthropic ───────────────────────────────────────────────

describe("cliResultToAnthropic", () => {
  it("builds a valid Messages body with cache usage passthrough", () => {
    const body = cliResultToAnthropic(fakeResult(), "req1", "sonnet");
    assert.equal(body.type, "message");
    assert.equal(body.role, "assistant");
    assert.deepEqual(body.content, [{ type: "text", text: "pong" }]);
    assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.usage.input_tokens, 4);
    assert.equal(body.usage.cache_read_input_tokens, 3000);
  });
});

describe("anthropicStreamEvents", () => {
  it("emits the spec event sequence carrying the full text", () => {
    const sse = anthropicStreamEvents(fakeResult(), "req1", "sonnet");
    const events = [...sse.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(events, [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.ok(sse.includes('"text":"pong"'));
  });
});
