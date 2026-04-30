#!/usr/bin/env bash
# Install a local wrapper that runs upstream pi with the light-agent extension.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
PI_ROOT="${REPO_ROOT}/pi"
BENCH_ROOT="${REPO_ROOT}/terminal-bench"
RUNNER="${REPO_ROOT}/run-local-cli.sh"
CODING_AGENT_DIR="${PI_ROOT}/packages/coding-agent"
DIST_DIR="${CODING_AGENT_DIR}/dist"
BUNDLE_DIR="${BENCH_ROOT}/bin/pi-bundle"
BUNDLE_ENTRY="${DIST_DIR}/bun/cli.js"
HOST_BINARY_PATH="${BUNDLE_DIR}/pi"
MANIFEST_PATH="${BENCH_ROOT}/bin/pi-benchmark-install.json"

log() { printf '==> %s\n' "$*" >&2; }
fail() {
	printf '%s\n' "$*" >&2
	exit 1
}

determine_global_bin_dir() {
	if [[ -n "${PI_GLOBAL_BIN_DIR:-}" ]]; then
		printf '%s\n' "${PI_GLOBAL_BIN_DIR}"
		return
	fi
	if [[ -n "${PI_GLOBAL_PREFIX:-}" ]]; then
		printf '%s\n' "${PI_GLOBAL_PREFIX}/bin"
		return
	fi
	npm config get prefix | sed 's:$:/bin:'
}

needs_rebuild() {
	local output="$1"
	[[ ! -x "${output}" ]] || has_newer_bundled_input "${output}"
}

has_newer_bundled_input() {
	local output="$1"
	local dist_dir
	for dist_dir in \
		"${PI_ROOT}/packages/ai/dist" \
		"${PI_ROOT}/packages/agent/dist" \
		"${PI_ROOT}/packages/tui/dist" \
		"${DIST_DIR}"; do
		[[ -d "${dist_dir}" ]] || continue
		if find "${dist_dir}" -type f -newer "${output}" -print -quit | grep -q .; then
			return 0
		fi
	done
	return 1
}

build_benchmark_binary() {
	local name="$1"
	local target="$2"
	local output="${BUNDLE_DIR}/${name}"

	if needs_rebuild "${output}"; then
		log "Building benchmark binary ${name}"
		bun build --compile --external koffi --target="${target}" "${BUNDLE_ENTRY}" --outfile "${output}"
	fi
	chmod +x "${output}"
}

copy_benchmark_assets() {
	log "Copying benchmark bundle assets"
	mkdir -p "${BUNDLE_DIR}"
	cp "${CODING_AGENT_DIR}/package.json" "${BUNDLE_DIR}/"
	cp "${CODING_AGENT_DIR}/README.md" "${BUNDLE_DIR}/"
	cp "${CODING_AGENT_DIR}/CHANGELOG.md" "${BUNDLE_DIR}/"
	cp "${PI_ROOT}/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm" "${BUNDLE_DIR}/"

	rm -rf "${BUNDLE_DIR}/theme" "${BUNDLE_DIR}/assets" "${BUNDLE_DIR}/export-html" "${BUNDLE_DIR}/docs" "${BUNDLE_DIR}/examples"
	mkdir -p "${BUNDLE_DIR}/theme" "${BUNDLE_DIR}/assets" "${BUNDLE_DIR}/export-html/vendor"
	cp "${CODING_AGENT_DIR}"/src/modes/interactive/theme/*.json "${BUNDLE_DIR}/theme/"
	cp "${CODING_AGENT_DIR}"/src/modes/interactive/assets/*.png "${BUNDLE_DIR}/assets/"
	cp "${CODING_AGENT_DIR}"/src/core/export-html/template.html "${BUNDLE_DIR}/export-html/"
	cp "${CODING_AGENT_DIR}"/src/core/export-html/template.css "${BUNDLE_DIR}/export-html/"
	cp "${CODING_AGENT_DIR}"/src/core/export-html/template.js "${BUNDLE_DIR}/export-html/"
	cp "${CODING_AGENT_DIR}"/src/core/export-html/vendor/*.js "${BUNDLE_DIR}/export-html/vendor/"
	cp -R "${CODING_AGENT_DIR}/docs" "${BUNDLE_DIR}/docs"
	cp -R "${CODING_AGENT_DIR}/examples" "${BUNDLE_DIR}/examples"
}

install_benchmark_bundle() {
	[[ -f "${BUNDLE_ENTRY}" ]] || fail "Expected ${BUNDLE_ENTRY}; run ${RUNNER} --version first."
	command -v bun >/dev/null 2>&1 || fail "Bun is required to build terminal-bench pi binaries."
	mkdir -p "${BUNDLE_DIR}"

	if needs_rebuild "${HOST_BINARY_PATH}"; then
		log "Building local pi benchmark binary"
		bun build --compile "${BUNDLE_ENTRY}" --outfile "${HOST_BINARY_PATH}"
	fi
	chmod +x "${HOST_BINARY_PATH}"

	build_benchmark_binary "pi-linux-arm64" "bun-linux-arm64"
	build_benchmark_binary "pi-linux-x64" "bun-linux-x64"

	copy_benchmark_assets

	log "Updating benchmark bundle manifest"
	mkdir -p "$(dirname "${MANIFEST_PATH}")"
	printf '{\n  "bundle_dir": "%s",\n  "binary_path": "%s"\n}\n' "${BUNDLE_DIR}" "${HOST_BINARY_PATH}" > "${MANIFEST_PATH}"
}

command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
[[ -x "${RUNNER}" ]] || chmod +x "${RUNNER}"

log "Building and verifying local pi launcher"
"${RUNNER}" --version >/dev/null
install_benchmark_bundle

GLOBAL_BIN_DIR="$(determine_global_bin_dir)"
mkdir -p "${GLOBAL_BIN_DIR}"

install_wrapper() {
	local name="$1"
	local destination="${GLOBAL_BIN_DIR}/${name}"

	cat > "${destination}" <<EOF
#!/usr/bin/env bash
exec "${RUNNER}" "\$@"
EOF
	chmod +x "${destination}"
	log "Installed ${destination}"
}

install_wrapper pi
install_wrapper light-agent

log "Done. Run: pi --version"
