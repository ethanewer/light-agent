#!/usr/bin/env bash
# Fast iteration launcher for the local pi CLI.
#
# Skips everything that can be skipped and uses TypeScript's incremental
# compiler so repeat runs finish in ~1s even after editing source.
#
# Specifically:
#   - `npm install` only runs when `pi/node_modules` is missing.
#   - The heavyweight `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`
#     packages are built once (when their `dist/` is missing) and then left
#     alone — they rarely change and their build pulls models from the
#     network. Delete their `dist/` directories or pass `--full` to force a
#     rebuild.
#   - `pi-tui` and `pi-coding-agent` are compiled with `tsc --incremental`,
#     so subsequent invocations only retype-check changed files.
#   - Asset copy (themes, templates) is skipped when the dist directory
#     already has them — pass `--copy-assets` to force a refresh.
#
# Pass any remaining arguments through to the CLI. Examples:
#   ./run-local-cli.sh                     # start interactive session
#   ./run-local-cli.sh --version           # run `pi --version`
#   ./run-local-cli.sh --full              # force a full rebuild first
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_ROOT="${SCRIPT_DIR}/pi"
PACKAGES_DIR="${PI_ROOT}/packages"
CLI_ENTRY="${PACKAGES_DIR}/coding-agent/dist/cli.js"
TSC="${PI_ROOT}/node_modules/typescript/bin/tsc"

FULL_REBUILD=0
COPY_ASSETS_FORCED=0
CLI_ARGS=()
for arg in "$@"; do
	case "$arg" in
		--full) FULL_REBUILD=1 ;;
		--copy-assets) COPY_ASSETS_FORCED=1 ;;
		*) CLI_ARGS+=("$arg") ;;
	esac
done

log() { printf '==> %s\n' "$*" >&2; }

# --- 1. Dependencies --------------------------------------------------------
if [[ ! -d "${PI_ROOT}/node_modules" ]]; then
	log "Installing workspace dependencies"
	(cd "${PI_ROOT}" && npm install)
fi

# --- 2. Heavyweight packages (ai, agent): build on demand ------------------
#
# These rarely change while iterating on the coding-agent or TUI, and the
# `pi-ai` build runs a network-bound model-generation step. We only build
# them if their dist is missing (first run, clean clone) or when --full
# was requested.
ensure_package_built() {
	local pkg="$1"
	local dist="${PACKAGES_DIR}/${pkg}/dist"
	if [[ "${FULL_REBUILD}" -eq 1 || ! -d "${dist}" || -z "$(ls -A "${dist}" 2>/dev/null || true)" ]]; then
		log "Building @mariozechner/pi-${pkg}"
		(cd "${PI_ROOT}" && npm --workspace "packages/${pkg}" run build)
	fi
}

ensure_package_built ai
ensure_package_built agent

# --- 3. Hot packages (tui, coding-agent): incremental tsc -------------------
incremental_build() {
	local pkg="$1"
	local pkg_dir="${PACKAGES_DIR}/${pkg}"
	log "tsc --incremental @ ${pkg}"
	node "${TSC}" -p "${pkg_dir}/tsconfig.build.json" --incremental \
		--tsBuildInfoFile "${pkg_dir}/dist/.tsbuildinfo"
}

incremental_build tui
incremental_build coding-agent

# --- 4. Asset copy (idempotent, usually a no-op) ---------------------------
#
# We need the theme JSONs, template.{html,css,js}, and image assets in
# dist/ for the CLI to start. Run the copy step only when the marker file
# is missing, or when the user asked for it.
CODING_AGENT_DIR="${PACKAGES_DIR}/coding-agent"
ASSET_MARKER="${CODING_AGENT_DIR}/dist/modes/interactive/theme/dark.json"
if [[ ! -f "${ASSET_MARKER}" || "${COPY_ASSETS_FORCED}" -eq 1 || "${FULL_REBUILD}" -eq 1 ]]; then
	log "Copying assets"
	(cd "${CODING_AGENT_DIR}" && npm run copy-assets >/dev/null)
fi

# Ensure the CLI entry is executable.
chmod +x "${CLI_ENTRY}" 2>/dev/null || true

if [[ ! -f "${CLI_ENTRY}" ]]; then
	echo "Expected CLI entry at ${CLI_ENTRY}, but it was not built." >&2
	exit 1
fi

# --- 5. Run ----------------------------------------------------------------
# Note: `"${CLI_ARGS[@]}"` triggers an unbound-variable error under `set -u`
# on macOS's bash 3.2 when the array is empty. The `${arr[@]+...}` guard
# expands to nothing when the array is unset/empty.
exec node "${CLI_ENTRY}" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}
