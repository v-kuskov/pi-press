# pi-press

A pi Coding Agent extension that lets the model compact its own conversation context. Two tools do the work: `press` turns the conversation into a structured summary through one LLM call, and `trim` reclaims the tokens sitting in old tool results for free. Token-pressure warnings nudge the model before the window fills, so long sessions keep running without losing critical information.

## Tools

### `press`

Compacts the conversation into a `<press-summary>` block and keeps the last messages verbatim.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `note` | string | — | What matters most; appended verbatim after the summary, outside the summarizing model's control |
| `keep` | integer | 1 | Messages from the end of the conversation to keep verbatim |

The summary has five sections — Task Overview, Current State, Discoveries, Next Steps, Context to Preserve — with empty sections dropped. Files named by tool calls during the run are listed under Context to Preserve. If an earlier `press` or `trim` anchor exists, the model merges into it instead of starting over.

Uses one model call: the configured compaction model if set, otherwise the session model. A configured but unavailable model is reported as an error rather than silently falling back.

### `trim`

Replaces old tool results with `[trimmed]` placeholders. No model call. Every message survives, so tool-call chains stay intact, and a `<press-trim>` anchor records what was trimmed and which files the run touched. A later `press` sees the anchor and only summarizes what is new.

Same `note` and `keep` parameters as `press`; the note is recorded in the anchor.

## Token pressure

At each turn boundary the extension checks context usage and injects one warning per threshold crossing, naming both tools and their parameters:

- `warnTokens` (default 260000) — a nudge to compact
- `criticalTokens` (default 500000) — an urgent warning with usage percent

Warnings reset after any compaction, so renewed pressure gets a fresh warning.

## Configuration

The extension reads the `press` key from pi's settings files. Project scope (`.pi/settings.json`) overrides global scope (`<agentDir>/settings.json`) field by field.

```json
{
  "press": {
    "model": "provider/model-id",
    "warnTokens": 260000,
    "criticalTokens": 500000
  }
}
```

All fields are optional. Invalid values are ignored and defaults apply. Settings are read on every use, so mid-session edits take effect immediately.

## Install

Load the directory as an extension:

```sh
pi -e path/to/pi-press
```

## Development

Node.js 24 or newer. The extension is loaded directly from TypeScript by jiti — no build step.

```sh
npm run check      # typecheck + smoke test
npm test           # smoke test (smoke.mjs, fake model registry)
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
