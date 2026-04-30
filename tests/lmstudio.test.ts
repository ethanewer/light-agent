import assert from "node:assert/strict";
import test from "node:test";

import {
	LM_STUDIO_DEFAULT_BASE_URL,
	discoverLmStudioModels,
	normalizeLmStudioBaseUrl,
	parseLmStudioModels,
} from "../extensions/light-agent/lmstudio.ts";

test("normalizeLmStudioBaseUrl accepts common LM Studio endpoint forms", () => {
	assert.equal(normalizeLmStudioBaseUrl(undefined), LM_STUDIO_DEFAULT_BASE_URL);
	assert.equal(normalizeLmStudioBaseUrl("http://localhost:1234"), "http://localhost:1234/v1");
	assert.equal(normalizeLmStudioBaseUrl("http://localhost:1234/v1/models"), "http://localhost:1234/v1");
	assert.equal(normalizeLmStudioBaseUrl("http://localhost:1234/v1/chat/completions"), "http://localhost:1234/v1");
});

test("parseLmStudioModels filters embeddings and maps chat models to provider models", () => {
	const models = parseLmStudioModels(
		{
			data: [
				{
					id: "qwen3-14b-instruct.gguf",
					display_name: "Qwen3 14B Instruct",
					context_window: 32768,
					max_tokens: 4096,
				},
				{
					id: "nomic-embed-text-v1.5",
					type: "embedding",
				},
			],
		},
		"http://127.0.0.1:1234/v1",
	);

	assert.equal(models.length, 1);
	assert.equal(models[0]?.id, "qwen3-14b-instruct.gguf");
	assert.equal(models[0]?.name, "Qwen3 14B Instruct");
	assert.equal(models[0]?.api, "openai-completions");
	assert.equal(models[0]?.contextWindow, 32768);
	assert.equal(models[0]?.maxTokens, 4096);
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.input, ["text"]);
	assert.deepEqual(models[0]?.headers, { "x-pi-lmstudio-request-model-id": "qwen3-14b-instruct.gguf" });
});

test("parseLmStudioModels filters common legacy embedding model ids", () => {
	const models = parseLmStudioModels(
		{
			data: [
				{ id: "bge-m3" },
				{ id: "e5-large-v2" },
				{ id: "gte-base" },
				{ id: "all-minilm-l6-v2" },
				{ id: "qwen3.5-9b-mlx" },
			],
		},
		"http://127.0.0.1:1234/v1",
	);

	assert.deepEqual(models.map((model) => model.id), ["qwen3.5-9b-mlx"]);
});

test("parseLmStudioModels skips LM Studio models that are known to be unloaded", () => {
	const models = parseLmStudioModels(
		{
			data: [
				{ id: "not-loaded-model", type: "vlm", state: "not-loaded" },
				{ id: "loaded-model", type: "vlm", state: "loaded" },
			],
		},
		"http://127.0.0.1:1234/v1",
	);

	assert.deepEqual(models.map((model) => model.id), ["loaded-model"]);
});

test("discoverLmStudioModels returns parsed models from the local endpoint", async () => {
	const urls: string[] = [];
	const fetchImpl = async (url: string | URL | Request) => {
		urls.push(String(url));
		return new Response(
			JSON.stringify({
				data: [{ id: "local-vision-vl", name: "Local Vision VL", state: "loaded" }],
			}),
			{ headers: { "content-type": "application/json" } },
		);
	};

	const result = await discoverLmStudioModels({ baseUrl: "http://localhost:1234", fetch: fetchImpl as typeof fetch });
	assert.equal(result.baseUrl, "http://localhost:1234/v1");
	assert.deepEqual(urls, ["http://localhost:1234/api/v0/models"]);
	assert.equal(result.models.length, 1);
	assert.equal(result.models[0]?.id, "local-vision-vl");
	assert.deepEqual(result.models[0]?.input, ["text", "image"]);
});

test("discoverLmStudioModels falls back to OpenAI-compatible /models on older servers", async () => {
	const urls: string[] = [];
	const fetchImpl = async (url: string | URL | Request) => {
		urls.push(String(url));
		if (String(url).endsWith("/api/v0/models")) return new Response("missing", { status: 404 });
		return new Response(JSON.stringify({ data: [{ id: "legacy-loaded-model" }] }), {
			headers: { "content-type": "application/json" },
		});
	};

	const result = await discoverLmStudioModels({ baseUrl: "http://localhost:1234", fetch: fetchImpl as typeof fetch });
	assert.deepEqual(urls, ["http://localhost:1234/api/v0/models", "http://localhost:1234/v1/models"]);
	assert.equal(result.models[0]?.id, "legacy-loaded-model");
});

test("discoverLmStudioModels degrades to an empty provider list when unavailable", async () => {
	const result = await discoverLmStudioModels({
		baseUrl: "http://localhost:1234",
		fetch: async () => {
			throw new Error("connection refused");
		},
	});

	assert.equal(result.baseUrl, "http://localhost:1234/v1");
	assert.deepEqual(result.models, []);
});
