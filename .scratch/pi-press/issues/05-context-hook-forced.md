# 05: Context Hook — Forced Compaction

**What to build:** Forced silent compaction when tokens >= forceTokens. Builds snapshot, calls LLM, replaces messages. Skips if last message is not assistant text. LLM failure returns original messages + error note.

**Blocked by:** 04 — Context Hook — Caching + Warning

**Status:** ready-for-agent

- [ ] forced compaction triggers when tokens >= forceTokens
- [ ] only triggers when last message is assistant text (not tool call)
- [ ] replaces all messages with compacted summary + note about forced compaction
- [ ] warning flag reset after forced compaction
- [ ] LLM failure returns original messages + error note (no infinite loop)
