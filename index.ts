/**
 * Pi Cursor Provider Extension
 *
 * Routes Pi model requests through the Cursor Agent CLI (`agent`) so that any
 * active Cursor subscription can be used from inside Pi.
 *
 * Authentication is handled by the CLI itself — run `agent login` (or set the
 * CURSOR_API_KEY environment variable) before using this provider.
 *
 * Usage:
 *   pi install npm:@netandreus/pi-cursor-provider
 *   # Then /model cursor/<model-id>, e.g. /model cursor/sonnet-4.5-thinking
 *
 * Configuration env vars:
 *   CURSOR_AGENT_PATH   Path to the Cursor Agent CLI binary (default: "agent")
 *   CURSOR_API_KEY      API key for Cursor (used by the agent subprocess if set)
 *   CURSOR_MODELS_CACHE Path to cached model catalog JSON (default: ~/.pi/agent/cursor-models-cache.json)
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";

/** Results from Cursor CLI tool runs, keyed by Pi toolCall id — used to block re-execution. */
type CursorPendingResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
};
const cursorOwnedToolCalls = new Set<string>();
const cursorPendingResults = new Map<string, CursorPendingResult>();

/**
 * Pi's TUI always renders ToolExecutionComponents *after* the assistant bubble.
 * Cursor packs tools + final answer into one stream, so a single message looks
 * backwards (answer first, tools last). We hold post-tool thinking/text and emit
 * it on the next streamSimple turn after tool passthrough.
 */
type CursorFollowUp = { thinking: string; text: string };
let pendingCursorFollowUp: CursorFollowUp | null = null;
/** When true, Cursor-owned tool executes must not terminate the agent loop. */
let cursorExpectFollowUp = false;

function isToolFollowUpTurn(context: Context): boolean {
  const msgs = context.messages;
  if (msgs.length === 0) return false;
  return msgs[msgs.length - 1]!.role === "toolResult";
}

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

interface CursorModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Static fallback list. Used when `agent models` fails or times out, and as
 * an attribute lookup table for models discovered dynamically.
 *
 * Source: `agent models` output (Cursor Agent CLI v2026.02.13-41ac335).
 */
