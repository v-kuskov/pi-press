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

/** The three sections of a `<press-summary>` block. */
export type PressSummary = {
	summary: string;
	files: string;
	notes: string;
};

/** A finished compaction. */
export type Compacted = {
	kind: "compacted";
	/** The replacement message; the kept messages follow it in the rebuilt context. */
	message: SummaryMessage;
	/** The parsed sections, for the caller's `details`. */
	summary: PressSummary;
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
 * the real reason rather than a generic one.
 */
export class PressError extends Error {
	/** A corrective instruction for the model, when there is an obvious one. */
	readonly hint: string | undefined;
	/** The response's `stopReason`, present only when a model call failed. */
	readonly stopReason: string | undefined;
	/** The provider's error text, present only when the provider reported one. */
	readonly providerMessage: string | undefined;

	constructor(
		message: string,
		options: {
			hint?: string;
			stopReason?: string;
			providerMessage?: string;
			cause?: unknown;
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "PressError";
		this.hint = options.hint;
		this.stopReason = options.stopReason;
		this.providerMessage = options.providerMessage;
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
			content: [{ type: "text", text: renderPressSummary(summary) }],
			timestamp: Date.now(),
		},
		summary,
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
			{ stopReason: response.stopReason, providerMessage: response.errorMessage },
		);
	}

	const text = textOf(response.content);
	if (text.length === 0) {
		// An abort or a token-limited answer can leave no text at all; naming the stop reason
		// is what tells the caller whether retrying is worth anything.
		throw new PressError(
			`Compaction failed: the model returned no text (stop reason: ${response.stopReason ?? "unknown"})`,
			{ stopReason: response.stopReason },
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

/** The prompt: what to preserve, the shape to answer in, and the conversation itself. */
function buildPrompt(
	snapshot: string,
	compacted: number,
	kept: number,
	note: string | undefined,
): string {
	const noteBlock = note
		? `\nThe caller asked you to preserve this in particular:\n${note}\n`
		: "";

	return `You compact a coding-agent conversation so the agent can keep working from a smaller context.

The ${compacted} messages below are replaced by your answer; the last ${kept} messages are preserved verbatim after it. Record what the next turn needs: what was asked, the decisions taken, the state of the work, the files touched, and what comes next.
${noteBlock}
Answer with exactly one <press-summary> block and nothing else, in this shape:

<press-summary>
## Summary
<what happened, the decisions, the current state, the next steps>
## Files
<files read or changed, one per line, and why>
## Notes
<anything from the caller's request that must survive; (none) when there was none>
</press-summary>

Conversation to compact (${compacted} messages):

${snapshot}`;
}

/**
 * The three sections the prompt asks for, in the order they are rendered.
 *
 * The prompt's expected shape and the parser's expectations are kept in one place so the
 * two cannot drift apart.
 */
const SUMMARY_SECTIONS = ["summary", "files", "notes"] as const;

/**
 * A line that is one of the three section headings, and nothing else.
 *
 * Markdown depth varies, the trailing colon varies, and some models drop the hashes
 * entirely, so all three are accepted. The whole line must be the heading, which is what
 * keeps a prose line that merely mentions "files" from splitting a section.
 */
const SECTION_HEADING = /^#{0,4}\s*(summary|files|notes)\s*:?\s*$/i;

/**
 * Read the three sections out of the model's answer.
 *
 * A model that answered in prose without headings is still worth keeping: the whole answer
 * becomes the summary, since a usable summary beats a failed call. Headings are matched
 * case-insensitively and at any depth, because models vary in how they punctuate them.
 */
export function parsePressSummary(raw: string): PressSummary {
	const block = pressSummaryBlock(raw);
	const { preamble, sections } = splitSections(block);
	return {
		// A model that opened with prose before its first heading put the summary there.
		summary: sections.summary ?? preamble ?? block,
		files: sections.files ?? "",
		notes: sections.notes ?? "",
	};
}

/** The inside of the `<press-summary>` block, or the whole answer when there is no block. */
function pressSummaryBlock(raw: string): string {
	const closed = /<press-summary>([\s\S]*?)<\/press-summary>/i.exec(raw);
	if (closed?.[1] !== undefined) return closed[1].trim();

	// An answer truncated by a token limit still has a usable body after the opening tag.
	const open = /<press-summary>([\s\S]*)/i.exec(raw);
	return (open?.[1] ?? raw).trim();
}

/**
 * Split a block body on its section headings.
 *
 * `preamble` is the text before the first heading, and sections that came back empty are
 * dropped rather than stored as empty strings - a heading with nothing under it carries no
 * information to preserve.
 */
function splitSections(block: string): {
	preamble: string | undefined;
	sections: Partial<Record<(typeof SUMMARY_SECTIONS)[number], string>>;
} {
	const bodies = new Map<string, string[]>();
	const leading: string[] = [];
	let current: string | undefined;

	for (const line of block.split("\n")) {
		const heading = SECTION_HEADING.exec(line);
		if (heading?.[1] !== undefined) current = heading[1].toLowerCase();
		if (current === undefined) {
			leading.push(line);
			continue;
		}
		const body = bodies.get(current) ?? [];
		if (heading === null) body.push(line);
		bodies.set(current, body);
	}

	const sections: Partial<Record<(typeof SUMMARY_SECTIONS)[number], string>> = {};
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
 * model that follows will not read "(none)" as information.
 */
export function renderPressSummary({ summary, files, notes }: PressSummary): string {
	const parts = [`## Summary\n${summary}`];
	if (files) parts.push(`## Files\n${files}`);
	if (notes) parts.push(`## Notes\n${notes}`);
	return `<press-summary>\n${parts.join("\n\n")}\n</press-summary>`;
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
