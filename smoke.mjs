import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import extensionFactory from "./index.ts";
import {
	DEFAULT_FORCE_TOKENS,
	DEFAULT_WARN_TOKENS,
	readPressSettings,
	SETTINGS_KEY,
} from "./src/config.ts";

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

await check("the factory registers nothing and starts nothing yet", async () => {
	const tools = [];
	const handlers = [];
	const factory = extensionFactory;

	// A factory that returned a promise, spawned a timer, or opened a handle would keep the
	// event loop busy after load; the load path in pi must stay synchronous.
	const result = factory({
		registerTool: (def) => tools.push(def.name),
		on: (event) => handlers.push(event),
	});

	assert.equal(result, undefined, "the factory is synchronous");
	assert.deepEqual(tools, [], "no tool is registered in ticket 01");
	assert.deepEqual(handlers, [], "no hook is registered in ticket 01");
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

rmSync(isolatedAgentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
