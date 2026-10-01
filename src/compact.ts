import type { PressSettings } from "./config.ts";

/** Characters of a tool result that survive into the snapshot. */
export const TOOL_RESULT_CHARS = 200;

/** Messages kept verbatim when the caller does not ask for a different number. */
export const DEFAULT_KEEP = 1;

/** Note for a conversation that holds nothing to compact at all. */
export const NO_MESSAGES_NOTE = "No messages available for compaction.";

/**
 * A conversation message, seen structurally.
 *
 * The engine reads messages through this shape instead of pi's `AgentMessage`, so the tool
 * executor, the context hooks and smoke.mjs all drive it without importing pi's message
 * types. A real `AgentMessage` satisfies the shape as it stands.
 */
export type ConversationMessage = {
	role: string;
	content?: unknown;
	toolName?: string;
	timestamp?: number;
};

/** The single message a compaction leaves in place of the messages it replaced. */
export type SummaryMessage = {
	role: "assistant";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
};

/** What a snapshot pass produced: something to compact, or a reason there is nothing. */
export type Snapshot =
	| {
			kind: "snapshot";
			/** The compacted run, rendered for the compaction prompt. */
			text: string;
			/** How many messages `text` covers. */
			compacted: number;
			/** Messages preserved verbatim, in their original order. */
			kept: ConversationMessage[];
	  }
	| { kind: "nothing"; note: string };

/** The five sections of a `<press-summary>` block. */
export type PressSummary = {
	taskOverview: string;
	currentState: string;
	discoveries: string;
	nextSteps: string;
	context: string;
};

/** A finished compaction. */
export type Compacted = {
	kind: "compacted";
	/** The replacement message; the kept messages follow it in the rebuilt context. */
	message: SummaryMessage;
	/** Messages preserved verbatim. */
	kept: ConversationMessage[];
	/** How many messages `message` replaced. */
	compacted: number;
};

/** Either a compaction happened, or there was nothing to compact. */
export type CompactionResult = Compacted | { kind: "skipped"; note: string };

/** The parts of a model response the engine reads. */
export type CompactionResponse = {
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
};

/**
 * The slice of pi's extension context the engine needs.
 *
 * Narrow on purpose: `ExtensionContext` and `ExtensionToolContext` both satisfy it, so the
 * same engine serves the `press` tool and the two context hooks, and a fake in smoke.mjs
 * needs nothing more than these three methods.
 */
export type CompactionContext = {
	/** The session's current model; the fallback when no compaction model is configured. */
	model?: unknown;
	/** The session's abort signal, forwarded so a compaction can be cancelled with the turn. */
	signal?: AbortSignal;
	modelRegistry: {
		find(provider: string, modelId: string): unknown;
		hasConfiguredAuth(model: unknown): boolean;
		complete(
			model: unknown,
			context: { messages: unknown[] },
			options?: { cacheRetention?: "none"; signal?: AbortSignal },
		): Promise<CompactionResponse>;
	};
};

/**
 * A compaction failure the caller reports to the model as `isError: true`.
 *
 * Carries the provider's own words when the failure was a model call, so the model is told
 * the real reason rather than a generic one. The wording itself is built at the throw site and
 * travels in `message`; the class holds only the corrective `hint` that {@link failureText}
 * appends for the reader.
 */
export class PressError extends Error {
	/** A corrective instruction for the model, when there is an obvious one. */
	readonly hint: string | undefined;

	constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "PressError";
		this.hint = options.hint;
	}
}

/**
 * Split the conversation into the run to compact and the tail to keep verbatim.
 *
 * `keep` counts raw messages from the end, not turns, and is clamped to the conversation:
 * a `keep` at or beyond the total leaves nothing to compact, which is reported as a note
 * rather than as an empty snapshot, because asking a model to summarize nothing is a
 * wasted call.
 */
export function buildSnapshot(
	messages: readonly ConversationMessage[],
	keep: number | undefined,
): Snapshot {
	const total = messages.length;
	if (total === 0) return { kind: "nothing", note: NO_MESSAGES_NOTE };

	const keptCount = clampKeep(keep, total);
	const compacted = messages.slice(0, total - keptCount);
	if (compacted.length === 0) {
		return {
			kind: "nothing",
			note: `Context is already small: keeping the last ${keptCount} of ${total} messages leaves nothing to compact.`,
		};
	}

	return {
		kind: "snapshot",
		text: compacted.map(renderMessage).join("\n\n"),
		compacted: compacted.length,
		kept: messages.slice(total - keptCount),
	};
}

