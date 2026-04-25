import type { Context, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "Mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createContext(): Context {
	return {
		messages: [],
		tools: [],
	};
}

function createSseResponse(events: string[]): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${event}\n\n`));
			}
			controller.close();
		},
	});

	return new Response(body, { status: 200 });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it("serializes provider retry controls for the proxy server", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			createSseResponse([
				JSON.stringify({ type: "start" }),
				JSON.stringify({
					type: "done",
					reason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			]),
		);
		vi.stubGlobal("fetch", fetchMock);

		const stream = streamProxy(createModel(), createContext(), {
			authToken: "token",
			proxyUrl: "https://proxy.example",
			timeoutMs: 30_000,
			maxRetries: 0,
			maxRetryDelayMs: 45_000,
		});

		await stream.result();

		const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
			options: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
		};
		expect(body.options.timeoutMs).toBe(30_000);
		expect(body.options.maxRetries).toBe(0);
		expect(body.options.maxRetryDelayMs).toBe(45_000);
	});
});
