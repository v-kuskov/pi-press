import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextHook } from "./src/context-hook.ts";
import { registerPressTool } from "./src/press-tool.ts";
import { registerTrimTool } from "./src/trim-tool.ts";
import { createPressState } from "./src/state.ts";

/**
 * pi-press: model-triggered context compaction.
 *
 * The `press` and `trim` tools are what the model calls; the `context` hook is what makes them
 * take effect. The hook caches the conversation for the tools to read, installs the compaction
 * either one stages, and warns the model when context usage crosses the configured thresholds.
 *
 * The two tools split the work: `trim` reclaims the tokens sitting in old tool results for
 * nothing, `press` spends a model call to turn the conversation into a summary.
 *
 * The three share one state instance created here, so a process hosting more than one session
 * gives each its own conversation and its own pending compaction.
 *
 * `readPressSettings` is deliberately not called at load: `SettingsManager.create` needs the
 * session cwd, which only an extension context carries. Both the tools and the hook read
 * settings per invocation, which also keeps a mid-session settings edit live.
 */
export default function piPress(pi: ExtensionAPI): void {
	const state = createPressState();
	registerPressTool(pi, state);
	registerTrimTool(pi, state);
	registerContextHook(pi, state);
}
