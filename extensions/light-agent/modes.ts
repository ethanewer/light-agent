import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

export interface AgentMode {
	name: string;
	tools: readonly string[] | null;
	systemPrompt: string | null;
}

const SEARCH_TOOLS = ["webfetch", "websearch"] as const;
const SEARCH_TOOL_SET = new Set<string>(SEARCH_TOOLS);
const CHAT_PROMPT = "You are a helpful assistant.";

export const AGENT_MODES: readonly AgentMode[] = [
	{ name: "general", tools: null, systemPrompt: null },
	{ name: "general+search", tools: SEARCH_TOOLS, systemPrompt: null },
	{ name: "chat", tools: [], systemPrompt: CHAT_PROMPT },
	{ name: "chat+search", tools: SEARCH_TOOLS, systemPrompt: CHAT_PROMPT },
];

interface ModeState {
	mode: string;
}

function findMode(name: string): AgentMode | undefined {
	return AGENT_MODES.find((mode) => mode.name === name);
}

export function getNextModeName(currentName: string): string {
	const index = AGENT_MODES.findIndex((mode) => mode.name === currentName);
	if (index < 0) return "general";
	return AGENT_MODES[(index < 0 ? 0 : index + 1) % AGENT_MODES.length]?.name ?? "general";
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

	function persistMode(): void {
		pi.appendEntry<ModeState>("light-agent-mode", { mode: activeModeName });
	}

	function applyMode(mode: AgentMode, persist: boolean, ctx?: ExtensionContext): void {
		captureBaseline();
		const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
		const nextTools =
			mode.tools === null
				? baselineTools ?? pi.getActiveTools()
				: mode.name === "general+search"
					? [...(baselineTools ?? []), ...SEARCH_TOOLS]
					: [...mode.tools];
		pi.setActiveTools([...new Set(nextTools)].filter((tool) => allToolNames.has(tool)));
		activeModeName = mode.name;
		if (persist) persistMode();
		ctx?.ui.setStatus("light-agent-mode", mode.name === "general" ? undefined : mode.name);
	}

	async function selectMode(args: string, ctx: ExtensionContext): Promise<void> {
		const requested = args.trim();
		const selected =
			requested ||
			(await ctx.ui.select(
				"Select mode",
				AGENT_MODES.map((mode) => mode.name),
			));
		if (!selected) return;
		const mode = findMode(selected);
		if (!mode) {
			ctx.ui.notify(`Unknown mode: ${selected}. Available: ${AGENT_MODES.map((item) => item.name).join(", ")}`, "warning");
			return;
		}
		applyMode(mode, true, ctx);
		ctx.ui.notify(`Switched to ${mode.name} mode`, "info");
	}

	pi.registerCommand("mode", {
		description: "Select light-agent mode",
		getArgumentCompletions(prefix) {
			const normalized = prefix.trim().toLowerCase();
			return AGENT_MODES.filter((mode) => mode.name.startsWith(normalized)).map((mode) => ({
				value: mode.name,
				label: mode.name,
			}));
		},
		handler: async (args, ctx) => selectMode(args, ctx),
	});

	pi.registerShortcut(Key.ctrlShift("m"), {
		description: "Cycle light-agent mode",
		handler: async (ctx) => {
			const nextMode = findMode(getNextModeName(activeModeName));
			if (!nextMode) return;
			applyMode(nextMode, true, ctx);
			ctx.ui.notify(`Switched to ${nextMode.name} mode`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		captureBaseline();
		const restored = getLastModeState(ctx);
		const mode = restored ? findMode(restored.mode) : findMode("general");
		if (mode) applyMode(mode, false, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		const restored = getLastModeState(ctx);
		const mode = restored ? findMode(restored.mode) : findMode("general");
		if (mode) applyMode(mode, false, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const mode = findMode(activeModeName);
		if (!mode?.systemPrompt) return;
		return { systemPrompt: mode.systemPrompt };
	});
}