/**
 * Compact the conversation through one model call.
 *
 * Returns the replacement message, the parsed sections and the kept tail; `skipped` when
 * the snapshot found nothing to compact. Every other failure - unusable model, provider
 * error, unusable answer - raises a {@link PressError} for the caller to report.
 */
export async function compactContext(
	ctx: CompactionContext,
	messages: readonly ConversationMessage[],
	keep: number | undefined,
	note: string | undefined,
	settings: PressSettings,
): Promise<CompactionResult> {
	const snapshot = buildSnapshot(messages, keep);
	if (snapshot.kind === "nothing") return { kind: "skipped", note: snapshot.note };

	const model = resolveCompactionModel(ctx, settings);
	const prompt = buildPrompt(snapshot.text, snapshot.compacted, snapshot.kept.length, note);
	const summary = parsePressSummary(await requestSummary(ctx, model, prompt));

	return {
		kind: "compacted",
		message: {
			role: "assistant",
			content: [{ type: "text", text: appendNote(renderPressSummary(summary), note) }],
			timestamp: Date.now(),
		},
		kept: snapshot.kept,
		compacted: snapshot.compacted,
	};
}

/**
 * Ask for the summary, with every failure mode turned into a {@link PressError}.
 *
 * Cache retention is off because the prompt is sent once and is never repeated, so a
 * cached prefix would be paid for and never read.
 */
async function requestSummary(
	ctx: CompactionContext,
	model: unknown,
	prompt: string,
): Promise<string> {
	let response: CompactionResponse;
	try {
		response = await ctx.modelRegistry.complete(
			model,
			{ messages: [userMessage(prompt)] },
			{ cacheRetention: "none", signal: ctx.signal },
		);
	} catch (error) {
		throw new PressError(`Compaction failed: ${reasonOf(error)}`, { cause: error });
	}

	if (response.stopReason === "error") {
		throw new PressError(
			`Compaction failed: ${response.errorMessage ?? "the model returned an error"}`,
		);
	}

	const text = textOf(response.content);
	if (text.length === 0) {
		// An abort or a token-limited answer can leave no text at all; naming the stop reason
		// is what tells the caller whether retrying is worth anything.
		throw new PressError(
			`Compaction failed: the model returned no text (stop reason: ${response.stopReason ?? "unknown"})`,
		);
	}
	return text;
}

/**
 * The model to compact with: `press.model` when configured, otherwise the session model.
 *
 * A configured model that is unknown or unauthenticated raises instead of falling back:
 * it names the model the user chose, and quietly spending a different one hides that their
 * choice is not being honoured.
 */
function resolveCompactionModel(ctx: CompactionContext, settings: PressSettings): unknown {
	const configured = settings.model;

	if (configured !== undefined) {
		const parsed = parseProviderModel(configured);
		if (!parsed) {
			throw new PressError(`Compaction model "${configured}" is not in provider/model form`, {
				hint: 'Set press.model to "provider/id" in settings, or remove it to compact with the session model.',
			});
		}
		const found = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!found) {
			throw new PressError(`Compaction model "${configured}" names no known model`, {
				hint: "Fix press.model in settings, or remove it to compact with the session model.",
			});
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
			throw new PressError(`No credentials configured for compacting with ${configured}`, {
				hint: "Fix press.model in settings, or remove it to compact with the session model.",
			});
		}
		return found;
	}

	const current = ctx.model;
	if (current === undefined || current === null) {
		throw new PressError("No session model to compact with", {
			hint: 'Set {"press":{"model":"provider/id"}} in settings to name one.',
		});
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(current)) {
		throw new PressError(`No credentials configured for ${describeModel(current)}`, {
			hint: "Set press.model in settings to name an authenticated provider.",
		});
	}
	return current;
}

/**
 * Split `provider/id` at the first slash only.
 *
 * A model id may itself contain slashes - `routerai/deepseek/deepseek-v4.1-flash` is one
 * model id on one provider - so only the first slash separates the two halves.
 */
