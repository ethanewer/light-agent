import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_MODES, getNextModeName, registerModes } from "../extensions/light-agent/modes.ts";

test("getNextModeName cycles through all light-agent modes", () => {
	const names = AGENT_MODES.map((mode) => mode.name);
	assert.deepEqual(names, ["general", "general+search", "chat", "chat+search"]);

	assert.equal(getNextModeName("general"), "general+search");
	assert.equal(getNextModeName("general+search"), "chat");
	assert.equal(getNextModeName("chat"), "chat+search");
	assert.equal(getNextModeName("chat+search"), "general");
});

test("getNextModeName recovers from unknown persisted values", () => {
	assert.equal(getNextModeName("unknown"), "general");
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

	await commands.get("mode")?.handler("chat", ctx);
	assert.deepEqual(activeTools, []);
	assert.deepEqual(await handlers.get("before_agent_start")?.({}, ctx), { systemPrompt: "You are a helpful assistant." });

	entries.length = 0;
	await handlers.get("session_start")?.({}, ctx);

	assert.deepEqual(activeTools, ["bash"]);
	assert.equal(await handlers.get("before_agent_start")?.({}, ctx), undefined);
	assert.equal(statusValues.at(-1), undefined);
});
