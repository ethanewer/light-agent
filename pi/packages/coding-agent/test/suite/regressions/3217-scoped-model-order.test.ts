import { setKeybindings, type TUI } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { ScopedModelsSelectorComponent } from "../../../src/modes/interactive/components/scoped-models-selector.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("issue #3217 scoped model ordering", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("propagates reordered scoped models back to the session state", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const orderedIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: orderedIds,
			},
			{
				onChange: (enabledModelIds) => {
					changes.push(enabledModelIds);
				},
				onPersist: () => {},
				onCancel: () => {},
			},
		);

		selector.handleInput("\x1b[1;3B");

		expect(changes).toEqual([[orderedIds[1], orderedIds[0], orderedIds[2]]]);
	});

	it("shows readable LM Studio variant labels next to model ids", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const model = {
			id: "qwen-3.5-9b#mlx-8-bit",
			name: "Qwen 3.5 9B (MLX, 8-bit)",
			api: "openai-completions",
			provider: "lmstudio",
			baseUrl: "http://127.0.0.1:1234/v1",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			model,
			harness.settingsManager,
			harness.session.modelRegistry,
			[{ model }],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const rendered = stripAnsi(selector.render(160).join("\n"));
		expect(rendered).toContain("qwen-3.5-9b#mlx-8-bit [lmstudio] — Qwen 3.5 9B (MLX, 8-bit)");
	});

	it("lazy-loads LM Studio models only after an lmstudio search", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
		});
		harnesses.push(harness);

		const currentModel = harness.getModel("faux-1")!;
		const lmStudioModel = {
			id: "gpt-oss-20b",
			name: "GPT OSS 20B",
			api: "openai-completions",
			provider: "lmstudio",
			baseUrl: "http://127.0.0.1:1234/v1",
			reasoning: true,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		let availableModels: Array<typeof currentModel | typeof lmStudioModel> = [currentModel];
		let loadCalls = 0;
		const fakeRegistry = {
			getAvailable: () => availableModels,
			find: (provider: string, id: string) =>
				availableModels.find((model) => model.provider === provider && model.id === id),
			refresh: () => {},
			loadAutoDetectedProviders: async () => {
				loadCalls += 1;
				availableModels = [currentModel, lmStudioModel];
			},
			getError: () => undefined,
		} as unknown as typeof harness.session.modelRegistry;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			fakeRegistry,
			[],
			() => {},
			() => {},
		);

		await waitForAsyncRender();
		expect(loadCalls).toBe(0);

		for (const char of "lmstudio") {
			selector.handleInput(char);
		}
		await waitForAsyncRender();
		await waitForAsyncRender();

		expect(loadCalls).toBe(1);
		const rendered = stripAnsi(selector.render(160).join("\n"));
		expect(rendered).toContain("gpt-oss-20b [lmstudio]");
	});

	it("preserves scoped model order in the /model scoped tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
				{ id: "faux-3", name: "Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		const modelThree = harness.getModel("faux-3")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			modelOne,
			harness.settingsManager,
			harness.session.modelRegistry,
			[{ model: modelTwo }, { model: modelOne }, { model: modelThree }],
			() => {},
			() => {},
		);

		await waitForAsyncRender();

		const renderedLines = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`[${modelOne.provider}]`));
		const orderedIds = renderedLines.slice(0, 3).map((line) => {
			const [modelId] = line.trim().replace(/^→\s*/, "").split(" [");
			return modelId?.trim() ?? "";
		});

		expect(orderedIds).toEqual([modelTwo.id, modelOne.id, modelThree.id]);
	});
});
