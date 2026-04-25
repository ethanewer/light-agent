import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";

export const LM_STUDIO_PROVIDER = "lmstudio";
export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const LM_STUDIO_REQUEST_MODEL_ID_HEADER = "x-pi-lmstudio-request-model-id";

const LM_STUDIO_DISCOVERY_CACHE_TTL_MS = 1000;
const LM_STUDIO_DISCOVERY_TIMEOUT_MS = 500;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

const LM_STUDIO_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
} satisfies OpenAICompletionsCompat;

type CachedDiscovery = {
	expiresAt: number;
	models: Model<"openai-completions">[];
};

type ParsedLmStudioEntry = {
	entry: Record<string, unknown>;
	requestModelId: string;
	displayName: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
};

type LmStudioVariantSegments = {
	id: string[];
	label: string[];
};

const discoveryCache = new Map<string, CachedDiscovery>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	}
	return undefined;
}

function getStringArrayField(record: Record<string, unknown>, keys: string[]): string[] {
	for (const key of keys) {
		const value = record[key];
		if (!Array.isArray(value)) {
			continue;
		}

		const items = value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		if (items.length > 0) {
			return items;
		}
	}
	return [];
}

function inferReasoningSupport(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return (
		normalized.includes("gpt-oss") ||
		normalized.includes("deepseek-r1") ||
		normalized.includes("qwq") ||
		normalized.includes("qwen3") ||
		normalized.includes("reason")
	);
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

function normalizeLmStudioBaseUrl(baseUrl?: string): string {
	const raw =
		baseUrl?.trim() ||
		process.env.LMSTUDIO_BASE_URL?.trim() ||
		process.env.LM_STUDIO_BASE_URL?.trim() ||
		LM_STUDIO_DEFAULT_BASE_URL;

	let normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/models")) {
		normalized = normalized.slice(0, -"/models".length);
	}
	if (normalized.endsWith("/chat/completions")) {
		normalized = normalized.slice(0, -"/chat/completions".length);
	}
	if (!normalized.endsWith("/v1")) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}

function getLmStudioServerBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/v1$/, "");
}

function cloneModels(models: Model<"openai-completions">[]): Model<"openai-completions">[] {
	return models.map((model) => ({
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		headers: model.headers ? { ...model.headers } : undefined,
		compat: model.compat ? { ...model.compat } : undefined,
	}));
}

function normalizeTag(value: string): string {
	return value.trim().toLowerCase();
}

function getPathBasename(value: string): string {
	const normalized = value.replace(/\\/g, "/");
	const basename = normalized.split("/").pop() ?? normalized;
	return basename.trim();
}

function sanitizeIdSegment(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function isEmbeddingTag(value: string): boolean {
	return /(^|[\s_:/-])(embedding|embeddings|embed|rerank|reranker)([\s_:/-]|$)/i.test(value);
}

function isGenerationCapability(value: string): boolean {
	return /(chat|completion|completions|responses|generate|generation|assistant|instruct|tool)/i.test(value);
}

function collectModelTags(entry: Record<string, unknown>): string[] {
	const tags = new Set<string>();
	const singleValueKeys = [
		"type",
		"task",
		"tasks",
		"category",
		"model_type",
		"modelType",
		"object_type",
		"objectType",
		"architecture",
		"arch",
		"mode",
		"kind",
		"endpoint",
		"capability",
		"capabilities",
		"name",
		"display_name",
		"displayName",
		"model_name",
		"modelName",
		"id",
	];
	for (const key of singleValueKeys) {
		const value = getStringField(entry, [key]);
		if (value) {
			tags.add(normalizeTag(value));
		}
	}

	const arrayValueKeys = ["capabilities", "tasks", "task_types", "taskTypes", "modalities", "tags"];
	for (const key of arrayValueKeys) {
		for (const value of getStringArrayField(entry, [key])) {
			tags.add(normalizeTag(value));
		}
	}

	return Array.from(tags);
}

function isRunnableLmStudioModel(entry: Record<string, unknown>, requestModelId: string): boolean {
	const tags = collectModelTags(entry);
	const hasEmbeddingTag = tags.some(isEmbeddingTag);
	const hasGenerationTag = tags.some(isGenerationCapability);
	if (hasEmbeddingTag && !hasGenerationTag) {
		return false;
	}

	const modelName = getStringField(entry, ["name", "display_name", "displayName", "model_name", "modelName"]);
	const descriptor = `${requestModelId} ${modelName ?? ""}`.toLowerCase();
	const knownEmbeddingOnlyPattern =
		/(^|[\s_:/-])(text-embedding|nomic-embed|mxbai-embed|snowflake-arctic-embed|jina-embeddings?|all-minilm|bge-|e5-|gte-)([\s_:/-]|$)/i;
	if (knownEmbeddingOnlyPattern.test(descriptor)) {
		return false;
	}

	return true;
}

function formatVariantLabel(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return trimmed;
	}

	const normalized = trimmed.toLowerCase();
	if (normalized === "mlx") {
		return "MLX";
	}
	if (normalized === "gguf") {
		return "GGUF";
	}
	if (/^q\d/i.test(trimmed) || /^iq\d/i.test(trimmed)) {
		return trimmed.toUpperCase();
	}
	return trimmed;
}

