import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import { getApiProvider } from "@mariozechner/pi-ai";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearLmStudioDiscoveryCache, LM_STUDIO_REQUEST_MODEL_ID_HEADER } from "../src/core/lmstudio-discovery.js";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.js";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		globalThis.fetch = originalFetch;
		delete process.env.LMSTUDIO_BASE_URL;
		delete process.env.LM_STUDIO_BASE_URL;
		delete process.env.PI_OFFLINE;
		clearLmStudioDiscoveryCache();
		clearApiKeyCache();
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext: Context = {
		messages: [],
	};

	describe("LM Studio auto-detection", () => {
		test("discovers loaded LM Studio models and makes them available", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{ id: "gpt-oss-20b", context_length: 131072, max_tokens: 8192 },
							{ id: "qwen2.5-coder-7b-instruct" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const gptOss = registry.find("lmstudio", "gpt-oss-20b");
			expect(gptOss).toBeDefined();
			expect(gptOss?.baseUrl).toBe("http://127.0.0.1:1234/v1");
			expect(gptOss?.reasoning).toBe(true);
			expect(gptOss?.contextWindow).toBe(131072);
			expect(gptOss?.maxTokens).toBe(8192);
			const compat = gptOss?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.supportsDeveloperRole).toBe(false);
			expect(compat?.supportsReasoningEffort).toBe(false);
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
			expect(registry.getAvailable().some((model) => model.provider === "lmstudio")).toBe(true);

			const auth = await registry.getApiKeyAndHeaders(gptOss!);
			expect(auth).toEqual({ ok: true, apiKey: "lmstudio", headers: undefined });
		});

		test("keeps distinct runnable lmstudio variants and filters out embedding models", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: "quinn-3.5-9b",
								identifier: "quinn-3.5-9b-gguf-q4",
								compatibility_type: "gguf",
								quantization: "4-bit",
								name: "Quinn 3.5 9B",
							},
							{
								id: "quinn-3.5-9b",
								identifier: "quinn-3.5-9b-gguf-q8",
								compatibility_type: "gguf",
								quantization: "8-bit",
								name: "Quinn 3.5 9B",
							},
							{
								id: "quinn-3.5-9b",
								identifier: "quinn-3.5-9b-mlx-q4",
								compatibility_type: "mlx",
								quantization: "4-bit",
								name: "Quinn 3.5 9B",
							},
							{
								id: "quinn-3.5-9b",
								identifier: "quinn-3.5-9b-mlx-q8",
								compatibility_type: "mlx",
								quantization: "8-bit",
								name: "Quinn 3.5 9B",
							},
							{
								id: "nomic-embed-text-v1.5",
								type: "embedding",
								name: "Nomic Embed Text v1.5",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const availableLmStudioModels = registry.getAvailable().filter((model) => model.provider === "lmstudio");
			expect(availableLmStudioModels.map((model) => model.id)).toEqual([
				"quinn-3.5-9b-gguf-q4",
				"quinn-3.5-9b-gguf-q8",
				"quinn-3.5-9b-mlx-q4",
				"quinn-3.5-9b-mlx-q8",
			]);
			expect(availableLmStudioModels.map((model) => model.name)).toEqual([
				"Quinn 3.5 9B (GGUF, 4-bit)",
				"Quinn 3.5 9B (GGUF, 8-bit)",
				"Quinn 3.5 9B (MLX, 4-bit)",
				"Quinn 3.5 9B (MLX, 8-bit)",
			]);
			expect(registry.find("lmstudio", "nomic-embed-text-v1.5")).toBeUndefined();
			expect(availableLmStudioModels.every((model) => model.input.includes("text"))).toBe(true);
			expect(availableLmStudioModels.every((model) => !model.id.includes("embed"))).toBe(true);
		});

		test("creates stable aliases for duplicate lmstudio ids without a backend identifier", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: "quinn-3.5-9b",
								compatibility_type: "gguf",
								quantization: "4-bit",
								name: "Quinn 3.5 9B",
							},
							{
								id: "quinn-3.5-9b",
								compatibility_type: "mlx",
								quantization: "8-bit",
								name: "Quinn 3.5 9B",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const gguf = registry.find("lmstudio", "quinn-3.5-9b#gguf-4-bit");
			const mlx = registry.find("lmstudio", "quinn-3.5-9b#mlx-8-bit");
			expect(gguf).toBeDefined();
			expect(mlx).toBeDefined();
			expect(gguf?.headers?.[LM_STUDIO_REQUEST_MODEL_ID_HEADER]).toBe("quinn-3.5-9b");
			expect(mlx?.headers?.[LM_STUDIO_REQUEST_MODEL_ID_HEADER]).toBe("quinn-3.5-9b");
		});

		test("keeps gguf quantizations for the same qwen model discoverable as separate choices", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: "qwen-3.5-9b",
								compatibility_type: "gguf",
								quantization: "4-bit",
								name: "Qwen 3.5 9B",
							},
							{
								id: "qwen-3.5-9b",
								compatibility_type: "gguf",
								quantization: "8-bit",
								name: "Qwen 3.5 9B",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			expect(registry.find("lmstudio", "qwen-3.5-9b#gguf-4-bit")?.name).toBe("Qwen 3.5 9B (GGUF, 4-bit)");
			expect(registry.find("lmstudio", "qwen-3.5-9b#gguf-8-bit")?.name).toBe("Qwen 3.5 9B (GGUF, 8-bit)");
		});

		test("infers MLX and GGUF quantization labels from identifiers and paths when fields are missing", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: "qwen3.5-9b-mlx",
								identifier: "mlx-community/qwen3.5-9b-8bit",
							},
							{
								id: "qwen3.5-9b",
								identifier: "qwen3.5-9b-gguf-q4",
								path: "/models/qwen3.5-9b-q4_k_m.gguf",
							},
							{
								id: "qwen3.5-9b",
								identifier: "qwen3.5-9b-gguf-q8",
								path: "/models/qwen3.5-9b-q8_0.gguf",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			expect(registry.find("lmstudio", "qwen3.5-9b-mlx")?.name).toBe("qwen3.5-9b-mlx (8-bit)");
			expect(registry.find("lmstudio", "qwen3.5-9b-gguf-q4")?.name).toBe("qwen3.5-9b (GGUF, 4-bit)");
			expect(registry.find("lmstudio", "qwen3.5-9b-gguf-q8")?.name).toBe("qwen3.5-9b (GGUF, 8-bit)");
		});

		test("deduplicates repeated LM Studio api/v1 variant records", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						models: [
							{
								key: "qwen-3.5-9b",
								display_name: "Qwen 3.5 9B",
								format: "gguf",
								variants: ["qwen-3.5-9b-gguf-q4", "qwen-3.5-9b-gguf-q8"],
							},
							{
								key: "qwen-3.5-9b",
								display_name: "Qwen 3.5 9B",
								format: "gguf",
								variants: ["qwen-3.5-9b-gguf-q4", "qwen-3.5-9b-gguf-q8"],
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const availableLmStudioModels = registry.getAvailable().filter((model) => model.provider === "lmstudio");
			expect(availableLmStudioModels.map((model) => model.id)).toEqual([
				"qwen-3.5-9b-gguf-q4",
				"qwen-3.5-9b-gguf-q8",
			]);
			expect(availableLmStudioModels.map((model) => model.name)).toEqual([
				"Qwen 3.5 9B (GGUF, 4-bit)",
				"Qwen 3.5 9B (GGUF, 8-bit)",
			]);
		});

		test("deduplicates semantic duplicates that use different LM Studio request ids", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [
							{
								id: "qwen35-9b-q80",
								name: "Qwen3.5 9B",
								compatibility_type: "gguf",
								quantization: "8-bit",
							},
							{
								id: "qwen35-9b-q4km",
								name: "Qwen3.5 9B",
								compatibility_type: "gguf",
								quantization: "4-bit",
							},
							{
								id: "qwen/qwen3.5-9b@q8_0",
								name: "Qwen3.5 9B",
								compatibility_type: "gguf",
								quantization: "8-bit",
							},
							{
								id: "qwen/qwen3.5-9b@q4_k_m",
								name: "Qwen3.5 9B",
								compatibility_type: "gguf",
								quantization: "4-bit",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const availableLmStudioModels = registry.getAvailable().filter((model) => model.provider === "lmstudio");
			expect(availableLmStudioModels.map((model) => model.id)).toEqual(["qwen35-9b-q4km", "qwen35-9b-q80"]);
			expect(availableLmStudioModels.map((model) => model.name)).toEqual([
				"Qwen3.5 9B (GGUF, 4-bit)",
				"Qwen3.5 9B (GGUF, 8-bit)",
			]);
		});

		test("deduplicates qwen gguf variants from the real LM Studio api/v1 payload shape", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						models: [
							{
								type: "llm",
								publisher: "bench",
								key: "qwen35-9b-q80",
								display_name: "Qwen3.5 9B",
								architecture: "qwen35",
								quantization: { name: "Q8_0", bits_per_weight: 8 },
								max_context_length: 262144,
								format: "gguf",
								capabilities: { vision: false, trained_for_tool_use: true },
							},
							{
								type: "llm",
								publisher: "bench",
								key: "qwen35-9b-q4km",
								display_name: "Qwen3.5 9B",
								architecture: "qwen35",
								quantization: { name: "Q4_K_M", bits_per_weight: 4 },
								max_context_length: 262144,
								format: "gguf",
								capabilities: { vision: false, trained_for_tool_use: true },
							},
							{
								type: "llm",
								publisher: "qwen",
								key: "qwen/qwen3.5-9b",
								display_name: "Qwen3.5 9B",
								architecture: "qwen35",
								quantization: { name: "Q8_0", bits_per_weight: 8 },
								max_context_length: 262144,
								format: "gguf",
								capabilities: { vision: true, trained_for_tool_use: true },
								variants: ["qwen/qwen3.5-9b@q4_k_m", "qwen/qwen3.5-9b@q8_0"],
								selected_variant: "qwen/qwen3.5-9b@q8_0",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const availableLmStudioModels = registry.getAvailable().filter((model) => model.provider === "lmstudio");
			expect(availableLmStudioModels.map((model) => model.id)).toEqual(["qwen35-9b-q4km", "qwen35-9b-q80"]);
			expect(availableLmStudioModels.map((model) => model.name)).toEqual([
				"Qwen3.5 9B (GGUF, 4-bit)",
				"Qwen3.5 9B (GGUF, 8-bit)",
			]);
		});

		test("keeps explicit lmstudio provider config instead of auto-detected models", async () => {
			writeRawModelsJson({
				lmstudio: {
					baseUrl: "http://custom-lmstudio.test/v1",
					apiKey: "LMSTUDIO_TOKEN",
					api: "openai-completions",
					models: [
						{
							id: "manual-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 4096,
							maxTokens: 1024,
						},
					],
				},
			});
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ id: "auto-detected-model" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const manual = registry.find("lmstudio", "manual-model");
			expect(manual?.baseUrl).toBe("http://custom-lmstudio.test/v1");
			expect(registry.find("lmstudio", "auto-detected-model")).toBeUndefined();
		});

		test("applies override-only lmstudio provider config to auto-detected models", async () => {
			writeRawModelsJson({
				lmstudio: {
					baseUrl: "http://custom-lmstudio.test/v1",
					compat: {
						supportsDeveloperRole: true,
						supportsReasoningEffort: true,
					},
				},
			});
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-oss-20b" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const detected = registry.find("lmstudio", "gpt-oss-20b");
			expect(detected?.baseUrl).toBe("http://custom-lmstudio.test/v1");
			const compat = detected?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.supportsDeveloperRole).toBe(true);
			expect(compat?.supportsReasoningEffort).toBe(true);
		});

		test("applies lmstudio modelOverrides to auto-detected models", async () => {
			writeRawModelsJson({
				lmstudio: {
					modelOverrides: {
						"gpt-oss-20b": {
							name: "GPT OSS 20B (Custom Label)",
							maxTokens: 4096,
						},
					},
				},
			});
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-oss-20b", max_tokens: 8192 }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });

			const detected = registry.find("lmstudio", "gpt-oss-20b");
			expect(detected?.name).toBe("GPT OSS 20B (Custom Label)");
			expect(detected?.maxTokens).toBe(4096);
		});

		test("refresh preserves previously auto-detected lmstudio models", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: [{ id: "gpt-oss-20b" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			await registry.loadAutoDetectedProviders({ force: true });
			expect(registry.find("lmstudio", "gpt-oss-20b")).toBeDefined();

			registry.refresh();

			const refreshed = registry.find("lmstudio", "gpt-oss-20b");
			expect(refreshed).toBeDefined();
			expect(registry.hasConfiguredAuth(refreshed!)).toBe(true);
		});
	});

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some((m) => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("custom models merge behavior", () => {
		test("built-in provider custom models inherit api and baseUrl without explicit fields", () => {
			// Built-in providers already have api/baseUrl on every model, and auth
			// comes from env vars / auth storage. No need to specify them.
			writeRawModelsJson({
				openrouter: {
					models: [
						{
							id: "fake-provider/fake-model",
							name: "Fake model",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();

			const model = registry.find("openrouter", "fake-provider/fake-model");
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-completions");
			expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1");
		});

		test("non-built-in provider custom models still require baseUrl and apiKey", () => {
			writeRawModelsJson({
				"my-custom-provider": {
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toContain("baseUrl");
		});

		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnetModels = models.filter((m) => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				const compat = model.compat as OpenAICompletionsCompat | undefined;
				expect(compat?.supportsUsageInStreaming).toBe(false);
				expect(compat?.supportsStrictMode).toBe(false);
			}
		});

		test("compat schema accepts reasoningEffortMap and supportsStrictMode", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								reasoningEffortMap: {
									minimal: "default",
									high: "max",
								},
								supportsStrictMode: false,
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.reasoningEffortMap).toEqual({ minimal: "default", high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENROUTER_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/openrouter-model",
							name: "Custom OpenRouter Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.some((m) => m.id === "custom/openrouter-model")).toBe(true);
			expect(
				models.some((m) => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet"),
			).toBe(true);
		});

		test("refresh() reloads merged custom models from disk", () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("removing custom models from models.json keeps built-in provider models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Should have both the new routing AND preserve other compat settings
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers at request time", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(sonnet!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-Custom-Model-Header"]).toBe("value");
			}
		});

		test("refresh() picks up model override changes", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			registry.refresh();

			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			registry.refresh();

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("failed registerProvider does not persist invalid streamSimple config", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			expect(() => registry.refresh()).not.toThrow();
		});

		test("failed registerProvider does not remove existing provider models", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			expect(() => registry.refresh()).not.toThrow();
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("anthropic", {
				oauth: {
					name: "Custom Anthropic OAuth",
					login: async () => ({
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			});

			expect(getOAuthProvider("anthropic")?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(getOAuthProvider("anthropic")?.name).not.toBe("Custom Anthropic OAuth");
		});

		test("unregisterProvider removes custom streamSimple override and restores built-in API stream handler", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(true);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("request-time resolution", () => {
			test("command is executed on every provider lookup", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(3);
			});

			test("commands are re-executed across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry1 = ModelRegistry.create(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = ModelRegistry.create(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands resolve independently", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are retried", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const key1 = await registry.getApiKeyForProvider("custom-provider");
				const key2 = await registry.getApiKeyForProvider("custom-provider");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(envVarName),
					});

					const registry = ModelRegistry.create(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("getAvailable does not execute command-backed apiKey resolution", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const available = registry.getAvailable();

				expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(0);
			});

			test("getApiKeyAndHeaders resolves authHeader on every request", async () => {
				const tokenFile = join(tempDir, "token");
				writeFileSync(tokenFile, "token-1");
				const tokenPath = toShPath(tokenFile);

				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
						authHeader: true,
					},
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth1 = await registry.getApiKeyAndHeaders(model!);
				expect(auth1).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});

				writeFileSync(tokenFile, "token-2");

				const auth2 = await registry.getApiKeyAndHeaders(model!);
				expect(auth2).toEqual({
					ok: true,
					apiKey: "token-2",
					headers: { Authorization: "Bearer token-2" },
				});
			});

			test("getApiKeyAndHeaders returns an error for failed authHeader resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!exit 1"),
						authHeader: true,
					},
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth = await registry.getApiKeyAndHeaders(model!);
				expect(auth.ok).toBe(false);
				if (!auth.ok) {
					expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
				}
			});
		});
	});
});
