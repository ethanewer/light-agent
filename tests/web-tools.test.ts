import assert from "node:assert/strict";
import test from "node:test";

import {
	createWebFetchToolDefinition,
	createWebSearchToolDefinition,
	truncateToolText,
} from "../extensions/light-agent/web-tools.ts";

test("truncateToolText enforces byte and line limits", () => {
	assert.equal(truncateToolText("one\ntwo\nthree", 1024, 2), "one\ntwo\n\n[Truncated: showing 2 of 3 lines, 1KB limit]");
	assert.equal(truncateToolText("abc", 1024, 2), "abc");
});

test("truncateToolText keeps a prefix of an oversized first line", () => {
	const result = truncateToolText("abcdef", 3, 20);
	assert.equal(result, "abc\n\n[Truncated: showing 1 of 1 lines, 0.0029296875KB limit]");
});

test("webfetch rejects non-http URLs before making a request", async () => {
	const tool = createWebFetchToolDefinition({
		operations: {
			fetch: async () => {
				throw new Error("fetch should not run");
			},
		},
	});

	await assert.rejects(
		() => (tool.execute as any)("call-1", { url: "file:///tmp/secret" }, undefined, undefined, {}),
		/URL must start with http:\/\/ or https:\/\//,
	);
});

test("webfetch converts HTML responses to markdown", async () => {
	const tool = createWebFetchToolDefinition({
		operations: {
			fetch: async () =>
				new Response("<html><body><h1>Hello</h1><p>World</p><script>ignored()</script></body></html>", {
					headers: { "content-type": "text/html; charset=utf-8" },
					status: 200,
				}),
		},
	});

	const result = await (tool.execute as any)("call-1", { url: "https://example.com" }, undefined, undefined, {});
	assert.equal(result.details.status, 200);
	assert.match(result.content[0].text, /# Hello/);
	assert.match(result.content[0].text, /World/);
	assert.doesNotMatch(result.content[0].text, /ignored/);
});

test("websearch parses MCP server-sent event payloads", async () => {
	const tool = createWebSearchToolDefinition({
		operations: {
			fetch: async (_url, init) => {
				assert.equal(init.method, "POST");
				const body = JSON.parse(init.body);
				assert.equal(body.params.arguments.query, "pi extensions");
				return new Response('event: message\ndata: {"result":{"content":[{"type":"text","text":"Result text"}]}}\n\n', {
					headers: { "content-type": "text/event-stream" },
					status: 200,
				});
			},
		},
	});

	const result = await (tool.execute as any)("call-1", { query: "pi extensions" }, undefined, undefined, {});
	assert.equal(result.details.status, 200);
	assert.deepEqual(result.content, [{ type: "text", text: "Result text" }]);
});
