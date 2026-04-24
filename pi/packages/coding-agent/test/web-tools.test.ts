import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../src/core/tools/webfetch.js";
import { createWebSearchTool } from "../src/core/tools/websearch.js";
import {
	createWebFetchToolDefinition as createRootWebFetchToolDefinition,
	createWebSearchToolDefinition as createRootWebSearchToolDefinition,
} from "../src/index.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function mockResponse(init: {
	body: string | ArrayBuffer;
	status?: number;
	headers?: Record<string, string>;
}): Response {
	const body = typeof init.body === "string" ? init.body : new Uint8Array(init.body);
	return new Response(body, {
		status: init.status ?? 200,
		headers: init.headers,
	});
}

describe("webfetch tool", () => {
	it("rejects URLs that are not http(s)", async () => {
		const tool = createWebFetchTool({
			operations: {
				fetch: async () => mockResponse({ body: "nope" }),
			},
		});
		await expect(tool.execute("wf-1", { url: "ftp://example.com" })).rejects.toThrow(/must start with http/);
	});

	it("converts HTML to markdown by default", async () => {
		const tool = createWebFetchTool({
			operations: {
				fetch: async () =>
					mockResponse({
						body: "<html><body><h1>Title</h1><p>hello <strong>world</strong></p></body></html>",
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
			},
		});
		const result = await tool.execute("wf-2", { url: "https://example.com/page" });
		const output = getTextOutput(result);
		expect(output).toContain("# Title");
		expect(output).toContain("**world**");
	});

	it("strips HTML to text when format=text", async () => {
		const tool = createWebFetchTool({
			operations: {
				fetch: async () =>
					mockResponse({
						body:
							"<html><head><style>body{color:red}</style></head><body>" +
							"<script>alert(1)</script><p>Paragraph &amp; text.</p></body></html>",
						headers: { "content-type": "text/html" },
					}),
			},
		});
		const result = await tool.execute("wf-3", {
			url: "https://example.com/page",
			format: "text",
		});
		const output = getTextOutput(result);
		expect(output).toContain("Paragraph & text.");
		expect(output).not.toContain("alert(1)");
		expect(output).not.toContain("color:red");
	});

	it("returns raw HTML when format=html", async () => {
		const html = "<p>raw <em>html</em></p>";
		const tool = createWebFetchTool({
			operations: {
				fetch: async () => mockResponse({ body: html, headers: { "content-type": "text/html" } }),
			},
		});
		const result = await tool.execute("wf-4", { url: "https://example.com", format: "html" });
		expect(getTextOutput(result)).toContain(html);
	});

	it("returns images as image content blocks", async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const tool = createWebFetchTool({
			operations: {
				fetch: async () =>
					mockResponse({
						body: pngBytes.buffer,
						headers: { "content-type": "image/png" },
					}),
			},
		});
		const result = await tool.execute("wf-5", { url: "https://example.com/logo.png" });
		expect(result.content).toHaveLength(2);
		expect(result.content[0].type).toBe("text");
		expect(result.content[1].type).toBe("image");
		expect((result.content[1] as any).mimeType).toBe("image/png");
	});

	it("throws on non-ok HTTP status", async () => {
		const tool = createWebFetchTool({
			operations: {
				fetch: async () => mockResponse({ body: "boom", status: 500 }),
			},
		});
		await expect(tool.execute("wf-6", { url: "https://example.com" })).rejects.toThrow(/500/);
	});

	it("rejects streamed bodies above the size limit without content-length", async () => {
		const tool = createWebFetchTool({
			operations: {
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/plain" } },
					),
			},
		});

		await expect(tool.execute("wf-7", { url: "https://example.com/large" })).rejects.toThrow(/too large/);
	});

	it("times out while reading a stalled body", async () => {
		vi.useFakeTimers();
		try {
			const tool = createWebFetchTool({
				operations: {
					fetch: async () =>
						new Response(
							new ReadableStream<Uint8Array>({
								pull: () => new Promise(() => {}),
							}),
							{ headers: { "content-type": "text/plain" } },
						),
				},
			});

			const result = expect(tool.execute("wf-8", { url: "https://example.com/slow", timeout: 1 })).rejects.toThrow(
				/timed out/,
			);
			await vi.advanceTimersByTimeAsync(1000);
			await result;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("websearch tool", () => {
	it("parses SSE MCP responses and returns the first content block", async () => {
		const sse = `event: message\ndata: ${JSON.stringify({
			jsonrpc: "2.0",
			result: { content: [{ type: "text", text: "result body" }] },
		})}\n\n`;
		let capturedBody: any = null;
		const tool = createWebSearchTool({
			operations: {
				fetch: async (_url, init) => {
					capturedBody = JSON.parse(init.body);
					return mockResponse({ body: sse, headers: { "content-type": "text/event-stream" } });
				},
			},
		});
		const result = await tool.execute("ws-1", { query: "test query", numResults: 3, type: "fast" });
		expect(getTextOutput(result)).toBe("result body");
		expect(capturedBody.params.arguments.query).toBe("test query");
		expect(capturedBody.params.arguments.numResults).toBe(3);
		expect(capturedBody.params.arguments.type).toBe("fast");
		expect(capturedBody.params.arguments.livecrawl).toBe("fallback");
	});

	it("surfaces MCP error payloads", async () => {
		const sse = `data: ${JSON.stringify({
			jsonrpc: "2.0",
			error: { code: -32000, message: "bad query" },
		})}\n\n`;
		const tool = createWebSearchTool({
			operations: {
				fetch: async () => mockResponse({ body: sse }),
			},
		});
		await expect(tool.execute("ws-2", { query: "anything" })).rejects.toThrow(/bad query/);
	});

	it("throws on HTTP errors", async () => {
		const tool = createWebSearchTool({
			operations: {
				fetch: async () => mockResponse({ body: "upstream error", status: 502 }),
			},
		});
		await expect(tool.execute("ws-3", { query: "hi" })).rejects.toThrow(/502/);
	});

	it("returns a friendly message when no results are present", async () => {
		const sse = `data: ${JSON.stringify({ jsonrpc: "2.0", result: { content: [] } })}\n\n`;
		const tool = createWebSearchTool({
			operations: {
				fetch: async () => mockResponse({ body: sse }),
			},
		});
		const result = await tool.execute("ws-4", { query: "obscure" });
		expect(getTextOutput(result)).toMatch(/No search results/i);
	});

	it("times out while reading a stalled search response", async () => {
		vi.useFakeTimers();
		try {
			const tool = createWebSearchTool({
				operations: {
					fetch: async () =>
						new Response(
							new ReadableStream<Uint8Array>({
								pull: () => new Promise(() => {}),
							}),
							{ headers: { "content-type": "text/event-stream" } },
						),
				},
			});

			const result = expect(tool.execute("ws-5", { query: "anything" })).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(25_000);
			await result;
		} finally {
			vi.useRealTimers();
		}
	});

	it("mentions the current year in its description", () => {
		const tool = createWebSearchTool();
		const year = new Date().getFullYear().toString();
		expect(tool.description).toContain(year);
	});
});

describe("web tool package exports", () => {
	it("exports web tool definitions from the package root", () => {
		expect(createRootWebFetchToolDefinition().name).toBe("webfetch");
		expect(createRootWebSearchToolDefinition().name).toBe("websearch");
	});
});
