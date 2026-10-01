# 04: Context Hook — Caching + Warning

**What to build:** Context event handler caches messages on every fire. Checks token usage when last message is assistant text (not tool call). Injects warning once when tokens >= warnTokens. Warning flag resets after any compaction.

**Blocked by:** 02 — Compaction Engine

**Status:** ready-for-agent

- [ ] context event caches event.messages in closure variable
- [ ] token check only fires when last message is assistant text message
- [ ] warning injected when tokens >= warnTokens and flag not set
- [ ] warning is a system message visible to the model
- [ ] warning flag resets after tool compaction or forced compaction
- [ ] no duplicate warnings while flag is set
