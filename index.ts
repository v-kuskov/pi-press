import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-press: model-triggered context compaction.
 *
 * The `press` tool, the message cache and the token-pressure hook all arrive in later
 * tickets; this ticket pins the package skeleton, the entry point and the `press`
 * configuration (see src/config.ts).
 *
 * Nothing is registered or started here yet, and `readPressSettings` is deliberately not
 * called at load: `SettingsManager.create` needs the session cwd, which only an extension
 * context carries. Reading per call also keeps a mid-session settings edit live.
 */
export default function piPress(_pi: ExtensionAPI): void {}
