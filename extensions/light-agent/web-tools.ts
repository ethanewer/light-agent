import type { ImageContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 100 * 1024;
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_FETCH_TIMEOUT_MS = 120 * 1000;
const DEFAULT_SEARCH_TIMEOUT_MS = 25 * 1000;
const DEFAULT_NUM_RESULTS = 8;
const EXA_BASE_URL = "https://mcp.exa.ai";
const EXA_ENDPOINT = "/mcp";
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from (must start with http:// or https://)" }),
	format: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
			description: "Format to return. Defaults to markdown.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (max 120, default 30)" })),
});

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(Type.Number({ description: "Number of search results to return (default: 8)" })),
	livecrawl: Type.Optional(
		Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
			description: "Live crawl mode. Defaults to fallback.",
		}),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
			description: "Search type. Defaults to auto.",
		}),
	),
	contextMaxCharacters: Type.Optional(Type.Number({ description: "Maximum characters returned in context" })),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;
export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebFetchOperations {
	fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response>;
}

export interface WebSearchOperations {
	fetch(
		url: string,
		init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
	): Promise<Response>;
}

export interface WebFetchToolOptions {
	operations?: WebFetchOperations;
}

export interface WebSearchToolOptions {
	operations?: WebSearchOperations;
}

interface McpSearchResponse {
	jsonrpc?: string;
	result?: {
		content?: Array<{ type: string; text: string }>;
	};
	error?: { code?: number; message?: string };
}

const defaultWebFetchOperations: WebFetchOperations = {
	fetch: (url, init) => fetch(url, init),
};

const defaultWebSearchOperations: WebSearchOperations = {
	fetch: (url, init) => fetch(url, init),
};

function timeoutSignal(timeoutMs: number, message: string, parent?: AbortSignal): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const timeoutHandle = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
	const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
	return {
		signal,
		dispose: () => clearTimeout(timeoutHandle),
	};
}

function getAbortMessage(signal: AbortSignal | undefined): string | undefined {
	if (signal?.aborted) return "Operation aborted";
	return undefined;
}

function buildAcceptHeader(format: "text" | "markdown" | "html"): string {
	switch (format) {
		case "markdown":
			return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
		case "text":
			return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
		case "html":
			return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
	}
}

async function readResponseBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	const body = response.body;
	if (!body) return new Uint8Array();

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new Error(`Response too large (exceeds ${maxBytes / (1024 * 1024)}MB limit)`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function convertHtmlToMarkdown(html: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	turndown.remove(["script", "style", "meta", "link"]);
	return turndown.turndown(html);
}

function stripHtmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export function truncateToolText(text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): string {
	const lines = text.split("\n");
	let output = "";
	let outputLines = 0;
	for (const line of lines) {
		if (outputLines >= maxLines) break;
		const separator = output ? "\n" : "";
		const candidate = `${output}${separator}${line}`;
		if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
			const usedBytes = Buffer.byteLength(`${output}${separator}`, "utf8");
			const remainingBytes = maxBytes - usedBytes;
			if (remainingBytes > 0) {
				output = `${output}${separator}${truncateUtf8(line, remainingBytes)}`;
				outputLines++;
			}
			break;
		}
		output = candidate;
		outputLines++;
	}
	if (outputLines < lines.length || Buffer.byteLength(text, "utf8") > maxBytes) {
		return `${output}\n\n[Truncated: showing ${outputLines} of ${lines.length} lines, ${maxBytes / 1024}KB limit]`;
	}
	return output;
}

function truncateUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

