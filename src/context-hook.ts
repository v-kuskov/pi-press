import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ConversationMessage } from "./compact.ts";
import { readPressSettings } from "./config.ts";
import type { PressState } from "./state.ts";

/** One message of the conversation, as pi's `context` event carries it. */
type AgentMessage = ContextEvent["messages"][number];

/**
 * Warning text handed to the model when the context crosses the warning threshold.
 *
 * It leads with `trim` because that is the move the model can make in one step at no cost: an
 * instruction the model can carry out right now beats one it has to weigh against a model call,
 * and the pressure often goes away without a summary. `press` follows for the case trimming
 * cannot cover. Both are named with their parameters, because this message is the model's only
 * prompt-side reminder of what they accept.
 */
export function warningText(tokens: number, warnTokens: number): string {
	return `Context is at ${tokens} tokens, past the ${warnTokens}-token warning threshold. Call trim now: it replaces old tool results with [trimmed] and costs no model call, and the raw output you have finished with is where the tokens went. Call press instead when the conversation itself should become a summary - pass note for what matters most to preserve, and keep for how many recent messages to leave verbatim.`;
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
 * Warning text handed to the model when context usage reaches the critical threshold.
 *
 * The regular warning says the context is filling; this one says the next step is already
 * degrading. It still leads with `trim`, the move that buys headroom before anything else runs,
 * and names `press` for the conversation that has become a summary rather than a working set.
 * Phrased as an instruction rather than a status, because acting within one step is the point.
 */
export function criticalWarningText(tokens: number, percent: number): string {
	return `Context is critically large: ${tokens} tokens, ${percent}% of the window, and the next steps will degrade unless you act now. Call trim to drop old tool results with [trimmed] before your next step - it costs no model call. Call press when the conversation itself should become a summary.`;
}

/** The synthetic message appended to the conversation to carry the critical warning. */
export function criticalWarningMessage(tokens: number, percent: number): AgentMessage {
	return {
		role: "system",
		content: [{ type: "text", text: criticalWarningText(tokens, percent) }],
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
function hasPrefix(conversation: readonly ConversationMessage[], base: readonly ConversationMessage[]): boolean {
	return base.length <= conversation.length && base.every((message, index) => conversation[index] === message);
}

/**
 * Register the `context` hook: the only place with a writable view of the conversation.
 *
 * It runs before every LLM call and does three things, in order:
 *
 * 1. Caches `event.messages` for the `press` and `trim` tools (see src/state.ts).
 * 2. Installs a compaction a tool staged, unless the conversation has moved on past it
 *    mid-turn - in which case the install is deferred, never dropped.
 * 3. Appends a warning when context usage crosses a threshold: a critical one at
 *    `press.criticalTokens`, otherwise a regular one at `press.warnTokens`.
 *
 * The hook never calls a model itself. Deciding what the conversation should become is the
 * model's job, through `press` or `trim`; the hook only reports the pressure and installs what
 * the tools produced, which is what keeps warning text and compaction under one owner each.
 *
 * Settings are re-read on every pass rather than cached at load: a pass already costs a
 * provider round trip, the read is a local file, and this keeps an edited threshold live
 * mid-session without a reload. The read is skipped on the passes that do not need it.
 *
 * `state` belongs to this registration alone, so two loaded sessions never see each other's
 * conversation or each other's pending compaction.
 */
export function registerContextHook(pi: ExtensionAPI, state: PressState): void {
	const hook: ContextHookState = { warned: false, criticallyWarned: false };
	pi.on("context", (event, ctx) => handleContext(event, ctx, hook, state));
}

/**
 * State the hook carries between `context` passes.
 *
 * Created per registration, so it lives and dies with the loaded extension. Each warning is
 * injected once per threshold crossing - one flag per threshold, so a session that was already
 * warned at the regular threshold still gets the critical warning when it reaches the critical
 * one - and both flags clear on any compaction, which is how pressure that builds up again gets
 * its own warning.
 */
export type ContextHookState = {
	/** Whether the regular warning has been appended and no compaction has cleared it yet. */
	warned: boolean;
	/** Whether the critical warning has been appended and no compaction has cleared it yet. */
	criticallyWarned: boolean;
};

/**
 * One `context` pass.
 *
 * The order is fixed by what each step needs: the cache is refreshed first because a staged
 * compaction may be replaced by it, the install comes next because it is the only step that can
 * rewrite the conversation, and the token checks come last because a compaction has just
 * relieved the pressure they measure.
 *
 * The critical threshold takes precedence over the regular one, and they share this pass rather
 * than both firing: at that pressure the model needs the urgent instruction, not two messages
 * saying the same thing.
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
		// threshold crossing deserves a fresh warning, so both flags clear here.
		state.warned = false;
		state.criticallyWarned = false;
		return { messages: asAgentMessages(installed) };
	}

	// Turn boundary first: it costs nothing and most passes end mid-turn.
	if (!isAssistantTextMessage(event.messages.at(-1))) return undefined;

	const usage = ctx.getContextUsage();
	if (usage === undefined) return undefined;
	const tokens = usage.tokens;
	if (tokens === null) return undefined;

	const settings = readPressSettings(ctx.cwd);

	// The critical threshold first. It is a crossing of its own: a session warned at the regular
	// threshold is still told, in no uncertain terms, that the situation has changed.
	if (tokens >= settings.criticalTokens) {
		if (state.criticallyWarned) return undefined;
		state.criticallyWarned = true;
		return {
			messages: [...event.messages, criticalWarningMessage(tokens, percentOf(usage.percent))],
		};
	}

	if (tokens < settings.warnTokens || state.warned) return undefined;

	state.warned = true;
	return { messages: [...event.messages, warningMessage(tokens, settings.warnTokens)] };
}

/** The whole-number percentage of the context window in use, for the critical warning. */
function percentOf(percent: number | null | undefined): number {
	return Math.round(percent ?? 0);
}

/**
 * The conversation the staged compaction asks for, or undefined when it must wait or is void.
 *
 * A staged summary describes one particular conversation, and installing it replaces the whole
 * array. That makes the timing the whole problem, and there are three cases:
 *
 * - The conversation it was made from is no longer in front of us. Something else rebuilt the
 *   history (the other tool, another handler), so the summary describes a session that has
 *   moved on: it is dropped rather than installed over the wrong conversation.
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

	if (!hasPrefix(event.messages, staged.base)) {
		press.clearStaged();
		return undefined;
	}

	const fresh = event.messages.slice(staged.base.length);
	if (fresh.length > 0 && !isAssistantTextMessage(event.messages.at(-1))) return undefined;

	press.clearStaged();
	return [...staged.messages, ...fresh];
}

/**
 * Present engine messages back to pi.
 *
 * The engine reads and writes messages structurally (`ConversationMessage`, see src/compact.ts)
 * so the hook, the tools and smoke.mjs share one shape; what it stages is a plain
 * `{role, content, timestamp}` object that satisfies a real message without carrying pi's
 * provider bookkeeping. Only the check needs the cast, and it happens at this one boundary.
 */
function asAgentMessages(messages: readonly ConversationMessage[]): AgentMessage[] {
	return messages as unknown as AgentMessage[];
}
