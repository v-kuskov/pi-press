# AGENTS.md

pi-press: a pi extension where the model compacts its own conversation — `press` (LLM summary) and `trim` (free tool-result erasure), plus a `context` hook that installs what they stage and warns on token pressure. Loaded from TypeScript by jiti; verify changes with `npm run check` (typecheck + `smoke.mjs`).

## Architecture

- `index.ts` — factory. Creates one `PressState` per registration and wires both tools and the hook to it, so sessions never share a conversation.
- `src/compact.ts` — the compaction engine: snapshot building, trimming, the single model call, and the `<press-summary>`/`<press-trim>` renderers and parsers. Both block formats' writers and parsers live here together — they must not drift.
- `src/state.ts` — shared state: the cached conversation and the staged compaction.
- `src/press-tool.ts`, `src/trim-tool.ts` — tool registration and executors.
- `src/context-hook.ts` — one pass per LLM call: cache messages, install staged compaction, then threshold checks.
- `src/config.ts` — the `press` settings key. Read per invocation, never at load, so settings edits stay live mid-session.
- `src/pi-context-contract.ts` — compile-time drift guard between `CompactionContext` and pi's real context types. Its assignments are the guard.
- `smoke.mjs` — the test suite.

## Load-bearing invariants

- **Stage, then install.** Tools only stage a replacement context in `PressState`; the `context` hook installs it. The tools hold the conversation still — rewriting it directly would race pi.
- **Hook order is fixed**: cache → install staged → threshold checks. A compaction must relieve pressure before warnings evaluate.
- **Act at turn boundaries only.** Threshold checks fire solely when the last message is assistant text with no pending tool call (`isAssistantTextMessage`); a mid-turn rewrite would drop results still in flight.
- **Notes never enter the prompt.** The caller's `note` is appended after the model's answer (`appendNote`) so it cannot be paraphrased away.
- **The cache holds pi's own array.** `hasPrefix` checks prefix membership by reference identity. Copying the array breaks stale-compaction detection.
- **The engine stays pi-free.** `compact.ts` declares structural message shapes so the smoke-test fake satisfies them; `pi-context-contract.ts` keeps that shape honest against pi's `ExtensionContext` and `ExtensionToolContext`.
- **Model resolution fails loud.** `press.model` configured but unknown or unauthenticated throws `PressError` with a hint; only an absent `model` falls back to the session model.

## Conventions

- Comments carry the why; the code carries the what.
- Tabs for indentation.
- Tests are assert-based checks in `smoke.mjs`, named as full sentences describing expected behaviour. Cases set `PI_CODING_AGENT_DIR` to a temp directory before anything reads settings, and build throwaway project trees per case.
