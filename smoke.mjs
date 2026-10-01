import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import extensionFactory from "./index.ts";
import {
	buildSnapshot,
	compactContext,
	DEFAULT_KEEP,
	extractFilePaths,
	failureText,
	findAnchor,
	NO_MESSAGES_NOTE,
	parsePressSummary,
	PressError,
	renderPressSummary,
	TOOL_RESULT_CHARS,
	trimMessages,
} from "./src/compact.ts";
import {
	DEFAULT_CRITICAL_TOKENS,
	DEFAULT_WARN_TOKENS,
	readPressSettings,
	SETTINGS_KEY,
} from "./src/config.ts";
import { handleContext, registerContextHook } from "./src/context-hook.ts";
import { registerPressTool } from "./src/press-tool.ts";
import { registerTrimTool } from "./src/trim-tool.ts";
import { createPressState } from "./src/state.ts";

/**
 * Isolation from the developer's own pi install.
 *
 * The extension reads the `press` key out of pi's settings, and a directory with no
 * project settings falls all the way through to the global file at
 * `<agentDir>/settings.json`. Point `<agentDir>` at an empty directory before anything
 * reads it, so every case starts unconfigured and only the cases that write settings
 * deliberately are affected.
 */
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-isolated-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;

let failures = 0;
let passed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed++;
	} catch (error) {
		failures++;
		console.log(`FAIL ${name}\n     ${error.message}`);
	}
}

