import type { ConversationMessage } from "./compact.ts";

/**
 * A compaction the tool produced and the hook has yet to install.
 *
 * The tool cannot replace the context itself: it returns a tool result, and the message array
 * is only writable from a `context` handler. So it stages `[summary, ...kept]` here, together
 * with the conversation the summary was made from. Recording that base is what lets the hook
 * tell a conversation the summary still describes from one that has moved on since.
 */
export type StagedCompaction = {
	/** The replacement context: the summary message, then the messages kept verbatim. */
	messages: readonly ConversationMessage[];
	/** The conversation the summary was built from. */
	base: readonly ConversationMessage[];
};

/**
 * The conversation between the context hook and the `press` tool.
 *
 * pi offers no accessor for the live message array; the only place it is visible is the
 * `context` event, which fires before every LLM call. So the hook caches `event.messages`
 * here and the tool executor reads it back - the same pattern pi-dcp uses.
 *
 * One instance per registration, created by the factory and handed to both the tool and the
 * hook: a process may host several sessions, and one session's tool must not compact another
 * session's conversation.
 */
export type PressState = {
	/** Record the messages the next `press` call should compact. Called by the context hook. */
	cacheMessages(messages: readonly ConversationMessage[]): void;
	/** The cached conversation, empty until the first `context` pass. Read by the `press` tool. */
	cachedMessages(): readonly ConversationMessage[];
	/**
	 * Stage a compaction's replacement context for the next `context` pass to install.
	 *
	 * `base` is the conversation the summary was made from, and defaults to the current cache.
	 * A caller that has awaited nothing since reading the cache can leave it out; the `press`
	 * tool passes the messages it compacted, because it awaits a model call in between and a
	 * `context` pass in that window would otherwise leave the cache describing a conversation
	 * the summary was never made from.
	 */
	stageCompacted(messages: readonly ConversationMessage[], base?: readonly ConversationMessage[]): void;
	/** The staged compaction waiting for a pass to install it, if any. Read by the hook. */
	staged(): StagedCompaction | undefined;
	/**
	 * Drop the staged compaction.
	 *
	 * Called when a pass installs it, and when a fresh compaction supersedes it: either way the
	 * summary takes effect exactly once and two passes cannot both replace their array with it.
	 */
	clearStaged(): void;
};

/** A fresh, empty state for one extension registration. */
export function createPressState(): PressState {
	let cached: readonly ConversationMessage[] = [];
	let staged: StagedCompaction | undefined;

	return {
		cacheMessages(messages) {
			cached = messages;
		},
		cachedMessages() {
			return cached;
		},
		stageCompacted(messages, base) {
			staged = { messages, base: base ?? cached };
		},
		staged() {
			return staged;
		},
		clearStaged() {
			staged = undefined;
		},
	};
}
