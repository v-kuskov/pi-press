import type { ConversationMessage } from "./compact.ts";

/**
 * The conversation between the context hook and the `press` tool.
 *
 * pi offers no accessor for the live message array; the only place it is visible is the
 * `context` event, which fires before every LLM call. So the handler (ticket 04) caches
 * `event.messages` here and the tool executor (ticket 03) reads it back. The same pattern
 * pi-dcp uses.
 *
 * Module state, not session state, because an extension is loaded once per process and both
 * the hook and the tool live in that one module graph. The cache is therefore only as fresh
 * as the last `context` pass - a known limit of the hook API.
 */
let cachedMessages: readonly ConversationMessage[] = [];

/**
 * A compaction's replacement context, produced by the tool and consumed by the hook.
 *
 * The tool cannot replace the context itself: it returns a tool result, and the message
 * array is only writable from a `context` handler. So the tool stages `[summary, ...kept]`
 * here and the next `context` pass (ticket 04) swaps the whole array for it.
 */
let stagedCompacted: readonly ConversationMessage[] | undefined;

/** Record the messages the next `press` call should compact. Called by the context hook. */
export function cacheMessages(messages: readonly ConversationMessage[]): void {
	cachedMessages = messages;
}

/** The cached conversation, empty until the first `context` pass. Read by the `press` tool. */
export function cachedMessagesSnapshot(): readonly ConversationMessage[] {
	return cachedMessages;
}

/** The compaction context waiting to be installed, if any. Read by the context hook. */
export function stagedCompactedContext(): readonly ConversationMessage[] | undefined {
	return stagedCompacted;
}

/**
 * Take the staged compaction context, if one is waiting.
 *
 * Taking clears it, so a compaction is installed exactly once and two `context` passes cannot
 * both replace their array with the same summary.
 */
export function takeStagedCompactedContext(): readonly ConversationMessage[] | undefined {
	const staged = stagedCompacted;
	stagedCompacted = undefined;
	return staged;
}

/** Stage a compaction's replacement context for the next `context` pass to install. */
export function stageCompactedContext(messages: readonly ConversationMessage[]): void {
	stagedCompacted = messages;
}
