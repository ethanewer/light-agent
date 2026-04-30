# AGENTS.md

## Layout

- `pi/` — upstream [pi](https://github.com/badlogic/pi-mono) monorepo as a git submodule. Do not patch it for light-agent features; keep local behavior in extensions.
- `extensions/light-agent/` — local pi extension package. This is where web tools, modes, and LM Studio discovery live.
- `tests/` — root tests for the local extension package.
- `run-local-cli.sh` — incremental local launcher. It builds upstream pi as needed and runs it with `--extension <repo-root>`. `--full` forces a clean rebuild.

## Type checking

Run after source edits. Fast, no side effects:

```bash
npm run check
```

For upstream pi type checking without formatting:

```bash
cd pi && node node_modules/@typescript/native-preview/bin/tsgo.js -p tsconfig.json --noEmit
```

## Tests

Run the root suite for extension changes:

```bash
npm run test
```

Run the upstream suite for a pi package only if you changed or diagnosed that package:

```bash
cd pi
npm --workspace packages/tui run test             # ~2s, offline
npm --workspace packages/agent run test           # ~1s, offline
npm --workspace packages/coding-agent run test    # ~2 min, offline, faux provider
npm --workspace packages/ai run test              # live network + real API keys
```

`pi-ai` tests hit real providers; their failures without credentials are environmental, not regressions. Skip them unless you changed `pi/packages/ai`.
If the `packages/coding-agent` full suite flakes, rerun the failing test in isolation before treating it as a regression.

For a single file:

```bash
cd pi/packages/<pkg>
npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
```

## Runtime verification

For CLI, TUI, or local-provider changes, do not stop at unit tests. Verify the real behavior before claiming a fix:

- run the local CLI (`./run-local-cli.sh ...`) and inspect the output
- run the installer workflow with a temp bin when changing install behavior (`PI_GLOBAL_BIN_DIR="$(mktemp -d)" ./install-cli.sh`)
- if the bug involves interactive behavior, drive the real TUI with `tmux` and capture the pane
- if the bug depends on a local server (for example LM Studio), inspect the live endpoint payloads as well as the CLI output

## Don't run

`npm run dev`, `npm run build`, and repo-root `npm test` — slow, network-dependent, or not part of this repo's extension workflow. Use `npm run test`.

## Scope

Keep diffs focused. Don't auto-format unrelated files; review `git diff` before handing work back and revert accidental reformats with `git checkout -- <file>`.
