import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));

// Cap the worker pool for coding-agent. Several test files run live Anthropic
// e2e flows in parallel; with vitest's default pool (~ncpu/2 on a 10-core
// Mac) they saturate the API and flake on timeouts / rate limits. 3 workers
// keeps end-to-end throughput roughly at parity with the default while
// eliminating the concurrent-load flakes.
const E2E_MAX_THREADS = 3;

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		poolOptions: {
			threads: { maxThreads: E2E_MAX_THREADS },
			forks: { maxForks: E2E_MAX_THREADS },
		},
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
