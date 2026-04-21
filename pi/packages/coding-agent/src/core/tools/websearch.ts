import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const EXA_BASE_URL = "https://mcp.exa.ai";
const EXA_ENDPOINT = "/mcp";
const DEFAULT_NUM_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 25 * 1000;

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(Type.Number({ description: "Number of search results to return (default: 8)" })),
	livecrawl: Type.Optional(
		Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
			description:
				"Live crawl mode: 'fallback' uses cached content first and only crawls live as backup, 'preferred' prioritizes live crawling. Default: 'fallback'.",
		}),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
			description: "Search type: 'auto' balanced (default), 'fast' quick results, 'deep' comprehensive search.",
		}),
	),
	contextMaxCharacters: Type.Optional(
		Type.Number({ description: "Maximum characters for the context string returned to the LLM (default: 10000)" }),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	status?: number;
}

/**
 * Pluggable operations for the websearch tool.
 * Override these to route searches through a different transport or provider.
 */
export interface WebSearchOperations {
	fetch: (
		url: string,
		init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
	) => Promise<Response>;
}

const defaultWebSearchOperations: WebSearchOperations = {
	fetch: (url, init) => fetch(url, init),
};

export interface WebSearchToolOptions {
	/** Custom operations for HTTP requests. Default: global fetch. */
	operations?: WebSearchOperations;
}

interface McpSearchResponse {
	jsonrpc?: string;
	result?: {
		content?: Array<{ type: string; text: string }>;
	};
	error?: { code?: number; message?: string };
}

function shortenQuery(query: string, maxLength = 80): string {
	if (query.length <= maxLength) return query;
	return `${query.slice(0, maxLength - 1)}…`;
}

function formatWebSearchCall(
	args: { query?: string; numResults?: number; type?: string } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const query = str(args?.query);
	const type = str(args?.type);
	const numResults = args?.numResults;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("websearch"))} `;
	text += query === null ? invalidArg : theme.fg("accent", `"${shortenQuery(query || "")}"`);
	const extras: string[] = [];
	if (type) extras.push(type);
	if (numResults !== undefined) extras.push(`n=${numResults}`);
	if (extras.length > 0) text += theme.fg("toolOutput", ` (${extras.join(", ")})`);
	return text;
}

function formatWebSearchResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 15;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	return text;
}

function buildDescription(): string {
	const year = new Date().getFullYear();
	return (
		"Search the web for up-to-date information beyond your training cutoff. " +
		"Returns titles, URLs, publication dates, and content excerpts from the most relevant pages. " +
		"Use this tool when the user asks about current events, recent releases, or anything that may have changed after your training data. " +
		"To read the full content of a URL from the results, use the webfetch tool. " +
		"Live crawl modes: 'fallback' (backup when cached unavailable) or 'preferred' (prioritize live crawling). " +
		"Search types: 'auto' (balanced), 'fast' (quick results), 'deep' (comprehensive search). " +
		`The current year is ${year}. You MUST use this year when searching for recent information or current events (e.g. prefer "AI news ${year}" over "AI news ${year - 1}").`
	);
}

function extractMcpText(payload: McpSearchResponse): string | undefined {
	const content = payload.result?.content;
	if (!content || content.length === 0) return undefined;
	return content[0]?.text;
}

export function createWebSearchToolDefinition(
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails | undefined> {
	const ops = options?.operations ?? defaultWebSearchOperations;
	return {
		name: "websearch",
		label: "websearch",
		description: buildDescription(),
		promptSnippet: "Search the web for up-to-date information",
		parameters: webSearchSchema,
		async execute(
			_toolCallId,
			{
				query,
				numResults,
				livecrawl,
				type,
				contextMaxCharacters,
			}: {
				query: string;
				numResults?: number;
				livecrawl?: "fallback" | "preferred";
				type?: "auto" | "fast" | "deep";
				contextMaxCharacters?: number;
			},
			signal?: AbortSignal,
		) {
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

			const timeoutController = new AbortController();
			const timeoutHandle = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

			let response: Response;
			try {
				response = await ops.fetch(`${EXA_BASE_URL}${EXA_ENDPOINT}`, {
					method: "POST",
					headers: {
						accept: "application/json, text/event-stream",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
					signal: combinedSignal,
				});
			} catch (e: any) {
				clearTimeout(timeoutHandle);
				if (signal?.aborted) throw new Error("Operation aborted");
				if (timeoutController.signal.aborted) throw new Error("Search request timed out");
				throw new Error(`Web search failed: ${e?.message ?? String(e)}`);
			}
			clearTimeout(timeoutHandle);

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				throw new Error(`Search error (${response.status})${errorText ? `: ${errorText}` : ""}`);
			}

			const responseText = await response.text();

			// Parse Server-Sent Events (SSE) response from the MCP endpoint.
			const lines = responseText.split("\n");
			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				let payload: McpSearchResponse;
				try {
					payload = JSON.parse(line.substring(6));
				} catch {
					continue;
				}
				if (payload.error) {
					throw new Error(`Search error: ${payload.error.message ?? "unknown error"}`);
				}
				const text = extractMcpText(payload);
				if (text !== undefined) {
					return {
						content: [{ type: "text", text }],
						details: { status: response.status },
					};
				}
			}

			return {
				content: [{ type: "text", text: "No search results found. Try a different query." }],
				details: { status: response.status },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebSearchResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebSearchTool(options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
