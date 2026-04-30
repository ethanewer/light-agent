import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface AgentMode {
	name: string;
	includeBaseline: boolean;
	extraTools: readonly string[];
	systemPrompt: string | null;
}

const SEARCH_TOOLS = ["webfetch", "websearch"] as const;
const SEARCH_TOOL_SET = new Set<string>(SEARCH_TOOLS);
const CHAT_PROMPT = "You are a helpful assistant.";

export const AGENT_MODES: readonly AgentMode[] = [
	{ name: "general", includeBaseline: true, extraTools: [], systemPrompt: null },
	{ name: "general+search", includeBaseline: true, extraTools: SEARCH_TOOLS, systemPrompt: null },
	{ name: "chat+search", includeBaseline: false, extraTools: SEARCH_TOOLS, systemPrompt: CHAT_PROMPT },
];

interface ModeState {
	mode: string;
}

function findMode(name: string): AgentMode | undefined {
	return AGENT_MODES.find((mode) => mode.name === name);
}

function getLastModeState(ctx: ExtensionContext): ModeState | undefined {
	for (const entry of ctx.sessionManager.getBranch().slice().reverse()) {
		if (entry.type !== "custom" || entry.customType !== "light-agent-mode") continue;
		const data = entry.data;
		if (typeof data === "object" && data !== null && "mode" in data && typeof data.mode === "string") {
			return { mode: data.mode };
		}
	}
	return undefined;
}

export function registerModes(pi: ExtensionAPI): void {
	let activeModeName = "general";
	let baselineTools: string[] | undefined;

	function captureBaseline(): void {
		if (baselineTools === undefined) baselineTools = pi.getActiveTools().filter((tool) => !SEARCH_TOOL_SET.has(tool));
	}

	function applyMode(mode: AgentMode, persist: boolean, ctx?: ExtensionContext): void {
		captureBaseline();
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const baseline = mode.includeBaseline ? baselineTools ?? [] : [];
		const nextTools = [...new Set([...baseline, ...mode.extraTools])].filter((tool) => allToolNames.has(tool));
		pi.setActiveTools(nextTools);
		activeModeName = mode.name;
		if (persist) pi.appendEntry<ModeState>("light-agent-mode", { mode: activeModeName });
		ctx?.ui.setStatus("light-agent-mode", mode.name === "general" ? undefined : mode.name);
	}

	function toggleMode(targetName: string, ctx: ExtensionContext): void {
		const target = findMode(targetName);
		const general = findMode("general");
		if (!target || !general) return;
		const next = activeModeName === targetName ? general : target;
		applyMode(next, true, ctx);
		ctx.ui.notify(`Switched to ${next.name} mode`, "info");
	}

	pi.registerCommand("search", {
		description: "Toggle web search tools (general+search mode)",
		handler: async (_args, ctx) => toggleMode("general+search", ctx),
	});

	pi.registerCommand("chat", {
		description: "Toggle chat mode with web search (chat+search)",
		handler: async (_args, ctx) => toggleMode("chat+search", ctx),
	});

	function restoreMode(ctx: ExtensionContext): void {
		captureBaseline();
		const restored = getLastModeState(ctx);
		const mode = (restored && findMode(restored.mode)) ?? findMode("general");
		if (mode) applyMode(mode, false, ctx);
	}

	pi.on("session_start", async (_event, ctx) => restoreMode(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreMode(ctx));

	pi.on("before_agent_start", async () => {
		const mode = findMode(activeModeName);
		if (!mode?.systemPrompt) return;
		return { systemPrompt: mode.systemPrompt };
	});
}
