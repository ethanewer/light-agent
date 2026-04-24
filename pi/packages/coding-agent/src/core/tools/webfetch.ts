import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 30 * 1000; // 30 seconds
const MAX_TIMEOUT_MS = 120 * 1000; // 2 minutes
const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from (must start with http:// or https://)" }),
	format: Type.Optional(
		Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
			description: "Format to return the content in. Defaults to 'markdown'.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (max 120, default 30)" })),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	truncation?: TruncationResult;
	status?: number;
	contentType?: string;
}

/**
 * Pluggable operations for the webfetch tool.
 * Override these to delegate HTTP fetching to a custom transport.
 */
export interface WebFetchOperations {
	fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
}

const defaultWebFetchOperations: WebFetchOperations = {
	fetch: (url, init) => fetch(url, init),
};

export interface WebFetchToolOptions {
	/** Custom operations for HTTP fetching. Default: global fetch. */
	operations?: WebFetchOperations;
}

function shortenUrl(url: string, maxLength = 80): string {
	if (url.length <= maxLength) return url;
	return `${url.slice(0, maxLength - 1)}…`;
}

function formatWebFetchCall(
	args: { url?: string; format?: string; timeout?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const url = str(args?.url);
	const format = str(args?.format);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("webfetch"))} `;
	text += url === null ? invalidArg : theme.fg("accent", shortenUrl(url || ""));
	if (format) text += theme.fg("toolOutput", ` (${format})`);
	return text;
}

function formatWebFetchResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: WebFetchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated: ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	return text;
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

function getAbortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function readChunkWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
	if (signal.aborted) {
		return Promise.reject(getAbortError(signal));
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(getAbortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function readResponseBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (!response.body) {
		return new Uint8Array();
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			const { done, value } = await readChunkWithAbort(reader, signal);
			if (done) break;
			if (!value) continue;

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(`Response too large (exceeds ${maxBytes / (1024 * 1024)}MB limit)`);
			}
			chunks.push(value);
		}
	} catch (error) {
		if (signal.aborted) {
			await reader.cancel().catch(() => {});
		}
		throw error;
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
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
	// Remove script/style/noscript/iframe/object/embed blocks entirely (including content).
	const withoutBlocks = html.replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
	// Strip remaining tags.
	const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
	// Decode a handful of common HTML entities.
	const decoded = withoutTags
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
	// Collapse excess whitespace while preserving paragraph breaks.
	return decoded
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function createWebFetchToolDefinition(
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails | undefined> {
	const ops = options?.operations ?? defaultWebFetchOperations;
	return {
		name: "webfetch",
		label: "webfetch",
		description: `Fetch content from a URL and return it as markdown, text, or HTML. Use this to read documentation, API references, blog posts, or any web page. The URL must start with http:// or https://. Format options: "markdown" (default, HTML converted to readable markdown), "text" (tags stripped), or "html" (raw). Output is truncated to ${DEFAULT_MAX_BYTES / 1024}KB; responses larger than 5MB are rejected. Read-only: does not modify any files.`,
		promptSnippet: "Fetch content from a URL as markdown, text, or HTML",
		parameters: webFetchSchema,
		async execute(
			_toolCallId,
			{ url, format, timeout }: { url: string; format?: "text" | "markdown" | "html"; timeout?: number },
			signal?: AbortSignal,
		) {
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}

			const effectiveFormat: "text" | "markdown" | "html" = format ?? "markdown";
			const timeoutMs = Math.min(Math.max((timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, 1000), MAX_TIMEOUT_MS);

			const timeoutController = new AbortController();
			const timeoutHandle = setTimeout(
				() => timeoutController.abort(new Error(`Request timed out after ${timeoutMs / 1000}s`)),
				timeoutMs,
			);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

			const headers: Record<string, string> = {
				"User-Agent": DEFAULT_USER_AGENT,
				Accept: buildAcceptHeader(effectiveFormat),
				"Accept-Language": "en-US,en;q=0.9",
			};

			let response: Response;
			try {
				const initial = await ops.fetch(url, { headers, signal: combinedSignal });
				// Retry with an honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch).
				response =
					initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
						? await ops.fetch(url, { headers: { ...headers, "User-Agent": "pi" }, signal: combinedSignal })
						: initial;
			} catch (e: any) {
				clearTimeout(timeoutHandle);
				if (signal?.aborted) throw new Error("Operation aborted");
				if (timeoutController.signal.aborted) throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
				throw new Error(`Failed to fetch ${url}: ${e?.message ?? String(e)}`);
			}

			let bodyBytes: Uint8Array;
			try {
				if (!response.ok) {
					throw new Error(`Request failed with status ${response.status}`);
				}

				const declaredLength = response.headers.get("content-length");
				if (declaredLength && Number.parseInt(declaredLength, 10) > MAX_RESPONSE_SIZE) {
					throw new Error(`Response too large (exceeds ${MAX_RESPONSE_SIZE / (1024 * 1024)}MB limit)`);
				}

				bodyBytes = await readResponseBytes(response, MAX_RESPONSE_SIZE, combinedSignal);
			} catch (e) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (timeoutController.signal.aborted) throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
				throw e;
			} finally {
				clearTimeout(timeoutHandle);
			}

			const contentType = response.headers.get("content-type") ?? "";
			const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
			const isImage = mime.startsWith("image/") && mime !== "image/svg+xml";

			if (isImage) {
				const base64 = Buffer.from(bodyBytes).toString("base64");
				return {
					content: [
						{ type: "text", text: `Fetched image from ${url} [${mime}]` },
						{ type: "image", data: base64, mimeType: mime },
					],
					details: { status: response.status, contentType },
				};
			}

			const bodyText = new TextDecoder().decode(bodyBytes);
			let rendered: string;
			switch (effectiveFormat) {
				case "markdown":
					rendered = contentType.includes("text/html") ? convertHtmlToMarkdown(bodyText) : bodyText;
					break;
				case "text":
					rendered = contentType.includes("text/html") ? stripHtmlToText(bodyText) : bodyText;
					break;
				case "html":
					rendered = bodyText;
					break;
			}

			const truncation = truncateHead(rendered);
			let outputText = truncation.content;
			const details: WebFetchToolDetails = { status: response.status, contentType };
			if (truncation.truncated) {
				details.truncation = truncation;
				if (truncation.firstLineExceedsLimit) {
					outputText = `[First line exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Try a different format or fetch a smaller URL.]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines} line limit)]`;
				} else {
					outputText += `\n\n[Truncated: ${truncation.outputLines} lines shown (${formatSize(DEFAULT_MAX_BYTES)} limit)]`;
				}
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createWebFetchTool(options?: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(options));
}
