import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import extensionFactory from "./index.ts";
import {
	buildSnapshot,
	compactContext,
	DEFAULT_KEEP,
	failureText,
	NO_MESSAGES_NOTE,
	parsePressSummary,
	PressError,
	renderPressSummary,
	TOOL_RESULT_CHARS,
} from "./src/compact.ts";
import {
	DEFAULT_FORCE_TOKENS,
	DEFAULT_WARN_TOKENS,
	readPressSettings,
	SETTINGS_KEY,
} from "./src/config.ts";
import { registerContextHook } from "./src/context-hook.ts";
import { registerPressTool } from "./src/press-tool.ts";
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

const DEFAULTS = { warnTokens: DEFAULT_WARN_TOKENS, forceTokens: DEFAULT_FORCE_TOKENS };

// Pressure over the warning threshold but under the hard limit. Warning cases run here,
// because crossing forceTokens is the one thing that makes the warning not the response.
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
		["press"],
		"the press tool is the only tool registered",
	);
	assert.equal(typeof tools[0].execute, "function", "the tool is executable");
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
		assert.equal(DEFAULT_FORCE_TOKENS, 500000);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the press key is read from the object form, project scope winning", async () => {
	resetSettings();
	const root = tempProject();
	try {
		writeScope(root, "global", {
			[SETTINGS_KEY]: { model: "global/model", warnTokens: 100, forceTokens: 200 },
		});
		assert.deepEqual(readPressSettings(root), {
			model: "global/model",
			warnTokens: 100,
			forceTokens: 200,
		});

		writeScope(root, "project", {
			[SETTINGS_KEY]: { model: "project/model", warnTokens: 11, forceTokens: 22 },
		});
		assert.deepEqual(
			readPressSettings(root),
			{ model: "project/model", warnTokens: 11, forceTokens: 22 },
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
			[SETTINGS_KEY]: { model: "global/model", warnTokens: 100, forceTokens: 200 },
		});
		// A project that only lowers the force threshold must not lose the global model.
		writeScope(root, "project", { [SETTINGS_KEY]: { forceTokens: 300 } });
		assert.deepEqual(readPressSettings(root), {
			model: "global/model",
			warnTokens: 100,
			forceTokens: 300,
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
				forceTokens: -5,
			},
		});
		assert.deepEqual(readPressSettings(root), { model: "spaced/model", ...DEFAULTS });

		for (const junk of [null, 42, "provider/model", [], {}, { model: 7 }, { model: "" }, { model: "   " }]) {
			writeScope(root, "global", { [SETTINGS_KEY]: junk });
			const settings = readPressSettings(root);
			assert.deepEqual(
				{ warnTokens: settings.warnTokens, forceTokens: settings.forceTokens },
				DEFAULTS,
				`junk ${JSON.stringify(junk)} ignored`,
			);
			assert.equal(settings.model, undefined, `junk ${JSON.stringify(junk)} has no model`);
		}

		for (const bad of ["100", Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
			writeScope(root, "global", { [SETTINGS_KEY]: { warnTokens: bad, forceTokens: bad } });
			assert.deepEqual(
				{ warnTokens: readPressSettings(root).warnTokens, forceTokens: readPressSettings(root).forceTokens },
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
function summaryAnswer({ summary = "did the work", files = "src/a.ts", notes = "(none)" } = {}) {
	return [
		{
			type: "text",
			text: `<press-summary>\n## Summary\n${summary}\n## Files\n${files}\n## Notes\n${notes}\n</press-summary>`,
		},
	];
}

const OK = { stopReason: "stop", usage: {}, content: summaryAnswer() };
const SETTINGS = { warnTokens: DEFAULT_WARN_TOKENS, forceTokens: DEFAULT_FORCE_TOKENS };

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
	assert.ok(prompt.includes("keep the migration plan"), "the note reaches the prompt");
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
	const { ctx } = fakeCtx({ respond: () => ({ stopReason: "stop", content: summaryAnswer({ notes: "" }) }) });

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
		summary: "did the work",
		files: "src/a.ts",
		notes: "",
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

await check("parsePressSummary reads the three sections of a press-summary block", async () => {
	const answer = [
		"Here you go:",
		"<press-summary>",
		"## Summary",
		"Fixed the parser.",
		"",
		"## Files",
		"- src/compact.ts (edited)",
		"## Notes",
		"The user wants the note preserved.",
		"</press-summary>",
	].join("\n");

	assert.deepEqual(parsePressSummary(answer), {
		summary: "Fixed the parser.",
		files: "- src/compact.ts (edited)",
		notes: "The user wants the note preserved.",
	});

	// Headings vary: numbered, case-different, without the hashes, with a colon.
	assert.deepEqual(
		parsePressSummary("<press-summary>\nSUMMARY:\na\nfiles\nb\n### Notes\nc\n</press-summary>"),
		{ summary: "a", files: "b", notes: "c" },
	);

	// Prose without headings is still worth keeping, and empty sections are dropped.
	assert.deepEqual(parsePressSummary("plain prose"), {
		summary: "plain prose",
		files: "",
		notes: "",
	});
	assert.deepEqual(
		parsePressSummary("<press-summary>\n## Summary\nonly this\n## Files\n\n</press-summary>"),
		{ summary: "only this", files: "", notes: "" },
	);

	// Prose ahead of the first heading is the summary, not litter.
	assert.deepEqual(
		parsePressSummary("<press-summary>\nlead in\n## Files\na.ts\n</press-summary>"),
		{ summary: "lead in", files: "a.ts", notes: "" },
	);

	// A truncated answer still has a usable body after the opening tag.
	assert.deepEqual(parsePressSummary("<press-summary>\n## Summary\ncut off here"), {
		summary: "cut off here",
		files: "",
		notes: "",
	});

	// Rendering is the shape the parse reads back.
	const rendered = renderPressSummary({ summary: "s", files: "f", notes: "n" });
	assert.deepEqual(parsePressSummary(rendered), { summary: "s", files: "f", notes: "n" });
});

await check("a summary split across text blocks is parsed as one answer", async () => {
	// Providers return one text block per streamed segment; the sections straddle them.
	const { ctx, calls } = fakeCtx({
		respond: () => ({
			stopReason: "stop",
			usage: {},
			content: [
				{ type: "text", text: "<press-summary>\n## Summary\nhalf " },
				{ type: "thinking", thinking: "ignore me" },
				{ type: "text", text: "a summary\n## Notes\nthe note\n</press-summary>" },
			],
		}),
	});

	const result = await compactContext(ctx, [user("one"), assistant("two")], 1, "the note", SETTINGS);
	assert.equal(result.kind, "compacted");
	// Blocks are joined with a newline, the same separator pi's own summarizer uses, so
	// separate blocks never glue two words together. The caller's note then follows the block.
	assert.deepEqual(parsePressSummary(result.message.content[0].text), {
		summary: "half \na summary",
		files: "",
		notes: "the note",
	});
	assert.equal(
		result.message.content[0].text,
		"<press-summary>\n## Summary\nhalf \na summary\n\n## Notes\nthe note\n</press-summary>\n\nthe note",
	);
	assert.equal(calls.length, 1);
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
			calls[0].context.messages[0].content[0].text.includes("keep the migration plan"),
			"the note also reaches the compaction prompt, to steer what is preserved",
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
	return { tool: tools[0], handler: handlers[0].handler };
}

/** The hook's `ctx`: only context usage and a cwd are read from it. */
function hookCtx(tokens, cwd = tmpdir()) {
	return {
		cwd,
		getContextUsage: () =>
			tokens === undefined ? undefined : { tokens, contextWindow: 1_000_000, percent: 0.5 },
	};
}

/** A pass over `messages`, as pi's runner would emit it, for one registration's hook. */
function contextPass(registration, messages, tokens, cwd, extra) {
	return registration.handler({ type: "context", messages }, { ...hookCtx(tokens, cwd), ...extra });
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
			await contextPass(hook, afterToolResult, DEFAULT_FORCE_TOKENS, root),
			undefined,
			"a trailing tool result does not warn",
		);

		const awaitingTool = [user("one"), assistant("two"), assistantToolCall()];
		assert.equal(
			await contextPass(hook, awaitingTool, DEFAULT_FORCE_TOKENS, root),
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
	const result = await contextPass(hook, messages, DEFAULT_FORCE_TOKENS, tmpdir());
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

// ---------------------------------------------------- forced compaction

await check("the hard limit force-compacts and keeps the last message verbatim", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two"), user("three"), assistant("four")];
	try {
		const { ctx, calls } = fakeCtx({ respond: () => OK });

		const below = await contextPass(hook, messages, DEFAULT_FORCE_TOKENS - 1, root, ctx);
		assert.equal(calls.length, 0, "under the limit nothing is compacted");
		assert.equal(below.messages.length, messages.length + 1, "under the limit the warning still fires");

		const forced = await contextPass(hook, messages, DEFAULT_FORCE_TOKENS, root, ctx);
		assert.equal(calls.length, 1, "the limit spends one compaction call");
		assert.equal(forced.messages.length, 2, "the conversation collapses to the summary and the tail");
		assert.match(forced.messages[0].content[0].text, /^<press-summary>/, "the summary leads");
		assert.deepEqual(forced.messages[1], messages.at(-1), "the last message survives verbatim");

		// The note is appended to the summary itself, so it survives a model that answered with
		// no Notes section at all - which is what the fixture does.
		const text = forced.messages[0].content[0].text;
		assert.ok(
			text.endsWith("Context was force-compacted due to token limit"),
			`the note is guaranteed to reach the model, got: ${text}`,
		);
		assert.equal(parsePressSummary(text).notes, "(none)", "the block is unchanged by the appended note");

		assert.ok(
			calls[0].context.messages[0].content[0].text.includes("Context was force-compacted due to token limit"),
			"the prompt carries the forced-compaction note too",
		);
	} finally {
		resetSettings();
		rmSync(root, { recursive: true, force: true });
	}
});

await check("the hard limit is only acted on at an assistant text turn boundary", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	try {
		const { ctx, calls } = fakeCtx({ respond: () => OK });

		const midTurn = [user("one"), assistantToolCall(), toolResult("read", "contents")];
		assert.equal(
			await contextPass(hook, midTurn, DEFAULT_FORCE_TOKENS, root, ctx),
			undefined,
			"a trailing tool result is mid-turn and must not be compacted",
		);
		assert.equal(
			await contextPass(hook, [user("one"), assistant("two"), assistantToolCall()], DEFAULT_FORCE_TOKENS, root, ctx),
			undefined,
			"an assistant turn that requests a tool must not be compacted",
		);
		assert.equal(calls.length, 0, "a mid-turn limit spends no compaction call");

		const boundary = [user("one"), assistant("two")];
		const forced = await contextPass(hook, boundary, DEFAULT_FORCE_TOKENS, root, ctx);
		assert.equal(forced.messages.length, 2, "the same pressure at a boundary does compact");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a failed forced compaction returns the conversation plus one error note", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	try {
		const provider = fakeCtx({
			respond: () => ({ stopReason: "error", errorMessage: "provider exploded", content: [] }),
		});

		const failed = await contextPass(hook, messages, DEFAULT_FORCE_TOKENS, root, provider.ctx);
		assert.equal(failed.messages.length, messages.length + 1, "the conversation is handed back untouched");
		assert.deepEqual(failed.messages.slice(0, messages.length), messages, "not one message is lost");
		const note = failed.messages.at(-1);
		assert.equal(note.role, "system", "the failure is reported as a system note");
		assert.match(note.content[0].text, /provider exploded/, "it names the provider's reason");
		assert.match(note.content[0].text, /did not happen/, "and says the compaction did not happen");
		assert.equal(provider.calls.length, 1, "the failed call is not retried inside the pass");

		// A caller that throws is reported the same way, and still no loop.
		const throwing = fakeCtx({
			respond: () => {
				throw new Error("socket closed");
			},
		});
		const thrown = await contextPass(hook, messages, DEFAULT_FORCE_TOKENS, root, throwing.ctx);
		assert.equal(thrown.messages.length, messages.length + 1);
		assert.match(thrown.messages.at(-1).content[0].text, /socket closed/);
		assert.equal(throwing.calls.length, 1, "a throwing client is called once per pass, never in a loop");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a forced compaction clears the warning instead of warning about it", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	try {
		const { ctx } = fakeCtx({ respond: () => OK });

		// Warn first, so the flag is set when the hard limit is reached.
		const warned = await contextPass(hook, messages, DEFAULT_WARN_TOKENS, root, ctx);
		assert.equal(warned.messages.length, messages.length + 1, "the crossing warns");

		const forced = await contextPass(hook, messages, DEFAULT_FORCE_TOKENS, root, ctx);
		assert.equal(forced.messages.length, 2, "the force pass replaces the conversation");
		assert.ok(
			!forced.messages.some((message) => message.role === "system"),
			"no warning is injected alongside the compaction that relieved it",
		);

		// The flag cleared with the compaction, so pressure building again warns afresh.
		const after = [forced.messages[0], user("four"), assistant("five")];
		const second = await contextPass(hook, after, DEFAULT_WARN_TOKENS, root, ctx);
		assert.equal(second.messages.length, after.length + 1, "the next crossing warns again");
	} finally {
		resetSettings();
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a skipped forced compaction resets nothing", async () => {
	resetSettings();
	const root = tempProject();
	const hook = contextHook();
	const messages = [user("one"), assistant("two")];
	try {
		const { ctx, calls } = fakeCtx({ respond: () => OK });
		writeScope(root, "project", { [SETTINGS_KEY]: { warnTokens: 10, forceTokens: 20 } });

		const warned = await contextPass(hook, messages, 15, root, ctx);
		assert.equal(warned.messages.length, 3, "the crossing warns and sets the flag");

		// One message with keep 1 leaves nothing to compact, so the engine reports skipped.
		const skipped = await contextPass(hook, [user("three")], 25, root, ctx);
		assert.equal(skipped, undefined, "a skipped compaction rewrites nothing");
		assert.equal(calls.length, 0, "the engine returns before spending a call");

		// The flag survived the skipped pass: pressure that was already warned about stays silent.
		const again = await contextPass(hook, messages, 15, root, ctx);
		assert.equal(again, undefined, "no warning is re-injected after a skipped force pass");
	} finally {
		resetSettings();
		rmSync(root, { recursive: true, force: true });
	}
});

rmSync(isolatedAgentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
