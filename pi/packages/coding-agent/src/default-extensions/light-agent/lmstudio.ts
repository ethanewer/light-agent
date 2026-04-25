import type { ExtensionAPI } from "../../core/extensions/types.js";
import { discoverLmStudioModels, LM_STUDIO_PROVIDER } from "./lmstudio-discovery.js";

export async function registerLmStudio(pi: ExtensionAPI): Promise<void> {
	const models = await discoverLmStudioModels();
	if (models.length === 0) return;
	const baseUrl = models[0]?.baseUrl;
	if (!baseUrl) return;
	pi.registerProvider(LM_STUDIO_PROVIDER, {
		baseUrl,
		apiKey: LM_STUDIO_PROVIDER,
		api: "openai-completions",
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			headers: model.headers,
			compat: model.compat,
		})),
	});
}