function tempProject() {
	const root = mkdtempSync(join(tmpdir(), "pi-press-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	return root;
}

/** Write one settings scope: "global" is the agent dir, "project" is `<root>/.pi`. */
function writeScope(root, scope, value) {
	const path =
		scope === "global" ? join(isolatedAgentDir, "settings.json") : join(root, ".pi", "settings.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function resetSettings() {
	rmSync(join(isolatedAgentDir, "settings.json"), { force: true });
}

const DEFAULTS = { warnTokens: DEFAULT_WARN_TOKENS, criticalTokens: DEFAULT_CRITICAL_TOKENS };

// Pressure over the warning threshold but under the hard limit. Warning cases run here,
// because crossing the critical threshold is the one thing that makes the warning not the response.
const WARNING_PRESSURE = DEFAULT_WARN_TOKENS + 1000;

// ------------------------------------------------------------------ factory

await check("the factory registers the press tool and the context hook synchronously", async () => {
	const tools = [];
	const handlers = [];
	const factory = extensionFactory;

	// A factory that returned a promise, spawned a timer, or opened a handle would keep the
	// event loop busy after load; the load path in pi must stay synchronous.
	const result = factory({
		registerTool: (definition) => tools.push(definition),
		on: (event) => handlers.push(event),
	});

	assert.equal(result, undefined, "the factory is synchronous");
	assert.deepEqual(handlers, ["context"], "the context hook is the only hook registered");
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["press", "trim"],
		"the press and trim tools are the only tools registered",
	);
	assert.ok(
		tools.every((tool) => typeof tool.execute === "function"),
		"both tools are executable",
	);
});

await check("each registration gets its own state, so sessions never share a conversation", async () => {
	resetSettings();
	const root = tempProject();
	try {
		// Two loads of the extension in one process: two tools, two hooks, two conversations.
		const first = captureRegistration();
		const second = captureRegistration();
		assert.notEqual(first.tool, second.tool, "each registration builds its own tool definition");

		const { ctx, calls } = fakeCtx({
			respond: () => ({ stopReason: "stop", content: summaryAnswer() }),
		});
		const firstMessages = [user("question from session one"), assistant("answer from session one")];
		const secondMessages = [user("question from session two"), assistant("answer from session two")];

		await contextPass(first, firstMessages, 0, root, ctx);
		await contextPass(second, secondMessages, 0, root, ctx);

		const result = await first.tool.execute("call-1", {}, undefined, undefined, toolCtx({ ctx }, root));
		assert.match(result.content[0].text, /^<press-summary>/);

		const prompt = calls[0].context.messages[0].content[0].text;
		assert.ok(prompt.includes("session one"), "the first session compacts its own conversation");
		assert.ok(
			!prompt.includes("session two"),
			"the second session's conversation is not in the first session's snapshot",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ config

await check("unconfigured settings fall back to the documented defaults", async () => {
	resetSettings();
	const root = tempProject();
	try {
		assert.deepEqual(readPressSettings(root), DEFAULTS);
		assert.equal(DEFAULT_WARN_TOKENS, 260000);
		assert.equal(DEFAULT_CRITICAL_TOKENS, 500000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the press key is read from the object form, project scope winning", async () => {
	resetSettings();
	const root = tempProject();
	try {
		writeScope(root, "global", {
			[SETTINGS_KEY]: { model: "global/model", warnTokens: 100, criticalTokens: 200 },
		});
		assert.deepEqual(readPressSettings(root), {
			model: "global/model",
			warnTokens: 100,
			criticalTokens: 200,
		});

		writeScope(root, "project", {
			[SETTINGS_KEY]: { model: "project/model", warnTokens: 11, criticalTokens: 22 },
		});
		assert.deepEqual(
			readPressSettings(root),
			{ model: "project/model", warnTokens: 11, criticalTokens: 22 },
			"project wins for every field",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("project scope overrides one field without discarding the others", async () => {
	resetSettings();
	const root = tempProject();
	try {
		writeScope(root, "global", {
			[SETTINGS_KEY]: { model: "global/model", warnTokens: 100, criticalTokens: 200 },
		});
		// A project that only lowers the critical threshold must not lose the global model.
		writeScope(root, "project", { [SETTINGS_KEY]: { criticalTokens: 300 } });
		assert.deepEqual(readPressSettings(root), {
			model: "global/model",
			warnTokens: 100,
			criticalTokens: 300,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("unusable field values are ignored in favour of the default", async () => {
	resetSettings();
	const root = tempProject();
	try {
		writeScope(root, "global", {
			[SETTINGS_KEY]: {
				model: "  spaced/model  ",
				warnTokens: 0,
				criticalTokens: -5,
			},
		});
		assert.deepEqual(readPressSettings(root), { model: "spaced/model", ...DEFAULTS });

		for (const junk of [null, 42, "provider/model", [], {}, { model: 7 }, { model: "" }, { model: "   " }]) {
			writeScope(root, "global", { [SETTINGS_KEY]: junk });
			const settings = readPressSettings(root);
			assert.deepEqual(
				{ warnTokens: settings.warnTokens, criticalTokens: settings.criticalTokens },
				DEFAULTS,
				`junk ${JSON.stringify(junk)} ignored`,
			);
			assert.equal(settings.model, undefined, `junk ${JSON.stringify(junk)} has no model`);
		}

		for (const bad of ["100", Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
			writeScope(root, "global", { [SETTINGS_KEY]: { warnTokens: bad, criticalTokens: bad } });
			assert.deepEqual(
				{ warnTokens: readPressSettings(root).warnTokens, criticalTokens: readPressSettings(root).criticalTokens },
				DEFAULTS,
				`threshold ${String(bad)} ignored`,
			);
		}

		// Fractional thresholds are floored rather than rejected: a number is a number.
		writeScope(root, "global", { [SETTINGS_KEY]: { warnTokens: 10.9 } });
		assert.equal(readPressSettings(root).warnTokens, 10);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a corrupt settings file degrades to defaults instead of throwing", async () => {
	resetSettings();
	const root = tempProject();
	try {
		writeScope(root, "global", "{ not json");
		assert.deepEqual(readPressSettings(root), DEFAULTS);

		// A broken project file must not hide a valid global one.
		writeScope(root, "global", { [SETTINGS_KEY]: { model: "global/model" } });
		writeScope(root, "project", "{ not json");
		assert.deepEqual(readPressSettings(root), { model: "global/model", ...DEFAULTS });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ------------------------------------------------------ compaction engine

function assistant(text, extra = {}) {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1, ...extra };
}

function user(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function toolResult(toolName, text) {
	return { role: "toolResult", toolName, content: [{ type: "text", text }], timestamp: 1 };
}

/**
 * A fake ctx for the compaction engine.
 *
 * `respond` is the only behaviour a case supplies; the registry records what it was asked
 * so a case can assert on the model that was chosen and the prompt that was sent.
 */
function fakeCtx({ respond, model = { provider: "routerai", id: "session-model" }, known, authed } = {}) {
	const calls = [];
	const catalogue = new Map(Object.entries(known ?? {}));
	const credentials = authed ?? (() => true);
	return {
		calls,
		ctx: {
			model,
			modelRegistry: {
				find: (provider, modelId) => catalogue.get(`${provider}/${modelId}`),
				hasConfiguredAuth: (candidate) => credentials(candidate),
				complete: async (chosen, context, options) => {
					calls.push({ model: chosen, context, options });
					return respond(chosen, context);
				},
			},
		},
	};
}

/** The `<press-summary>` wrapper a well-behaved compaction model returns. */
function summaryAnswer({ task = "did the work", state = "", discoveries = "", next = "", context = "" } = {}) {
	const sections = [`## Task Overview\n${task}`];
	if (state) sections.push(`## Current State\n${state}`);
	if (discoveries) sections.push(`## Important Discoveries\n${discoveries}`);
	if (next) sections.push(`## Next Steps\n${next}`);
	if (context) sections.push(`## Context to Preserve\n${context}`);
	return [{ type: "text", text: `<press-summary>\n${sections.join("\n\n")}\n</press-summary>` }];
}

const OK = { stopReason: "stop", usage: {}, content: summaryAnswer() };
const SETTINGS = { warnTokens: DEFAULT_WARN_TOKENS, criticalTokens: DEFAULT_CRITICAL_TOKENS };

await check("buildSnapshot truncates tool results and keeps assistant text whole", async () => {
	const long = "x".repeat(500);
	const messages = [
		user("read the file"),
		assistant("I will read it"),
		toolResult("read", long),
		assistant("the file says nothing"),
	];

	const snapshot = buildSnapshot(messages, 1);
	assert.equal(snapshot.kind, "snapshot");
	assert.equal(snapshot.compacted, 3, "all but the last message is compacted");
	assert.deepEqual(snapshot.kept, [messages[3]], "the tail is preserved verbatim");

	const tool = `[Tool: read] → ${"x".repeat(TOOL_RESULT_CHARS)}...`;
	assert.ok(snapshot.text.includes(tool), `tool result truncated to 200 chars, got: ${snapshot.text}`);
	assert.ok(!snapshot.text.includes(long), "the full tool result is not in the snapshot");
	assert.ok(snapshot.text.includes("I will read it"), "assistant text is kept as-is");
	assert.ok(snapshot.text.includes("read the file"), "user text is kept as-is");
	assert.equal(TOOL_RESULT_CHARS, 200, "the documented truncation length");
});

await check("buildSnapshot does not cut a tool result that already fits", async () => {
	const snapshot = buildSnapshot([toolResult("grep", "no matches")], 0);
	assert.equal(snapshot.text, "### 0. toolResult grep\n[Tool: grep] → no matches");

	// A fitting result keeps its newlines: the snapshot reports what the tool returned.
	const multi = buildSnapshot([toolResult("read", "line one\nline two")], 0);
	assert.ok(multi.text.includes("[Tool: read] → line one\nline two"), multi.text);

	const empty = buildSnapshot([toolResult("bash", "")], 0);
	assert.ok(empty.text.includes("[Tool: bash] → (no text output)"));

	// An assistant turn that only called tools still names the calls.
	const calls = buildSnapshot(
		[
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read" },
					{ type: "toolCall", name: "edit" },
				],
			},
		],
		0,
	);
	assert.equal(calls.text, "### 0. assistant\n(called read, edit)");
});

await check("buildSnapshot clamps keep to the total and reports nothing to compact", async () => {
	const messages = [user("one"), assistant("two")];

	const over = buildSnapshot(messages, 99);
	assert.equal(over.kind, "nothing");
	assert.match(over.note, /already small/i);

	const exact = buildSnapshot(messages, 2);
	assert.equal(exact.kind, "nothing", "keep equal to the total compacts nothing");

	const empty = buildSnapshot([], 1);
	assert.equal(empty.kind, "nothing");
	assert.equal(empty.note, NO_MESSAGES_NOTE);

	// keep 0 and a negative keep both mean "compact everything" rather than an error.
	assert.equal(buildSnapshot(messages, 0).compacted, 2);
	assert.equal(buildSnapshot(messages, -5).compacted, 2);
	assert.equal(buildSnapshot(messages, undefined).compacted, 1, "the default keeps the last message");
	assert.equal(DEFAULT_KEEP, 1);
});

await check("compactContext compacts with the configured model and replaces the run", async () => {
	const compactionModel = { provider: "routerai", id: "compactor" };
	const { ctx, calls } = fakeCtx({
		respond: () => OK,
		known: { "routerai/compactor": compactionModel },
	});
	const messages = [user("one"), assistant("two"), user("three"), assistant("four")];

	const result = await compactContext(ctx, messages, 1, "keep the migration plan", {
		...SETTINGS,
		model: "routerai/compactor",
	});

	assert.equal(result.kind, "compacted");
	assert.deepEqual(calls[0].model, compactionModel, "the configured model is used");
	assert.equal(calls[0].options.cacheRetention, "none", "a one-shot prompt is not cached");

	const prompt = calls[0].context.messages[0].content[0].text;
	assert.ok(
		!prompt.includes("keep the migration plan"),
		"the note is the caller's, and never enters the prompt",
	);
	assert.ok(prompt.includes("### 1. assistant"), "the snapshot reaches the prompt");
	assert.ok(!prompt.includes("four"), "the kept tail is not part of the snapshot");

	assert.equal(result.message.role, "assistant");
	assert.equal(result.compacted, 3);
	assert.deepEqual(result.kept, [messages[3]], "the kept messages ride along for the caller");
	assert.ok(
		result.message.content[0].text.startsWith("<press-summary>"),
		"the replacement is a press-summary block",
	);
});

await check("the caller's note is appended to the summary, not left to the model", async () => {
	// The model answers without a Notes section at all, which is exactly the case the old
	// prompt-dependent wording lost: the note must survive anyway, outside the model's control.
	const { ctx } = fakeCtx({ respond: () => ({ stopReason: "stop", content: summaryAnswer() }) });

	const result = await compactContext(
		ctx,
		[user("one"), assistant("two")],
		1,
		"reach the migration plan before Friday",
		SETTINGS,
	);

	assert.equal(result.kind, "compacted");
	const text = result.message.content[0].text;
	assert.ok(text.endsWith("reach the migration plan before Friday"), `note appended, got: ${text}`);
	assert.ok(text.includes("</press-summary>"), "the block itself is untouched");

	// The block still parses back: the appended note is outside it, not a fourth section.
	assert.deepEqual(parsePressSummary(text), {
		taskOverview: "did the work",
		currentState: "",
		discoveries: "",
		nextSteps: "",
		context: "",
	});

	// A caller with nothing to say gets no trailing blank text.
	const quiet = await compactContext(ctx, [user("one"), assistant("two")], 1, "   ", SETTINGS);
	assert.ok(quiet.message.content[0].text.endsWith("</press-summary>"));
});

await check("compactContext falls back to the session model, and skips an empty snapshot", async () => {
	const session = { provider: "routerai", id: "session-model" };
	const { ctx, calls } = fakeCtx({ respond: () => OK, model: session });

	const result = await compactContext(ctx, [user("one"), assistant("two")], 1, undefined, SETTINGS);
	assert.equal(result.kind, "compacted");
	assert.deepEqual(calls[0].model, session, "the session model is the fallback");

	const skipped = await compactContext(ctx, [user("one")], 5, undefined, SETTINGS);
	assert.equal(skipped.kind, "skipped");
	assert.match(skipped.note, /already small/i);
	assert.equal(calls.length, 1, "a skipped compaction spends no model call");
});

await check("an unusable compaction model fails loudly rather than spending another one", async () => {
	const cases = [
		{ model: "routerai/missing", expected: /names no known model/i },
		{ model: "not-a-model", expected: /provider\/model form/i },
		{ model: "routerai/unauthed", expected: /No credentials/i },
	];

	for (const { model, expected } of cases) {
		const { ctx, calls } = fakeCtx({
			respond: () => OK,
			known: { "routerai/unauthed": { provider: "routerai", id: "unauthed" } },
			authed: (candidate) => candidate?.id !== "unauthed",
		});
		await assert.rejects(
			() => compactContext(ctx, [user("one"), assistant("two")], 1, undefined, { ...SETTINGS, model }),
			expected,
		);
		assert.equal(calls.length, 0, `${model}: no model call is spent on a bad configuration`);
	}
});

await check("an unauthenticated session model is reported, not used", async () => {
	const { ctx, calls } = fakeCtx({
		respond: () => OK,
		model: { provider: "routerai", id: "session-model" },
		authed: () => false,
	});
	await assert.rejects(
		() => compactContext(ctx, [user("one"), assistant("two")], 1, undefined, SETTINGS),
		/No credentials configured for routerai\/session-model/,
	);
	assert.equal(calls.length, 0);
});

await check("a provider error is named in the failure, and a throw is reported too", async () => {
	const failing = fakeCtx({
		respond: () => ({ stopReason: "error", errorMessage: "rate limited" }),
	});
	const error = await compactContext(
		failing.ctx,
		[user("one"), assistant("two")],
		1,
		undefined,
		SETTINGS,
	).then(
		() => undefined,
		(caught) => caught,
	);
	assert.ok(error, "a provider error rejects");
	assert.equal(error.name, "PressError");
	assert.match(error.message, /rate limited/, "the provider's own words are in the message");
	assert.equal(error.hint, undefined, "a provider failure has no corrective hint to give");

	const throwing = fakeCtx({
		respond: () => {
			throw new Error("socket closed");
		},
	});
	await assert.rejects(
		() =>
			compactContext(throwing.ctx, [user("one"), assistant("two")], 1, undefined, SETTINGS),
		/socket closed/,
	);

	const silent = fakeCtx({ respond: () => ({ stopReason: "stop", content: [] }) });
	await assert.rejects(
		() => compactContext(silent.ctx, [user("one"), assistant("two")], 1, undefined, SETTINGS),
		/returned no text/i,
	);
});

await check("failureText words every failure the same way for both callers", async () => {
	// The tool and the context hook report the same failures, so they share the wording.
	assert.equal(
		failureText(new PressError("Compaction failed: no model", { hint: "Set press.model." })),
		"Compaction failed: no model\n\nSet press.model.",
		"the hint follows the failure",
	);
	assert.equal(failureText(new PressError("Compaction failed: bare")), "Compaction failed: bare");
	assert.equal(failureText(new Error("socket closed")), "Compaction failed: socket closed");
	assert.equal(failureText("just a string"), "Compaction failed: just a string");
});

await check("parsePressSummary reads the five sections of a press-summary block", async () => {
	const answer = [
		"Here you go:",
		"<press-summary>",
		"## Task Overview",
		"Fixed the parser.",
		"",
		"## Current State",
		"Working.",
		"## Important Discoveries",
		"- src/compact.ts (edited)",
		"## Context to Preserve",
		"The user wants the note preserved.",
		"</press-summary>",
	].join("\n");

	assert.deepEqual(parsePressSummary(answer), {
		taskOverview: "Fixed the parser.",
		currentState: "Working.",
		discoveries: "- src/compact.ts (edited)",
		nextSteps: "",
		context: "The user wants the note preserved.",
	});

	// Headings vary: numbered, case-different, without the hashes, with a colon.
	assert.deepEqual(
		parsePressSummary("<press-summary>\nTask Overview:\na\ncurrent state\nb\n### Important Discoveries\nc\n</press-summary>"),
		{ taskOverview: "a", currentState: "b", discoveries: "c", nextSteps: "", context: "" },
	);

	// Prose without headings is still worth keeping, and empty sections are dropped.
	assert.deepEqual(parsePressSummary("plain prose"), {
		taskOverview: "plain prose",
		currentState: "",
		discoveries: "",
		nextSteps: "",
		context: "",
	});
	assert.deepEqual(
		parsePressSummary("<press-summary>\n## Task Overview\nonly this\n## Current State\n\n</press-summary>"),
		{ taskOverview: "only this", currentState: "", discoveries: "", nextSteps: "", context: "" },
	);

	// Prose ahead of the first heading is the task overview, not litter.
	assert.deepEqual(
		parsePressSummary("<press-summary>\nlead in\n## Context to Preserve\na.ts\n</press-summary>"),
		{ taskOverview: "lead in", currentState: "", discoveries: "", nextSteps: "", context: "a.ts" },
	);

	// A truncated answer still has a usable body after the opening tag.
	assert.deepEqual(parsePressSummary("<press-summary>\n## Task Overview\ncut off here"), {
		taskOverview: "cut off here",
		currentState: "",
		discoveries: "",
		nextSteps: "",
		context: "",
	});

	// Rendering is the shape the parse reads back.
	const rendered = renderPressSummary({ taskOverview: "s", currentState: "c", discoveries: "d", nextSteps: "n", context: "x" });
	assert.deepEqual(parsePressSummary(rendered), { taskOverview: "s", currentState: "c", discoveries: "d", nextSteps: "n", context: "x" });
});

await check("a summary split across text blocks is parsed as one answer", async () => {
	// Providers return one text block per streamed segment; the sections straddle them.
	const { ctx, calls } = fakeCtx({
		respond: () => ({
			stopReason: "stop",
			usage: {},
			content: [
				{ type: "text", text: "<press-summary>\n## Task Overview\nhalf " },
				{ type: "thinking", thinking: "ignore me" },
				{ type: "text", text: "a summary\n## Context to Preserve\nthe note\n</press-summary>" },
			],
		}),
	});

	const result = await compactContext(ctx, [user("one"), assistant("two")], 1, "the note", SETTINGS);
	assert.equal(result.kind, "compacted");
	// Blocks are joined with a newline, the same separator pi's own summarizer uses, so
	// separate blocks never glue two words together. The caller's note then follows the block.
	assert.deepEqual(parsePressSummary(result.message.content[0].text), {
		taskOverview: "half \na summary",
		currentState: "",
		discoveries: "",
		nextSteps: "",
		context: "the note",
	});
	assert.equal(
		result.message.content[0].text,
		"<press-summary>\n## Task Overview\nhalf \na summary\n\n## Context to Preserve\nthe note\n</press-summary>\n\nthe note",
	);
	assert.equal(calls.length, 1);
});

// ------------------------------------------------- anchor / trim / files

/** An assistant turn holding a real `<press-summary>` block, as a compaction leaves one. */
function summaryAnchor(text = "first pass") {
	return assistant(
		`<press-summary>\n## Task Overview\n${text}\n\n## Context to Preserve\nsrc/compact.ts\n</press-summary>`,
	);
}

/** An assistant turn holding a `<press-trim>` note, as the trim tool leaves one. */
function trimAnchor(text = "12 tool results replaced with [trimmed].") {
	return assistant(`<press-trim>\n${text}\n</press-trim>`);
}

await check("findAnchor finds the latest compaction already in the conversation", async () => {
	assert.equal(findAnchor([]), undefined, "an empty run has no anchor");
	assert.equal(
		findAnchor([user("one"), assistant("two")]),
		undefined,
		"a conversation never compacted has no anchor",
	);

	const first = summaryAnchor("first");
	const second = summaryAnchor("second");
	const messages = [first, user("new work"), second, assistant("more work")];

	const anchor = findAnchor(messages);
	assert.equal(anchor.kind, "summary", "the block is read as a summary");
	assert.equal(anchor.afterIndex, 2, "afterIndex is the anchor message's own index");
	assert.equal(
		anchor.text,
		"## Task Overview\nsecond\n\n## Context to Preserve\nsrc/compact.ts",
		"text is the inside of the block, and the latest anchor wins",
	);
	assert.deepEqual(
		messages.slice(anchor.afterIndex + 1),
		[assistant("more work")],
		"slicing after the index leaves exactly the messages a fresh compaction covers",
	);

	// A summary truncated by a token limit is still an anchor: the body after the opening tag
	// is what a later compaction merges into.
	const truncated = findAnchor([assistant("<press-summary>\n## Task Overview\ncut off")]);
	assert.equal(truncated.kind, "summary");
	assert.equal(truncated.text, "## Task Overview\ncut off");
});

await check("findAnchor rejects tag mentions that are not compactions", async () => {
	// A note quoting the format, and an assistant turn discussing it, both carry the tag without
	// being a compaction. The section parser is the arbiter: no recognized heading, no anchor.
	const quoting = user("remember that <press-summary> wraps the summary block");
	const discussing = assistant("I emit a <press-summary> block when I compact.");
	assert.equal(findAnchor([quoting]), undefined, "a user note quoting the tag is not an anchor");
	assert.equal(findAnchor([discussing]), undefined, "assistant prose about the tag is not an anchor");

	// Non-assistant messages are never anchors, even with a well-formed block in them.
	const inAToolResult = {
		role: "toolResult",
		toolName: "read",
		content: [
			{ type: "text", text: "<press-summary>\n## Task Overview\nx\n</press-summary>" },
		],
	};
	assert.equal(
		findAnchor([inAToolResult]),
		undefined,
		"only an assistant message can carry a compaction",
	);

	// False positive ahead of a real anchor: the scan keeps going backward past it.
	const real = summaryAnchor("real");
	const anchor = findAnchor([discussing, real]);
	assert.equal(anchor.afterIndex, 1, "the scan skips the false positive and finds the real anchor");
	assert.equal(anchor.text, "## Task Overview\nreal\n\n## Context to Preserve\nsrc/compact.ts");
});

await check("findAnchor recognizes a trim note, closed or truncated", async () => {
	const messages = [user("one"), trimAnchor(), assistant("after the trim")];
	const anchor = findAnchor(messages);
	assert.equal(anchor.kind, "trim");
	assert.equal(anchor.afterIndex, 1);
	assert.equal(anchor.text, "12 tool results replaced with [trimmed].");

	const truncated = findAnchor([assistant("<press-trim>\n20 tool results replaced with [trimmed].")]);
	assert.equal(truncated.kind, "trim", "an unclosed tail is still a trim anchor");
	assert.equal(truncated.text, "20 tool results replaced with [trimmed].");

	// The tag alone is not the signal: prose mentioning the format lacks the count line.
	assert.equal(
		findAnchor([assistant("keep <press-trim> in mind")]),
		undefined,
		"assistant prose mentioning the tag is not a trim anchor",
	);

	// A trim and a summary in the same run: the later one is the anchor.
	const both = [trimAnchor(), user("work"), summaryAnchor("after")];
	assert.equal(findAnchor(both).kind, "summary");
	assert.equal(findAnchor(both.slice(0, 2)).kind, "trim");
});

await check("trimMessages replaces tool results without dropping the messages", async () => {
	const call = assistantToolCall("read");
	const first = { ...toolResult("read", "the whole file"), toolCallId: "call-1" };
	const second = { ...toolResult("bash", "a pile of output"), toolCallId: "call-2" };
	const messages = [call, first, second, assistant("done reading"), user("tail")];

	const result = trimMessages(messages, 1);
	assert.equal(result.kind, "trimmed");
	assert.equal(result.trimmed, 2, "both tool results in the compacted run are replaced");
	assert.equal(result.kept, 1, "the kept tail count is reported");
	assert.equal(result.messages.length, messages.length, "not one message is dropped");
	assert.deepEqual(result.messages[0], call, "the tool call that produced the results is untouched");

	// The chain pi replays is the point: identity survives, only the content is replaced.
	assert.equal(result.messages[1].toolCallId, "call-1", "the result still answers its call");
	assert.equal(result.messages[1].toolName, "read");
	assert.equal(result.messages[1].timestamp, first.timestamp);
	assert.deepEqual(result.messages[1].content, [{ type: "text", text: "[trimmed]" }]);
	assert.deepEqual(result.messages[2].content, [{ type: "text", text: "[trimmed]" }]);
	assert.ok(!JSON.stringify(result.messages).includes("the whole file"), "the bulk is gone");

	// Assistant reasoning and the kept tail stay verbatim.
	assert.deepEqual(result.messages[3], messages[3], "assistant text is not touched by a trim");
	assert.deepEqual(
		result.messages[4],
		messages[4],
		"the kept tail rides verbatim",
	);
	assert.deepEqual(
		messages[1].content,
		[{ type: "text", text: "the whole file" }],
		"the input is not mutated",
	);

	// keep 0 trims everything there is.
	assert.equal(trimMessages(messages, 0).trimmed, 2);
});

await check("trimMessages skips what is already processed or has nothing to trim", async () => {
	const old = { ...toolResult("read", "old output"), toolCallId: "call-old" };
	const fresh = { ...toolResult("read", "new output"), toolCallId: "call-new" };

	// The anchor region is already processed: only what follows it is a candidate.
	const messages = [old, summaryAnchor(), fresh, assistant("end"), user("tail")];
	const result = trimMessages(messages, 1);
	assert.equal(result.kind, "trimmed");
	assert.equal(result.trimmed, 1, "only the result after the anchor is trimmed");
	assert.deepEqual(
		result.messages[0].content,
		[{ type: "text", text: "old output" }],
		"before the anchor is left alone",
	);
	assert.deepEqual(result.messages[2].content, [{ type: "text", text: "[trimmed]" }]);

	// A trim is never applied twice to what a previous trim already replaced.
	const afterTrim = trimMessages([trimAnchor(), fresh, user("tail")], 1);
	assert.equal(afterTrim.trimmed, 1, "the fresh result after a trim note is trimmed");
	const nothingNew = trimMessages([trimAnchor(), assistant("no tools here")], 1);
	assert.equal(nothingNew.kind, "nothing");
	assert.match(nothingNew.note, /No tool results to trim/);

	// The same nothing-cases as buildSnapshot, so the tool can word them the same way.
	const noTools = trimMessages([user("one"), assistant("two")], 1);
	assert.equal(noTools.kind, "nothing");
	assert.match(noTools.note, /No tool results to trim/);

	const over = trimMessages([user("one"), assistant("two")], 99);
	assert.equal(over.kind, "nothing");
	assert.match(over.note, /already small/i);
	assert.equal(trimMessages([], 1).note, NO_MESSAGES_NOTE);
});

await check("extractFilePaths reads the paths the tool calls named", async () => {
	const messages = [
		user("go"),
		{
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "src/compact.ts" } },
				{ type: "toolCall", name: "edit", arguments: { path: "src/config.ts" } },
			],
		},
		toolResult("read", "contents"),
		{
			role: "assistant",
			content: [
				{ type: "toolCall", name: "resolve_file", arguments: { pattern: "compact" } },
				{ type: "toolCall", name: "summary", arguments: { path: "src/state.ts" } },
				{ type: "toolCall", name: "related_files", arguments: { path: "src/compact.ts" } },
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", name: "write", arguments: {} },
				{ type: "toolCall", name: "write", arguments: { path: "src/new.ts" } },
				{ type: "thinking", thinking: "ignored" },
			],
		},
	];

	assert.deepEqual(
		extractFilePaths(messages),
		["src/compact.ts", "src/config.ts", "compact", "src/state.ts", "src/new.ts"],
		"file tools contribute their path or pattern, deduplicated in first-seen order",
	);
	assert.deepEqual(extractFilePaths([]), [], "an empty run names no files");
	assert.deepEqual(
		extractFilePaths([user("only text"), toolResult("read", "x")]),
		[],
		"only assistant tool calls count",
	);
});

await check("compactContext merges new messages into the existing summary", async () => {
	const anchor = summaryAnchor("first pass");
	const messages = [anchor, user("new question"), assistant("new answer"), user("tail")];
	const { ctx, calls } = fakeCtx({ respond: () => OK });

	const result = await compactContext(ctx, messages, 1, undefined, SETTINGS);
	assert.equal(result.kind, "compacted");
	const prompt = calls[0].context.messages[0].content[0].text;

	assert.ok(prompt.includes("existing summary"), "the prompt frames the answer as a merge");
	assert.ok(prompt.includes("Merge the new messages into it"), "and says what to do with them");
	assert.ok(prompt.includes("first pass"), "the model is handed its own earlier summary");
	assert.ok(prompt.includes("Merge the 2 messages below"), "only the messages after the anchor are counted");
	assert.ok(prompt.includes("new question"), "the new messages are the snapshot");
	assert.ok(!prompt.includes("### 0. assistant"), "the anchor itself is not re-summarized");
	assert.ok(prompt.includes("## Task Overview"), "the output format is unchanged");

	assert.equal(result.compacted, 3, "the replacement still covers the whole compacted run");
	assert.deepEqual(result.kept, [messages[3]], "and the kept tail is unchanged");
});

await check("compactContext frames a trim anchor as fresh work, and skips an empty tail", async () => {
	const trimmed = trimAnchor("40 tool results replaced with [trimmed].");
	const { ctx, calls } = fakeCtx({ respond: () => OK });

	const messages = [trimmed, user("new question"), assistant("new answer"), user("tail")];
	const result = await compactContext(ctx, messages, 1, undefined, SETTINGS);
	assert.equal(result.kind, "compacted");
	const prompt = calls[0].context.messages[0].content[0].text;
	assert.ok(prompt.includes("previously trimmed"), "the prompt explains the trimmed history");
	assert.ok(prompt.includes("Summarize only the new messages"));
	assert.ok(prompt.includes("40 tool results replaced"), "the trim note travels into the prompt");
	assert.ok(prompt.includes("new question"));

	// The anchor is the last message of the compacted run: there is nothing left to summarize.
	const nothing = await compactContext(ctx, [trimmed, user("tail")], 1, undefined, SETTINGS);
	assert.equal(nothing.kind, "skipped");
	assert.match(nothing.note, /nothing new to summarize/i);
	assert.equal(calls.length, 1, "a skipped continuation spends no model call");

	// A note is still appended, never prompted, on the anchored path too.
	const noted = await compactContext(ctx, messages, 1, "a fresh note", SETTINGS);
	assert.ok(noted.message.content[0].text.endsWith("a fresh note"));
	assert.ok(!calls[1].context.messages[0].content[0].text.includes("a fresh note"));
});

await check("renderPressSummary appends the referenced files inside Context to Preserve", async () => {
	const summary = {
		taskOverview: "did the work",
		currentState: "working",
		discoveries: "",
		nextSteps: "",
		context: "the user wants this to stay short",
	};
	const files = ["src/compact.ts", "src/state.ts"];

	const rendered = renderPressSummary(summary, files);
	assert.equal(
		rendered,
		"<press-summary>\n" +
			"## Task Overview\ndid the work\n\n" +
			"## Current State\nworking\n\n" +
			"## Context to Preserve\nthe user wants this to stay short\n\n" +
			"Recently referenced files:\n- src/compact.ts\n- src/state.ts\n" +
			"</press-summary>",
	);

	// The parser reads the whole block back, list included: the files line sits in the section body.
	const parsed = parsePressSummary(rendered);
	assert.equal(
		parsed.context,
		"the user wants this to stay short\n\nRecently referenced files:\n- src/compact.ts\n- src/state.ts",
	);
	assert.equal(parsed.taskOverview, "did the work");

	// The section still renders when the model left it empty and only the list is there.
	const empty = renderPressSummary({ ...summary, context: "" }, ["src/foo.ts"]);
	assert.equal(parsePressSummary(empty).context, "Recently referenced files:\n- src/foo.ts");

	// No files, or an empty list, renders exactly what the model produced.
	assert.equal(renderPressSummary(summary), renderPressSummary(summary, []));
	assert.ok(!renderPressSummary(summary).includes("Recently referenced files"));
	assert.ok(!renderPressSummary({ ...summary, context: "" }).includes("## Context to Preserve"));
});

await check("a compaction records the files its tool calls named", async () => {
	const { ctx, calls } = fakeCtx({ respond: () => OK });
	const messages = [
		user("do the thing"),
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "read", arguments: { path: "src/compact.ts" } }],
		},
		toolResult("read", "contents"),
		assistant("read it"),
	];

	const result = await compactContext(ctx, messages, 1, undefined, SETTINGS);
	assert.equal(result.kind, "compacted");
	const text = result.message.content[0].text;
	assert.ok(text.includes("Recently referenced files:\n- src/compact.ts"), text);
	assert.equal(parsePressSummary(text).context, "Recently referenced files:\n- src/compact.ts");
	assert.ok(
		!calls[0].context.messages[0].content[0].text.includes("Recently referenced"),
		"the files are recorded, not prompted for",
	);
});

// ---------------------------------------------------------------- press tool

/** The tool definition, registered against the per-registration state a case owns. */
function pressTool(state = createPressState()) {
	const tools = [];
	registerPressTool({ registerTool: (definition) => tools.push(definition) }, state);
	assert.equal(tools.length, 1, "exactly one tool is registered");
	return tools[0];
}

/** The tool executor's fifth argument: the engine's fake ctx plus a working directory. */
function toolCtx(fake, cwd) {
	return { ...fake.ctx, cwd };
}

await check("the press tool declares optional note and keep parameters", async () => {
	const tool = pressTool();
	assert.equal(tool.name, "press");
	assert.equal(typeof tool.label, "string");
	assert.equal(typeof tool.description, "string");

	const schema = tool.parameters;
	assert.deepEqual(Object.keys(schema.properties).sort(), ["keep", "note"]);
	assert.equal(schema.properties.note.type, "string");
	assert.equal(schema.properties.keep.type, "integer");
	assert.equal(schema.properties.keep.default, 1, "keep defaults to the last message only");
	assert.deepEqual(schema.required ?? [], [], "both parameters are optional");
});

await check("the press tool injects no prompt snippet of its own", async () => {
	// Spec: the tool description is enough, and prompt injection is out of scope. The wording
	// that used to live in promptGuidelines is folded into the description instead.
	const tool = pressTool();
	assert.equal(tool.promptSnippet, undefined, "no snippet is registered");
	assert.equal(tool.promptGuidelines, undefined, "no guidelines are registered");
	assert.match(tool.description, /start over/, "the guidance survives in the description");
	assert.match(tool.description, /keep/, "and so does what `keep` is for");
});

await check("press compacts the cached messages and hands the model the summary", async () => {
	resetSettings();
	const root = tempProject();
	try {
		const state = createPressState();
		const compactionModel = { provider: "routerai", id: "compactor" };
		const { ctx, calls } = fakeCtx({
			respond: () => OK,
			known: { "routerai/compactor": compactionModel },
		});
		writeScope(root, "project", { [SETTINGS_KEY]: { model: "routerai/compactor" } });

		const messages = [user("one"), assistant("two"), user("three")];
		state.cacheMessages(messages);

		const result = await pressTool(state).execute(
			"call-1",
			{ note: "keep the migration plan", keep: 1 },
			undefined,
			undefined,
			toolCtx({ ctx }, root),
		);

		assert.notEqual(result.isError, true, "a successful press is not an error result");
		assert.match(result.content[0].text, /^<press-summary>/, "the model sees the summary block");
		assert.match(result.content[0].text, /did the work/);
		assert.ok(
			result.content[0].text.endsWith("keep the migration plan"),
			"the user's note is appended outside the model's answer",
		);
		assert.equal(result.details.status, "compacted");
		assert.equal(result.details.compacted, 2);
		assert.equal(result.details.kept, 1);
		assert.equal(calls.length, 1, "one summary call is spent");
		assert.ok(
			!calls[0].context.messages[0].content[0].text.includes("keep the migration plan"),
			"the note is appended outside the model's answer, never prompted into it",
		);

		// The handoff the context hook consumes: the summary message, then the untouched tail.
		const staged = state.staged();
		assert.equal(staged.messages.length, 2);
		assert.equal(
			staged.messages[0].content[0].text,
			result.content[0].text,
			"the staged block is what the model saw",
		);
		assert.deepEqual(staged.messages[1], messages[2], "the kept message is staged verbatim");
		assert.deepEqual(staged.base, messages, "the staged compaction records what it was made from");
		state.clearStaged();
		assert.equal(state.staged(), undefined, "clearing the staged compaction is enough");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("press reports an error when nothing has been cached yet", async () => {
	const state = createPressState();
	const { ctx, calls } = fakeCtx({ respond: () => OK });

	const result = await pressTool(state).execute("call-2", {}, undefined, undefined, toolCtx({ ctx }, tmpdir()));

	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, NO_MESSAGES_NOTE);
	assert.equal(result.details.status, "error");
	assert.equal(calls.length, 0, "an empty cache spends no model call");
	assert.equal(state.staged(), undefined);
});

await check("press reports a context that is already small without spending a call", async () => {
	resetSettings();
	const root = tempProject();
	try {
		const state = createPressState();
		state.cacheMessages([user("one"), assistant("two")]);
		const { ctx, calls } = fakeCtx({ respond: () => OK });

		const result = await pressTool(state).execute(
			"call-3",
			{ keep: 5 },
			undefined,
			undefined,
			toolCtx({ ctx }, root),
		);

		assert.notEqual(result.isError, true, "a small context is a normal result, not a failure");
		assert.match(result.content[0].text, /already small/i);
		assert.equal(result.details.status, "skipped");
		assert.equal(calls.length, 0, "nothing to compact means no model call");
		assert.equal(state.staged(), undefined, "nothing is staged for the context hook");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a compaction model failure reaches the model as an error result", async () => {
	resetSettings();
	const root = tempProject();
	try {
		const state = createPressState();
		state.cacheMessages([user("one"), assistant("two")]);

		const provider = fakeCtx({
			respond: () => ({ stopReason: "error", errorMessage: "provider exploded", content: [] }),
		});
		const failed = await pressTool(state).execute(
			"call-4",
			{},
			undefined,
			undefined,
			toolCtx(provider, root),
		);
		assert.equal(failed.isError, true);
		assert.match(failed.content[0].text, /Compaction failed: provider exploded/);
		assert.equal(failed.details.status, "error");
		assert.equal(state.staged(), undefined, "a failed press stages nothing");

		// A provider client that throws is reported the same way rather than escaping.
		const throwing = fakeCtx({
			respond: () => {
				throw new Error("socket closed");
			},
		});
		const thrown = await pressTool(state).execute(
			"call-5",
			{},
			undefined,
			undefined,
			toolCtx(throwing, root),
		);
		assert.equal(thrown.isError, true);
		assert.match(thrown.content[0].text, /Compaction failed: socket closed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----------------------------------------------------------------- trim tool

/** The trim tool definition, registered against the per-registration state a case owns. */
function trimTool(state = createPressState()) {
	const tools = [];
	registerTrimTool({ registerTool: (definition) => tools.push(definition) }, state);
	assert.equal(tools.length, 1, "exactly one tool is registered");
	return tools[0];
}

/** A conversation whose token cost sits in old tool results, which is what trim is for. */
function trimmableConversation() {
	return [
		user("do the thing"),
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "read", arguments: { path: "src/compact.ts" } }],
		},
		toolResult("read", "a very long file read"),
		assistant("read it"),
		{
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
		},
		toolResult("bash", "a very long test log"),
		assistant("tests pass"),
	];
}

await check("the trim tool declares optional note and keep parameters", async () => {
	const tool = trimTool();
	assert.equal(tool.name, "trim");
	assert.equal(typeof tool.label, "string");
	assert.equal(typeof tool.description, "string");
	assert.equal(tool.executionMode, "sequential", "a trim rewrites the conversation");

	const schema = tool.parameters;
	assert.deepEqual(Object.keys(schema.properties).sort(), ["keep", "note"]);
	assert.equal(schema.properties.note.type, "string");
	assert.equal(schema.properties.keep.type, "integer");
	assert.equal(schema.properties.keep.default, 1, "keep defaults to the last message only");
	assert.deepEqual(schema.required ?? [], [], "both parameters are optional");
});

await check("both tools declare no prompt snippet and no mode parameter", async () => {
	const press = pressTool();
	const tool = trimTool();

	for (const definition of [press, tool]) {
		assert.equal(definition.promptSnippet, undefined, "no snippet is registered");
		assert.equal(definition.promptGuidelines, undefined, "no guidelines are registered");
		assert.ok(
			!("mode" in definition.parameters.properties),
			"press and trim stay separate tools rather than one with a mode parameter",
		);
	}

	assert.match(press.description, /trim/, "press points at trim as the cheap alternative");
	assert.match(tool.description, /press/, "trim points back at press for a full summary");
	assert.match(tool.description, /no model call/, "the description says why trim is cheap");
});

await check("trim replaces old tool results and stages an anchor plus the trimmed run", async () => {
	resetSettings();
	const state = createPressState();
	const messages = trimmableConversation();
	state.cacheMessages(messages);

	const result = await trimTool(state).execute("call-1", { keep: 1 }, undefined, undefined, undefined);

	assert.notEqual(result.isError, true, "a trim is not an error result");
	assert.equal(
		result.content[0].text,
		"Context trimmed.\n- 2 tool results replaced with [trimmed]\n- last 1 messages kept verbatim",
		"the tool result the model reads is counts only",
	);
	assert.equal(result.details.status, "trimmed");
	assert.equal(result.details.trimmed, 2);
	assert.equal(result.details.kept, 1);

	const staged = state.staged();
	assert.equal(staged.messages.length, messages.length + 1, "the anchor leads the trimmed run");
	const anchor = staged.messages[0];
	assert.equal(anchor.role, "assistant");
	assert.equal(
		anchor.content[0].text,
		"<press-trim>\n2 tool results replaced with [trimmed].\nRecently referenced files: src/compact.ts.\n</press-trim>",
		"the anchor states what was trimmed and which files the run had touched",
	);
	assert.deepEqual(
		staged.messages.slice(1).map((message) => message.role),
		messages.map((message) => message.role),
		"every message survives the trim, so the toolCall -> toolResult chain stays intact",
	);
	assert.equal(staged.messages[3].content[0].text, "[trimmed]", "the old read result is a placeholder");
	assert.equal(staged.messages[6].content[0].text, "[trimmed]", "and so is the old bash log");
	assert.deepEqual(staged.messages.at(-1), messages.at(-1), "the kept tail is verbatim");
	assert.deepEqual(staged.base, messages, "the staged trim records what it was made from");
	assert.ok(
		!state.cachedMessages().some((message) => message.content?.[0]?.text === "[trimmed]"),
		"the tool does not mutate the cached conversation",
	);
});

await check("the trim note travels inside the anchor block", async () => {
	resetSettings();
	const state = createPressState();
	state.cacheMessages(trimmableConversation());

	const result = await trimTool(state).execute(
		"call-1",
		{ keep: 2, note: "  decided to keep the schema stable  " },
		undefined,
		undefined,
		undefined,
	);

	assert.equal(result.details.kept, 2, "keep is honoured");
	const text = state.staged().messages[0].content[0].text;
	assert.match(text, /Note: decided to keep the schema stable/, "the note is trimmed and recorded");
	assert.ok(text.startsWith("<press-trim>\n") && text.endsWith("\n</press-trim>"), "inside the block");
	assert.ok(
		!result.content[0].text.includes("decided to keep"),
		"the tool result stays factual: the model reads its note back from the anchor",
	);
	assert.equal(
		findAnchor(state.staged().messages).text.split("\n").at(-1),
		"Note: decided to keep the schema stable",
		"a later findAnchor surfaces the note to the next compaction",
	);

	// A whitespace-only note leaves no line behind at all.
	state.clearStaged();
	const blank = await trimTool(state).execute("call-2", { keep: 1, note: "   " }, undefined, undefined, undefined);
	assert.notEqual(blank.details.status, "skipped");
	assert.ok(!state.staged().messages[0].content[0].text.includes("Note:"));

	// No file-naming tool calls means no files line either.
	state.clearStaged();
	state.cacheMessages([user("one"), assistant("two"), toolResult("bash", "log"), assistant("three")]);
	await trimTool(state).execute("call-3", { keep: 1 }, undefined, undefined, undefined);
	assert.equal(
		state.staged().messages[0].content[0].text,
		"<press-trim>\n1 tool results replaced with [trimmed].\n</press-trim>",
		"the files line is omitted when nothing was referenced",
	);
});

await check("trim reports a context with nothing to trim without staging", async () => {
	resetSettings();
	const state = createPressState();

	const empty = await trimTool(state).execute("call-1", {}, undefined, undefined, undefined);
	assert.equal(empty.isError, true, "an empty cache is an error result");
	assert.equal(empty.content[0].text, NO_MESSAGES_NOTE);
	assert.equal(empty.details.status, "error");
	assert.equal(state.staged(), undefined);

	// An already-small conversation: keep 7 of seven messages leaves nothing to trim.
	state.cacheMessages(trimmableConversation());
	const small = await trimTool(state).execute("call-2", { keep: 7 }, undefined, undefined, undefined);
	assert.notEqual(small.isError, true, "a small context is a normal result, not a failure");
	assert.match(small.content[0].text, /leaves nothing to trim/);
	assert.equal(small.details.status, "skipped");
	assert.equal(small.details.trimmed, 0);
	assert.equal(state.staged(), undefined, "nothing is staged for the context hook");

	// A conversation with no tool results at all: nothing to replace.
	state.cacheMessages([user("one"), assistant("two"), user("three"), assistant("four")]);
	const noResults = await trimTool(state).execute("call-3", { keep: 1 }, undefined, undefined, undefined);
	assert.match(noResults.content[0].text, /No tool results to trim/);
	assert.equal(noResults.details.status, "skipped");
	assert.equal(state.staged(), undefined);
});

await check("a trim a context pass later installs leaves the anchor in the conversation", async () => {
	resetSettings();
	const root = tempProject();
	try {
		const registration = captureRegistration();
		const messages = trimmableConversation();

		await contextPass(registration, messages, DEFAULT_WARN_TOKENS - 1, root);
		const trimmer = registration.tools.find((definition) => definition.name === "trim");
		await trimmer.execute("call-1", { keep: 1, note: "the plan holds" }, undefined, undefined, undefined);

		const installed = await contextPass(registration, messages, DEFAULT_WARN_TOKENS - 1, root);
		assert.equal(installed.messages.length, messages.length + 1, "the anchor is added, nothing dropped");
		assert.match(installed.messages[0].content[0].text, /^<press-trim>/, "the anchor leads");
		assert.equal(findAnchor(installed.messages).kind, "trim", "and the next compaction sees it");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------- context hook

/**
 * One registration's hook plus the state it shares with the tool.
 *
 * Built through `registerContextHook` rather than the factory so a case can reach the state
 * the two halves share - which is the point of moving that state out of the module.
 */
function contextHook() {
	const state = createPressState();
	const handlers = [];
	registerContextHook({ on: (event, handler) => handlers.push({ event, handler }) }, state);
	assert.deepEqual(
		handlers.map((entry) => entry.event),
		["context"],
		"exactly one context handler is registered",
	);
	return { state, handler: handlers[0].handler };
}

/** A load of the whole extension, with the tool and hook it registered. */
function captureRegistration() {
	const tools = [];
	const handlers = [];
	extensionFactory({
		registerTool: (definition) => tools.push(definition),
		on: (event, handler) => handlers.push({ event, handler }),
	});
	return { tool: tools[0], tools, handler: handlers[0].handler };
}

/** The hook's `ctx`: only context usage and a cwd are read from it. */
function hookCtx(tokens, cwd = tmpdir()) {
	// pi reports `percent` already scaled to 0-100, so a 1M window makes the arithmetic exact.
	return {
		cwd,
		getContextUsage: () =>
			tokens === undefined
				? undefined
				: {
						tokens,
						contextWindow: 1_000_000,
						percent: tokens === null ? null : Math.round(tokens / 10_000),
					},
	};
}

/** A pass over `messages`, as pi's runner would emit it, for one registration's hook. */
function contextPass(registration, messages, tokens, cwd, extra) {
	return registration.handler({ type: "context", messages }, { ...hookCtx(tokens, cwd), ...extra });
}

/**
 * A pass driven through `handleContext` directly, with the flag state in the case's own hands.
 *
 * The registration helper above owns its flags privately, which is the right shape for the
 * extension but hides them from a case that has to assert on both of them.
 */
function directHook() {
	const press = createPressState();
	const state = { warned: false, criticallyWarned: false };
	return {
		state,
		press,
		pass: (messages, tokens, cwd = tmpdir(), extra) =>
			handleContext({ type: "context", messages }, { ...hookCtx(tokens, cwd), ...extra }, state, press),
	};
}

/** An assistant turn that ends by requesting a tool: mid-turn, never a compaction point. */
function assistantToolCall(name = "read") {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${name}`, name, arguments: {} }],
		timestamp: 1,
	};
}

/** A summary message as the tool would stage it. */
function summaryMessage(text = "did the work") {
	return {
		role: "assistant",
		content: [{ type: "text", text: `<press-summary>\n## Summary\n${text}\n</press-summary>` }],
		timestamp: 9,
	};
}

await check("the context hook caches the conversation for the press tool", async () => {
	resetSettings();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	const result = await contextPass(hook, messages, DEFAULT_WARN_TOKENS - 1, tempProject());

	assert.equal(result, undefined, "a quiet pass rewrites nothing");
	assert.equal(hook.state.cachedMessages(), messages, "the tool reads back the messages pi handed over");
});

await check("token pressure at the threshold warns the model once", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	try {
		const result = await contextPass(hook, messages, DEFAULT_WARN_TOKENS, root);

		assert.equal(result.messages.length, messages.length + 1, "the warning is appended, not substituted");
		assert.deepEqual(
			result.messages.slice(0, messages.length),
			messages,
			"the conversation itself is untouched",
		);
		const warning = result.messages.at(-1);
		assert.equal(warning.role, "system", "the warning must be a system message");
		assert.equal(typeof warning.timestamp, "number");
		assert.match(warning.content[0].text, /press/, "it names the tool to call");
		assert.ok(
			warning.content[0].text.includes(String(DEFAULT_WARN_TOKENS)),
			"it states the threshold",
		);
		assert.deepEqual(
			hook.state.cachedMessages(),
			messages,
			"our own warning is not cached, so press never summarizes it",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the warning honours the configured threshold", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	try {
		writeScope(root, "project", { [SETTINGS_KEY]: { warnTokens: 100 } });

		const below = await contextPass(hook, messages, 99, root);
		assert.equal(below, undefined, "below the configured threshold nothing happens");

		const above = await contextPass(hook, messages, 100, root);
		assert.equal(above.messages.length, messages.length + 1, "the configured threshold warns");
		assert.match(above.messages.at(-1).content[0].text, /100/, "the warning quotes it");
	} finally {
		resetSettings();
		rmSync(root, { recursive: true, force: true });
	}
});

await check("token pressure is only checked at an assistant text turn boundary", async () => {
	resetSettings();
	const hook = contextHook();
	const root = tempProject();
	try {
		// Tool results and in-flight tool calls are mid-turn: the compaction points are wrong
		// there, and acting would rewrite the conversation around results still arriving.
		const afterToolResult = [user("one"), assistantToolCall(), toolResult("read", "contents")];
		assert.equal(
			await contextPass(hook, afterToolResult, DEFAULT_CRITICAL_TOKENS, root),
			undefined,
			"a trailing tool result does not warn",
		);

		const awaitingTool = [user("one"), assistant("two"), assistantToolCall()];
		assert.equal(
			await contextPass(hook, awaitingTool, DEFAULT_CRITICAL_TOKENS, root),
			undefined,
			"an assistant message that requests a tool does not warn",
		);

		// Same messages, same hook: at a real boundary the warning does fire, so the cases above
		// prove the shape check and not a broken threshold.
		const boundary = [user("one"), assistant("two")];
		const warned = await contextPass(hook, boundary, WARNING_PRESSURE, root);
		assert.equal(warned.messages.length, boundary.length + 1, "an assistant text turn does warn");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the warning is injected once while the flag is set", async () => {
	resetSettings();
	const hook = contextHook();
	const root = tempProject();
	const messages = [user("one"), assistant("two")];
	try {
		const first = await contextPass(hook, messages, DEFAULT_WARN_TOKENS, root);
		assert.equal(first.messages.length, messages.length + 1, "the first crossing warns");

		const second = await contextPass(hook, messages, WARNING_PRESSURE, root);
		assert.equal(second, undefined, "further pressure while warned adds nothing");

		const third = await contextPass(hook, messages, WARNING_PRESSURE + 1000, root);
		assert.equal(third, undefined, "raising pressure does not re-inject the warning");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("unknown token usage leaves the context alone", async () => {
	resetSettings();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];

	assert.equal(await contextPass(hook, messages, undefined), undefined, "no usage means no check");
	assert.equal(
		await contextPass(hook, messages, null),
		undefined,
		"usage that pi reports as unknown does not warn",
	);
});

await check("a press stages a compaction the next context pass installs", async () => {
	resetSettings();
	const root = tempProject();
	try {
		// The whole handoff through one registration: the tool stages, the hook installs.
		const registration = captureRegistration();
		const { ctx, calls } = fakeCtx({ respond: () => OK });
		const messages = [user("one"), assistant("two"), user("three")];

		await contextPass(registration, messages, DEFAULT_WARN_TOKENS - 1, root, ctx);
		const pressed = await registration.tool.execute(
			"call-1",
			{ note: "keep the plan", keep: 1 },
			undefined,
			undefined,
			toolCtx({ ctx }, root),
		);
		assert.equal(calls.length, 1, "the press spent one call");

		const installed = await contextPass(registration, messages, DEFAULT_WARN_TOKENS - 1, root, ctx);
		assert.equal(installed.messages.length, 2, "the summary replaces the compacted run, tail kept");
		assert.equal(
			installed.messages[0].content[0].text,
			pressed.content[0].text,
			"the model now holds exactly what the tool reported",
		);
		assert.deepEqual(installed.messages[1], messages[2], "the kept message survives verbatim");
		assert.equal(calls.length, 1, "installing a staging spends no further call");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a staged compaction replaces the conversation", async () => {
	resetSettings();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	const summary = summaryMessage();
	const kept = user("three");

	// A summary the tool built from exactly these messages, as the tool would stage it.
	hook.state.cacheMessages(messages);
	hook.state.stageCompacted([summary, kept]);

	// Consumption is checked above any threshold: a staged compaction from a manual `press`
	// must not also draw a warning about the pressure it just relieved.
	const result = await contextPass(hook, messages, DEFAULT_CRITICAL_TOKENS, tmpdir());
	assert.deepEqual(result.messages, [summary, kept], "the summary and the kept tail stand in");
	assert.equal(hook.state.staged(), undefined, "a staged compaction is consumed exactly once");
});

await check("a staged compaction waits for a turn boundary instead of dropping fresh tool results", async () => {
	resetSettings();
	const hook = contextHook();
	const root = tempProject();
	const base = [user("one"), assistant("two")];
	const summary = summaryMessage();
	try {
		// The model called press while also calling tools, so results for it are still arriving.
		hook.state.cacheMessages(base);
		hook.state.stageCompacted([summary]);

		const fresh = toolResult("read", "contents the model has not seen yet");
		const deferred = await contextPass(hook, [...base, fresh], WARNING_PRESSURE, root);
		assert.equal(deferred, undefined, "a mid-turn install is deferred, not installed");
		assert.notEqual(hook.state.staged(), undefined, "and the staged compaction is not lost");

		// The turn reaches a boundary, so the install happens - and the work that arrived while
		// it waited rides along after the summary instead of being swallowed by it.
		const answered = [assistant("I read it")];
		const installed = await contextPass(hook, [...base, fresh, ...answered], WARNING_PRESSURE, root);
		assert.deepEqual(
			installed.messages,
			[summary, fresh, ...answered],
			"the fresh messages follow the summary, not in place of it",
		);
		assert.equal(hook.state.staged(), undefined, "the deferred install is consumed once it lands");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a staged compaction over a replaced history is dropped, not installed", async () => {
	resetSettings();
	const hook = contextHook();
	const root = tempProject();
	const base = [user("one"), assistant("two")];
	const summary = summaryMessage();
	try {
		hook.state.cacheMessages(base);
		hook.state.stageCompacted([summary]);

		// Something else rebuilt the conversation: the summary describes a history that is gone,
		// and installing it would replace work it never saw. It is dropped.
		const replaced = [user("brand new start"), assistant("the new answer")];
		const result = await contextPass(hook, replaced, WARNING_PRESSURE, root);
		assert.equal(hook.state.staged(), undefined, "the stale staging is dropped");
		assert.deepEqual(
			result.messages.slice(0, replaced.length),
			replaced,
			"the conversation stands; only the warning is appended",
		);
		assert.equal(result.messages.at(-1).role, "system", "the pass carries on as a normal warning pass");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a compaction clears the warning flag", async () => {
	resetSettings();
	const hook = contextHook();
	const root = tempProject();
	const before = [user("one"), assistant("two")];
	const summary = summaryMessage();
	try {
		const first = await contextPass(hook, before, DEFAULT_WARN_TOKENS, root);
		assert.equal(first.messages.length, before.length + 1, "pressure warns before the compaction");

		// The last pass cached `before`, so that is the conversation the summary describes.
		hook.state.stageCompacted([summary]);
		const compacted = await contextPass(hook, before, DEFAULT_WARN_TOKENS, root);
		assert.deepEqual(compacted.messages, [summary], "the compaction is installed instead");

		// The flag cleared with the compaction, so pressure building again gets its own warning.
		const after = [summary, user("four"), assistant("five")];
		const second = await contextPass(hook, after, DEFAULT_WARN_TOKENS, root);
		assert.equal(second.messages.length, after.length + 1, "the next crossing warns again");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------- critical warning

await check("the critical threshold injects the urgent warning and spends no model call", async () => {
	resetSettings();
	const root = tempProject();
	const hook = directHook();
	const messages = [user("one"), assistant("two")];
	try {
		const { ctx, calls } = fakeCtx({ respond: () => OK });

		const below = await hook.pass(messages, DEFAULT_CRITICAL_TOKENS - 1, root, ctx);
		assert.equal(below.messages.length, messages.length + 1, "under the critical limit the regular warning fires");
		assert.match(below.messages.at(-1).content[0].text, /warning threshold/);

		const critical = await hook.pass(messages, DEFAULT_CRITICAL_TOKENS, root, ctx);
		assert.equal(calls.length, 0, "the hook never calls a model: it only warns");
		assert.equal(
			critical.messages.length,
			messages.length + 1,
			"the critical warning is appended, not substituted",
		);
		assert.deepEqual(critical.messages.slice(0, messages.length), messages, "the conversation is untouched");

		const warning = critical.messages.at(-1);
		assert.equal(warning.role, "system", "the critical warning must be a system message");
		assert.equal(typeof warning.timestamp, "number");
		assert.match(warning.content[0].text, /critically/i, "it says how bad it is");
		assert.ok(warning.content[0].text.includes(String(DEFAULT_CRITICAL_TOKENS)), "it states the tokens");
		assert.match(warning.content[0].text, /50%/, "and the share of the window in use");
		assert.match(warning.content[0].text, /press/, "it names press");
		assert.match(warning.content[0].text, /trim/, "and the cheap tool as well");
		assert.deepEqual(
			hook.press.cachedMessages(),
			messages,
			"our own warning is not cached, so press never summarizes it",
		);
	} finally {
		resetSettings();
		rmSync(root, { recursive: true, force: true });
	}
});

await check("both tools are named in the regular warning text", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	try {
		const result = await contextPass(hook, messages, DEFAULT_WARN_TOKENS, root);
		const text = result.messages.at(-1).content[0].text;
		assert.match(text, /press/, "the warning names press");
		assert.match(text, /trim/, "and trim, the tool that needs no model call");
		assert.match(text, /\[trimmed\]/, "saying what trim actually does to the conversation");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the critical warning is only injected at an assistant text turn boundary", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	try {
		const { ctx, calls } = fakeCtx({ respond: () => OK });

		const midTurn = [user("one"), assistantToolCall(), toolResult("read", "contents")];
		assert.equal(
			await contextPass(hook, midTurn, DEFAULT_CRITICAL_TOKENS, root, ctx),
			undefined,
			"a trailing tool result is mid-turn and must not be warned about",
		);
		assert.equal(
			await contextPass(hook, [user("one"), assistant("two"), assistantToolCall()], DEFAULT_CRITICAL_TOKENS, root, ctx),
			undefined,
			"an assistant turn that requests a tool must not be warned about either",
		);
		assert.equal(calls.length, 0, "a mid-turn limit spends no call");

		const boundary = [user("one"), assistant("two")];
		const warned = await contextPass(hook, boundary, DEFAULT_CRITICAL_TOKENS, root, ctx);
		assert.equal(warned.messages.length, boundary.length + 1, "the same pressure at a boundary does warn");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a session warned at the regular threshold still gets the critical warning", async () => {
	resetSettings();
	const hook = directHook();
	const root = tempProject();
	const messages = [user("one"), assistant("two")];
	try {
		const regular = await hook.pass(messages, DEFAULT_WARN_TOKENS, root);
		assert.equal(regular.messages.length, messages.length + 1, "the regular crossing warns");
		assert.ok(!/critically/i.test(regular.messages.at(-1).content[0].text));
		assert.equal(hook.state.warned, true);
		assert.equal(hook.state.criticallyWarned, false, "the regular crossing arms only its own flag");

		// The critical warning is a crossing of its own: being warned already does not suppress it.
		const critical = await hook.pass(messages, DEFAULT_CRITICAL_TOKENS, root);
		assert.equal(critical.messages.length, messages.length + 1, "the critical crossing warns anyway");
		assert.match(critical.messages.at(-1).content[0].text, /critically/i);
		assert.equal(hook.state.criticallyWarned, true);
		assert.equal(hook.state.warned, true, "the regular flag is left as it was");

		// Each warning is injected once: neither repeats while its flag is set.
		assert.equal(await hook.pass(messages, DEFAULT_CRITICAL_TOKENS, root), undefined);
		assert.equal(
			await hook.pass(messages, DEFAULT_CRITICAL_TOKENS + 1000, root),
			undefined,
			"raising pressure further does not re-inject the critical warning",
		);
	} finally {
		resetSettings();
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a critical crossing sends one message, not the regular warning as well", async () => {
	resetSettings();
	const root = tempProject();
	const hook = directHook();
	const messages = [user("one"), assistant("two")];
	try {
		const result = await hook.pass(messages, DEFAULT_CRITICAL_TOKENS, root);
		const injected = result.messages.slice(messages.length);
		assert.equal(injected.length, 1, "exactly one message is appended");
		assert.match(injected[0].content[0].text, /critically/i, "and it is the urgent one");
		assert.equal(hook.state.warned, false, "the regular flag stays untouched by a critical crossing");

		// A later pass back at the regular threshold still warns, since that flag was never armed.
		const lower = await hook.pass(messages, DEFAULT_WARN_TOKENS, root);
		assert.equal(lower.messages.length, messages.length + 1);
		assert.ok(!/critically/i.test(lower.messages.at(-1).content[0].text));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("an installed compaction clears both warning flags", async () => {
	resetSettings();
	const hook = directHook();
	const root = tempProject();
	const before = [user("one"), assistant("two")];
	const summary = summaryMessage();
	try {
		// Arm both flags: the regular crossing first, then the critical one.
		await hook.pass(before, DEFAULT_WARN_TOKENS, root);
		const critical = await hook.pass(before, DEFAULT_CRITICAL_TOKENS, root);
		assert.equal(critical.messages.length, before.length + 1, "the critical crossing warns");
		assert.equal(hook.state.warned, true);
		assert.equal(hook.state.criticallyWarned, true);

		// The last pass cached `before`, so that is the conversation the summary describes.
		hook.press.stageCompacted([summary]);
		const compacted = await hook.pass(before, DEFAULT_CRITICAL_TOKENS, root);
		assert.deepEqual(compacted.messages, [summary], "the compaction is installed instead");
		assert.equal(hook.state.warned, false, "the regular flag clears with the compaction");
		assert.equal(hook.state.criticallyWarned, false, "and so does the critical one");

		// Fresh headroom means fresh warnings allowed, at both thresholds.
		const after = [summary, user("four"), assistant("five")];
		const second = await hook.pass(after, DEFAULT_WARN_TOKENS, root);
		assert.equal(second.messages.length, after.length + 1, "the next regular crossing warns again");

		const fresh = [summary, user("four"), assistant("five"), user("six"), assistant("seven")];
		const third = await hook.pass(fresh, DEFAULT_CRITICAL_TOKENS, root);
		assert.match(third.messages.at(-1).content[0].text, /critically/i, "and the critical one too");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

rmSync(isolatedAgentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
