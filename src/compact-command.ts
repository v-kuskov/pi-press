import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { compactContext, type ConversationMessage } from "./compact.ts";
import { readPressSettings } from "./config.ts";

/**
 * How a `/compact` preparation looks to this module: the messages pi means to discard, and the
 * summary the conversation already carries.
 *
 * Declared structurally rather than imported, like the engine's own message shape, so smoke.mjs
 * can drive the pure helper without constructing pi's session types.
 */
export type CompactionPlan = {
	/** History before the turn the cut point landed in. Discarded by the compaction. */
	messagesToSummarize: readonly ConversationMessage[];
	/** The prefix of a split turn, when the cut landed mid-turn. Also discarded. */
	turnPrefixMessages: readonly ConversationMessage[];
	/** Whether this compaction is splitting a turn. */
	isSplitTurn: boolean;
	/** The summary already in the conversation, for iterative update. */
	previousSummary?: string;
};

/**
 * The messages a manual `/compact` has to summarize, in conversation order.
 *
 * Everything pi hands over is discarded, so everything it hands over has to be summarized: the
 * history, and the split turn's prefix when there is one. Missing the prefix would drop a turn
 * that the user is mid-way through.
 *
 * A previous summary arrives as its own field rather than inside the message lists, because pi
 * excludes the entry it replaced. It is re-attached here as the `compactionSummary` message our
 * engine reads, so `findAnchor` recognizes it and the new summary is merged into it instead of
 * starting from nothing. Order matters: the old summary leads the messages it already covers.
 */
export function compactionMessages(plan: CompactionPlan): ConversationMessage[] {
	const messages: ConversationMessage[] = [...plan.messagesToSummarize];
	if (plan.isSplitTurn) messages.push(...plan.turnPrefixMessages);

	const previous = plan.previousSummary?.trim();
	if (previous === undefined || previous.length === 0) return messages;

	return [{ role: "compactionSummary", summary: previous }, ...messages];
}

/**
 * Register the `session_before_compact` hook: our compaction as the manual `/compact` command.
 *
 * pi hardcodes `/compact` in its own submit handler, so an extension cannot register that name:
 * the command is unreachable. This hook is the supported seam: pi prepares the compaction, asks
 * the extension what the summary should be, and persists whatever comes back as a session entry.
 * That persistence is the point: the `context` hook's compaction is a per-request projection and
 * leaves no durable trace, while this writes a real compaction entry.
 *
 * Only `reason === "manual"` is taken. pi's automatic threshold and overflow compactions are left
 * alone: they are the safety net that keeps a session from overflowing its window, and they carry
 * pi's retry policy and split-turn handling. Replacing the summary there would trade a working
 * safety net for a different prompt.
 *
 * Retention is deliberately pi's. `preparation` splits the branch into the messages it will
 * discard and the cut point it will keep from, and this returns exactly those boundaries - so the
 * recent tail stays verbatim, chosen by pi's token budget rather than by a count this module
 * cannot see. The engine is therefore asked to summarize the discarded run with `keep: 0`:
 * summarize everything given, keep none of it, because the keeping is already decided.
 *
 * Failure falls back rather than fails. `runner.emit` catches a throw from this handler, reports
 * it, and leaves the result undefined, so pi runs its own compaction for the same command - the
 * user still gets a compacted session, and still sees why ours did not run.
 */
export function registerCompactCommand(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		if (event.reason !== "manual") return undefined;
		return await manualCompaction(event, ctx);
	});
}

/**
 * The compaction result for a manual `/compact`, or undefined to let pi produce its own.
 *
 * `customInstructions` is what the user typed after `/compact`. pi feeds it to its own
 * summarizer as extra focus; here it becomes the engine's `note`, which lands after the summary
 * and rides into the stored entry once the block's tags are stripped. The user's words reach the
 * next turn unparaphrased either way, which is the intent behind typing them.
 */
async function manualCompaction(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<SessionBeforeCompactResult | undefined> {
	const messages = compactionMessages({
		messagesToSummarize: event.preparation
			.messagesToSummarize as readonly ConversationMessage[],
		turnPrefixMessages: event.preparation
			.turnPrefixMessages as readonly ConversationMessage[],
		isSplitTurn: event.preparation.isSplitTurn,
		...(event.preparation.previousSummary === undefined
			? {}
			: { previousSummary: event.preparation.previousSummary }),
	});
	if (messages.length === 0) return undefined;

	const result = await compactContext(
		ctx,
		messages,
		0,
		event.customInstructions,
		readPressSettings(ctx.cwd),
	);

	// Nothing to summarize is not a failure, but it is also not a compaction: hand the command
	// back to pi rather than persisting a summary of nothing.
	if (result.kind === "skipped") return undefined;

	// pi wraps whatever it stores in its own <summary> tags and posts it as a user message, so our
	// block goes in bare. Storing our <press-summary> too would nest two tag conventions in one
	// message and leave two parse paths that can drift. The tags are removed rather than the block
	// extracted, because the caller's note is appended after the closing tag and must survive.
	const summary = unwrapPressSummary(result.message.content[0]?.text ?? "").trim();
	if (summary.length === 0) return undefined;

	return {
		compaction: {
			summary,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	};
}

/**
 * The text with our block's tags removed, everything around them kept.
 *
 * Everything the engine renders is stored, not just the block's inside: the caller's note arrives
 * appended after the closing tag, and extracting the interior alone would drop it silently.
 */
export function unwrapPressSummary(text: string): string {
	return text.replace(/<\/?press-summary>\s*/gi, "");
}
