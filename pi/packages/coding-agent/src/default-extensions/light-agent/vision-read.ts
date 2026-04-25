import { resolve } from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	describeImageFallback,
	hasConfiguredVisionFallback,
	supportsImageInput,
	VISION_FALLBACK_MODEL_LABEL,
} from "./vision-fallback.js";

function isImageContent(content: unknown): content is ImageContent {
	return typeof content === "object" && content !== null && (content as { type?: unknown }).type === "image";
}

function isTextContent(content: unknown): content is TextContent {
	return typeof content === "object" && content !== null && (content as { type?: unknown }).type === "text";
}

export function registerVisionRead(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read") return undefined;
		if (supportsImageInput(ctx.model)) return undefined;
		const image = event.content.find(isImageContent);
		if (!image) return undefined;

		const textNote = event.content.find(isTextContent)?.text ?? "Read image file";
		const path =
			typeof (event.input as { path?: unknown }).path === "string" ? (event.input as { path: string }).path : "";
		if (!hasConfiguredVisionFallback(ctx.modelRegistry)) {
			return {
				content: [
					{
						type: "text" as const,
						text: `${textNote}\n[Current model does not support images. The image will be omitted from this request.]\n[Image omitted: no vision-capable model path is configured.]`,
					},
				],
			};
		}

		const absolutePath = path ? resolve(ctx.cwd, path.startsWith("@") ? path.slice(1) : path) : ctx.cwd;
		const description = await describeImageFallback(ctx, image, absolutePath, ctx.signal);
		return {
			content: [
				{
					type: "text" as const,
					text:
						`${textNote}\n` +
						`[Image analyzed with ${VISION_FALLBACK_MODEL_LABEL} because the active model does not support image input.]\n\n` +
						description,
				},
			],
		};
	});
}
