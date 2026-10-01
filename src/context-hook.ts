import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { compactContext, DEFAULT_KEEP, failureText } from "./compact.ts";
import type { ConversationMessage } from "./compact.ts";
import { readPressSettings } from "./config.ts";
import type { PressSettings } from "./config.ts";
import type { PressState } from "./state.ts";

/** One message of the conversation, as pi's `context` event carries it. */
type AgentMessage = ContextEvent["messages"][number];

/**
 * The note a forced compaction carries.
 *
 * It reaches the next turns twice over: appended to the summary by the engine, outside the
 * compaction model's control, and given to that model in its prompt so it knows why the
 * conversation it is reading is being cut short.
 */
const FORCE_NOTE = "Context was force-compacted due to token limit";

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
 * Whether `conversation` still contains `base` at its front, message by message.
 *
 * Identity, not deep equality: the hook caches the array pi handed it, so the messages a
 * summary was made from are literally the ones now in front of us. A conversation that no
 * longer holds them was rebuilt elsewhere, and the summary describes a history that is gone.
 */
function startsWith(conversation: readonly ConversationMessage[], base: readonly ConversationMessage[]): boolean {
	return base.length <= conversation.length && base.every((message, index) => conversation[index] === message);
}

/**
 * Register the `context` hook: the only place with a writable view of the conversation.
 *
 * It runs before every LLM call and does four things, in order:
 *
 * 1. Caches `event.messages` for the `press` tool (see src/state.ts).
 * 2. Installs a compaction the tool staged, unless the conversation has moved on past it
 *    mid-turn - in which case the install is deferred, never dropped.
 * 3. Force-compacts silently when context usage crosses `press.forceTokens`, which is the
 *    safety net for a model that never called `press` on its own.
 * 4. Warns the model once when context usage crosses `press.warnTokens`.
 *
 * Settings are re-read on every pass rather than cached at load: a pass already costs a
 * provider round trip, the read is a local file, and this keeps an edited threshold live
 * mid-session without a reload. The read is skipped on the passes that do not need it.
 *
 * `state` belongs to this registration alone, so two loaded sessions never see each other's
 * conversation or each other's pending compaction.
 */
export function registerContextHook(pi: ExtensionAPI, state: PressState): void {
	const hook: ContextHookState = { warned: false };
	pi.on("context", (event, ctx) => handleContext(event, ctx, hook, state));
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
 * One `context` pass.
 *
 * Exported as the seam for forced compaction: the force branch reads the same `tokens` and
 * `settings` and slots in above the warning, so a force pass replaces the conversation and
 * never also warns about it.
 */
export async function handleContext(
	event: ContextEvent,
	ctx: ExtensionContext,
	state: ContextHookState,
	press: PressState,
): Promise<ContextEventResult | undefined> {
	// Cache the conversation as pi handed it over: the warning appended below is ours, not
	// part of the transcript, and must not end up in what `press` summarizes.
	press.cacheMessages(event.messages);

	const installed = installStaged(event, press);
	if (installed !== undefined) {
		// A compaction just landed. Its summary has no pressure behind it, and the next
		// threshold crossing deserves a fresh warning, so the flag clears here.
		state.warned = false;
		return { messages: asAgentMessages(installed) };
	}

	// Turn boundary first: it costs nothing and most passes end mid-turn.
	if (!isAssistantTextMessage(event.messages.at(-1))) return undefined;

	const tokens = ctx.getContextUsage()?.tokens;
	if (tokens === undefined || tokens === null) return undefined;

	const settings = readPressSettings(ctx.cwd);

	// The hard limit first: at this pressure the conversation is compacted whether the model
	// asked or not, and the pass ends here so the warning is never injected alongside it.
	if (tokens >= settings.forceTokens) return forceCompact(event, ctx, state, settings);

	if (tokens < settings.warnTokens || state.warned) return undefined;

	state.warned = true;
	return { messages: [...event.messages, warningMessage(tokens, settings.warnTokens)] };
}

/**
 * The conversation the staged compaction asks for, or undefined when it must wait or is void.
 *
 * A staged summary describes one particular conversation, and installing it replaces the whole
 * array. That makes the timing the whole problem, and there are three cases:
 *
 * - The conversation it was made from is no longer in front of us. Something else rebuilt the
 *   history (a forced compaction, another handler), so the summary describes a session that
 *   has moved on: it is dropped rather than installed over the wrong conversation.
 * - The conversation has grown with work the summary never saw - the tool results that
 *   followed the `press` call, possibly for tools the model called alongside it. Installing
 *   now would drop them, and the model would never read a result it asked for, so the install
 *   waits. The staging stays in place, so it installs on a later pass instead of being lost.
 * - Nothing newer than the summary, or the turn has come back to rest at an assistant text
 *   message: everything the summary did not cover is finished work, so it installs. Those
 *   newer messages ride along after the kept tail, which is what keeps a delayed install from
 *   swallowing the turn that arrived while it waited.
 */
function installStaged(
	event: ContextEvent,
	press: PressState,
): readonly ConversationMessage[] | undefined {
	const staged = press.staged();
	if (staged === undefined) return undefined;

	if (!startsWith(event.messages, staged.base)) {
		press.clearStaged();
		return undefined;
	}

	const fresh = event.messages.slice(staged.base.length);
	if (fresh.length > 0 && !isAssistantTextMessage(event.messages.at(-1))) return undefined;

	press.clearStaged();
	return [...staged.messages, ...fresh];
}

/**
 * Force-compact the conversation because context usage has reached the hard limit.
 *
 * The engine does the work: a forced compaction is a `press` with the default `keep`, so
 * everything but the last message is summarized and the last message is preserved verbatim.
 * The difference is who decides - here nobody does, which is why the pass returns the rebuilt
 * array in place of the one pi handed over.
 *
 * A failure never retries inside the pass. A provider that is down would otherwise spin on
 * every pass, so the conversation is handed back untouched with a note saying what happened,
 * and the next turn decides what to do about it.
 */
async function forceCompact(
	event: ContextEvent,
	ctx: ExtensionContext,
	state: ContextHookState,
	settings: PressSettings,
): Promise<ContextEventResult | undefined> {
	try {
		const result = await compactContext(ctx, event.messages, DEFAULT_KEEP, FORCE_NOTE, settings);

		if (result.kind === "skipped") {
			// Nothing was compacted, so this pass changed nothing - and the warning flag is left
			// as it was. Clearing it here would re-arm a warning for pressure that never went away.
			return undefined;
		}

		// Any compaction relieves the pressure the warning was about, so the next crossing gets
		// its own warning (the same reset the staged-compaction branch performs above).
		state.warned = false;
		return { messages: asAgentMessages([result.message, ...result.kept]) };
	} catch (error) {
		return { messages: [...event.messages, forceFailureMessage(error)] };
	}
}

/** The synthetic message that reports a failed forced compaction to the model. */
function forceFailureMessage(error: unknown): AgentMessage {
	return {
		role: "system",
		content: [
			{
				type: "text",
				text: `The context is over the token limit but forced compaction did not happen, so the conversation is unchanged. ${failureText(error)}\n\nCall the press tool to compact the conversation yourself.`,
			},
		],
		timestamp: Date.now(),
	};
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
