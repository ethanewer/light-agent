import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { convertMessages, streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	OpenAICompletionsCompat,
	Usage,
} from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const deepseekCompat = {
	supportsStore: true,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	reasoningEffortMap: { minimal: "high", low: "high", medium: "high", high: "high", xhigh: "max" },
	supportsUsageInStreaming: true,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: false,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

const deepseekModel: Model<"openai-completions"> = {
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 384000,
	compat: deepseekCompat,
};

function buildAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: emptyUsage,
		stopReason,
		timestamp: 1,
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("DeepSeek OpenAI-compatible replay", () => {
	it("preserves reasoning_content and uses empty content for assistant tool calls", () => {
		const messages = convertMessages(
			deepseekModel,
			{
				messages: [
					buildAssistant(
						[
							{ type: "thinking", thinking: "plan", thinkingSignature: "reasoning_content" },
							{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "x" } },
						],
						"toolUse",
					),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "lookup",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			deepseekCompat,
		);

		const assistant = messages[0] as Record<string, unknown>;
		expect(assistant.role).toBe("assistant");
		expect(assistant.content).toBe("");
		expect(assistant.reasoning_content).toBe("plan");
		expect(assistant.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: {
					name: "lookup",
					arguments: JSON.stringify({ query: "x" }),
				},
			},
		]);
	});

	it("adds empty reasoning_content to replayed assistant text messages", () => {
		const messages = convertMessages(
			deepseekModel,
			{
				messages: [buildAssistant([{ type: "text", text: "done" }], "stop")],
			},
			deepseekCompat,
		);

		const assistant = messages[0] as Record<string, unknown>;
		expect(assistant.content).toBe("done");
		expect(assistant.reasoning_content).toBe("");
	});

	it("sends DeepSeek max_tokens and thinking controls", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		const server = http.createServer(async (req, res) => {
			if (req.method !== "POST" || req.url !== "/chat/completions") {
				res.writeHead(404).end();
				return;
			}

			let body = "";
			for await (const chunk of req) {
				body += chunk.toString();
			}
			requestBodies.push(JSON.parse(body) as Record<string, unknown>);

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-deepseek",
					object: "chat.completion.chunk",
					created: 0,
					model: "deepseek-v4-pro",
					choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
					usage: null,
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-deepseek",
					object: "chat.completion.chunk",
					created: 0,
					model: "deepseek-v4-pro",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			const model = { ...deepseekModel, baseUrl: `http://127.0.0.1:${port}` };
			const context: Context = {
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
				tools: [],
			};

			await collectEvents(
				streamOpenAICompletions(model, context, {
					apiKey: "test-key",
					maxTokens: 1234,
					reasoningEffort: "xhigh",
				}),
			);

			expect(requestBodies).toHaveLength(1);
			expect(requestBodies[0]?.max_tokens).toBe(1234);
			expect(requestBodies[0]?.max_completion_tokens).toBeUndefined();
			expect(requestBodies[0]?.thinking).toEqual({ type: "enabled" });
			expect(requestBodies[0]?.reasoning_effort).toBe("max");
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
