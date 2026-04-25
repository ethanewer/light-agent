import type { ExtensionAPI } from "../../core/extensions/types.js";

interface AgentMode {
	name: string;
	tools: readonly string[] | null;
	systemPrompt: string | null;
}

const GENERAL_TOOLS = ["read", "bash", "edit", "write"] as const;
const SEARCH_TOOLS = ["webfetch", "websearch"] as const;

const AGENT_MODES: readonly AgentMode[] = [
	{ name: "general", tools: null, systemPrompt: null },
	{ name: "general+search", tools: [...GENERAL_TOOLS, ...SEARCH_TOOLS], systemPrompt: null },
	{ name: "chat", tools: [], systemPrompt: "You are a helpful assistant." },
	{ name: "chat+search", tools: [...SEARCH_TOOLS], systemPrompt: "You are a helpful assistant." },
];

function nextAgentMode(currentName: string): AgentMode {
	const idx = AGENT_MODES.findIndex((mode) => mode.name === currentName);
	return AGENT_MODES[idx < 0 ? 0 : (idx + 1) % AGENT_MODES.length]!;
}

export function registerModes(pi: ExtensionAPI): void {
	let currentModeName = AGENT_MODES[0]?.name ?? "general";
	let defaultToolNames: string[] | undefined;

	function resetModeState(): void {
		currentModeName = AGENT_MODES[0]?.name ?? "general";
		defaultToolNames = undefined;
	}

	function applyMode(mode: AgentMode, notify?: (message: string) => void): void {
		if (defaultToolNames === undefined) {
			defaultToolNames = pi.getActiveTools();
		}
		const toolNames = mode.tools === null ? defaultToolNames : [...mode.tools];
		pi.setActiveTools(toolNames);
		currentModeName = mode.name;
		notify?.(`Switched to ${mode.name} mode`);
	}

	pi.on("session_start", (_event, ctx) => {
		resetModeState();
		ctx.ui.addEditorInputHandler((event) => {
			if (AGENT_MODES.length < 2) return undefined;
			if (!event.keybindings.matches(event.data, "tui.input.tab")) return undefined;
			if (event.editor.getText().length !== 0) return undefined;
			applyMode(nextAgentMode(currentModeName), (message) => ctx.ui.notify(message, "info"));
			event.requestRender();
			return true;
		});
	});

	pi.on("before_agent_start", (_event) => {
		const mode = AGENT_MODES.find((candidate) => candidate.name === currentModeName);
		if (!mode?.systemPrompt) return undefined;
		return { systemPrompt: mode.systemPrompt };
	});
}