const STATIC_MODELS: CursorModelDef[] = [
  // Auto — CLI may emit thinking deltas even on Auto; mark reasoning so Pi shows the trail
  { id: "auto", name: "Auto", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  // Composer
  { id: "composer-1.5", name: "Composer 1.5", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "composer-1", name: "Composer 1", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  // Claude Opus
  { id: "opus-4.6-thinking", name: "Claude 4.6 Opus (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { id: "opus-4.6", name: "Claude 4.6 Opus", reasoning: false, contextWindow: 200000, maxTokens: 32000 },
  { id: "opus-4.5-thinking", name: "Claude 4.5 Opus (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { id: "opus-4.5", name: "Claude 4.5 Opus", reasoning: false, contextWindow: 200000, maxTokens: 32000 },
  // Claude Sonnet
  { id: "sonnet-4.6-thinking", name: "Claude 4.6 Sonnet (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { id: "sonnet-4.6", name: "Claude 4.6 Sonnet", reasoning: false, contextWindow: 200000, maxTokens: 32000 },
  { id: "sonnet-4.5-thinking", name: "Claude 4.5 Sonnet (Thinking)", reasoning: true, contextWindow: 200000, maxTokens: 32000 },
  { id: "sonnet-4.5", name: "Claude 4.5 Sonnet", reasoning: false, contextWindow: 200000, maxTokens: 32000 },
  // GPT-5 series
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-low", name: "GPT-5.3 Codex Low", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-high", name: "GPT-5.3 Codex High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-xhigh", name: "GPT-5.3 Codex Extra High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-fast", name: "GPT-5.3 Codex Fast", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-low-fast", name: "GPT-5.3 Codex Low Fast", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-high-fast", name: "GPT-5.3 Codex High Fast", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.3-codex-xhigh-fast", name: "GPT-5.3 Codex Extra High Fast", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2", name: "GPT-5.2", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-high", name: "GPT-5.2 High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-high", name: "GPT-5.2 Codex High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-low", name: "GPT-5.2 Codex Low", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-xhigh", name: "GPT-5.2 Codex Extra High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-fast", name: "GPT-5.2 Codex Fast", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-high-fast", name: "GPT-5.2 Codex High Fast", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-low-fast", name: "GPT-5.2 Codex Low Fast", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.2-codex-xhigh-fast", name: "GPT-5.2 Codex Extra High Fast", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.1-high", name: "GPT-5.1 High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.1-codex-max-high", name: "GPT-5.1 Codex Max High", reasoning: true, contextWindow: 200000, maxTokens: 32768 },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", reasoning: false, contextWindow: 200000, maxTokens: 32768 },
  // Gemini
  { id: "gemini-3-pro", name: "Gemini 3 Pro", reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
  // Grok
  { id: "grok", name: "Grok", reasoning: false, contextWindow: 131072, maxTokens: 32768 },
];

/** Fast lookup: static model id → definition */
const STATIC_MODELS_MAP = new Map<string, CursorModelDef>(
  STATIC_MODELS.map((m) => [m.id, m]),
);

// ---------------------------------------------------------------------------
// Canonical model ID mapping
// Maps canonical IDs (e.g. claude-sonnet-4-5) to CLI model IDs. When Pi
// provides a reasoning/thinking level, the corresponding variant is used.
// ---------------------------------------------------------------------------

type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModelVariants {
  default: string;
  minimal?: string;
  low?: string;
  medium?: string;
  high?: string;
  xhigh?: string;
}

const MODEL_MAP: Record<string, ModelVariants> = {
  "claude-sonnet-4-5": {
    default: "sonnet-4.5",
    minimal: "sonnet-4.5-thinking",
    low: "sonnet-4.5-thinking",
    medium: "sonnet-4.5-thinking",
    high: "sonnet-4.5-thinking",
    xhigh: "sonnet-4.5-thinking",
  },
  "claude-sonnet-4-6": {
    default: "sonnet-4.6",
    minimal: "sonnet-4.6-thinking",
    low: "sonnet-4.6-thinking",
    medium: "sonnet-4.6-thinking",
    high: "sonnet-4.6-thinking",
    xhigh: "sonnet-4.6-thinking",
  },
  "claude-opus-4-5": {
    default: "opus-4.5",
    minimal: "opus-4.5-thinking",
    low: "opus-4.5-thinking",
    medium: "opus-4.5-thinking",
    high: "opus-4.5-thinking",
    xhigh: "opus-4.5-thinking",
  },
  "claude-opus-4-6": {
    default: "opus-4.6",
    minimal: "opus-4.6-thinking",
    low: "opus-4.6-thinking",
    medium: "opus-4.6-thinking",
    high: "opus-4.6-thinking",
    xhigh: "opus-4.6-thinking",
  },
  "gpt-5.2": {
    default: "gpt-5.2",
    high: "gpt-5.2-high",
    xhigh: "gpt-5.2-high",
  },
  "gpt-5.2-codex": {
    default: "gpt-5.2-codex",
    minimal: "gpt-5.2-codex-low",
    low: "gpt-5.2-codex-low",
    high: "gpt-5.2-codex-high",
    xhigh: "gpt-5.2-codex-xhigh",
  },
  "gpt-5.2-codex-fast": {
    default: "gpt-5.2-codex-fast",
    minimal: "gpt-5.2-codex-low-fast",
    low: "gpt-5.2-codex-low-fast",
    high: "gpt-5.2-codex-high-fast",
    xhigh: "gpt-5.2-codex-xhigh-fast",
  },
  "gpt-5.3-codex": {
    default: "gpt-5.3-codex",
    minimal: "gpt-5.3-codex-low",
    low: "gpt-5.3-codex-low",
    high: "gpt-5.3-codex-high",
    xhigh: "gpt-5.3-codex-xhigh",
  },
  "gpt-5.3-codex-fast": {
    default: "gpt-5.3-codex-fast",
    minimal: "gpt-5.3-codex-low-fast",
    low: "gpt-5.3-codex-low-fast",
    high: "gpt-5.3-codex-high-fast",
    xhigh: "gpt-5.3-codex-xhigh-fast",
  },
  "gpt-5.1": {
    default: "gpt-5.1-high",
  },
  "gpt-5.1-codex-max": {
    default: "gpt-5.1-codex-max",
    high: "gpt-5.1-codex-max-high",
    xhigh: "gpt-5.1-codex-max-high",
  },
  "gemini-3-pro-preview": { default: "gemini-3-pro" },
  "gemini-3-flash-preview": { default: "gemini-3-flash" },
  "grok-code-fast-1": { default: "grok" },
};

const cursorDefaultToCanonical = new Map<string, string>();
const allMappedCursorIds = new Set<string>();
for (const [canonicalId, variants] of Object.entries(MODEL_MAP)) {
  if (variants.default) cursorDefaultToCanonical.set(variants.default, canonicalId);
  for (const cursorId of Object.values(variants)) {
    if (cursorId) allMappedCursorIds.add(cursorId);
  }
}

/**
 * Convert a Cursor CLI model ID to its canonical ID.
 * Returns null for variant-only IDs (e.g. thinking); they are not shown as separate models.
 * Returns the id as-is for unmapped models.
 */
function toCanonicalId(cursorId: string): string | null {
  const canonical = cursorDefaultToCanonical.get(cursorId);
  if (canonical) return canonical;
  if (allMappedCursorIds.has(cursorId)) return null;
  return cursorId;
}

/**
 * Resolve a canonical model ID (and optional reasoning level) to the Cursor CLI model ID.
 * Returns the id as-is for unmapped models.
 */
function toCursorId(canonicalId: string, reasoning?: string): string {
  const family = MODEL_MAP[canonicalId];
  if (!family) return canonicalId;
  const level = reasoning as ReasoningLevel | undefined;
  const variant = level && family[level];
  return variant ?? family.default ?? canonicalId;
}

// ---------------------------------------------------------------------------
// Dynamic model discovery via `agent models`
// ---------------------------------------------------------------------------

/** Timeout (ms) for `agent models` discovery call. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Infer the `reasoning` flag for a model that is not in the static list.
 * Models whose id ends with -thinking, -high, -xhigh, -max-high, or -max are
 * treated as reasoning/extended-thinking models.
 */
function inferReasoning(id: string): boolean {
  return /(-thinking|-high|-xhigh|-max-high)$/.test(id);
}

/**
 * Parse the text output of `agent models` into a list of model definitions.
 *
 * Expected format (one model per line after the header, before the tip):
 *   <id> - <name>  [(current[, default] | default)]
 *
 * Example lines:
 *   "auto - Auto"
 *   "opus-4.6-thinking - Claude 4.6 Opus (Thinking)  (default)"
 *   "sonnet-4.6 - Claude 4.6 Sonnet  (current)"
 */
function parseAgentModelsOutput(output: string): CursorModelDef[] {
  const results: CursorModelDef[] = [];
  // Match lines like: "model-id - Display Name  (optional flags)"
  const lineRe = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+?)(?:\s+\((?:current|default|current,\s*default)\))?$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available") || trimmed.startsWith("Tip:")) continue;
    const match = lineRe.exec(trimmed);
    if (!match) continue;

    const id = match[1].trim();
    const rawName = match[2].trim();

    // Use static attributes if available, otherwise infer
    const known = STATIC_MODELS_MAP.get(id);
    results.push({
      id,
      name: rawName,
      reasoning: known?.reasoning ?? inferReasoning(id),
      contextWindow: known?.contextWindow ?? 200000,
      maxTokens: known?.maxTokens ?? 32768,
    });
  }
  return results;
}

/**
 * Run `agent models` and return the parsed model list.
 * Rejects if the CLI exits with an error, produces no usable output, or
 * exceeds the discovery timeout.
 */
function runAgentModels(agentPath: string): Promise<CursorModelDef[]> {
  return new Promise((resolve, reject) => {
    const args = ["models"];
    if (process.env["CURSOR_API_KEY"]) {
      args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
    }

    let stdout = "";
    let stderr = "";
    const child = spawn(agentPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent models timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
    }, DISCOVERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`agent models exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      const models = parseAgentModelsOutput(stdout);
      if (models.length === 0) {
        reject(new Error("agent models returned no models"));
        return;
      }
      resolve(models);
    });
  });
}

// ---------------------------------------------------------------------------
// Prompt serialisation
// Serialises the Pi context into a single text prompt for the CLI.
// Cursor CLI receives the conversation as one -p "..." argument; multi-turn
// history is included as a prefixed transcript (best-effort).
// ---------------------------------------------------------------------------

/**
 * Convert a content block (text or image) to a plain string for the CLI prompt.
 * Images are serialised as a textual placeholder because the Cursor Agent CLI
 * (v2026.02.13) does not support image attachments in the `--print` prompt.
 * The placeholder preserves the image's MIME type and byte-size so the model
 * can at least acknowledge that an image was intended.
 */
function contentBlockToText(block: TextContent | import("@mariozechner/pi-ai").ImageContent): string {
  if (block.type === "text") return block.text;
  // ImageContent: { type: "image", data: string (base64), mimeType: string }
  const bytes = Math.round((block.data.length * 3) / 4);
  return `[Image: ${block.mimeType}, ~${bytes} bytes — note: image input is not supported by the Cursor Agent CLI; the visual content cannot be passed through]`;
}

function serializeContext(context: Context): string {
  const lines: string[] = [];

  if (context.systemPrompt) {
    lines.push(`[System]\n${context.systemPrompt}\n`);
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map(contentBlockToText).join("\n");
      lines.push(`[User]\n${text}`);
    } else if (msg.role === "assistant") {
      const parts: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text.trim()) parts.push(c.text);
        else if (c.type === "toolCall") {
          parts.push(`[Tool call: ${c.name}] ${JSON.stringify(c.arguments)}`);
        }
      }
      if (parts.length > 0) {
        lines.push(`[Assistant]\n${parts.join("\n")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content.map(contentBlockToText).join("\n");
      if (text.trim()) {
        lines.push(`[Tool result: ${msg.toolName}]\n${text}`);
      }
    }
  }

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// NDJSON event types — Cursor CLI stream-json shape
// ---------------------------------------------------------------------------

interface CursorAssistantEvent {
  type: "assistant";
  message: { role: "assistant"; content: Array<{ type: "text"; text: string }> };
  session_id: string;
}

/**
 * Cursor CLI thinking trail (stream-json).
 * Deltas carry `text`; `completed` closes the block (no text).
 */
interface CursorThinkingEvent {
  type: "thinking";
  subtype: "delta" | "completed";
  text?: string;
  session_id: string;
}

/**
 * A single Cursor CLI tool call (the value keyed by tool name).
 * The key is the tool name in camelCase (e.g. "shellToolCall", "readToolCall").
 * args are present on both started and completed; result only on completed.
 */
interface CursorToolCallPayload {
  args: Record<string, unknown>;
  result?: {
    success?: Record<string, unknown>;
    rejected?: { reason?: string };
    error?: { message?: string };
  };
}

interface CursorToolCallEvent {
  type: "tool_call";
  subtype: "started" | "completed";
  call_id?: string;
  /** Payload keyed by tool name (e.g. "shellToolCall"); may include extra metadata keys. */
  tool_call: Record<string, CursorToolCallPayload | unknown>;
}

interface CursorResultEvent {
  type: "result";
  subtype: string;
  duration_ms: number;
}

type CursorStreamEvent =
  | CursorAssistantEvent
  | CursorThinkingEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | { type: string };

function parseLine(line: string): CursorStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CursorStreamEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool mapping — Cursor CLI tools → Pi built-in tool names + sanitized args
// so the TUI renders native ToolExecutionComponent cards. Pi must not re-run
// them: see cursorOwnedToolCalls + tool_call block handlers below.
// ---------------------------------------------------------------------------

type PiToolMapping = {
  name: string;
  args: (raw: Record<string, unknown>) => Record<string, unknown> | null;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const PI_TOOL_MAP: Record<string, PiToolMapping> = {
  shellToolCall: {
    name: "bash",
    args: (a) => {
      const command = str(a.command);
      return command ? { command } : null;
    },
  },
  readToolCall: {
    name: "read",
    args: (a) => {
      const path = str(a.path) ?? str(a.targetFile) ?? str(a.filePath) ?? str(a.absolutePath);
      if (!path) return null;
      const out: Record<string, unknown> = { path };
      if (typeof a.offset === "number") out.offset = a.offset;
      if (typeof a.limit === "number") out.limit = a.limit;
      return out;
    },
  },
  writeToolCall: {
    name: "write",
    args: (a) => {
      const path = str(a.path) ?? str(a.filePath) ?? str(a.absolutePath);
      const content = str(a.content) ?? str(a.contents) ?? str(a.newString) ?? str(a.new_string);
      return path && content != null ? { path, content } : null;
    },
  },
  editToolCall: {
    name: "edit",
    args: (a) => {
      const path = str(a.path) ?? str(a.filePath) ?? str(a.absolutePath);
      if (!path) return null;
      if (Array.isArray(a.edits)) return { path, edits: a.edits };
      const oldText = str(a.oldText) ?? str(a.old_string) ?? str(a.oldString);
      const newText = str(a.newText) ?? str(a.new_string) ?? str(a.newString);
      if (oldText == null || newText == null) return null;
      return { path, edits: [{ oldText, newText }] };
    },
  },
  grepToolCall: {
    name: "grep",
    args: (a) => {
      const pattern = str(a.pattern) ?? str(a.query) ?? str(a.regex);
      if (!pattern) return null;
      const out: Record<string, unknown> = { pattern };
      const path = str(a.path) ?? str(a.dir) ?? str(a.directory);
      if (path) out.path = path;
      if (str(a.glob)) out.glob = a.glob;
      if (typeof a.caseInsensitive === "boolean") out.ignoreCase = a.caseInsensitive;
      if (typeof a.ignoreCase === "boolean") out.ignoreCase = a.ignoreCase;
      return out;
    },
  },
  globToolCall: {
    name: "find",
    args: (a) => {
      const pattern = str(a.globPattern) ?? str(a.pattern) ?? str(a.glob);
      if (!pattern) return null;
      const out: Record<string, unknown> = { pattern };
      const path = str(a.path) ?? str(a.targetDirectory) ?? str(a.dir);
      if (path) out.path = path;
      return out;
    },
  },
  findToolCall: {
    name: "find",
    args: (a) => {
      const pattern = str(a.pattern) ?? str(a.globPattern) ?? str(a.glob);
      if (!pattern) return null;
      const out: Record<string, unknown> = { pattern };
      const path = str(a.path) ?? str(a.targetDirectory) ?? str(a.dir);
      if (path) out.path = path;
      return out;
    },
  },
  lsToolCall: {
    name: "ls",
    args: (a) => {
      const out: Record<string, unknown> = {};
      const path = str(a.path) ?? str(a.dir) ?? str(a.directory) ?? str(a.targetDirectory);
      if (path) out.path = path;
      if (typeof a.limit === "number") out.limit = a.limit;
      return out;
    },
  },
};

const FALLBACK_TOOL_LABEL: Record<string, string> = {
  shellToolCall: "bash",
  readToolCall: "read",
  editToolCall: "edit",
  writeToolCall: "write",
  deleteToolCall: "delete",
  grepToolCall: "grep",
  globToolCall: "find",
  lsToolCall: "ls",
  todoToolCall: "todo",
  updateTodosToolCall: "todo",
  findToolCall: "find",
  webFetchToolCall: "web_fetch",
  webSearchToolCall: "web_search",
};

function cliToolKey(toolCall: Record<string, unknown>): string | undefined {
  return Object.keys(toolCall).find((k) => k in PI_TOOL_MAP || k in FALLBACK_TOOL_LABEL || k.endsWith("ToolCall"));
}

function normalizeToolCallId(raw: string | undefined, fallbackIndex: number): string {
  const cleaned = (raw ?? `cursor-tool-${fallbackIndex}`).replace(/\s+/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : `cursor-tool-${fallbackIndex}`;
}

function formatCursorToolResult(
  payload: CursorToolCallPayload,
): CursorPendingResult {
  const result = payload.result;
  if (!result) {
    return { content: [{ type: "text", text: "(no result)" }], isError: false };
  }
  if (result.rejected) {
    return {
      content: [{ type: "text", text: result.rejected.reason ?? "Rejected" }],
      isError: true,
    };
  }
  if (result.error) {
    return {
      content: [{ type: "text", text: result.error.message ?? "Error" }],
      isError: true,
    };
  }
  const success = result.success;
  if (success && typeof success === "object") {
    const s = success as Record<string, unknown>;
    // Shell-like
    if ("stdout" in s || "stderr" in s || "exitCode" in s || "interleavedOutput" in s) {
      const exitCode = typeof s.exitCode === "number" ? s.exitCode : 0;
      const out =
        str(s.interleavedOutput) ??
        [str(s.stdout) ?? "", str(s.stderr) ?? ""].filter(Boolean).join("\n");
      const text = out || `(exit ${exitCode})`;
      return { content: [{ type: "text", text }], isError: exitCode !== 0 };
    }
    // Read / generic content
    if (typeof s.content === "string") {
      return { content: [{ type: "text", text: s.content }], isError: false };
    }
    if (typeof s.contents === "string") {
      return { content: [{ type: "text", text: s.contents }], isError: false };
    }
    if (Array.isArray(s.lines)) {
      return { content: [{ type: "text", text: s.lines.map(String).join("\n") }], isError: false };
    }
  }
  try {
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };
  } catch {
    return { content: [{ type: "text", text: String(result) }], isError: false };
  }
}

/**
 * Override built-in tools so Cursor-owned call ids return the CLI result.
 * terminate is false when a follow-up answer was buffered (so Pi requests it next).
 */
function registerCursorToolPassthroughs(pi: ExtensionAPI) {
  const factories = [
    createBashToolDefinition,
    createReadToolDefinition,
    createWriteToolDefinition,
    createEditToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ] as const;

  for (const create of factories) {
    const probe = create(process.cwd());
    pi.registerTool({
      name: probe.name,
      label: probe.label,
      description: probe.description,
      parameters: probe.parameters,
      promptSnippet: probe.promptSnippet,
      promptGuidelines: probe.promptGuidelines,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (cursorOwnedToolCalls.has(toolCallId)) {
          const cached = cursorPendingResults.get(toolCallId) ?? {
            content: [{ type: "text", text: "(Cursor CLI result missing)" }],
            isError: true,
          };
          cursorOwnedToolCalls.delete(toolCallId);
          cursorPendingResults.delete(toolCallId);
          if (cached.isError) {
            throw new Error(cached.content.map((c) => c.text).join("\n") || "Tool failed");
          }
          return {
            content: cached.content,
            details: {},
            terminate: !cursorExpectFollowUp,
          };
        }
        const tool = create(ctx.cwd);
        // Factories are a union; each registration closes over one concrete tool.
        return tool.execute(toolCallId, params as never, signal, onUpdate, ctx);
      },
    });
  }
}

/** Emit a buffered post-tool answer without spawning Cursor again. */
function streamCursorFollowUp(
  model: Model<Api>,
  follow: CursorFollowUp,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = Date.now();
    const output: AssistantMessage & { duration?: number; ttft?: number } = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    stream.push({ type: "start", partial: output });

    if (options?.signal?.aborted) {
      output.stopReason = "aborted";
      output.duration = Date.now() - startTime;
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
      return;
    }

    if (follow.thinking.trim()) {
      output.content.push({ type: "thinking", thinking: "" });
      const idx = output.content.length - 1;
      stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
      const block = output.content[idx] as ThinkingContent;
      block.thinking = follow.thinking;
      stream.push({
        type: "thinking_delta",
        contentIndex: idx,
        delta: follow.thinking,
        partial: output,
      });
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: follow.thinking,
        partial: output,
      });
    }

    if (follow.text.trim()) {
      output.content.push({ type: "text", text: "" });
      const idx = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex: idx, partial: output });
      const block = output.content[idx] as TextContent;
      block.text = follow.text;
      stream.push({
        type: "text_delta",
        contentIndex: idx,
        delta: follow.text,
        partial: output,
      });
      stream.push({
        type: "text_end",
        contentIndex: idx,
        content: follow.text,
        partial: output,
      });
    }

    output.duration = Date.now() - startTime;
    output.ttft = 0;
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// streamSimple — the custom backend for the cursor provider
// ---------------------------------------------------------------------------

function streamCursorCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // Second agent-loop turn: deliver buffered post-tool answer in order.
  if (pendingCursorFollowUp && isToolFollowUpTurn(context)) {
    const follow = pendingCursorFollowUp;
    pendingCursorFollowUp = null;
    cursorExpectFollowUp = false;
    return streamCursorFollowUp(model, follow, options);
  }
  // Stale buffer from an aborted turn — do not leak into a new user prompt.
  pendingCursorFollowUp = null;
  cursorExpectFollowUp = false;

  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = Date.now();
    let firstTokenTime: number | undefined;

    const output: AssistantMessage & { duration?: number; ttft?: number } = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const setTiming = () => {
      output.duration = Date.now() - startTime;
      output.ttft = firstTokenTime != null ? firstTokenTime - startTime : undefined;
    };

    try {
      const agentPath =
        process.env["CURSOR_AGENT_PATH"] ??
        process.env["AGENT_PATH"] ??
        "agent";

      const workspacePath = process.cwd();
      const prompt = serializeContext(context);
      const reasoningLevel = (options as { reasoning?: string })?.reasoning;
      const cliModelId = toCursorId(model.id, reasoningLevel);

      const args = [
        "--print",
        "--output-format", "stream-json",
        "--model", cliModelId,
        "--trust",
        "--workspace", workspacePath,
        prompt,
      ];

      if (process.env["CURSOR_API_KEY"]) {
        args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
      }

      stream.push({ type: "start", partial: output });

      const child = spawn(agentPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const stderrChunks: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      let textBlockOpen = false;
      let thinkingBlockOpen = false;
      let accumulatedText = "";
      let accumulatedThinking = "";
      let toolSeq = 0;
      /** Once Cursor starts tools, later thinking/text go to the follow-up message. */
      let toolsStarted = false;
      let bufferedFollowThinking = "";
      let bufferedFollowText = "";
      /** call_id → contentIndex for open native toolCall blocks */
      const openToolCalls = new Map<string, number>();

      const closeTextBlock = () => {
        if (!textBlockOpen) return;
        const idx = output.content.length - 1;
        const block = output.content[idx] as TextContent;
        stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
        textBlockOpen = false;
      };

      const closeThinkingBlock = () => {
        if (!thinkingBlockOpen) return;
        const idx = output.content.length - 1;
        const block = output.content[idx] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: idx,
          content: block.thinking,
          partial: output,
        });
        thinkingBlockOpen = false;
      };

      const ensureTextBlock = () => {
        if (textBlockOpen) return;
        closeThinkingBlock();
        output.content.push({ type: "text", text: "" });
        const idx = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex: idx, partial: output });
        textBlockOpen = true;
      };

      const ensureThinkingBlock = () => {
        if (thinkingBlockOpen) return;
        closeTextBlock();
        output.content.push({ type: "thinking", thinking: "" });
        const idx = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
        thinkingBlockOpen = true;
      };

      const emitTextMarker = (marker: string) => {
        if (toolsStarted) {
          bufferedFollowText += marker;
          accumulatedText += marker;
          return;
        }
        ensureTextBlock();
        const idx = output.content.length - 1;
        const textBlock = output.content[idx] as TextContent;
        textBlock.text += marker;
        accumulatedText += marker;
        stream.push({ type: "text_delta", contentIndex: idx, delta: marker, partial: output });
      };

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

      rl.on("line", (line: string) => {
        const event = parseLine(line);
        if (!event) return;

        // Forward CLI thinking trail → Pi thinking_* events (was previously dropped).
        if (event.type === "thinking") {
          const te = event as CursorThinkingEvent;
          if (te.subtype === "delta") {
            const delta = te.text ?? "";
            if (!delta) return;
            if (firstTokenTime === undefined) firstTokenTime = Date.now();
            if (toolsStarted) {
              bufferedFollowThinking += delta;
              accumulatedThinking += delta;
              return;
            }
            ensureThinkingBlock();
            const idx = output.content.length - 1;
            const thinkingBlock = output.content[idx] as ThinkingContent;
            thinkingBlock.thinking += delta;
            accumulatedThinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: idx,
              delta,
              partial: output,
            });
            return;
          }
          if (te.subtype === "completed") {
            if (!toolsStarted) closeThinkingBlock();
            return;
          }
          return;
        }

        if (event.type === "assistant") {
          const ae = event as CursorAssistantEvent;
          for (const block of ae.message.content) {
            if (block.type !== "text") continue;
            if (!block.text.trim()) continue;

            if (firstTokenTime === undefined) firstTokenTime = Date.now();
            if (toolsStarted) {
              bufferedFollowText += block.text;
              accumulatedText += block.text;
              continue;
            }
            ensureTextBlock();

            const idx = output.content.length - 1;
            const textBlock = output.content[idx] as TextContent;
            textBlock.text += block.text;
            accumulatedText += block.text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: output });
          }
          return;
        }

        // Native Pi tool cards when we can map to a built-in tool; otherwise a short text marker.
        // Cursor already executed the tool — passthrough execute returns the cached result.
        if (event.type === "tool_call") {
          const tce = event as CursorToolCallEvent;
          const cliKey = cliToolKey(tce.tool_call as Record<string, unknown>);
          if (!cliKey) return;
          const rawPayload = tce.tool_call[cliKey];
          if (!rawPayload || typeof rawPayload !== "object") return;
          const payload = rawPayload as CursorToolCallPayload;
          const callId = normalizeToolCallId(
            tce.call_id ?? str(payload.args?.toolCallId),
            ++toolSeq,
          );

          if (tce.subtype === "started") {
            if (firstTokenTime === undefined) firstTokenTime = Date.now();
            if (!toolsStarted) {
              closeTextBlock();
              closeThinkingBlock();
              toolsStarted = true;
            }
            const mapping = PI_TOOL_MAP[cliKey];
            const piArgs = mapping?.args(payload.args ?? {});
            if (mapping && piArgs) {
              const toolCall: ToolCall = {
                type: "toolCall",
                id: callId,
                name: mapping.name,
                arguments: piArgs,
              };
              output.content.push(toolCall);
              const idx = output.content.length - 1;
              openToolCalls.set(callId, idx);
              cursorOwnedToolCalls.add(callId);
              stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
              stream.push({
                type: "toolcall_end",
                contentIndex: idx,
                toolCall,
                partial: output,
              });
            } else {
              const label = FALLBACK_TOOL_LABEL[cliKey] ?? cliKey.replace(/ToolCall$/, "");
              const brief = JSON.stringify(payload.args ?? {});
              const clipped = brief.length > 160 ? brief.slice(0, 160) + "…" : brief;
              emitTextMarker(`\n[${label}] ${clipped}\n`);
            }
            return;
          }

          if (tce.subtype === "completed") {
            const formatted = formatCursorToolResult(payload);
            if (openToolCalls.has(callId) || cursorOwnedToolCalls.has(callId)) {
              cursorOwnedToolCalls.add(callId);
              cursorPendingResults.set(callId, formatted);
              openToolCalls.delete(callId);
            } else {
              // Unmapped tool: append a compact result under the text marker
              const body = formatted.content.map((c) => c.text).join("\n");
              if (body.trim()) {
                const clipped = body.length > 400 ? body.slice(0, 400) + "…" : body;
                emitTextMarker(`${clipped}\n`);
              }
            }
          }
        }
      });

      await new Promise<void>((resolve) => {
        child.on("close", (code) => {
          options?.signal?.removeEventListener("abort", onAbort);

          closeThinkingBlock();
          closeTextBlock();

          if (options?.signal?.aborted) {
            pendingCursorFollowUp = null;
            cursorExpectFollowUp = false;
            output.stopReason = "aborted";
            setTiming();
            stream.push({ type: "error", reason: "aborted", error: output });
            stream.end();
            resolve();
            return;
          }

          if (
            code !== 0 &&
            !accumulatedText &&
            !accumulatedThinking &&
            !output.content.some((c) => c.type === "toolCall")
          ) {
            pendingCursorFollowUp = null;
            cursorExpectFollowUp = false;
            const stderr = stderrChunks.join("").trim();
            output.stopReason = "error";
            output.errorMessage = stderr || `Cursor CLI exited with code ${code}`;
            setTiming();
            stream.push({ type: "error", reason: "error", error: output });
            stream.end();
            resolve();
            return;
          }

          const hasTools = output.content.some((c) => c.type === "toolCall");
          const followThinking = bufferedFollowThinking.trim();
          const followText = bufferedFollowText.trim();
          if (hasTools && (followThinking || followText)) {
            pendingCursorFollowUp = { thinking: followThinking, text: followText };
            cursorExpectFollowUp = true;
          } else {
            pendingCursorFollowUp = null;
            cursorExpectFollowUp = false;
          }

          setTiming();
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
          resolve();
        });

        child.on("error", (err) => {
          options?.signal?.removeEventListener("abort", onAbort);
          pendingCursorFollowUp = null;
          cursorExpectFollowUp = false;
          output.stopReason = "error";
          output.errorMessage = err.message;
          setTiming();
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          resolve();
        });
      });
    } catch (error) {
      pendingCursorFollowUp = null;
      cursorExpectFollowUp = false;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      setTiming();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `agent login` in an interactive child process so the user can
 * authenticate with Cursor from within a Pi session.
 * Returns a promise that resolves when login completes (exit 0) and rejects
 * on non-zero exit or spawn error.
 */
function runAgentLogin(agentPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["login"];
    // Suppress browser-open so login is purely CLI-driven (prints URL/code)
    const env = { ...process.env, NO_OPEN_BROWSER: "1" };

    const child = spawn(agentPath, args, {
      stdio: "inherit",
      env,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent login exited with code ${code}`));
    });
  });
}

/**
 * Run `agent status` and return the trimmed output (e.g. "✓ Logged in as …").
 */
function runAgentStatus(agentPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(agentPath, ["status"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { out += c.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", () => resolve(out.trim()));
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Build a ProviderModelConfig array from a list of CursorModelDef entries.
 * Uses canonical IDs where a mapping exists and omits variant-only entries.
 */
function toProviderModels(defs: CursorModelDef[]) {
  const seen = new Set<string>();
  return defs.flatMap((m) => {
    const canonicalId = toCanonicalId(m.id);
    if (canonicalId === null) return []; // variant-only; hide
    const id = canonicalId !== m.id ? canonicalId : m.id;
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: `${m.name} (Cursor)`,
        reasoning: m.reasoning,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Model catalog cache (non-blocking startup)
// ---------------------------------------------------------------------------

/**
 * Cursor's `agent models` commonly takes ~2–3s. Awaiting it inside the
 * extension factory blocks Pi startup for every session. Instead we register
 * immediately from a disk cache (falling back to STATIC_MODELS) and refresh
 * the catalog from `session_start` when the cache is stale.
 *
 * Override path with CURSOR_MODELS_CACHE. Default TTL is 24h.
 */
const CACHE_PATH =
  process.env["CURSOR_MODELS_CACHE"] ??
  join(homedir(), ".pi", "agent", "cursor-models-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelsCache {
  at: number;
  models: CursorModelDef[];
}

function loadModelsCache(): CursorModelDef[] | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as ModelsCache;
    if (Array.isArray(parsed?.models) && parsed.models.length > 0) return parsed.models;
  } catch {
    // no cache yet
  }
  return null;
}

function saveModelsCache(models: CursorModelDef[]): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({ at: Date.now(), models } satisfies ModelsCache),
    );
    renameSync(tmpPath, CACHE_PATH);
  } catch {
    // cache write is best-effort
  }
}

function cacheIsFresh(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as ModelsCache;
    return typeof parsed?.at === "number" && Date.now() - parsed.at < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/** Refresh cache from `agent models`. Safe to call without awaiting at session start. */
async function refreshModelsCache(agentPath: string): Promise<CursorModelDef[] | null> {
  try {
    const defs = await runAgentModels(agentPath);
    saveModelsCache(defs);
    return defs;
  } catch {
    return null;
  }
}

function registerCursorProvider(pi: ExtensionAPI, modelDefs: CursorModelDef[]): void {
  pi.registerProvider("cursor", {
    baseUrl: "cli://cursor-agent",
    apiKey: "CURSOR_API_KEY",
    api: "cursor-cli" as Api,
    models: toProviderModels(modelDefs),
    streamSimple: streamCursorCli,
  });
}

export default function (pi: ExtensionAPI) {
  const agentPath =
    process.env["CURSOR_AGENT_PATH"] ??
    process.env["AGENT_PATH"] ??
    "agent";

  // Non-blocking startup: register from cache (or static list) immediately.
  // Background discovery is deferred to session_start so factory-only
  // invocations (e.g. --list-models) do not spawn `agent models`.
  registerCursorProvider(pi, loadModelsCache() ?? STATIC_MODELS);

  registerCursorToolPassthroughs(pi);

  pi.on("session_start", () => {
    if (!cacheIsFresh()) {
      void (async () => {
        const defs = await refreshModelsCache(agentPath);
        if (defs) registerCursorProvider(pi, defs);
      })();
    }
  });

  // ---------------------------------------------------------------------------
  // Slash commands for Cursor auth management
  // ---------------------------------------------------------------------------

  pi.registerCommand("cursor-models-refresh", {
    description: "Refresh cached Cursor model catalog (run `agent models`)",
    handler: async (_args, ctx) => {
      const defs = await refreshModelsCache(agentPath);
      if (defs) {
        registerCursorProvider(pi, defs);
        ctx.ui.notify(
          `Cursor model catalog refreshed (${defs.length} models).`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "Failed to refresh Cursor model catalog (agent models error); keeping cached list.",
          "error",
        );
      }
    },
  });

  pi.registerCommand("cursor-login", {
    description: "Log in to Cursor (runs `agent login`)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Starting Cursor login (NO_OPEN_BROWSER=1 — copy the URL from the output)…", "info");
      try {
        await runAgentLogin(agentPath);
        ctx.ui.notify("Cursor login successful.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cursor login failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("cursor-status", {
    description: "Show Cursor authentication status (runs `agent status`)",
    handler: async (_args, ctx) => {
      try {
        const status = await runAgentStatus(agentPath);
        ctx.ui.notify(status || "No output from `agent status`.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Could not get Cursor status: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("cursor-logout", {
    description: "Log out of Cursor (runs `agent logout`)",
    handler: async (_args, ctx) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(agentPath, ["logout"], {
            stdio: "inherit",
            env: process.env,
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`agent logout exited with code ${code}`));
          });
        });
        ctx.ui.notify("Logged out of Cursor.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cursor logout failed: ${msg}`, "error");
      }
    },
  });
}
