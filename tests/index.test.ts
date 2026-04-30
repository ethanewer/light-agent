import assert from "node:assert/strict";
import test from "node:test";

import lightAgentExtension, { isOfflineModeEnabled } from "../extensions/light-agent/index.ts";

const originalOffline = process.env.PI_OFFLINE;
const originalFetch = globalThis.fetch;

test.afterEach(() => {
	if (originalOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalOffline;
	}
	globalThis.fetch = originalFetch;
});

test("isOfflineModeEnabled mirrors CLI truthy PI_OFFLINE values", () => {
	delete process.env.PI_OFFLINE;
	assert.equal(isOfflineModeEnabled(), false);

	process.env.PI_OFFLINE = "1";
	assert.equal(isOfflineModeEnabled(), true);

	process.env.PI_OFFLINE = "true";
	assert.equal(isOfflineModeEnabled(), true);

	process.env.PI_OFFLINE = "yes";
	assert.equal(isOfflineModeEnabled(), true);

	process.env.PI_OFFLINE = "0";
	assert.equal(isOfflineModeEnabled(), false);
});

test("lightAgentExtension skips startup discovery network calls in offline mode", async () => {
	process.env.PI_OFFLINE = "1";
	globalThis.fetch = async () => {
		throw new Error("offline startup should not fetch");
	};

	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const registeredShortcuts: unknown[] = [];
	const handlers: string[] = [];
	const providers: string[] = [];

	await lightAgentExtension({
		registerTool(tool: { name: string }) {
			registeredTools.push(tool.name);
		},
		registerCommand(name: string) {
			registeredCommands.push(name);
		},
		registerShortcut(key: unknown) {
			registeredShortcuts.push(key);
		},
		on(name: string) {
			handlers.push(name);
		},
		registerProvider(name: string) {
			providers.push(name);
		},
		unregisterProvider(name: string) {
			providers.push(name);
		},
		getActiveTools() {
			return ["bash"];
		},
		getAllTools() {
			return [{ name: "bash" }, { name: "webfetch" }, { name: "websearch" }];
		},
		setActiveTools() {},
		appendEntry() {},
	} as never);

	assert.deepEqual(registeredTools, ["webfetch", "websearch"]);
	assert.deepEqual(registeredCommands, ["search", "chat"]);
	assert.equal(registeredShortcuts.length, 0);
	assert.deepEqual(handlers, ["session_start", "session_tree", "before_agent_start"]);
	assert.deepEqual(providers, []);
});
