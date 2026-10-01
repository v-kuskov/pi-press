import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import extensionFactory from "./index.ts";
import {
	buildSnapshot,
	compactContext,
	DEFAULT_KEEP,
	NO_MESSAGES_NOTE,
	parsePressSummary,
	renderPressSummary,
	TOOL_RESULT_CHARS,
} from "./src/compact.ts";
import {
	DEFAULT_FORCE_TOKENS,
	DEFAULT_WARN_TOKENS,
	readPressSettings,
	SETTINGS_KEY,
} from "./src/config.ts";
import {
	cacheMessages,
	stagedCompactedContext,
	takeStagedCompactedContext,
} from "./src/state.ts";

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

// ------------------------------------------------------------------ factory

await check("the factory registers the press tool synchronously", async () => {
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
	assert.deepEqual(handlers, [], "no hook is registered until ticket 04");
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["press"],
		"the press tool is the only tool registered",
	);
	assert.equal(typeof tools[0].execute, "function", "the tool is executable");
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
	assert.equal(result.summary.summary, "did the work", "the parsed sections come back for details");
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

await check("a provider error surfaces its stop reason, and a throw is reported too", async () => {
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
	assert.equal(error.stopReason, "error", "the stop reason rides on the error");
	assert.equal(error.providerMessage, "rate limited");
	assert.match(error.message, /rate limited/);

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
	// separate blocks never glue two words together.
	assert.equal(result.summary.summary, "half \na summary", "the adjacent blocks join");
	assert.equal(result.summary.notes, "the note");
	assert.equal(
		result.message.content[0].text,
		"<press-summary>\n## Summary\nhalf \na summary\n\n## Notes\nthe note\n</press-summary>",
	);
	assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- press tool

/** The definition the extension hands to pi, captured through a fake registry. */
function pressTool() {
	const tools = [];
	extensionFactory({ registerTool: (definition) => tools.push(definition), on: () => {} });
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

await check("press compacts the cached messages and hands the model the summary", async () => {
	resetSettings();
	const root = tempProject();
	try {
		const compactionModel = { provider: "routerai", id: "compactor" };
		const { ctx, calls } = fakeCtx({
			respond: () => OK,
			known: { "routerai/compactor": compactionModel },
		});
		writeScope(root, "project", { [SETTINGS_KEY]: { model: "routerai/compactor" } });

		const messages = [user("one"), assistant("two"), user("three")];
		cacheMessages(messages);

		const result = await pressTool().execute(
			"call-1",
			{ note: "keep the migration plan", keep: 1 },
			undefined,
			undefined,
			toolCtx({ ctx }, root),
		);

		assert.notEqual(result.isError, true, "a successful press is not an error result");
		assert.match(result.content[0].text, /^<press-summary>/, "the model sees the summary block");
		assert.match(result.content[0].text, /did the work/);
		assert.equal(result.details.status, "compacted");
		assert.equal(result.details.compacted, 2);
		assert.equal(result.details.kept, 1);
		assert.equal(calls.length, 1, "one summary call is spent");
		assert.ok(
			calls[0].context.messages[0].content[0].text.includes("keep the migration plan"),
			"the note reaches the compaction prompt",
		);

		// The handoff tickets 04/05 consume: the summary message, then the untouched tail.
		const staged = takeStagedCompactedContext();
		assert.equal(staged.length, 2);
		assert.equal(staged[0].content[0].text, result.content[0].text, "the staged block is what the model saw");
		assert.deepEqual(staged[1], messages[2], "the kept message is unstaged verbatim");
		assert.equal(stagedCompactedContext(), undefined, "the staged context is held, not read twice");
		assert.equal(takeStagedCompactedContext(), undefined, "taking the staged context once is enough");
	} finally {
		cacheMessages([]);
		rmSync(root, { recursive: true, force: true });
	}
});

await check("press reports an error when nothing has been cached yet", async () => {
	cacheMessages([]);
	const { ctx, calls } = fakeCtx({ respond: () => OK });

	const result = await pressTool().execute("call-2", {}, undefined, undefined, toolCtx({ ctx }, tmpdir()));

	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, NO_MESSAGES_NOTE);
	assert.equal(result.details.status, "error");
	assert.equal(calls.length, 0, "an empty cache spends no model call");
	assert.equal(takeStagedCompactedContext(), undefined);
});

await check("press reports a context that is already small without spending a call", async () => {
	resetSettings();
	const root = tempProject();
	try {
		cacheMessages([user("one"), assistant("two")]);
		const { ctx, calls } = fakeCtx({ respond: () => OK });

		const result = await pressTool().execute(
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
		assert.equal(takeStagedCompactedContext(), undefined, "nothing is staged for the context hook");
	} finally {
		cacheMessages([]);
		rmSync(root, { recursive: true, force: true });
	}
});

await check("a compaction model failure reaches the model as an error result", async () => {
	resetSettings();
	const root = tempProject();
	try {
		cacheMessages([user("one"), assistant("two")]);

		const provider = fakeCtx({
			respond: () => ({ stopReason: "error", errorMessage: "provider exploded", content: [] }),
		});
		const failed = await pressTool().execute(
			"call-4",
			{},
			undefined,
			undefined,
			toolCtx(provider, root),
		);
		assert.equal(failed.isError, true);
		assert.match(failed.content[0].text, /Compaction failed: provider exploded/);
		assert.equal(failed.details.status, "error");
		assert.equal(takeStagedCompactedContext(), undefined, "a failed press stages nothing");

		// A provider client that throws is reported the same way rather than escaping.
		const throwing = fakeCtx({
			respond: () => {
				throw new Error("socket closed");
			},
		});
		const thrown = await pressTool().execute(
			"call-5",
			{},
			undefined,
			undefined,
			toolCtx(throwing, root),
		);
		assert.equal(thrown.isError, true);
		assert.match(thrown.content[0].text, /Compaction failed: socket closed/);
	} finally {
		cacheMessages([]);
		rmSync(root, { recursive: true, force: true });
	}
});

rmSync(isolatedAgentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