function inferCompatibilityType(values: string[]): string | undefined {
	for (const value of values) {
		const normalized = value.toLowerCase();
		if (/\bmlx\b|mlx-community/.test(normalized)) {
			return "MLX";
		}
		if (/\bgguf\b/.test(normalized)) {
			return "GGUF";
		}
	}
	return undefined;
}

function inferQuantization(values: string[]): string | undefined {
	for (const value of values) {
		const bitMatch = value.match(/(?:^|[^a-z0-9])([248]|16)-?bit(?:[^a-z0-9]|$)/i);
		if (bitMatch) {
			return `${bitMatch[1]}-bit`;
		}

		const compactBitMatch = value.match(/(?:^|[^a-z0-9])([248]|16)bit(?:[^a-z0-9]|$)/i);
		if (compactBitMatch) {
			return `${compactBitMatch[1]}-bit`;
		}

		const qMatch = value.match(/(?:^|[^a-z0-9])(iq\d(?:[_-][a-z0-9]+)?|q\d(?:[_-][a-z0-9]+)?)(?:[^a-z0-9]|$)/i);
		if (qMatch) {
			const quantization = qMatch[1].replace(/-/g, "_").toUpperCase();
			const simpleQuantization = quantization.match(/^Q([248])(?:_0)?$/i);
			if (simpleQuantization) {
				return `${simpleQuantization[1]}-bit`;
			}
			return quantization;
		}

		const precisionMatch = value.match(/(?:^|[^a-z0-9])(INT[248]|FP16|BF16)(?:[^a-z0-9]|$)/i);
		if (precisionMatch) {
			return precisionMatch[1].toUpperCase();
		}
	}
	return undefined;
}

function inferQuantizationBits(values: string[]): number | undefined {
	for (const value of values) {
		const bitMatch = value.match(/(?:^|[^a-z0-9])([248]|16)-?bit(?:[^a-z0-9]|$)/i);
		if (bitMatch) {
			return Number(bitMatch[1]);
		}

		const compactBitMatch = value.match(/(?:^|[^a-z0-9])([248]|16)bit(?:[^a-z0-9]|$)/i);
		if (compactBitMatch) {
			return Number(compactBitMatch[1]);
		}

		const qMatch = value.match(/(?:^|[^a-z0-9])i?q([248]|16)(?:[_-][a-z0-9]+)?(?:[^a-z0-9]|$)/i);
		if (qMatch) {
			return Number(qMatch[1]);
		}
	}
	return undefined;
}

