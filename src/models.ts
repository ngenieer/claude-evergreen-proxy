/**
 * Model registry — no hardcoded model names.
 *
 * The advertised list (GET /v1/models) is resolved from:
 *   1. CLAUDE_PROXY_MODELS env var (comma/space separated) — pins the list
 *   2. models.json — written by discovery+probing (see below), refreshed daily
 *   3. bare family aliases (opus/sonnet/haiku/fable) — until discovery populates
 *
 * The candidate ids are DISCOVERED from the CLI itself (it knows its own current
 * lineup and omits retired models), then each is PROBED (actually invoked) so only
 * ids the CLI accepts are kept. This runs on startup when the cache is stale and
 * then at most once per day, so the list stays current with zero hardcoded names.
 *
 * Requests are never restricted to this list — extractModel passes the requested
 * model straight to the CLI, which resolves aliases and versions.
 */
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

export const MODELS_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once per day

export function modelsFilePath(): string {
  return process.env.CLAUDE_PROXY_MODELS_FILE || resolve(process.cwd(), "models.json");
}

function parseList(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

interface ModelsFile {
  models: string[];
  updatedAt: number;
}

function readModelsFile(): ModelsFile | null {
  const file = modelsFilePath();
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const models = Array.isArray(data) ? data : data.models;
    if (Array.isArray(models)) {
      return { models: models.map(String), updatedAt: Number(data.updatedAt) || 0 };
    }
  } catch {
    /* malformed — treat as absent */
  }
  return null;
}

/**
 * Bare family aliases the CLI always resolves to its current model. Used only
 * as the advertised-list fallback before discovery has populated models.json —
 * they never go stale, so this does not reintroduce hardcoded model *versions*.
 */
export const FALLBACK_MODELS = ["opus", "sonnet", "haiku", "fable"];

/** Advertised model list: env var > models.json > bare-alias fallback. */
export function resolveModels(): string[] {
  const env = process.env.CLAUDE_PROXY_MODELS;
  if (env && parseList(env).length) return parseList(env);
  const cached = readModelsFile()?.models;
  return cached?.length ? cached : [...FALLBACK_MODELS];
}

function writeModels(models: string[]): void {
  writeFileSync(
    modelsFilePath(),
    JSON.stringify({ models, updatedAt: Date.now() }, null, 2) + "\n",
    "utf-8"
  );
}

function claudeBin(): string {
  return process.env.CLAUDE_BIN || "claude";
}

// --- discovery ---

const CLAUDE_ID_RE = /\bclaude-[a-z]+-[0-9][\w.-]*\b/g;

/**
 * Ask the CLI which model ids it can be invoked with. Parses `claude-<family>-<version>`
 * ids out of the reply, so it self-updates as the lineup changes (and omits retired ids).
 */
export function discoverModels(timeoutMs = 90000): Promise<string[]> {
  const prompt =
    "Output ONLY the exact model ids that can be passed to Claude Code via --model, " +
    "one per line, in the form claude-<family>-<version> (e.g. claude-sonnet-5). " +
    "Cover the opus, sonnet, haiku and fable families. No prose, no markdown.";
  return new Promise((res) => {
    const child = spawn(claudeBin(), ["-p", "--model", "sonnet", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      res([]);
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      res(Array.from(new Set(out.match(CLAUDE_ID_RE) ?? [])));
    });
    child.on("error", () => {
      clearTimeout(timer);
      res([]);
    });
  });
}

// --- probing ---

// Markers in CLI output that mean the requested model was rejected.
const FAIL_RE =
  /retired|may not exist|issue with the selected model|pick a different model|not have access/i;

export interface ProbeResult {
  id: string;
  ok: boolean;
  detail: string;
}

/** Probe one model id against the CLI; ok=true if the CLI accepts and runs it. */
export function probeModel(id: string, timeoutMs = 60000): Promise<ProbeResult> {
  return new Promise((res) => {
    const child = spawn(claudeBin(), ["-p", "--model", id, "Reply with only: ok"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      res({ id, ok: false, detail: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      const ok = code === 0 && text.length > 0 && !FAIL_RE.test(text);
      res({ id, ok, detail: ok ? "ok" : text.slice(0, 120).replace(/\s+/g, " ") || `exit ${code}` });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ id, ok: false, detail: String(e).slice(0, 120) });
    });
  });
}

/** Discover (or use given) candidates, probe them, and return only the working ids. */
async function discoverAndProbe(candidates: string[]): Promise<string[]> {
  let cands = candidates;
  if (!cands.length) cands = await discoverModels();
  if (!cands.length) return [];
  const results = await Promise.all(cands.map((id) => probeModel(id)));
  return results.filter((r) => r.ok).map((r) => r.id);
}

// --- CLI command: probe-models ---

/** `probe-models [ids...]` — discover (if no ids), probe, write models.json. Verbose. */
export async function probeAndWrite(candidates: string[]): Promise<string[]> {
  let cands = candidates;
  if (!cands.length) {
    console.log("Discovering model ids from the CLI...");
    cands = await discoverModels();
    console.log(`  discovered: ${cands.join(", ") || "(none)"}`);
  }
  if (!cands.length) {
    console.log("No candidates to probe.");
    return resolveModels();
  }
  console.log(`Probing ${cands.length} id(s) against the CLI...\n`);
  const results = await Promise.all(cands.map((id) => probeModel(id)));
  for (const r of results) {
    console.log(`  ${r.ok ? "OK  " : "skip"}  ${r.id}${r.ok ? "" : `  — ${r.detail}`}`);
  }
  const working = results.filter((r) => r.ok).map((r) => r.id);
  if (working.length) {
    writeModels(working);
    console.log(`\nWrote ${working.length}/${cands.length} working model(s) → ${modelsFilePath()}`);
  } else {
    console.log("\nNo working models found — keeping the existing list.");
  }
  return working;
}

// --- daily auto-refresh ---

let refreshing = false;

function isStale(): boolean {
  if (process.env.CLAUDE_PROXY_MODELS) return false; // list pinned via env
  const f = readModelsFile();
  return !f || Date.now() - f.updatedAt > MODELS_TTL_MS;
}

async function refreshInBackground(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const working = await discoverAndProbe([]);
    if (working.length) {
      writeModels(working);
      console.error(`[models] refreshed (${working.length}): ${working.join(", ")}`);
    } else {
      console.error("[models] refresh found no working models — keeping existing list");
    }
  } catch (e) {
    console.error("[models] refresh failed:", e);
  } finally {
    refreshing = false;
  }
}

/**
 * Wire up model-list freshness for a running server: refresh now if the cache is
 * missing/stale, then re-check once per day. No-op when the list is pinned via env.
 */
export function scheduleModelRefresh(): void {
  if (process.env.CLAUDE_PROXY_MODELS) return;
  if (isStale()) {
    console.error("[models] list missing or stale — refreshing in the background...");
    void refreshInBackground();
  }
  setInterval(() => {
    if (isStale()) void refreshInBackground();
  }, MODELS_TTL_MS).unref();
}
