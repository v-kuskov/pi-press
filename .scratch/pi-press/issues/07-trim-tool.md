# 07: Trim Tool + Press Tool Update

**What to build:** New `src/trim-tool.ts` registering a `trim` tool; update `src/press-tool.ts` description; register the new tool in `src/index.ts`.

**Blocked by:** 06 — Compaction Engine

**Status:** in-progress

## 1. trim tool (`src/trim-tool.ts`)

Mirror of `press-tool.ts`, deterministic flavor.

- `registerTrimTool(pi: ExtensionAPI, state: PressState): void`
- Parameters (TypeBox):
  - `note?: string` — "Note to leave for yourself in the trimmed context, e.g. what was just decided."
  - `keep?: integer, min 0, default 1` — "How many recent messages to keep verbatim."
- `executionMode: "sequential"` (rewrites the conversation — must not overlap other tool calls).
- Description: trim is the fast, no-LLM path — replaces old tool results with `[trimmed]` placeholders while keeping assistant reasoning; use when tokens need freeing now; press for a full structured summary.

### Execute flow

1. `state.cachedMessages()`; empty → error result `NO_MESSAGES_NOTE`.
2. `trimMessages(messages, params.keep)`.
   - `kind: "nothing"` → skipped result (`status: "skipped"`, note text), same shape press uses.
   - `kind: "trimmed"` → continue.
3. Build the synthetic anchor message:

```ts
const anchorText = `<press-trim>\n${trimmed} tool results replaced with [trimmed].${files.length ? `\nRecently referenced: ${files.join(", ")}.` : ""}\n</press-trim>`;
```

- `files` from `extractFilePaths(messages)` (full conversation is fine; the engine helper dedupes).
- The caller note is NOT part of this anchor message body beyond... **it is**: append `Note: <note>` as a line inside `<press-trim>` when a note was passed, so a later `findAnchor` surfaces it to the next compaction. One note per call.
- Stage `[anchorMessage, ...result.messages]` with base = the messages this call processed (same discipline as press: `state.stageCompacted(replacement, messages)`).
- The staged replacement is the anchor message followed by the **trimmed message array** (anchor region untouched, candidates' tool results replaced, kept tail verbatim).

4. Tool result returned to the model (its view of this turn):

```
Context trimmed.
- N tool results replaced with [trimmed]
- last K messages kept verbatim
```

Plus, when a note was passed: `\n\nNote left: <note>` — no, note already sits in the anchor. Keep the tool result factual: counts only. Model sees its note in the next context pass via the anchor.

### TrimDetails

```ts
export type TrimDetails = {
  status: "trimmed" | "skipped" | "error";
  trimmed: number;
  kept: number;
};
```

## 2. press tool update (`src/press-tool.ts`)

- No `mode` parameter (press is compaction-only by design).
- Description tweak: mention `trim` as the fast alternative when only tokens need freeing.
- Everything else unchanged: `note`/`keep` params, staging, PressDetails.

## 3. index.ts

- Register trim alongside press: `registerTrimTool(pi, state)` next to `registerPressTool`.
- Both share the one `PressState` (per-registration).

## Verification

- `npx tsc --noEmit` clean.
- `node smoke.mjs` — new tests: trim happy path (counts, `[trimmed]` placeholders, anchor message format), trim with note (note inside `<press-trim>`), trim skipped (no tool results), trim empty conversation, tool result shape; full suite green.
