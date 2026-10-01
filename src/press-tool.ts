import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { compactContext, NO_MESSAGES_NOTE, PressError } from "./compact.ts";
import { readPressSettings } from "./config.ts";
import { cachedMessagesSnapshot, stageCompactedContext } from "./state.ts";

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
 * stages `[summary, ...kept]` in the shared state module for the next `context` pass to
 * install in place of the array. Until that hook exists the staging is inert, which is why
 * the tool result carries the summary text in full.
 */
export function registerPressTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "press",
		label: "Compact context",
		description:
			"Compact the conversation so far into a summary, keeping the most recent messages verbatim. Call it when the context is getting full and you want to keep working on the same task. Pass a note describing what matters most to preserve.",
		promptSnippet: "Compact the conversation when its context is filling up",
		promptGuidelines: [
			"When the context is getting full, call press instead of asking the user to start over. Pass note with what matters most to preserve, and raise keep when you are mid-way through a multi-step task.",
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
			const messages = cachedMessagesSnapshot();
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
			stageCompactedContext([result.message, ...result.kept]);

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

/**
 * The failure text the model reads.
 *
 * The engine's `hint` is the corrective instruction written for exactly this reader, so it
 * follows the failure rather than being dropped; an unexpected throw has no hint.
 */
function failureText(error: unknown): string {
	if (error instanceof PressError) {
		return error.hint === undefined ? error.message : `${error.message}\n\n${error.hint}`;
	}
	return `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
}
