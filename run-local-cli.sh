#!/usr/bin/env bash
# Incremental launcher for light-agent on top of an upstream pi submodule.
#
# Pass any remaining arguments through to pi. Examples:
#   ./run-local-cli.sh                     # start interactive session
#   ./run-local-cli.sh --version           # run `pi --version`
#   ./run-local-cli.sh --full              # force a clean rebuild first
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
PI_ROOT="${REPO_ROOT}/pi"
PACKAGES_DIR="${PI_ROOT}/packages"
CLI_ENTRY="${PACKAGES_DIR}/coding-agent/dist/cli.js"
LOCK_DIR="${PI_ROOT}/.light-agent-build.lock"

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
fail() {
	printf '%s\n' "$*" >&2
	exit 1
}

acquire_build_lock() {
	local attempts=0
	while ! mkdir "${LOCK_DIR}" 2>/dev/null; do
		if [[ -f "${LOCK_DIR}/pid" ]]; then
			local owner_pid
			owner_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
			if [[ -n "${owner_pid}" ]] && ! kill -0 "${owner_pid}" 2>/dev/null; then
				rm -rf "${LOCK_DIR}" 2>/dev/null || true
				continue
			fi
		fi
		attempts=$((attempts + 1))
		if [[ "${attempts}" -gt 600 ]]; then
			fail "Timed out waiting for ${LOCK_DIR}"
		fi
		sleep 0.1
	done
	printf '%s\n' "$$" > "${LOCK_DIR}/pid"
}

release_build_lock() {
	rm -rf "${LOCK_DIR}" 2>/dev/null || true
}

ensure_submodule() {
	if [[ ! -f "${PI_ROOT}/package.json" ]]; then
		log "Initializing upstream pi submodule"
		git -C "${REPO_ROOT}" submodule sync -- pi >/dev/null
		git -C "${REPO_ROOT}" submodule update --init --recursive pi
	fi

	[[ -f "${PI_ROOT}/package.json" ]] || fail "pi submodule is missing. Run: git submodule update --init --recursive pi"
}

install_deps_if_needed() {
	local dir="$1"
	local label="$2"

	if [[ -d "${dir}/node_modules" ]]; then
		return
	fi

	log "Installing ${label} dependencies"
	if [[ -f "${dir}/package-lock.json" ]]; then
		(cd "${dir}" && npm ci)
	else
		(cd "${dir}" && npm install)
	fi
}

has_newer_input() {
	local marker="$1"
	shift

	local path
	for path in "$@"; do
		[[ -e "${path}" ]] || continue
		if [[ -d "${path}" ]]; then
			if find "${path}" -type f -newer "${marker}" -print -quit | grep -q .; then
				return 0
			fi
		elif [[ "${path}" -nt "${marker}" ]]; then
			return 0
		fi
	done

	return 1
}

build_package() {
	local pkg="$1"
	local entry="$2"
	local pkg_dir="${PACKAGES_DIR}/${pkg}"
	local dist="${pkg_dir}/dist"
	local entry_path="${pkg_dir}/${entry}"
	local tsgo="${PI_ROOT}/node_modules/.bin/tsgo"

	if [[ "${FULL_REBUILD}" -eq 1 ]]; then
		rm -rf "${dist}"
	fi

	if [[ ! -f "${entry_path}" ]] || has_newer_input "${entry_path}" \
		"${pkg_dir}/src" \
		"${pkg_dir}/package.json" \
		"${pkg_dir}/tsconfig.build.json" \
		"${PI_ROOT}/tsconfig.base.json" \
		"${PI_ROOT}/tsconfig.json"; then
		log "Building packages/${pkg}"
		[[ -x "${tsgo}" ]] || fail "Expected ${tsgo}; run npm install in ${PI_ROOT}"
		"${tsgo}" -p "${pkg_dir}/tsconfig.build.json"
	fi
}

should_inject_extension() {
	local command="${CLI_ARGS[0]:-}"
	case "${command}" in
		install | remove | uninstall | update | list | config) return 1 ;;
		*) return 0 ;;
	esac
}

ensure_submodule
acquire_build_lock
trap release_build_lock EXIT INT TERM
install_deps_if_needed "${PI_ROOT}" "upstream pi"
install_deps_if_needed "${REPO_ROOT}" "light-agent extension"

build_package ai "dist/index.js"
build_package agent "dist/index.js"
build_package tui "dist/index.js"
build_package coding-agent "dist/cli.js"

CODING_AGENT_DIR="${PACKAGES_DIR}/coding-agent"
ASSET_MARKER="${CODING_AGENT_DIR}/dist/modes/interactive/theme/dark.json"
if [[ ! -f "${ASSET_MARKER}" || "${COPY_ASSETS_FORCED}" -eq 1 || "${FULL_REBUILD}" -eq 1 ]]; then
	log "Copying coding-agent assets"
	(cd "${CODING_AGENT_DIR}" && npm run copy-assets >/dev/null)
fi

chmod +x "${CLI_ENTRY}" 2>/dev/null || true
[[ -f "${CLI_ENTRY}" ]] || fail "Expected CLI entry at ${CLI_ENTRY}, but it was not built."

release_build_lock
trap - EXIT INT TERM
if should_inject_extension; then
	exec node "${CLI_ENTRY}" --extension "${REPO_ROOT}" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}
else
	exec node "${CLI_ENTRY}" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}
fi
