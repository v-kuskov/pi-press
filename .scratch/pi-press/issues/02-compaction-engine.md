# 02: Compaction Engine

**What to build:** Core compaction logic: builds a snapshot from messages (tool results truncated to 200 chars, LLM text as-is), calls LLM via ctx.modelRegistry.complete(), parses <press-summary> response. Returns compacted messages array.

**Blocked by:** 01 — Skeleton + Config

**Status:** done

- [ ] buildSnapshot splits messages by keep parameter, truncates tool results to 200 chars
- [ ] compactContext calls LLM with config model (fallback to session model)
- [ ] LLM response parsed for <press-summary> block with summary, files, notes sections
- [ ] LLM failure returns error with stopReason details
- [ ] keep > total messages clamps to total, returns note
