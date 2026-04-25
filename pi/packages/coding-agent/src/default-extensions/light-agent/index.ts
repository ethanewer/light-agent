import type { ExtensionAPI } from "../../core/extensions/types.js";
import { registerLmStudio } from "./lmstudio.js";
import { registerModes } from "./modes.js";
import { registerVisionRead } from "./vision-read.js";
import { registerVoice } from "./voice.js";
import { createWebFetchToolDefinition } from "./web-tools/webfetch.js";
import { createWebSearchToolDefinition } from "./web-tools/websearch.js";

/** Built-in fork defaults implemented via the extension runtime. */
export default async function lightAgentDefaults(pi: ExtensionAPI) {
	pi.registerTool({ ...createWebFetchToolDefinition(), defaultActive: false });
	pi.registerTool({ ...createWebSearchToolDefinition(), defaultActive: false });
	registerModes(pi);
	registerVisionRead(pi);
	registerVoice(pi);
	await registerLmStudio(pi);
}
