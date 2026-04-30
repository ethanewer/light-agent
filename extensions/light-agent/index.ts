import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerLmStudio } from "./lmstudio.js";
import { registerModes } from "./modes.js";
import { registerWebTools } from "./web-tools.js";

export function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export default async function lightAgentExtension(pi: ExtensionAPI): Promise<void> {
	registerWebTools(pi);
	registerModes(pi);
	if (isOfflineModeEnabled()) return;
	await registerLmStudio(pi);
}
