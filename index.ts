import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPressTool } from "./src/press-tool.ts";

/**
 * pi-press: model-triggered context compaction.
 *
 * The `press` tool is registered here; the message cache and the token-pressure hook arrive
 * in later tickets (see src/state.ts for the cache the tool reads and stages into).
 *
 * `readPressSettings` is deliberately not called at load: `SettingsManager.create` needs the
 * session cwd, which only an extension context carries. The tool reads settings per call,
 * which also keeps a mid-session settings edit live.
 */
export default function piPress(pi: ExtensionAPI): void {
	registerPressTool(pi);
}
