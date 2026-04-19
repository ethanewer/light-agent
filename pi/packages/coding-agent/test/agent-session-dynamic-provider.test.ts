import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import type { ExtensionFactory } from "../src/core/sdk.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFn = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("refreshes read tool metadata when fallback provider availability changes at runtime", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");

		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", {
					baseUrl: "http://localhost:8080/text-only-anthropic",
					apiKey: "test-key",
					api: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Text-Only Claude",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				});
				pi.registerCommand("enable-vision-fallback", {
					description: "Enable fallback vision provider",
					handler: async () => {
						pi.registerProvider("openrouter", {
							baseUrl: "http://localhost:8080/openrouter",
							apiKey: "openrouter-test-key",
							api: "openai-completions",
							models: [
								{
									id: "qwen/qwen3.6-plus",
									name: "Vision Fallback",
									reasoning: false,
									input: ["text", "image"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 4096,
								},
							],
						});
					},
				});
				pi.registerCommand("disable-vision-fallback", {
					description: "Disable fallback vision provider",
					handler: async () => {
						pi.unregisterProvider("openrouter");
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/disable-vision-fallback");

		const disabledInitiallyReadTool = session.getAllTools().find((tool) => tool.name === "read");
		expect(disabledInitiallyReadTool?.description).toBe(
			"Read the contents of a file. Supports text files. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		);

		await session.prompt("/enable-vision-fallback");

		const enabledReadTool = session.getAllTools().find((tool) => tool.name === "read");
		expect(enabledReadTool?.description).toContain(
			"For image files (jpg, png, gif, webp), a text description of the image is returned.",
		);

		await session.prompt("/disable-vision-fallback");

		const disabledReadTool = session.getAllTools().find((tool) => tool.name === "read");
		expect(disabledReadTool?.description).toBe(
			"Read the contents of a file. Supports text files. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		);

		session.dispose();
	});

	it("refreshes read tool metadata when fallback auth changes at runtime", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "");

		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", {
					baseUrl: "http://localhost:8080/text-only-anthropic",
					apiKey: "test-key",
					api: "anthropic",
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Text-Only Claude",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				});
			},
		]);

		const readTool = () => session.agent.state.tools.find((tool) => tool.name === "read");

		expect(readTool()?.description).toBe(
			"Read the contents of a file. Supports text files. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		);

		session.modelRegistry.authStorage.setRuntimeApiKey("openrouter", "runtime-openrouter-key");
		session.refreshModelRegistryState();

		expect(readTool()?.description).toContain(
			"For image files (jpg, png, gif, webp), a text description of the image is returned.",
		);

		session.modelRegistry.authStorage.removeRuntimeApiKey("openrouter");
		session.refreshModelRegistryState();

		expect(readTool()?.description).toBe(
			"Read the contents of a file. Supports text files. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		);

		session.dispose();
	});
});
