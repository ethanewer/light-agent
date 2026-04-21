import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastClientOptions: undefined as Record<string, unknown> | undefined,
	lastParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: Record<string, unknown>) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: Record<string, unknown>) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "resp_123",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions internal request model id", () => {
	beforeEach(() => {
		mockState.lastClientOptions = undefined;
		mockState.lastParams = undefined;
	});

	it("uses the internal request model id for the payload and strips it from headers", async () => {
		const model: Model<"openai-completions"> = {
			id: "quinn-3.5-9b#gguf-q4",
			name: "Quinn 3.5 9B (GGUF, 4-bit)",
			api: "openai-completions",
			provider: "lmstudio",
			baseUrl: "http://127.0.0.1:1234/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			headers: {
				"x-pi-lmstudio-request-model-id": "quinn-3.5-9b",
				"X-Test": "yes",
			},
		};

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "hello",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(mockState.lastParams?.model).toBe("quinn-3.5-9b");
		expect(mockState.lastClientOptions?.defaultHeaders).toEqual({ "X-Test": "yes" });
	});
});
