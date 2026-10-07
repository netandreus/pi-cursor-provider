#!/usr/bin/env node
/**
 * Regression: Pi 1.x hands providers a TranscriptContext whose only field is
 * `messages`. The system prompt lives in system messages (`content` plus named
 * `sections`) and `context.systemPrompt` is unset. The provider used to read
 * only `context.systemPrompt`, so under Pi 1.x the whole `[System]` block was
 * dropped and the Cursor CLI received the transcript with no instructions.
 *
 * Node loads index.ts through its built-in type stripping, so the test skips
 * itself on Node builds that cannot strip types.
 */
const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1] ?? 0);
if (major < 23 || (major === 23 && minor < 6)) {
  console.log(`SKIP: system-prompt transcript test needs Node >= 23.6 (got ${process.versions.node})`);
  process.exit(0);
}

let resolveSystemPrompt;
let serializeContext;
try {
  ({ resolveSystemPrompt, serializeContext } = await import("../index.ts"));
} catch (error) {
  console.error(`FAIL: could not load index.ts: ${error?.message ?? error}`);
  process.exit(1);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
function pass(message) {
  console.log(`PASS: ${message}`);
}
function equal(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// 1. Pi 1.x shape: system message carries content and named sections.
const transcriptContext = {
  messages: [
    {
      role: "system",
      content: "",
      sections: {
        preamble: "You are an expert coding assistant.",
        rules: "<rules>\n- Be concise\n</rules>",
      },
      timestamp: 0,
    },
    { role: "user", content: "hi", timestamp: 1 },
  ],
};
equal(
  resolveSystemPrompt(transcriptContext),
  "You are an expert coding assistant.\n\n<rules>\n- Be concise\n</rules>",
  "transcript replay must emit content then sections",
);

const prompt = serializeContext(transcriptContext);
if (!prompt.startsWith("[System]\nYou are an expert coding assistant."))
  fail(`serializeContext dropped the [System] block: ${JSON.stringify(prompt.slice(0, 120))}`);
if (!prompt.includes("[User]\nhi"))
  fail(`serializeContext lost the user turn: ${JSON.stringify(prompt)}`);
pass("Pi 1.x transcript system message reaches the [System] block");

// 2. Later system messages patch sections by name, and null removes one.
const patched = {
  messages: [
    { role: "system", content: "Base.", sections: { rules: "old rules" }, timestamp: 0 },
    { role: "system", content: "", sections: { rules: "new rules", docs: "docs block" }, timestamp: 1 },
    { role: "system", sections: { docs: null }, timestamp: 2 },
  ],
};
equal(
  resolveSystemPrompt(patched),
  "Base.\n\nnew rules",
  "sections must patch by name and null must remove",
);
pass("section patches and removals replay in order");

// 3. Legacy Pi still sets the field, and it wins.
const legacy = {
  systemPrompt: "Legacy prompt.",
  messages: transcriptContext.messages,
};
equal(resolveSystemPrompt(legacy), "Legacy prompt.", "legacy systemPrompt must win");
pass("legacy context.systemPrompt still wins");

// 4. No system messages and no field means no prompt, not a crash.
equal(
  resolveSystemPrompt({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
  "",
  "a transcript without system messages has no prompt",
);
pass("missing prompt stays empty");

console.log("system-prompt transcript: all cases passed");
