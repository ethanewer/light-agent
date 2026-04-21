/**
 * Agent modes: declarative personas for the assistant.
 *
 * Each mode specifies an optional tool set and an optional system prompt
 * override. A mode with `tools: null` keeps the session's default tool set;
 * a mode with `systemPrompt: null` keeps the normally-built system prompt
 * (with tool snippets, guidelines, skills, project context, etc.).
 *
 * Used by the interactive mode to let users cycle agent personas with Tab
 * on an empty editor. Adding new modes only requires appending to
 * `AGENT_MODES` — no other code changes are needed.
 */

export interface AgentMode {
	/** Short display name shown in status messages. */
	name: string;
	/** Tool names to enable, or `null` to use the session's default tool set. */
	tools: readonly string[] | null;
	/** System prompt override, or `null` to use the normally-built prompt. */
	systemPrompt: string | null;
}

/** Available agent modes, cycled in the order declared here. */
export const AGENT_MODES: readonly AgentMode[] = [
	{
		name: "general",
		tools: null,
		systemPrompt: null,
	},
	{
		name: "chat",
		tools: [],
		systemPrompt: "You are a helpful assistant.",
	},
];

/** Return the next mode after `currentName`, wrapping around. */
export function nextAgentMode(currentName: string): AgentMode {
	const idx = AGENT_MODES.findIndex((m) => m.name === currentName);
	const nextIdx = idx < 0 ? 0 : (idx + 1) % AGENT_MODES.length;
	// AGENT_MODES is non-empty by construction.
	return AGENT_MODES[nextIdx] as AgentMode;
}
