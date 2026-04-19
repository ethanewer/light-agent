/**
 * Vision-fallback helpers for the read tool.
 *
 * When the currently active model cannot consume images but an OpenRouter auth is configured,
 * we can still surface image contents to the agent by routing a single describe-this-image
 * request through a known vision-capable fallback model. Callers use
 * {@link describeImageFallback} to turn an image into a text description (with an internal
 * (path, mtime, size) LRU cache) and {@link hasConfiguredVisionFallback} /
 * {@link supportsImageInput} to decide whether the fallback path is even viable.
 */

import { type Api, completeSimple, type ImageContent, type Model, type TextContent } from "@mariozechner/pi-ai";
import { stat as fsStat } from "fs/promises";
import type { ExtensionContext } from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";

export const VISION_FALLBACK_PROVIDER = "openrouter";
export const VISION_FALLBACK_MODEL_ID = "qwen/qwen3.6-plus";
export const VISION_FALLBACK_MODEL_LABEL = `${VISION_FALLBACK_PROVIDER}/${VISION_FALLBACK_MODEL_ID}`;
const VISION_FALLBACK_BASE_URL = "https://openrouter.ai/api/v1";
const IMAGE_DESCRIPTION_PROMPT =
	"Analyze this image carefully and thoroughly. Describe every visual element, spatial relationship, text, symbol, and structural detail you can identify. Be precise about positions, labels, and values.";

/** Bounded LRU-ish cache of fallback descriptions keyed by path + mtime + size. */
const FALLBACK_DESCRIPTION_CACHE_MAX = 64;
const fallbackDescriptionCache = new Map<string, string>();

function rememberFallbackDescription(key: string, description: string): void {
	if (fallbackDescriptionCache.has(key)) {
		fallbackDescriptionCache.delete(key);
	} else if (fallbackDescriptionCache.size >= FALLBACK_DESCRIPTION_CACHE_MAX) {
		const oldest = fallbackDescriptionCache.keys().next().value;
		if (oldest !== undefined) fallbackDescriptionCache.delete(oldest);
	}
	fallbackDescriptionCache.set(key, description);
}

async function fallbackCacheKey(absolutePath: string): Promise<string | undefined> {
	try {
		const stats = await fsStat(absolutePath);
		return `${absolutePath}:${stats.mtimeMs}:${stats.size}`;
	} catch {
		return undefined;
	}
}

export function supportsImageInput(model: Model<Api> | undefined): boolean {
	return model?.input?.includes("image") === true;
}

/**
 * Build a synthetic Model targeting the OpenRouter fallback id. We don't require the model to
 * exist in the bundled registry snapshot (which is regenerated periodically) — the registry is
 * only consulted for auth (keyed by provider).
 */
function buildVisionFallbackModel(): Model<Api> {
	return {
		id: VISION_FALLBACK_MODEL_ID,
		name: VISION_FALLBACK_MODEL_LABEL,
		api: "openai-completions",
		provider: VISION_FALLBACK_PROVIDER,
		baseUrl: VISION_FALLBACK_BASE_URL,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<Api>;
}

function getConfiguredVisionFallbackModel(modelRegistry: ModelRegistry | undefined): Model<Api> | undefined {
	if (!modelRegistry) {
		return undefined;
	}
	// Prefer a concrete registry entry when present, otherwise synthesize an OpenRouter model so
	// we can still route requests even if the exact id isn't in the bundled registry snapshot.
	const candidate =
		modelRegistry.find(VISION_FALLBACK_PROVIDER, VISION_FALLBACK_MODEL_ID) ?? buildVisionFallbackModel();
	if (!supportsImageInput(candidate) || !modelRegistry.hasConfiguredAuth(candidate)) {
		return undefined;
	}
	return candidate;
}

export function hasConfiguredVisionFallback(modelRegistry: ModelRegistry | undefined): boolean {
	return !!getConfiguredVisionFallbackModel(modelRegistry);
}

async function describeImageWithFallbackModel(
	ctx: ExtensionContext,
	image: ImageContent,
	path: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const model = getConfiguredVisionFallbackModel(ctx.modelRegistry);
	if (!model) {
		throw new Error(`Could not resolve fallback vision model ${VISION_FALLBACK_MODEL_LABEL}.`);
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(`Could not use fallback vision model ${VISION_FALLBACK_MODEL_LABEL}: ${auth.error}`);
	}

	const response = await completeSimple(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `${IMAGE_DESCRIPTION_PROMPT}\n\nImage path: ${path}` }, image],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
		},
	);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Vision fallback request failed with status ${response.stopReason}.`);
	}

	const text = response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!text) {
		throw new Error(`Vision fallback model ${VISION_FALLBACK_MODEL_LABEL} returned no text output.`);
	}

	return text;
}

/**
 * Describe `image` via the configured vision fallback model. Results are cached by
 * (absolutePath, mtime, size) so repeated reads of the same file within a session make at
 * most one upstream call.
 */
export async function describeImageFallback(
	ctx: ExtensionContext,
	image: ImageContent,
	absolutePath: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const cacheKey = await fallbackCacheKey(absolutePath);
	if (cacheKey) {
		const cached = fallbackDescriptionCache.get(cacheKey);
		if (cached !== undefined) return cached;
	}
	const description = await describeImageWithFallbackModel(ctx, image, absolutePath, signal);
	if (cacheKey) rememberFallbackDescription(cacheKey, description);
	return description;
}
