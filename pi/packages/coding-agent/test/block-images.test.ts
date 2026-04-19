import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.js";

// 1x1 red PNG image as base64 (smallest valid PNG)
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("blockImages setting", () => {
	describe("SettingsManager", () => {
		it("should default blockImages to false", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getBlockImages()).toBe(false);
		});

		it("should return true when blockImages is set to true", () => {
			const manager = SettingsManager.inMemory({ images: { blockImages: true } });
			expect(manager.getBlockImages()).toBe(true);
		});

		it("should persist blockImages setting via setBlockImages", () => {
			const manager = SettingsManager.inMemory({});
			expect(manager.getBlockImages()).toBe(false);

			manager.setBlockImages(true);
			expect(manager.getBlockImages()).toBe(true);

			manager.setBlockImages(false);
			expect(manager.getBlockImages()).toBe(false);
		});

		it("should handle blockImages alongside autoResize", () => {
			const manager = SettingsManager.inMemory({
				images: { autoResize: true, blockImages: true },
			});
			expect(manager.getImageAutoResize()).toBe(true);
			expect(manager.getBlockImages()).toBe(true);
		});
	});

	describe("Read tool", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `block-images-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should always read images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const tool = createReadTool(testDir);
			const result = await tool.execute("test-1", { path: imagePath });

			// Should have text note + image content
			expect(result.content.length).toBeGreaterThanOrEqual(1);
			const hasImage = result.content.some((c) => c.type === "image");
			expect(hasImage).toBe(true);
		});

		it("should read text files normally", async () => {
			// Create test text file
			const textPath = join(testDir, "test.txt");
			writeFileSync(textPath, "Hello, world!");

			const tool = createReadTool(testDir);
			const result = await tool.execute("test-2", { path: textPath });

			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			const textContent = result.content[0] as { type: "text"; text: string };
			expect(textContent.text).toContain("Hello, world!");
		});

		it.each([true, false])(
			"should skip fallback vision when no configured fallback model exists (autoResize=%s)",
			async (autoResizeImages) => {
				const imagePath = join(testDir, "test.png");
				writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

				const getApiKeyAndHeaders = vi.fn();
				const fallbackModel = { id: "qwen/qwen3.6-plus", provider: "openrouter" };
				const ctx = {
					model: { input: ["text"] },
					modelRegistry: {
						find: vi.fn().mockReturnValue(fallbackModel),
						hasConfiguredAuth: vi.fn().mockReturnValue(false),
						getApiKeyAndHeaders,
					},
				} as unknown as ExtensionContext;

				const tool = createReadToolDefinition(testDir, {
					autoResizeImages,
					modelRegistry: ctx.modelRegistry,
				});
				const result = await tool.execute("test-missing-fallback", { path: imagePath }, undefined, undefined, ctx);

				expect(ctx.modelRegistry.find).toHaveBeenCalled();
				expect(ctx.modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled();
				expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
				expect(result.content).toHaveLength(1);
				expect(result.content[0].type).toBe("text");
				expect((result.content[0] as { type: "text"; text: string }).text).toContain(
					"Image omitted: no vision-capable model path is configured.",
				);
			},
		);

		it("should not advertise or invoke fallback vision for text-only fallback models", async () => {
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const getApiKeyAndHeaders = vi.fn();
			const fallbackModel = { id: "qwen/qwen3.6-plus", provider: "openrouter", input: ["text"] };
			const modelRegistry = {
				find: vi.fn().mockReturnValue(fallbackModel),
				hasConfiguredAuth: vi.fn().mockReturnValue(true),
				getApiKeyAndHeaders,
			};
			const ctx = {
				model: { input: ["text"] },
				modelRegistry,
			} as unknown as ExtensionContext;

			const tool = createReadToolDefinition(testDir, {
				autoResizeImages: false,
				currentModel: ctx.model as any,
				modelRegistry: modelRegistry as any,
			});

			expect(tool.description).toBe(
				"Read the contents of a file. Supports text files. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
			);

			const result = await tool.execute("test-text-only-fallback", { path: imagePath }, undefined, undefined, ctx);

			expect(modelRegistry.find).toHaveBeenCalled();
			expect(modelRegistry.hasConfiguredAuth).not.toHaveBeenCalled();
			expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as { type: "text"; text: string }).text).toContain(
				"Image omitted: no vision-capable model path is configured.",
			);
		});

		it("should honor model-aware execution semantics in createReadTool without an AgentSession", async () => {
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const modelRegistry = {
				find: vi.fn().mockReturnValue(undefined),
				hasConfiguredAuth: vi.fn().mockReturnValue(false),
				getApiKeyAndHeaders: vi.fn(),
			};
			const tool = createReadTool(testDir, {
				autoResizeImages: false,
				currentModel: { input: ["text"] } as any,
				modelRegistry: modelRegistry as any,
			});

			expect(tool.description).toBe(
				"Read the contents of a file. Supports text files. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
			);

			const result = await tool.execute("test-create-read-tool-context", { path: imagePath });

			expect(modelRegistry.find).toHaveBeenCalled();
			expect(result.content).toHaveLength(1);
			expect(result.content[0].type).toBe("text");
			expect((result.content[0] as { type: "text"; text: string }).text).toContain(
				"Image omitted: no vision-capable model path is configured.",
			);
			expect(result.content.some((c) => c.type === "image")).toBe(false);
		});
	});

	describe("processFileArguments", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `block-images-process-test-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("should always process images (filtering happens at convertToLlm layer)", async () => {
			// Create test image
			const imagePath = join(testDir, "test.png");
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

			const result = await processFileArguments([imagePath]);

			expect(result.images).toHaveLength(1);
			expect(result.images[0].type).toBe("image");
		});

		it("should process text files normally", async () => {
			// Create test text file
			const textPath = join(testDir, "test.txt");
			writeFileSync(textPath, "Hello, world!");

			const result = await processFileArguments([textPath]);

			expect(result.images).toHaveLength(0);
			expect(result.text).toContain("Hello, world!");
		});
	});
});
