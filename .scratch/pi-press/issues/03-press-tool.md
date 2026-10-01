# 03: Press Tool

**What to build:** Registers the press tool with note (optional string) and keep (optional integer, default 1) parameters. Wires to compaction engine. Model can call press to compact context.

**Blocked by:** 02 — Compaction Engine

**Status:** done

- [ ] press tool registered via pi.registerTool with TypeBox parameters
- [ ] tool accepts note (optional string) and keep (optional integer, default 1)
- [ ] tool reads cached messages from context hook
- [ ] tool calls compaction engine and returns summary as tool result
- [ ] no messages cached returns isError with message
- [ ] LLM failure returns isError with error details
