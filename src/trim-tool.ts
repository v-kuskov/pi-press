import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { extractFilePaths, NO_MESSAGES_NOTE, renderPressTrim, trimMessages } from "./compact.ts";
import type { PressState } from "./state.ts";

/** The `trim` tool's parameters. */
const parameters = Type.Object({
	note: Type.Optional(
		Type.String({
			description: "Note to leave for yourself in the trimmed context, for example what was just decided.",
		}),
	),
	keep: Type.Optional(
		Type.Integer({
			description: "How many recent messages to keep verbatim. Defaults to 1.",
			minimum: 0,
			default: 1,
		}),
	),
});

/** What the trim tool reports alongside the trim, for the UI and the transcript. */
export type TrimDetails = {
	/** Which of the three outcomes happened. */
	status: "trimmed" | "skipped" | "error";
	/** Tool results replaced with `[trimmed]`; 0 unless `status` is "trimmed". */
	trimmed: number;
	/** Messages preserved verbatim; 0 unless `status` is "trimmed". */
	kept: number;
};

/**
 * Register the `trim` tool: the fast, deterministic way to free context.
 *
 * Trimming is the cheap half of compaction. The token cost of a session sits in its tool
 * results, and this replaces the old ones with `[trimmed]` placeholders without asking a model
 * anything, so the model keeps its own reasoning and the work it is mid-way through while the
 * raw file reads and command output go. Nothing calls it on the model's behalf: the model
 * reaches for `trim` when it needs tokens now, and for `press` when the conversation itself
 * needs to become a summary.
 *
 * The pass leaves a `<press-trim>` anchor message in the conversation - counts, the files the
 * trimmed run named, and the caller's note - so a later `findAnchor` sees what was trimmed and
 * the next compaction merges into it instead of re-reading placeholders. The tool result the
 * model sees this turn is counts only; its note reaches the next turn through the anchor.
 *
 * As with `press`, the tool cannot replace the context itself - only a `context` handler can -
 * so the replacement is staged for the next pass, based on the messages this call processed.
 *
 * `state` is the registration's own cache, so a second loaded session cannot trim this one's
 * conversation.
 */
export function registerTrimTool(pi: ExtensionAPI, state: PressState): void {
	pi.registerTool({
		name: "trim",
		label: "Trim context",
		description:
			"Trim the conversation by replacing old tool results with [trimmed] placeholders, keeping your own messages and the most recent ones verbatim. It spends no model call and never loses your own reasoning, so reach for it whenever the context is carrying raw output you have finished with: long file reads, search results, test and build logs. Pass keep to leave more recent messages untouched, and note to leave yourself a line in the trimmed context. Call press instead when the conversation itself should become a summary.",
		// A tool without a snippet is left out of the system prompt's tool section, which is the
		// difference between a tool the model remembers and one it has to rediscover each turn.
		promptSnippet: "Free context by replacing old tool results with [trimmed] placeholders",
		promptGuidelines: [
			"Call trim after any large tool result - a long file read, a search, a test or build log - once you have what you need from it, so the raw output stops costing tokens.",
		],
		parameters,
		// Trimming rewrites the conversation, so it must not overlap with other tool calls.
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: Static<typeof parameters>,
			_signal,
			_onUpdate,
			_ctx: ExtensionToolContext,
		): Promise<AgentToolResult<TrimDetails>> {
			const messages = state.cachedMessages();
			if (messages.length === 0) {
				return errorResult(NO_MESSAGES_NOTE);
			}

			const result = trimMessages(messages, params.keep);
			if (result.kind === "nothing") {
				// Nothing to trim is not a failure: the model asked, the context is fine.
				return {
					content: [{ type: "text", text: result.note }],
					details: { status: "skipped", trimmed: 0, kept: 0 },
				};
			}

			// The anchor carries the note, not the tool result: only what is in the conversation
			// reaches a later compaction, and the model reads its own note back from there.
			const anchor = renderPressTrim(result.trimmed, extractFilePaths(messages), params.note);

			// Stage the replacement context for the next context pass; see this function's doc.
			// The base is the array this call processed, not a re-read of the cache.
			state.stageCompacted([anchor, ...result.messages], messages);

			return {
				content: [
					{
						type: "text",
						text: `Context trimmed.\n- ${result.trimmed} tool results replaced with [trimmed]\n- last ${result.kept} messages kept verbatim`,
					},
				],
				details: { status: "trimmed", trimmed: result.trimmed, kept: result.kept },
			};
		},
	});
}

/** A failed trim, reported to the model without throwing. */
function errorResult(text: string): AgentToolResult<TrimDetails> {
	return {
		content: [{ type: "text", text }],
		details: { status: "error", trimmed: 0, kept: 0 },
		isError: true,
	};
}