function buildVariantSegments(entry: Record<string, unknown>, requestModelId: string): LmStudioVariantSegments {
	const idSegments: string[] = [];
	const labelSegments: string[] = [];
	const pushSegment = (rawValue: string | undefined, labelValue?: string) => {
		if (!rawValue) {
			return;
		}
		const label = formatVariantLabel(rawValue);
		if (!label) {
			return;
		}
		const normalizedLabel = label.toLowerCase();
		if (normalizedLabel === requestModelId.toLowerCase()) {
			return;
		}

		const sanitized = sanitizeIdSegment(labelValue ?? label);
		if (!sanitized) {
			return;
		}
		if (!idSegments.includes(sanitized)) {
			idSegments.push(sanitized);
		}
		if (!labelSegments.some((existing) => existing.toLowerCase() === normalizedLabel)) {
			labelSegments.push(label);
		}
	};

	const backendIdentifier = getStringField(entry, [
		"identifier",
		"loaded_model_id",
		"loadedModelId",
		"model_key",
		"modelKey",
		"key",
	]);
	const pathLike = getStringField(entry, ["path", "model_path", "modelPath", "filename", "file_name", "fileName"]);
	const pathBasename = pathLike ? getPathBasename(pathLike) : undefined;
	const displayName = getStringField(entry, ["name", "display_name", "displayName", "model_name", "modelName"]);
	const inferenceSources = [requestModelId, displayName, backendIdentifier, pathBasename].filter(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);

	pushSegment(
		getStringField(entry, ["compatibility_type", "compatibilityType", "format", "engine", "runtime"]) ??
			inferCompatibilityType(inferenceSources),
	);
	pushSegment(
		getStringField(entry, ["quantization", "quantization_name", "quantizationName", "precision", "dtype"]) ??
			inferQuantization(inferenceSources),
	);
	const bits = getNumberField(entry, ["bits", "bitWidth", "quantization_bits", "quantizationBits"]);
	if (bits) {
		pushSegment(`${bits}-bit`, `${bits}-bit`);
	}

	return { id: idSegments, label: labelSegments };
}

