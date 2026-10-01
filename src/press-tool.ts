import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { compactContext, failureText, NO_MESSAGES_NOTE } from "./compact.ts";
import { readPressSettings } from "./config.ts";
import type { PressState } from "./state.ts";

/** The `press` tool's parameters. */
const parameters = Type.Object({
	note: Type.Optional(
		Type.String({
			description:
				"What matters most to preserve, for example decisions just made or a plan being followed.",
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

/** What the press tool reports alongside the summary, for the UI and the transcript. */
export type PressDetails = {
	/** Which of the three outcomes happened. */
	status: "compacted" | "skipped" | "error";
	/** Messages the summary replaced; 0 unless `status` is "compacted". */
	compacted: number;
	/** Messages preserved verbatim; 0 unless `status` is "compacted". */
	kept: number;
};

/**
 * Register the `press` tool: the model's own way to compact the conversation.
 *
 * The model calls it when its context is filling up. It reads the messages the context hook
 * cached, summarizes everything but the last `keep` messages through one compaction model
 * call, and returns the resulting `<press-summary>` block as its tool result.
 *
 * The tool result is all the model sees on this turn. Replacing the conversation itself is
 * the context hook's job (it is the only place with the message array), so the executor also
 * stages `[summary, ...kept]` in the registration's state for the next `context` pass to
 * install in place of the array. Until that hook exists the staging is inert, which is why
 * the tool result carries the summary text in full.
 *
 * `state` is the registration's own cache, so a second loaded session cannot compact this
 * one's conversation.
 */
export function registerPressTool(pi: ExtensionAPI, state: PressState): void {
	pi.registerTool({
		name: "press",
		label: "Compact context",
		description:
			"Compact the conversation so far into a <press-summary> block, keeping the most recent messages verbatim. Call press when the conversation itself should become a summary: a finished phase of work, a long multi-step task still running, or a session that would otherwise have to start over. It spends one model call, so when freeing tokens is all you need, trim does that for free. Pass note saying what matters most to preserve, and raise keep when you are mid-way through a multi-step task.",
		// A tool without a snippet is left out of the system prompt's tool section, which is the
		// difference between a tool the model remembers and one it has to rediscover each turn.
		promptSnippet: "Compact a long conversation into a summary and keep working in the same session",
		promptGuidelines: [
			"Call press before starting a new phase of work once the finished phase fills the context: summarize what it decided, carry the plan forward through note, and continue in this session.",
		],
		parameters,
		// Compaction rewrites the conversation, so it must not overlap with other tool calls.
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: Static<typeof parameters>,
			_signal,
			_onUpdate,
			ctx: ExtensionToolContext,
		): Promise<AgentToolResult<PressDetails>> {
			const messages = state.cachedMessages();
			if (messages.length === 0) {
				return errorResult(NO_MESSAGES_NOTE);
			}

			let result;
			try {
				result = await compactContext(
					ctx,
					messages,
					params.keep,
					params.note,
					readPressSettings(ctx.cwd),
				);
			} catch (error) {
				return errorResult(failureText(error));
			}

			if (result.kind === "skipped") {
				// Nothing to compact is not a failure: the model asked, the context is fine.
				return {
					content: [{ type: "text", text: result.note }],
					details: { status: "skipped", compacted: 0, kept: 0 },
				};
			}

			// Stage the replacement context for the next context pass; see this function's doc.
			// The base is the array this call compacted, not a re-read of the cache: a context
			// pass during the model call above would have replaced the cache with a conversation
			// this summary never saw, and comparing against that would drop the compaction.
			state.stageCompacted([result.message, ...result.kept], messages);

			// The engine always fills this single block; the fallback only satisfies the checker.
			const text = result.message.content[0]?.text ?? "";
			return {
				content: [{ type: "text", text }],
				details: {
					status: "compacted",
					compacted: result.compacted,
					kept: result.kept.length,
				},
			};
		},
	});
}

/** A failed press, reported to the model without throwing. */
function errorResult(text: string): AgentToolResult<PressDetails> {
	return {
		content: [{ type: "text", text }],
		details: { status: "error", compacted: 0, kept: 0 },
		isError: true,
	};
}
