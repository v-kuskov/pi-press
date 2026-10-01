import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextHook } from "./src/context-hook.ts";
import { registerPressTool } from "./src/press-tool.ts";
import { createPressState } from "./src/state.ts";

/**
 * pi-press: model-triggered context compaction.
 *
 * The `press` tool is what the model calls; the `context` hook is what makes it take effect.
 * The hook caches the conversation for the tool to read, installs the compaction the tool
 * stages, and warns the model when context usage crosses the configured threshold.
 *
 * The two share one state instance created here, so a process hosting more than one session
 * gives each its own conversation and its own pending compaction.
 *
 * `readPressSettings` is deliberately not called at load: `SettingsManager.create` needs the
 * session cwd, which only an extension context carries. Both the tool and the hook read
 * settings per invocation, which also keeps a mid-session settings edit live.
 */
export default function piPress(pi: ExtensionAPI): void {
	const state = createPressState();
	registerPressTool(pi, state);
	registerContextHook(pi, state);
}