function normalizeSemanticModelLabel(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

function buildParsedEntryDeduplicationKey(parsed: ParsedLmStudioEntry): string {
	const variantSegments = buildVariantSegments(parsed.entry, parsed.requestModelId).label;
	const normalizedDisplayName = normalizeSemanticModelLabel(parsed.displayName);
	const normalizedVariantSignature = variantSegments
		.map((segment) => normalizeSemanticModelLabel(segment))
		.filter((segment) => segment.length > 0)
		.join("|");
	return `${normalizedDisplayName}#${normalizedVariantSignature}`;
}

function buildSelectableModelId(
	parsed: ParsedLmStudioEntry,
	duplicateRequestIds: Set<string>,
	usedModelIds: Set<string>,
): { id: string; requestModelIdOverride?: string } {
	const { entry, requestModelId } = parsed;
	const isDuplicateRequestId = duplicateRequestIds.has(requestModelId);
	const backendIdentifier = getStringField(entry, [
		"identifier",
		"loaded_model_id",
		"loadedModelId",
		"model_key",
		"modelKey",
		"key",
	]);
	const variantSegments = buildVariantSegments(entry, requestModelId);

	if (!isDuplicateRequestId) {
		if (!usedModelIds.has(requestModelId)) {
			usedModelIds.add(requestModelId);
			return { id: requestModelId };
		}
		let suffix = 2;
		let candidateId = `${requestModelId}-${suffix}`;
		while (usedModelIds.has(candidateId)) {
			suffix += 1;
			candidateId = `${requestModelId}-${suffix}`;
		}
		usedModelIds.add(candidateId);
		return { id: candidateId, requestModelIdOverride: requestModelId };
	}

	const candidates: Array<{ id: string; requestModelIdOverride?: string }> = [];
	if (backendIdentifier && backendIdentifier !== requestModelId) {
		candidates.push({ id: backendIdentifier });
	}
	if (variantSegments.id.length > 0) {
		candidates.push({
			id: `${requestModelId}#${variantSegments.id.join("-")}`,
			requestModelIdOverride: requestModelId,
		});
	}

	for (const candidate of candidates) {
		if (!usedModelIds.has(candidate.id)) {
			usedModelIds.add(candidate.id);
			return candidate;
		}
	}

	const fallbackBase = `${requestModelId}#${variantSegments.id.join("-") || "variant"}`;
	let suffix = 2;
	let candidateId = fallbackBase;
	while (usedModelIds.has(candidateId)) {
		candidateId = `${fallbackBase}-${suffix}`;
		suffix += 1;
	}
	usedModelIds.add(candidateId);
	return { id: candidateId, requestModelIdOverride: requestModelId };
}

function buildDisplayName(parsed: ParsedLmStudioEntry, selectableId: string): string {
	const { entry, requestModelId, displayName } = parsed;
	const variantSegments = buildVariantSegments(entry, requestModelId).label;
	if (variantSegments.length === 0) {
		return displayName === requestModelId && selectableId !== requestModelId ? selectableId : displayName;
	}

	const normalizedDisplay = displayName.toLowerCase();
	const missingSegments = variantSegments.filter((segment) => !normalizedDisplay.includes(segment.toLowerCase()));
	if (missingSegments.length === 0) {
		return displayName;
	}
	return `${displayName} (${missingSegments.join(", ")})`;
}

function parseLmStudioApiV1Models(payload: unknown): Record<string, unknown>[] {
	const records = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
	const entries: Record<string, unknown>[] = [];

	for (const rawRecord of records) {
		if (!isRecord(rawRecord)) {
			continue;
		}

		const key = getStringField(rawRecord, ["key"]);
		if (!key) {
			continue;
		}

		const loadedInstances = Array.isArray(rawRecord.loaded_instances) ? rawRecord.loaded_instances : [];
		const firstLoadedInstance = loadedInstances.find(isRecord);
		const loadedContextLength =
			firstLoadedInstance && isRecord(firstLoadedInstance.config)
				? getNumberField(firstLoadedInstance.config, ["context_length", "contextLength"])
				: undefined;
		const quantization = isRecord(rawRecord.quantization) ? rawRecord.quantization : undefined;
		const format = getStringField(rawRecord, ["format"]);
		const displayName = getStringField(rawRecord, ["display_name", "displayName"]) ?? key;
		const modelType = getStringField(rawRecord, ["type"]);
		const maxContextLength = getNumberField(rawRecord, ["max_context_length", "maxContextLength"]);
		const capabilities = isRecord(rawRecord.capabilities) ? rawRecord.capabilities : undefined;
		const variants = Array.isArray(rawRecord.variants)
			? rawRecord.variants.filter(
					(variant): variant is string => typeof variant === "string" && variant.trim().length > 0,
				)
			: [];
		const requestModelIds =
			variants.length > 0 ? variants : [getStringField(firstLoadedInstance ?? {}, ["id"]) ?? key];

		for (const requestModelId of requestModelIds) {
			const variantQuantizationName = requestModelId.includes("@") ? requestModelId.split("@").pop() : undefined;
			const variantInferenceSources = [requestModelId, variantQuantizationName].filter(
				(value): value is string => typeof value === "string" && value.trim().length > 0,
			);
			const inferredVariantBits = inferQuantizationBits(variantInferenceSources);
			const fallbackBits = getNumberField(quantization ?? {}, ["bits_per_weight", "bitsPerWeight"]);
			const resolvedBits = inferredVariantBits ?? fallbackBits;
			const resolvedQuantization =
				inferQuantization(variantInferenceSources) ??
				inferQuantization(
					[getStringField(quantization ?? {}, ["name"])].filter(
						(value): value is string => typeof value === "string" && value.trim().length > 0,
					),
				) ??
				getStringField(quantization ?? {}, ["name"]);
			const quantizationLabel = resolvedBits ? `${resolvedBits}-bit` : resolvedQuantization;
			entries.push({
				id: requestModelId,
				display_name: displayName,
				type: modelType,
				compatibility_type: format,
				quantization: quantizationLabel,
				bits: resolvedBits,
				max_context_length: maxContextLength,
				loaded_context_length: loadedContextLength,
				input: capabilities?.vision === true ? (["text", "image"] as const) : (["text"] as const),
			});
		}
	}

	return entries;
}

function parseLmStudioModels(payload: unknown, baseUrl: string): Model<"openai-completions">[] {
	const records =
		isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
	const parsedEntries: ParsedLmStudioEntry[] = [];
	const seenParsedEntryKeys = new Set<string>();
	const requestIdCounts = new Map<string, number>();

	for (const rawEntry of records) {
		if (!isRecord(rawEntry)) {
			continue;
		}

		const requestModelId = getStringField(rawEntry, ["id"]);
		if (!requestModelId) {
			continue;
		}
		if (!isRunnableLmStudioModel(rawEntry, requestModelId)) {
			continue;
		}

		const contextWindow =
			getNumberField(rawEntry, ["context_length", "max_context_length", "contextWindow", "maxContextLength"]) ??
			DEFAULT_CONTEXT_WINDOW;
		const maxTokens = Math.min(
			getNumberField(rawEntry, ["max_tokens", "max_completion_tokens", "maxTokens"]) ?? DEFAULT_MAX_TOKENS,
			contextWindow,
		);
		const displayName =
			getStringField(rawEntry, ["name", "display_name", "displayName", "model_name", "modelName"]) ?? requestModelId;
		const reasoning = inferReasoningSupport(requestModelId);
		const explicitInput = getStringArrayField(rawEntry, ["input", "modalities"]);
		const input =
			explicitInput.length > 0
				? (explicitInput.filter((value): value is "text" | "image" => value === "text" || value === "image") as (
						| "text"
						| "image"
					)[])
				: isRecord(rawEntry.capabilities) && rawEntry.capabilities.vision === true
					? (["text", "image"] as const)
					: getStringField(rawEntry, ["type"]) === "vlm"
						? (["text", "image"] as const)
						: inferVisionSupport(requestModelId)
							? (["text", "image"] as const)
							: (["text"] as const);

		const parsedEntry: ParsedLmStudioEntry = {
			entry: rawEntry,
			requestModelId,
			displayName,
			contextWindow,
			maxTokens,
			reasoning,
			input: [...input],
		};
		const deduplicationKey = buildParsedEntryDeduplicationKey(parsedEntry);
		if (seenParsedEntryKeys.has(deduplicationKey)) {
			continue;
		}
		seenParsedEntryKeys.add(deduplicationKey);
		requestIdCounts.set(requestModelId, (requestIdCounts.get(requestModelId) ?? 0) + 1);
		parsedEntries.push(parsedEntry);
	}

	const duplicateRequestIds = new Set(
		Array.from(requestIdCounts.entries())
			.filter(([, count]) => count > 1)
			.map(([requestModelId]) => requestModelId),
	);
	const usedModelIds = new Set<string>();
	const models: Model<"openai-completions">[] = [];

	for (const parsed of parsedEntries) {
		const selectable = buildSelectableModelId(parsed, duplicateRequestIds, usedModelIds);
		const headers = selectable.requestModelIdOverride
			? { [LM_STUDIO_REQUEST_MODEL_ID_HEADER]: selectable.requestModelIdOverride }
			: undefined;
		models.push({
			id: selectable.id,
			name: buildDisplayName(parsed, selectable.id),
			api: "openai-completions",
			provider: LM_STUDIO_PROVIDER,
			baseUrl,
			reasoning: parsed.reasoning,
			input: [...parsed.input],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: parsed.contextWindow,
			maxTokens: parsed.maxTokens,
			headers,
			compat: { ...LM_STUDIO_COMPAT },
		});
	}

	return models.sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverLmStudioModels(options?: {
	baseUrl?: string;
	force?: boolean;
	timeoutMs?: number;
}): Promise<Model<"openai-completions">[]> {
	if (process.env.PI_OFFLINE) {
		return [];
	}

	const baseUrl = normalizeLmStudioBaseUrl(options?.baseUrl);
	const now = Date.now();
	const cached = discoveryCache.get(baseUrl);
	if (!options?.force && cached && cached.expiresAt > now) {
		return cloneModels(cached.models);
	}

	const serverBaseUrl = getLmStudioServerBaseUrl(baseUrl);
	const endpoints = [`${serverBaseUrl}/api/v1/models`, `${serverBaseUrl}/api/v0/models`, `${baseUrl}/models`];

	for (const endpoint of endpoints) {
		try {
			const response = await fetch(endpoint, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(options?.timeoutMs ?? LM_STUDIO_DISCOVERY_TIMEOUT_MS),
			});
			if (!response.ok) {
				continue;
			}

			const payload = (await response.json()) as unknown;
			const normalizedPayload =
				endpoint.endsWith("/api/v1/models") && isRecord(payload) && Array.isArray(payload.models)
					? { data: parseLmStudioApiV1Models(payload) }
					: payload;
			const models = parseLmStudioModels(normalizedPayload, baseUrl);
			if (models.length === 0) {
				continue;
			}

			discoveryCache.set(baseUrl, {
				expiresAt: now + LM_STUDIO_DISCOVERY_CACHE_TTL_MS,
				models: cloneModels(models),
			});
			return models;
		} catch {}
	}

	discoveryCache.set(baseUrl, { expiresAt: now + LM_STUDIO_DISCOVERY_CACHE_TTL_MS, models: [] });
	return [];
}

export function clearLmStudioDiscoveryCache(): void {
	discoveryCache.clear();
}
