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

/**
 * Default tools for "general"-flavored modes. Kept in sync with
 * `AgentSession._buildRuntime`'s built-in default active tool names so that
 * "general + search" extends the default set without hard-coding divergent
 * behavior here. If the session's default ever changes, update this list too.
 */
const GENERAL_TOOLS = ["read", "bash", "edit", "write"] as const;
const SEARCH_TOOLS = ["webfetch", "websearch"] as const;
const SANDBOX_TOOLS = ["bash_sandbox"] as const;

/**
 * System prompt for the sandbox modes. The sandbox is backed by `just-bash`:
 * an in-process virtual bash with an in-memory filesystem that cannot touch
 * the host machine. Only the truly unintuitive bits are spelled out here;
 * the tool description covers the rest.
 */
const SANDBOX_SYSTEM_PROMPT =
	"You are running in an isolated in-memory sandbox that cannot affect the host machine. " +
	"Use the bash_sandbox tool freely to run commands, write files, and analyze data. Its " +
	"filesystem starts empty and persists across calls within this session. Beyond the " +
	"standard Unix utilities, bash_sandbox provides python3 with the Python standard library; " +
	"heavy third-party packages (numpy, pandas, torch, scikit-learn, matplotlib, etc.) are not " +
	"installed and cannot be installed. The sandbox itself has no network access.";

const SANDBOX_SEARCH_SYSTEM_PROMPT = `${SANDBOX_SYSTEM_PROMPT} Use websearch and webfetch to look up information from the web.`;

/** Available agent modes, cycled in the order declared here. */
export const AGENT_MODES: readonly AgentMode[] = [
	{
		name: "general",
		tools: null,
		systemPrompt: null,
	},
	{
		name: "general+search",
		tools: [...GENERAL_TOOLS, ...SEARCH_TOOLS],
		systemPrompt: null,
	},
	{
		name: "chat",
		tools: [],
		systemPrompt: "You are a helpful assistant.",
	},
	{
		name: "chat+search",
		tools: [...SEARCH_TOOLS],
		systemPrompt: "You are a helpful assistant.",
	},
	{
		name: "sandbox",
		tools: [...SANDBOX_TOOLS],
		systemPrompt: SANDBOX_SYSTEM_PROMPT,
	},
	{
		name: "sandbox+search",
		tools: [...SANDBOX_TOOLS, ...SEARCH_TOOLS],
		systemPrompt: SANDBOX_SEARCH_SYSTEM_PROMPT,
	},
];

/** Return the next mode after `currentName`, wrapping around. */
export function nextAgentMode(currentName: string): AgentMode {
	const idx = AGENT_MODES.findIndex((m) => m.name === currentName);
	const nextIdx = idx < 0 ? 0 : (idx + 1) % AGENT_MODES.length;
	// AGENT_MODES is non-empty by construction.
	return AGENT_MODES[nextIdx] as AgentMode;
}