function parseProviderModel(value: string): { provider: string; modelId: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/** `provider/id` for an error message, when the model is shaped like one. */
function describeModel(model: unknown): string {
	if (model && typeof model === "object") {
		const { provider, id } = model as { provider?: unknown; id?: unknown };
		if (typeof provider === "string" && typeof id === "string") return `${provider}/${id}`;
	}
	return "the session model";
}

/** The prompt: continuation framing, structured sections, and the conversation itself. */
function buildPrompt(
	snapshot: string,
	compacted: number,
	kept: number,
	note: string | undefined,
): string {
	const noteBlock = note
		? `\nThe caller asked you to preserve this in particular:\n${note}\n`
		: "";

	return `Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently.

The ${compacted} messages below are replaced by your answer; the last ${kept} messages are preserved verbatim after it.
${noteBlock}
Err on the side of including information that would prevent duplicate work or repeated mistakes.

Answer with exactly one <press-summary> block and nothing else:

<press-summary>
## Task Overview
<what the user asked for and the overall goal>
## Current State
<where the work stands — progress made, what's working, what's broken>
## Important Discoveries
<decisions and their rationale, errors and their resolution, approaches tried and abandoned>
## Next Steps
<what to do next, open questions, blockers>
## Context to Preserve
<file paths, user constraints, conventions, anything else the next turn needs>
</press-summary>

Conversation to compact (${compacted} messages):

${snapshot}`;
}

/**
/**
 * The five sections the prompt asks for, in the order they are rendered.
 *
 * The prompt's expected shape and the parser's expectations are kept in one place so the
 * two cannot drift apart.
 */
const SUMMARY_SECTIONS: (keyof PressSummary)[] = [
	"taskOverview",
	"currentState",
	"discoveries",
	"nextSteps",
	"context",
];

/**
 * Maps the lowercased heading text the model might produce to the canonical section key.
 *
 * Accepts short forms (task, state, next, context) and full forms (task overview,
 * current state, next steps, context to preserve).  Old three-section headings
 * (summary, files, notes) are intentionally absent so pre-update summaries degrade
 * into the preamble fallback rather than filling the wrong field.
 */
const SECTION_KEY: Record<string, keyof PressSummary> = {
	"task overview": "taskOverview",
	task: "taskOverview",
	"current state": "currentState",
	state: "currentState",
	"important discoveries": "discoveries",
	discoveries: "discoveries",
	"next steps": "nextSteps",
	"next step": "nextSteps",
	next: "nextSteps",
	"context to preserve": "context",
	context: "context",
};

/** If line is a recognized section heading, return its canonical key. */
function headingKey(line: string): keyof PressSummary | undefined {
	const m = /^#{0,4}\s*(.+?)\s*:?\s*$/i.exec(line);
	if (!m || m[1] === undefined) return undefined;
	return SECTION_KEY[m[1].toLowerCase().replace(/\s+/g, " ")];
}


/**
 * Read the five sections out of the model's answer.
 *
 * A model that answered in prose without headings is still worth keeping: the whole answer
 * becomes the task overview, since a usable summary beats a failed call.  Headings are matched
 * case-insensitively and at any depth, because models vary in how they punctuate them.
 */
export function parsePressSummary(raw: string): PressSummary {
	const block = pressSummaryBody(raw);
	const { preamble, sections } = splitSections(block);
	return {
		// A model that opened with prose before its first heading put the task overview there.
		taskOverview: sections.taskOverview ?? preamble ?? block,
		currentState: sections.currentState ?? "",
		discoveries: sections.discoveries ?? "",
		nextSteps: sections.nextSteps ?? "",
		context: sections.context ?? "",
	};
}

/** The inside of the `<press-summary>` block, or the whole answer when there is no block. */
function pressSummaryBody(raw: string): string {
	const closed = /<press-summary>([\s\S]*?)<\/press-summary>/i.exec(raw);
	if (closed?.[1] !== undefined) return closed[1].trim();

	// An answer truncated by a token limit still has a usable body after the opening tag.
	const open = /<press-summary>([\s\S]*)/i.exec(raw);
	return (open?.[1] ?? raw).trim();
}

/**
 * Split a block body on its section headings.
 *
 * preamble is the text before the first recognized heading, and sections that came back
 * empty are dropped rather than stored as empty strings - a heading with nothing under it
 * carries no information to preserve.
 */
function splitSections(block: string): {
	preamble: string | undefined;
	sections: Partial<Record<keyof PressSummary, string>>;
} {
	const bodies = new Map<keyof PressSummary, string[]>();
	const leading: string[] = [];
	let current: keyof PressSummary | undefined;

	for (const line of block.split("\n")) {
		const key = headingKey(line);
		if (key !== undefined) current = key;
		if (current === undefined) {
			leading.push(line);
			continue;
		}
		if (key === undefined) {
			// Content line under a recognized section.
			const body = bodies.get(current) ?? [];
			body.push(line);
			bodies.set(current, body);
		}
	}

	const sections: Partial<Record<keyof PressSummary, string>> = {};
	for (const section of SUMMARY_SECTIONS) {
		const body = bodies.get(section)?.join("\n").trim();
		if (body) sections[section] = body;
	}

	return { preamble: leading.join("\n").trim() || undefined, sections };
}


/**
 * The canonical form of a summary, as it lands in the context.
 *
 * Sections that came back empty are dropped rather than filled with a placeholder: the
 * model that follows will not read "(none)" as information.  Task Overview is always
 * rendered because it is the primary section.
 */
export function renderPressSummary(ps: PressSummary): string {
	const parts = [`## Task Overview\n${ps.taskOverview}`];
	if (ps.currentState) parts.push(`## Current State\n${ps.currentState}`);
	if (ps.discoveries) parts.push(`## Important Discoveries\n${ps.discoveries}`);
	if (ps.nextSteps) parts.push(`## Next Steps\n${ps.nextSteps}`);
	if (ps.context) parts.push(`## Context to Preserve\n${ps.context}`);
	return `<press-summary>\n${parts.join("\n\n")}\n</press-summary>`;
}

/**
 * The summary block with the caller's note appended after it.
 *
 * The note is appended here, not left for the compaction model to paraphrase into its output.
 * The one line explaining why the conversation is suddenly short is exactly the line a summary
 * must not lose, and a model that paraphrases or drops it would lose it silently - so the note
 * is added to the message outside the model's control, and `renderPressSummary` stays the pure
 * renderer of what the model produced.
 *
 * The note still reaches the prompt as well: there it tells the model what to preserve, and
 * here it tells the next turn what happened.
 */
function appendNote(block: string, note: string | undefined): string {
	const trimmed = note?.trim();
	return trimmed ? `${block}\n\n${trimmed}` : block;
}

/**
 * How a failure is worded for the model that has to act on it.
 *
 * One place, because two callers report the same failures: the `press` tool returns the text as
 * its result, and the context hook embeds it in the note it appends to the conversation. Both
 * readers need the engine's `hint` - the corrective instruction written for exactly this reader -
 * and an unexpected throw has none.
 */
export function failureText(error: unknown): string {
	if (error instanceof PressError) {
		return error.hint === undefined ? error.message : `${error.message}\n\n${error.hint}`;
	}
	return `Compaction failed: ${reasonOf(error)}`;
}

/** Clamp a caller-supplied `keep` into `[0, total]`, floor first. */
function clampKeep(keep: number | undefined, total: number): number {
	const wanted =
		typeof keep === "number" && Number.isFinite(keep) ? Math.floor(keep) : DEFAULT_KEEP;
	return Math.min(Math.max(wanted, 0), total);
}

/** One snapshot entry: a numbered header naming the role, then the body. */
function renderMessage(message: ConversationMessage, index: number): string {
	const label = message.toolName ? `${message.role} ${message.toolName}` : message.role;
	return `### ${index}. ${label}\n${bodyOf(message)}`;
}

/** A message's body: tool results truncated, anything else verbatim. */
function bodyOf(message: ConversationMessage): string {
	const text = textOf(message.content);
	if (message.role === "toolResult") return truncateToolResult(message.toolName, text);
	if (text.length > 0) return text;

	// An assistant turn that only called tools carries no text; naming the calls keeps the
	// snapshot honest about work that happened without spending the tokens of the results.
	const calls = toolCallNames(message.content);
	return calls.length > 0 ? `(called ${calls.join(", ")})` : "(no text)";
}

/**
 * One line naming a tool and the head of what it returned.
 *
 * Tool results are where the bulk of a session's tokens live - a file read, a code-mode
 * dump - so only the first {@link TOOL_RESULT_CHARS} characters survive. The text is taken
 * verbatim, newlines included: the snapshot is evidence about what a tool returned, and
 * rewriting it would misreport the result. The ellipsis appears only when something was
 * cut, so a short result never claims to be truncated.
 */
function truncateToolResult(toolName: string | undefined, text: string): string {
	const name = toolName ?? "unknown";
	if (text.length === 0) return `[Tool: ${name}] → (no text output)`;

	const head = text.slice(0, TOOL_RESULT_CHARS);
	return `[Tool: ${name}] → ${head}${text.length > TOOL_RESULT_CHARS ? "..." : ""}`;
}

/** Concatenated text of a message's content, whether it is a string or content blocks. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.filter(
			(part): part is { type: string; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Names of the tool calls in a message's content blocks, in order. */
function toolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	return content.flatMap((part) => {
		if (typeof part !== "object" || part === null) return [];
		const { type, name } = part as { type?: unknown; name?: unknown };
		return type === "toolCall" && typeof name === "string" ? [name] : [];
	});
}

/** A plain user message, the shape `complete()` expects for the prompt. */
function userMessage(text: string): Record<string, unknown> {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** A thrown value as a sentence tail, for callers that surface it to the model. */
function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
