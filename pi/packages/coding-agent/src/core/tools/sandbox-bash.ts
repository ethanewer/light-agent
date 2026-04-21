import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Bash, type BashExecResult, type BashOptions } from "just-bash";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashOperations, type BashToolDetails, type BashToolInput, createBashToolDefinition } from "./bash.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";

/**
 * Options for the sandbox bash tool.
 *
 * The sandbox is backed by `just-bash`: an in-process virtual bash environment
 * with an in-memory filesystem. Commands cannot read or write the host machine.
 */
export interface SandboxBashToolOptions {
	/** Enable python3/python. Default: true. */
	python?: boolean;
	/**
	 * Enable js-exec for JavaScript/TypeScript. Default: false.
	 *
	 * Disabled by default because the js-exec worker is miswired in the published
	 * just-bash 2.14.2 bundle (upstream issues #194, #159). Flip to true once the
	 * upstream fix ships, or if you are running a patched build.
	 */
	javascript?: BashOptions["javascript"];
	/** Initial files to seed the virtual filesystem with. */
	files?: BashOptions["files"];
	/** Initial working directory inside the sandbox. Default: /home/user. */
	cwd?: string;
	/** Initial environment variables visible inside the sandbox. */
	env?: Record<string, string>;
	/** Execution limits (loop iterations, call depth, etc.). */
	executionLimits?: BashOptions["executionLimits"];
	/** Network configuration. Sandbox has no network access by default. */
	network?: BashOptions["network"];
	/** Additional raw options forwarded to `new Bash(...)`. */
	bashOptions?: Partial<BashOptions>;
}

const SANDBOX_BASH_NAME = "bash_sandbox";

const SANDBOX_BASH_DESCRIPTION =
	"Execute a bash command in an isolated in-memory sandbox. The sandbox provides bash with " +
	"the standard Unix utilities (ls, cat, grep, sed, awk, find, jq, xan, yq, etc.) and python3 " +
	"(CPython; only the standard library is installed — no numpy/pandas/torch/etc.). The virtual " +
	"filesystem starts empty, persists across calls within this session, and cannot affect the " +
	`host machine. Returns stdout and stderr; output is truncated to the last ${DEFAULT_MAX_LINES} lines or ` +
	`${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Optionally provide a timeout in seconds.`;

const SANDBOX_BASH_PROMPT_SNIPPET =
	"Execute bash in an isolated in-memory sandbox (standard Unix utilities + python3 stdlib)";

/**
 * Create a persistent `BashOperations` backed by `just-bash`.
 *
 * The underlying `Bash` instance is created lazily on the first exec and reused
 * across subsequent calls so that files written in one call are visible in the next.
 */
export function createSandboxBashOperations(options?: SandboxBashToolOptions): BashOperations {
	let bash: Bash | undefined;
	const getBash = (): Bash => {
		if (!bash) {
			bash = new Bash({
				python: options?.python ?? true,
				javascript: options?.javascript ?? false,
				files: options?.files,
				cwd: options?.cwd,
				env: options?.env,
				executionLimits: options?.executionLimits,
				network: options?.network,
				...options?.bashOptions,
			});
		}
		return bash;
	};

	return {
		async exec(command, _cwd, { onData, signal, timeout }) {
			const b = getBash();
			const timeoutController = new AbortController();
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					timeoutController.abort();
				}, timeout * 1000);
			}
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
			let result: BashExecResult;
			try {
				result = await b.exec(command, { signal: combinedSignal });
			} catch (err) {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${timeout}`);
				throw err instanceof Error ? err : new Error(String(err));
			}
			if (timeoutHandle) clearTimeout(timeoutHandle);
			// just-bash returns silently on AbortSignal rather than throwing. Translate
			// our own abort/timeout flags into the error vocabulary the bash tool expects.
			if (signal?.aborted) throw new Error("aborted");
			if (timedOut) throw new Error(`timeout:${timeout}`);
			// just-bash does not stream; deliver the combined output once at completion.
			const combined = (result.stdout ?? "") + (result.stderr ?? "");
			if (combined.length > 0) {
				onData(Buffer.from(combined, "utf-8"));
			}
			return { exitCode: result.exitCode };
		},
	};
}

/**
 * Create the sandbox bash tool definition.
 *
 * This reuses the regular bash tool's execute/render pipeline but swaps the
 * operations for a `just-bash`-backed implementation and advertises a distinct
 * tool name so it can coexist with the host `bash` tool in the registry.
 */
export function createSandboxBashToolDefinition(
	options?: SandboxBashToolOptions,
): ToolDefinition<any, BashToolDetails | undefined> {
	const sandboxOps = createSandboxBashOperations(options);
	// The `cwd` argument is ignored by the sandbox ops. Pass the sandbox's
	// initial cwd so any host-facing display fallbacks look sensible.
	const base = createBashToolDefinition(options?.cwd ?? "/home/user", {
		operations: sandboxOps,
	});
	return {
		...base,
		name: SANDBOX_BASH_NAME,
		label: SANDBOX_BASH_NAME,
		description: SANDBOX_BASH_DESCRIPTION,
		promptSnippet: SANDBOX_BASH_PROMPT_SNIPPET,
	};
}

export function createSandboxBashTool(options?: SandboxBashToolOptions): AgentTool<any, BashToolDetails | undefined> {
	return wrapToolDefinition(createSandboxBashToolDefinition(options));
}

export type { BashToolInput as SandboxBashToolInput };
