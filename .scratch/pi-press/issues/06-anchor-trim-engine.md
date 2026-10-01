# 06: Compaction Engine — Anchor System, Trimming, File Paths

**What to build:** Three engine capabilities in `src/compact.ts`, all pure functions testable through smoke.mjs.

**Status:** in-progress

## 1. findAnchor

Search a compacted run backward for the last anchor message: an assistant message whose text contains `<press-summary>` or `<press-trim>` block.

```ts
export type Anchor =
  | { kind: "summary"; text: string; afterIndex: number }
  | { kind: "trim"; text: string; afterIndex: number };
export function findAnchor(messages: readonly ConversationMessage[]): Anchor | undefined
```

- Iterate from the end; the first (latest) anchor wins.
- `text` is the inside of the block (use the existing `pressSummaryBody`-style extraction for `<press-summary>`; for `<press-trim>` extract between `<press-trim>` and `</press-trim>`, tolerating an unclosed tail the same way).
- `afterIndex` is the index of the anchor message itself; callers slice `messages.slice(afterIndex + 1)` to get only messages after it.
- For `<press-summary>` candidates: validate by running the extracted text through the section parser — if no recognized section heading is found, treat it as a false positive (e.g. a caller note that literally contains `<press-summary>` text) and keep scanning backward.
- Return `undefined` when no valid anchor exists.

## 2. trimMessages

Deterministic trimming: replace tool result content with `[trimmed]`, keep everything else.

```ts
export type TrimResult =
  | { kind: "trimmed"; messages: ConversationMessage[]; trimmed: number; kept: number }
  | { kind: "nothing"; note: string };
export function trimMessages(
  messages: readonly ConversationMessage[],
  keep: number | undefined,
): TrimResult
```

- Split with the same `clampKeep` logic as `buildSnapshot`: kept tail = last `keep` messages, untouched.
- **Anchor-aware**: call `findAnchor` on the compacted run. If an anchor exists, only messages after `afterIndex` are candidates; messages up to and including the anchor are left as-is (they are already processed).
- In the candidate region: every message with `role === "toolResult"` gets its `content` replaced with `[{ type: "text", text: "[trimmed]" }]`. Message identity/shape (role, timestamps, toolCallId) preserved — do NOT drop the message, dropping breaks the toolCall → toolResult chain.
- `trimmed` counts replaced tool results; `kept` is the kept-tail count.
- If the candidate region contains zero tool results: return `{ kind: "nothing", note }` with a note like "No tool results to trim." (mirrors `buildSnapshot`'s nothing case).
- If nothing to compact at all (keep >= total): same `kind: "nothing"` path.

## 3. extractFilePaths

```ts
export function extractFilePaths(messages: readonly ConversationMessage[]): string[]
```

- Scan `assistant` messages for `toolCalls` blocks.
- For tool names that operate on files (`read`, `edit`, `write`, `resolve_file`, `summary`, `related_files`), extract the path-like argument (`path` or `pattern`).
- Deduplicate, preserving first-seen order... no: preserving **last** occurrence order is wrong too. Preserve first-seen order (stable, deterministic).
- Return `string[]` (possibly empty).

## 4. buildPrompt — remove note, add anchor

```ts
function buildPrompt(
  snapshot: string,
  compacted: number,
  kept: number,
  anchor?: Anchor,
): string
```

- **Remove the `note` parameter entirely.** The caller's note never enters the LLM prompt. Delete the `noteBlock`.
- When `anchor` is provided, prepend an anchor section to the prompt:
  - `anchor.kind === "summary"`: framed as continuation/merge — "Below is your existing summary for this conversation. Merge the new messages into it: preserve what is still relevant, remove what is superseded or resolved." Then the existing summary text, then the new-messages snapshot.
  - `anchor.kind === "trim"`: framed as fresh summary with prior context noted — "The conversation was previously trimmed; the note below describes what was removed. Summarize only the new messages." Then the trim note, then the new-messages snapshot.
- The five-section `<press-summary>` output format, continuation framing, and over-inclusion bias stay exactly as they are.
- Headings must stay in sync with `SUMMARY_SECTIONS` / `SECTION_KEY`.

## 5. compactContext — use the anchor

```ts
export async function compactContext(
  ctx, messages, keep, note, settings,
): Promise<CompactionResult>
```

Signature unchanged (note still accepted — it is appended deterministically, not prompted). Internally:

1. `buildSnapshot(messages, keep)` → compacted run + kept tail (unchanged).
2. `findAnchor(compactedRun)`.
3. If anchor found: new-messages run = `compactedRun.slice(anchor.afterIndex + 1)`. If the new run is empty, return `kind: "skipped"` with a note like "Already compacted up to the last anchor: nothing new to summarize." Otherwise build the snapshot text from the new run only.
4. Build prompt with anchor (see §4). LLM call, parse — unchanged.
5. `extractFilePaths` over the **full compacted run** (not just the new messages) and pass to `renderPressSummary`.
6. `appendNote(rendered, note)` — unchanged; note still deterministic output append.

## 6. renderPressSummary — referenced files

```ts
function renderPressSummary(summary: PressSummary, referencedFiles?: readonly string[]): string
```

- After the model-generated `## Context to Preserve` section content (or as its own trailing block when the model left that section empty), deterministically append:

```
Recently referenced files:
- src/foo.ts
- src/bar.ts
```

- Only when `referencedFiles` is non-empty.
- Must still produce valid `<press-summary>` block structure; parser must round-trip it (the "Recently referenced files:" lines live inside the Context to Preserve section body).

## 7. Unchanged

- `PressSummary` five fields, `SUMMARY_SECTIONS`, `SECTION_KEY`, `headingKey`, `parsePressSummary`, `splitSections`, `appendNote`, `failureText`, `PressError`, `resolveCompactionModel`, `requestSummary`.
- Note semantics: optional, model's own note-to-self, one per call, deterministic append after `<press-summary>`, never in prompt.

## Verification

- `npx tsc --noEmit` clean.
- `node smoke.mjs` — existing tests updated (note removed from prompt assertions), new tests for findAnchor / trimMessages / extractFilePaths / anchored prompt / referenced files round-trip. Full suite green.
