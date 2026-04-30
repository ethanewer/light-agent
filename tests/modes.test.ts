import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_MODES, registerModes } from "../extensions/light-agent/modes.ts";

test("AGENT_MODES exposes the expected light-agent modes", () => {
	const names = AGENT_MODES.map((mode) => mode.name);
	assert.deepEqual(names, ["general", "general+search", "chat+search"]);
});

test("session_start resets to general mode when no mode is persisted", async () => {
	let activeTools = ["bash", "webfetch"];
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const statusValues: Array<string | undefined> = [];
	const entries: unknown[] = [];
	const ctx = {
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus(_name: string, value: string | undefined) {
				statusValues.push(value);
			},
			notify() {},
			select: async () => undefined,
		},
	};

	registerModes({
		registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) {
			commands.set(name, command);
		},
		registerShortcut() {},
		on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
			handlers.set(name, handler);
		},
		getActiveTools() {
			return activeTools;
		},
		getAllTools() {
			return [{ name: "bash" }, { name: "webfetch" }, { name: "websearch" }];
		},
		setActiveTools(tools: string[]) {
			activeTools = tools;
		},
		appendEntry(_type: string, data: unknown) {
			entries.push({ type: "custom", customType: "light-agent-mode", data });
		},
	} as never);

	assert.ok(commands.has("chat"));
	assert.ok(commands.has("search"));
	assert.ok(!commands.has("mode"));

	await commands.get("chat")?.handler("", ctx);
	assert.deepEqual(activeTools, ["webfetch", "websearch"]);
	assert.deepEqual(await handlers.get("before_agent_start")?.({}, ctx), { systemPrompt: "You are a helpful assistant." });
	assert.equal(statusValues.at(-1), "chat+search");

	// /chat again toggles back to general
	await commands.get("chat")?.handler("", ctx);
	assert.deepEqual(activeTools, ["bash"]);
	assert.equal(await handlers.get("before_agent_start")?.({}, ctx), undefined);
	assert.equal(statusValues.at(-1), undefined);

	// /search enables general+search
	await commands.get("search")?.handler("", ctx);
	assert.deepEqual(activeTools.sort(), ["bash", "webfetch", "websearch"]);
	assert.equal(statusValues.at(-1), "general+search");

	// /search again toggles back to general
	await commands.get("search")?.handler("", ctx);
	assert.deepEqual(activeTools, ["bash"]);
	assert.equal(statusValues.at(-1), undefined);

	entries.length = 0;
	await handlers.get("session_start")?.({}, ctx);

	assert.deepEqual(activeTools, ["bash"]);
	assert.equal(await handlers.get("before_agent_start")?.({}, ctx), undefined);
	assert.equal(statusValues.at(-1), undefined);
});
