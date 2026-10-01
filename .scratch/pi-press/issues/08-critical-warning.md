# 08: Context Hook — Critical Warning, Remove Forced Compaction

**What to build:** Replace silent forced compaction with a second, more urgent warning; mention both tools in warnings.

**Status:** in-progress

## 1. Remove forced compaction

Delete from `src/context-hook.ts`:

- `FORCE_NOTE` constant.
- `forceCompact` function.
- `forceFailureMessage` function.
- The force-compact branch in `handleContext` that calls `compactContext` at `forceTokens`.

The hook no longer makes LLM calls of its own. Its only jobs: cache messages, install staged compactions, inject warnings.

## 2. Critical warning

New exported pair, same shape as `warningText` / `warningMessage`:

```ts
export function criticalWarningText(tokens: number, percent: number): string
export function criticalWarningMessage(tokens: number, percent: number): AgentMessage
```

- Fired when `tokens >= settings.criticalTokens`.
- More urgent than the regular warning: names BOTH tools and demands immediate action.
- Suggested text: context is critically large (N tokens, P% of window) — call press for a structured summary or trim to drop tool results now, before the next step degrades.
- Include both tool names and their purpose in one or two sentences. Model must act on this in one step.

## 3. handleContext ordering

New order inside the turn-boundary check:

1. Cache messages (always, unchanged).
2. Install staged compaction if any (unchanged — deferred/invalid logic intact).
3. Turn boundary check: if last message not assistant-text → return, no token checks.
4. Token usage check:
   - `tokens >= criticalTokens` → inject critical warning (once per crossing).
   - else `tokens >= warnTokens` → inject regular warning (once per crossing).
5. Warning flag semantics unchanged: single `warned` flag, injected once, cleared by any installed compaction.

One flag covers both thresholds: crossing warnTokens arms it; a later crossing of criticalTokens while still armed should still upgrade... **decision**: use two flags or one?

**Chosen: two flags.** `warned` and `criticallyWarned`. A session that crossed warnTokens must still receive the critical warning when it later crosses criticalTokens. Compaction install clears BOTH flags (fresh headroom, fresh warnings allowed).

## 4. config.ts

- `DEFAULT_FORCE_TOKENS` renamed to `DEFAULT_CRITICAL_TOKENS` (500000), JSDoc: "Context tokens at or above which a critical warning is injected." Field name `forceTokens` renamed to `criticalTokens` too — the earlier "config names stay" decision is superseded (user: no backcompat needed yet).
- `PressSettings.criticalTokens` doc comment likewise.

## 5. Unchanged

- `warningText` regular message (mentions press — update to mention press OR trim).
- `isAssistantTextMessage`, `hasPrefix` (renamed from `startsWith`), install/staged logic.
- `registerContextHook` shape.

## Verification

- `npx tsc --noEmit` clean.
- `node smoke.mjs` — tests that covered forced compaction now assert critical-warning injection instead; new tests: critical at ≥ criticalTokens, both flags independent, compaction clears both, warning text names both tools. Full suite green.