export function createWebFetchToolDefinition(options?: WebFetchToolOptions): ToolDefinition<typeof webFetchSchema> {
	const ops = options?.operations ?? defaultWebFetchOperations;
	return {
		name: "webfetch",
		label: "webfetch",
		description: `Fetch content from a URL and return it as markdown, text, or HTML. The URL must start with http:// or https://. Format options: markdown (default), text, or html. Output is truncated to ${DEFAULT_MAX_BYTES / 1024}KB; responses larger than 5MB are rejected.`,
		promptSnippet: "Fetch content from a URL as markdown, text, or HTML",
		promptGuidelines: ["Use webfetch to read the full content of specific URLs, especially URLs returned by websearch."],
		parameters: webFetchSchema,
		async execute(
			_toolCallId,
			{ url, format, timeout }: WebFetchToolInput,
			signal?: AbortSignal,
		): Promise<{
			content: ({ type: "text"; text: string } | ImageContent)[];
			details: { status: number; contentType: string };
		}> {
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			const effectiveFormat = format ?? "markdown";
			const timeoutMs = Math.min(Math.max((timeout ?? DEFAULT_FETCH_TIMEOUT_MS / 1000) * 1000, 1000), MAX_FETCH_TIMEOUT_MS);
			const timeoutMessage = `Request timed out after ${timeoutMs / 1000}s`;
			const abort = timeoutSignal(timeoutMs, timeoutMessage, signal);

			const headers: Record<string, string> = {
				"User-Agent": DEFAULT_USER_AGENT,
				Accept: buildAcceptHeader(effectiveFormat),
				"Accept-Language": "en-US,en;q=0.9",
			};

			try {
				let response = await ops.fetch(url, { headers, signal: abort.signal });
				if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
					response = await ops.fetch(url, { headers: { ...headers, "User-Agent": "pi" }, signal: abort.signal });
				}
				if (!response.ok) throw new Error(`Request failed with status ${response.status}`);

				const declaredLength = response.headers.get("content-length");
				if (declaredLength && Number.parseInt(declaredLength, 10) > MAX_RESPONSE_SIZE) {
					throw new Error(`Response too large (exceeds ${MAX_RESPONSE_SIZE / (1024 * 1024)}MB limit)`);
				}

				const bodyBytes = await readResponseBytes(response, MAX_RESPONSE_SIZE, abort.signal);
				const contentType = response.headers.get("content-type") ?? "";
				const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

				if (mime.startsWith("image/") && mime !== "image/svg+xml") {
					return {
						content: [
							{ type: "text", text: `Fetched image from ${url} [${mime}]` },
							{ type: "image", data: Buffer.from(bodyBytes).toString("base64"), mimeType: mime },
						],
						details: { status: response.status, contentType },
					};
				}

				const bodyText = new TextDecoder().decode(bodyBytes);
				const rendered =
					effectiveFormat === "markdown" && contentType.includes("text/html")
						? convertHtmlToMarkdown(bodyText)
						: effectiveFormat === "text" && contentType.includes("text/html")
							? stripHtmlToText(bodyText)
							: bodyText;

				return {
					content: [{ type: "text", text: truncateToolText(rendered) }],
					details: { status: response.status, contentType },
				};
			} catch (error) {
				const abortMessage = getAbortMessage(signal);
				if (abortMessage) throw new Error(abortMessage);
				if (abort.signal.aborted) throw new Error(timeoutMessage);
				throw error;
			} finally {
				abort.dispose();
			}
		},
	};
}

function buildSearchDescription(): string {
	const year = new Date().getFullYear();
	return (
		"Search the web for up-to-date information beyond the model training cutoff. " +
		"Returns titles, URLs, publication dates, and excerpts from relevant pages. " +
		"Use webfetch to read full content from result URLs. " +
		`The current year is ${year}; include it in searches for recent information when useful.`
	);
}

function extractMcpText(payload: McpSearchResponse): string | undefined {
	const content = payload.result?.content;
	return content?.[0]?.text;
}

export function createWebSearchToolDefinition(options?: WebSearchToolOptions): ToolDefinition<typeof webSearchSchema> {
	const ops = options?.operations ?? defaultWebSearchOperations;
	return {
		name: "websearch",
		label: "websearch",
		description: buildSearchDescription(),
		promptSnippet: "Search the web for up-to-date information",
		promptGuidelines: [
			"Use websearch when the user asks about current events, recent releases, prices, schedules, or anything likely to have changed.",
		],
		parameters: webSearchSchema,
		async execute(
			_toolCallId,
			{ query, numResults, livecrawl, type, contextMaxCharacters }: WebSearchToolInput,
			signal?: AbortSignal,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: { status: number } }> {
			const body = {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "web_search_exa",
					arguments: {
						query,
						type: type ?? "auto",
						numResults: numResults ?? DEFAULT_NUM_RESULTS,
						livecrawl: livecrawl ?? "fallback",
						...(contextMaxCharacters !== undefined ? { contextMaxCharacters } : {}),
					},
				},
			};

			const timeoutMessage = "Search request timed out";
			const abort = timeoutSignal(DEFAULT_SEARCH_TIMEOUT_MS, timeoutMessage, signal);
			try {
				const response = await ops.fetch(`${EXA_BASE_URL}${EXA_ENDPOINT}`, {
					method: "POST",
					headers: {
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal: abort.signal,
				});
				const responseText = new TextDecoder().decode(await readResponseBytes(response, MAX_RESPONSE_SIZE, abort.signal));
				if (!response.ok) throw new Error(`Search error (${response.status})${responseText ? `: ${responseText}` : ""}`);

				for (const line of responseText.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = JSON.parse(line.substring(6)) as McpSearchResponse;
					if (payload.error) throw new Error(`Search error: ${payload.error.message ?? "unknown error"}`);
					const text = extractMcpText(payload);
					if (text !== undefined) return { content: [{ type: "text", text }], details: { status: response.status } };
				}
				return { content: [{ type: "text", text: "No search results found. Try a different query." }], details: { status: response.status } };
			} catch (error) {
				const abortMessage = getAbortMessage(signal);
				if (abortMessage) throw new Error(abortMessage);
				if (abort.signal.aborted) throw new Error(timeoutMessage);
				throw error;
			} finally {
				abort.dispose();
			}
		},
	};
}

export function registerWebTools(pi: ExtensionAPI): void {
	pi.registerTool(createWebFetchToolDefinition());
	pi.registerTool(createWebSearchToolDefinition());
}
