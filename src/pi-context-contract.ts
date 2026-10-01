import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { CompactionContext } from "./compact.ts";

/**
 * Compile-time check that a real pi context satisfies the engine's context type.
 *
 * The compaction engine declares its own narrow `CompactionContext` instead of importing
 * pi's, so that the tool executor (ticket 03), the context hooks (tickets 04/05) and
 * smoke.mjs can all drive it without constructing a full pi context. That decoupling is
 * only safe while the real thing still fits: this file makes `tsc --noEmit` fail the moment
 * the two drift apart, which the runtime tests in smoke.mjs cannot catch.
 *
 * Both shapes are checked: a tool executor receives an `ExtensionToolContext`, an event
 * handler receives an `ExtensionContext`.
 */
declare const extensionContext: ExtensionContext;
declare const toolContext: ExtensionToolContext;

const fromHandler: CompactionContext = extensionContext;
const fromTool: CompactionContext = toolContext;
void fromHandler;
void fromTool;
