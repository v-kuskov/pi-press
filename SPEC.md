# pi-press: Model-Triggered Context Compaction

## Problem Statement

During long coding sessions, the conversation context grows until it hits the model's token limit. When this happens, the model loses access to earlier messages, decisions, and file context — degrading its ability to help. Existing solutions either silently drop messages (losing information) or require the user to manually manage context. The model itself is in the best position to decide *when* to compact and *what* to preserve, but it needs a tool to do so.

## Solution

A pi extension that provides a `press` tool the model can call to compact the conversation context via an LLM summarization call. The model decides when context is getting full and calls `press` (optionally with a note about what's important to preserve). The extension builds a snapshot of the conversation, sends it to a compaction LLM, and replaces the context with a structured summary. As a safety net, the extension also monitors token usage and automatically compacts when hard limits are reached.

## User Stories

1. As a model with a full context window, I want to call `press` to compact the conversation, so that I can continue working without losing critical information
2. As a model calling `press`, I want to provide a `note` parameter explaining what's important, so that the compaction summary preserves what matters most
3. As a model calling `press`, I want to specify how many recent messages to keep verbatim (via `keep`), so that the immediate working context is preserved
4. As a user, I want forced silent compaction when context hits a hard limit, so that the session doesn't break even if the model forgets to compact
5. As a user, I want a warning injected at a configurable token threshold, so that the model is nudged to compact before it's too late
6. As a user, I want to configure the compaction model separately from the session model, so that I can use a cheaper/faster model for compaction
7. As a user, I want to configure the warning and force thresholds, so that compaction behavior matches my workflow
8. As a user, I want compaction config in pi's standard settings location (global + project), so that I don't need extension-specific config files
9. As a model receiving a compaction result, I want a structured summary with key info, files touched, and notes, so that I can resume work with full context
10. As a model, I want tool results in the snapshot truncated to brief mentions, so that the compaction LLM isn't overwhelmed by huge file reads or codemode output
11. As a model, I want LLM-generated text (my own reasoning, explanations) preserved as-is in the snapshot, so that nuance isn't lost to truncation
12. As a user, I want the extension to return an error to the model if the compaction LLM fails, so that the model can retry or continue with degraded context
13. As a user, I want the warning injected only once per threshold crossing, so that the context isn't spammed with repeated warnings
14. As a model, I want the default behavior to preserve only the last message, so that compaction is thorough by default
15. As a model, I want to keep more messages when I'm in the middle of a complex multi-step task, so that the working context isn't lost
16. As a user, I want the extension to follow pi-summary's config pattern (SettingsManager), so that it integrates consistently with the pi ecosystem
17. As a user, I want the extension to be self-contained in its project directory, so that it doesn't modify anything outside `D:/Code/pi-press`

## Implementation Decisions

### Extension architecture

The extension follows the standard pi extension format: a TypeScript module default-exporting a factory function that receives `ExtensionAPI`. Loaded by jiti (no build step). Entry point declared in `package.json` under `pi.extensions`.

### Tool registration

The `press` tool is registered via `pi.registerTool()` with TypeBox parameters:
- `note` (optional string): model's context about what to preserve
- `keep` (optional integer, default 1): number of messages from the end to preserve verbatim

The tool is registered as `exposure: "direct"` (default) — immediately available to the model. No system prompt injection is needed; the tool description is sufficient. If the model refuses to call it, a system prompt nudge can be added later via `before_agent_start`.

### Context message caching

Messages are cached via the `context` event handler, which fires before each LLM call. The handler stores `event.messages` in a closure variable. The `press` tool executor reads this cached array. This is the same pattern pi-dcp uses — there is no direct accessor for the live message array outside event handlers.

### Snapshot building

When `press` executes, it builds a snapshot of the messages to compact:
1. Split messages: `toCompact = messages.slice(0, -keep)`, `toKeep = messages.slice(-keep)`
2. For each message in `toCompact`:
   - Keep `role` and text content
   - Tool results (role: `toolResult`): replace with `[Tool: {toolName}] → {first 200 chars}...`
   - LLM text content: keep as-is
3. The last assistant message (or last N if `keep > 1`) is preserved verbatim in `toKeep`

### Compaction LLM call

The snapshot is sent to `ctx.modelRegistry.complete()` with a prompt instructing the LLM to produce a structured summary. Model resolution order:
1. `press.model` from config (format: `provider/id`)
2. Current session model (`ctx.model`)

Auth failures or missing model → throw error, return `isError: true` to the model.

### Compaction output format

The LLM produces a `<press-summary>` block containing:
- `summary`: key information, decisions, state
- `files`: list of files read or changed
- `notes`: any user-provided note appended

This block replaces all compacted messages as a single assistant message. The kept messages follow it.

### Token pressure in context hook

The `context` event handler monitors `ctx.getContextUsage().tokens` only when the last message is an assistant text message (not a tool call). This is the natural turn boundary — tool calls and results are mid-turn and shouldn't trigger injection.
- If `>= warnTokens` and no warning injected yet → append a warning message naming `press` and `trim` (once per threshold crossing)
- If `>= criticalTokens` and no critical warning injected yet → append a critical warning naming both tools

The hook never calls a model itself: deciding what the conversation should become is the model's job, through `press` or `trim`.

Guards:
- Only check when last message is assistant text (not tool call)
- Two independent flags (regular, critical); both clear when a staged compaction is installed

### Configuration pattern

Follows pi-summary's pattern: `SettingsManager.create(cwd)` from `@earendil-works/pi-coding-agent`. The extension reads the `press` top-level key from pi's settings files. Project scope wins over global.

Config fields:
- `press.model` (string, optional): compaction model as `provider/id`
- `press.warnTokens` (number, default 260000): token count for warning injection
- `press.criticalTokens` (number, default 500000): critical warning threshold

Unknown/invalid fields are ignored; missing fields use defaults. Malformed config is treated as "not configured" (no error thrown).

### Error handling

- LLM call failure (stopReason === "error") → return `{ isError: true, content: [{type:"text", text: "Compaction failed: {error}"}] }`
- No messages cached → return error "No messages available for compaction"
- Config errors → silently fall back to defaults

### `keep` parameter semantics

`keep` counts raw messages from the end of the array, not logical turns. If `keep` exceeds the total message count, clamp to total (compact nothing, return a note that context is already small). Default is 1 (last message only).

### Tool result identification

Tool results are identified by `role: "toolResult"` on `ToolResultMessage`. Assistant messages with `toolCalls` arrays are kept as-is in the snapshot — only the result payload is truncated.

### Peer dependencies

Standard pi extension peer deps (all `"*"`):
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Dev deps for development: same packages pinned to `^0.99.2`, plus `typescript`.

## Testing Decisions

- No formal test suite initially (pi-summary uses `smoke.mjs` with a fake API — can adopt later)
- Manual testing: install extension via `pi -e D:/Code/pi-press`, call `press` tool in a session
- Verify: config loading (global vs project), tool execution, context hook warnings, critical warning injection
- The extension is self-contained; no mocks of pi internals needed for initial validation
- LLM call can be tested by checking the model registry integration against `routerai/deepseek/deepseek-v4.1-flash`

## Out of Scope

- System prompt injection (only add if model refuses to call the tool)
- Branch/fork handling (pi-dcp's complex branch-aware state reconstruction)
- Session persistence of compaction state (closure variables only)
- UI renderers (TUI components for press tool results)
- Slash commands (pi-dcp has `dcp:help`, `dcp:context`, etc.)
- Multiple compaction strategies (pi-dcp has content-derived keys, nested compression blocks)
- Token counting accuracy optimization (relies on `ctx.getContextUsage()`)

## Further Notes

- The extension uses the pi-dcp pattern of caching messages in the `context` handler closure. This means the cache is only as fresh as the last context pass — a known limitation.
- Critical warnings are injected in the `context` hook; compaction itself happens when the model calls `press` or `trim` on the next turn.
- The `keep` parameter defaults to 1 (last message only). The model can increase this when mid-task.
- Warning injection resets after any compaction (`press` or `trim`), so it re-injects if pressure builds again.
- `keep` > total messages clamps to total — compacts nothing, returns a note.
- Test model for development: `routerai/deepseek/deepseek-v4.1-flash`