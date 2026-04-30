import type { Api, Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

export const LM_STUDIO_PROVIDER = "lmstudio";
export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DISCOVERY_TIMEOUT_MS = 500;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

const LM_STUDIO_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} satisfies OpenAICompletionsCompat;

export interface LmStudioDiscoveryOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

interface LmStudioModelsPayload {
	data?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function getNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function getStringArrayField(record: Record<string, unknown>, keys: string[]): string[] {
	for (const key of keys) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
		if (items.length > 0) return items;
	}
	return [];
}

export function normalizeLmStudioBaseUrl(baseUrl?: string): string {
	const raw =
		baseUrl?.trim() ||
		process.env.LMSTUDIO_BASE_URL?.trim() ||
		process.env.LM_STUDIO_BASE_URL?.trim() ||
		LM_STUDIO_DEFAULT_BASE_URL;

	let normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/models")) normalized = normalized.slice(0, -"/models".length);
	if (normalized.endsWith("/chat/completions")) normalized = normalized.slice(0, -"/chat/completions".length);
	if (!normalized.endsWith("/v1")) normalized = `${normalized}/v1`;
	return normalized;
}

function formatDisplayName(value: string): string {
	return value
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isEmbeddingOnly(entry: Record<string, unknown>, requestModelId: string): boolean {
	const tags = [
		...getStringArrayField(entry, ["capabilities", "tasks", "task_types", "taskTypes", "modalities", "tags"]),
		...["type", "task", "category", "model_type", "modelType", "architecture", "mode"].flatMap((key) => {
			const value = getStringField(entry, [key]);
			return value ? [value] : [];
		}),
	].map((value) => value.toLowerCase());

	const hasEmbeddingTag = tags.some((tag) => /(^|[\s_:/-])(embedding|embeddings|embed|rerank|reranker)([\s_:/-]|$)/i.test(tag));
	const hasGenerationTag = tags.some((tag) => /(chat|completion|completions|responses|generate|generation|assistant|instruct|tool)/i.test(tag));
	const descriptor = `${requestModelId} ${getStringField(entry, ["name", "display_name", "displayName"]) ?? ""}`.toLowerCase();
	const knownEmbeddingName =
		/(^|[\s_:/-])(?:text-embedding|nomic-embed|mxbai-embed|snowflake-arctic-embed|jina-embeddings?|all-minilm|bge|e5|gte)(?=$|[\s_:/-])/i;
	return (hasEmbeddingTag && !hasGenerationTag) || knownEmbeddingName.test(descriptor);
}

function inferReasoningSupport(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized.includes("gpt-oss") || normalized.includes("deepseek-r1") || normalized.includes("qwq") || normalized.includes("qwen3") || normalized.includes("reason");
}

function inferVisionSupport(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return (
		normalized.includes("vision") ||
		normalized.includes("-vl") ||
		normalized.includes("llava") ||
		normalized.includes("pixtral") ||
		normalized.includes("moondream") ||
		normalized.includes("gemma-3") ||
		normalized.includes("internvl")
	);
}

function isKnownUnavailableState(entry: Record<string, unknown>): boolean {
	const state = getStringField(entry, ["state", "status"]);
	if (!state) return false;
	const normalized = state.toLowerCase();
	return !["loaded", "ready", "running", "started"].includes(normalized);
}

function getLmStudioApiV0ModelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/v1$/, "")}/api/v0/models`;
}

export function parseLmStudioModels(payload: unknown, baseUrl: string): ProviderModelConfig[] {
	if (!isRecord(payload) || !Array.isArray((payload as LmStudioModelsPayload).data)) return [];

	const models: ProviderModelConfig[] = [];
	const seenIds = new Set<string>();
	for (const rawEntry of (payload as LmStudioModelsPayload).data ?? []) {
		if (!isRecord(rawEntry)) continue;
		const requestModelId = getStringField(rawEntry, ["id", "model", "path", "name"]);
		if (!requestModelId || isEmbeddingOnly(rawEntry, requestModelId) || isKnownUnavailableState(rawEntry)) continue;

		const displayName =
			getStringField(rawEntry, ["display_name", "displayName", "name", "model_name", "modelName"]) ??
			formatDisplayName(requestModelId);
		if (seenIds.has(requestModelId)) continue;
		seenIds.add(requestModelId);

		const contextWindow = getNumberField(rawEntry, ["context_window", "contextWindow", "n_ctx", "max_context_length"]) ?? DEFAULT_CONTEXT_WINDOW;
		const maxTokens = getNumberField(rawEntry, ["max_tokens", "maxTokens", "max_output_tokens"]) ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
		const input: ("text" | "image")[] = inferVisionSupport(`${requestModelId} ${displayName}`) ? ["text", "image"] : ["text"];

		models.push({
			id: requestModelId,
			name: displayName,
			api: "openai-completions",
			reasoning: inferReasoningSupport(`${requestModelId} ${displayName}`),
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			headers: { "x-pi-lmstudio-request-model-id": requestModelId },
			compat: LM_STUDIO_COMPAT as Model<Api>["compat"],
		});
	}
	return models;
}

export async function discoverLmStudioModels(options?: LmStudioDiscoveryOptions): Promise<{
	baseUrl: string;
	models: ProviderModelConfig[];
}> {
	const baseUrl = normalizeLmStudioBaseUrl(options?.baseUrl);
	const fetchImpl = options?.fetch ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("LM Studio discovery timed out")), options?.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
	try {
		const apiV0Response = await fetchImpl(getLmStudioApiV0ModelsUrl(baseUrl), { signal: controller.signal });
		if (apiV0Response.ok) {
			const payload = await apiV0Response.json();
			return { baseUrl, models: parseLmStudioModels(payload, baseUrl) };
		}

		const response = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal });
		if (!response.ok) return { baseUrl, models: [] };
		const payload = await response.json();
		return { baseUrl, models: parseLmStudioModels(payload, baseUrl) };
	} catch {
		return { baseUrl, models: [] };
	} finally {
		clearTimeout(timeout);
	}
}

async function refreshLmStudio(pi: ExtensionAPI, notify?: (message: string, type?: "info" | "warning" | "error") => void): Promise<void> {
	const { baseUrl, models } = await discoverLmStudioModels();
	if (models.length === 0) {
		pi.unregisterProvider(LM_STUDIO_PROVIDER);
		notify?.("No running LM Studio chat models found.", "warning");
		return;
	}

	pi.registerProvider(LM_STUDIO_PROVIDER, {
		name: "LM Studio",
		baseUrl,
		apiKey: LM_STUDIO_PROVIDER,
		api: "openai-completions",
		authHeader: false,
		models,
	});
	notify?.(`Registered ${models.length} LM Studio model${models.length === 1 ? "" : "s"}.`, "info");
}

export async function registerLmStudio(pi: ExtensionAPI): Promise<void> {
	await refreshLmStudio(pi);
	pi.registerCommand("lmstudio-refresh", {
		description: "Refresh auto-discovered LM Studio models",
		handler: async (_args, ctx) => {
			await refreshLmStudio(pi, (message, type) => ctx.ui.notify(message, type));
		},
	});
}
