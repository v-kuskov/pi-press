import { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Settings key that holds this extension's own configuration.
 *
 * pi's `Settings` interface has no field for extension config, but the settings file is
 * not filtered: unknown top-level keys survive a load. pi-summary relies on the same
 * behaviour for its `summary` key.
 */
export const SETTINGS_KEY = "press";

/** Context tokens at or above which the model is warned that it should press. */
export const DEFAULT_WARN_TOKENS = 260000;

/** Context tokens at or above which a critical warning is injected. */
export const DEFAULT_CRITICAL_TOKENS = 500000;

/** Extracted form of the `press` settings key, with every field resolved. */
export type PressSettings = {
	/** Compaction model as `provider/id`. Absent means "use the session model". */
	model?: string;
	warnTokens: number;
	/** Context tokens at or above which a critical warning is injected. */
	criticalTokens: number;
};

/** The value of one configured field, or undefined when it was absent or unusable. */
type PartialPressSettings = {
	model?: string;
	warnTokens?: number;
	criticalTokens?: number;
};

/**
 * Read the `press` key from pi's settings, project scope winning field by field.
 *
 * Field-by-field precedence keeps a project override narrow: setting `press.criticalTokens`
 * in a project must not discard the `press.model` the user configured globally.
 *
 * A malformed or unreadable config is reported as "not configured" rather than thrown,
 * because every field has a working default - the session model, and the two warning
 * thresholds.
 */
export function readPressSettings(cwd: string): PressSettings {
	let settings: SettingsManager;
	try {
		settings = SettingsManager.create(cwd);
	} catch {
		return defaults();
	}

	// Project scope is read first so a project can pin any subset of the three fields.
	const project = normalizePressValue(readScope(settings, "project"));
	const global = normalizePressValue(readScope(settings, "global"));
	const model = project.model ?? global.model;
	return {
		// Omitted rather than set to undefined, so a caller can test for the key itself.
		...(model === undefined ? {} : { model }),
		warnTokens: project.warnTokens ?? global.warnTokens ?? DEFAULT_WARN_TOKENS,
		criticalTokens: project.criticalTokens ?? global.criticalTokens ?? DEFAULT_CRITICAL_TOKENS,
	};
}

/** Defaults for every field, the configuration used when nothing usable is configured. */
function defaults(): PressSettings {
	return { warnTokens: DEFAULT_WARN_TOKENS, criticalTokens: DEFAULT_CRITICAL_TOKENS };
}

/**
 * One settings scope's `press` value.
 *
 * A scope that cannot be read is treated as absent, so a broken project file still lets a
 * valid global one through.
 */
function readScope(settings: SettingsManager, scope: "project" | "global"): unknown {
	try {
		const scoped = scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
		return (scoped as unknown as Record<string, unknown>)[SETTINGS_KEY];
	} catch {
		return undefined;
	}
}

/** Normalize one `press` value, ignoring anything unusable and defaulting nothing. */
function normalizePressValue(raw: unknown): PartialPressSettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const out: PartialPressSettings = {};

	const model = source.model;
	if (typeof model === "string" && model.trim().length > 0) out.model = model.trim();

	const warnTokens = tokenCount(source.warnTokens);
	if (warnTokens !== undefined) out.warnTokens = warnTokens;

	const criticalTokens = tokenCount(source.criticalTokens);
	if (criticalTokens !== undefined) out.criticalTokens = criticalTokens;

	return out;
}

/** A token threshold is a positive whole number; anything else is not one. */
function tokenCount(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
	const whole = Math.floor(raw);
	return whole > 0 ? whole : undefined;
}
