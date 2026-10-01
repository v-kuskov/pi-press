import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ConversationMessage } from "./compact.ts";
import { readPressSettings } from "./config.ts";
import { cacheMessages, takeStagedCompactedContext } from "./state.ts";

/** One message of the conversation, as pi's `context` event carries it. */
type AgentMessage = ContextEvent["messages"][number];

/**
 * Warning text handed to the model when the context crosses the configured threshold.
 *
 * It names the tool and both of its parameters, because the model reading it has to act on
 * it in one step: nothing else will tell it what `press` accepts.
 */
export function warningText(tokens: number, warnTokens: number): string {
	return `Context usage is at ${tokens} tokens, past the ${warnTokens}-token warning threshold. Call the press tool to compact the conversation into a summary before the context is lost to forced compaction: pass note describing what matters most to preserve, and keep for how many recent messages to leave verbatim.`;
}

/** The synthetic message appended to the conversation to carry the warning. */
export function warningMessage(tokens: number, warnTokens: number): AgentMessage {
	return {
		role: "system",
		content: [{ type: "text", text: warningText(tokens, warnTokens) }],
		timestamp: Date.now(),
	};
}

/**
 * Whether `message` is an assistant turn that ends with text and nothing pending.
 *
 * This is the natural turn boundary, and the only place the token pressure check runs: an
 * assistant message that requests a tool call, or a tool result, is mid-turn, and acting on
 * the conversation there would rewrite it out from under results that are still arriving.
 */
export function isAssistantTextMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "assistant" || !Array.isArray(content)) return false;

	let hasText = false;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const type = (part as { type?: unknown }).type;
		if (type === "toolCall") return false;
		if (type === "text") hasText = true;
	}
	return hasText;
}

/**
 * State the hook carries between `context` passes.
 *
 * Created per registration, so it lives and dies with the loaded extension. The warning is
 * injected once per threshold crossing and the flag clears on any compaction, which is how
 * pressure that builds up again gets its own warning.
 */
export type ContextHookState = {
	/** Whether the warning has been appended and no compaction has cleared it yet. */
	warned: boolean;
};

/**
 * Register the `context` hook: the only place with a writable view of the conversation.
 *
 * It runs before every LLM call and does three things, in order:
 *
 * 1. Caches `event.messages` for the `press` tool (see src/state.ts).
 * 2. Installs a compaction the tool staged. The tool cannot replace the conversation itself,
 *    so a manual `press` only takes effect here, on the next pass.
 * 3. Warns the model once when context usage crosses `press.warnTokens`.
 *
 * Settings are re-read on every pass rather than cached at load: a pass already costs a
 * provider round trip, the read is a local file, and this keeps an edited threshold live
 * mid-session without a reload. The read is skipped on the passes that do not need it.
 */
export function registerContextHook(pi: ExtensionAPI): void {
	const state: ContextHookState = { warned: false };
	pi.on("context", (event, ctx) => handleContext(event, ctx, state));
}

/**
 * One `context` pass.
 *
 * Exported as the seam for forced compaction (ticket 05): the force branch reads the same
 * `tokens` and `settings` and slots in above the warning, so a force pass replaces the
 * conversation and never also warns about it.
 */
export function handleContext(
	event: ContextEvent,
	ctx: ExtensionContext,
	state: ContextHookState,
): ContextEventResult | undefined {
	// Cache the conversation as pi handed it over: the warning appended below is ours, not
	// part of the transcript, and must not end up in what `press` summarizes.
	cacheMessages(event.messages);

	const staged = takeStagedCompactedContext();
	if (staged !== undefined) {
		// A compaction just landed. Its summary has no pressure behind it, and the next
		// threshold crossing deserves a fresh warning, so the flag clears here.
		state.warned = false;
		return { messages: asAgentMessages(staged) };
	}

	// Turn boundary first: it costs nothing and most passes end mid-turn.
	if (!isAssistantTextMessage(event.messages.at(-1))) return undefined;

	const tokens = ctx.getContextUsage()?.tokens;
	if (tokens === undefined || tokens === null) return undefined;

	const settings = readPressSettings(ctx.cwd);
	if (tokens < settings.warnTokens || state.warned) return undefined;

	state.warned = true;
	return { messages: [...event.messages, warningMessage(tokens, settings.warnTokens)] };
}

/**
 * Present engine messages back to pi.
 *
 * The engine reads and writes messages structurally (`ConversationMessage`, see src/compact.ts)
 * so the hook, the tool and smoke.mjs share one shape; what it stages is a plain
 * `{role, content, timestamp}` object that satisfies a real message without carrying pi's
 * provider bookkeeping. Only the check needs the cast, and it happens at this one boundary.
 */
function asAgentMessages(messages: readonly ConversationMessage[]): AgentMessage[] {
	return messages as unknown as AgentMessage[];
}
