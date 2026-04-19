#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
PI_ROOT="${REPO_ROOT}/pi"
BENCH_ROOT="${REPO_ROOT}/terminal-bench"
BUNDLE_DIR="${PI_ROOT}/packages/coding-agent/dist"
BINARY_PATH="${BUNDLE_DIR}/pi"
MANIFEST_PATH="${BENCH_ROOT}/bin/pi-benchmark-install.json"

GLOBAL_PREFIX="${PI_GLOBAL_PREFIX:-$(npm config get prefix)}"
GLOBAL_BIN_DIR="${PI_GLOBAL_BIN_DIR:-${GLOBAL_PREFIX}/bin}"
GLOBAL_PI_PATH="${GLOBAL_BIN_DIR}/pi"

echo "==> Installing workspace dependencies"
(cd "${PI_ROOT}" && npm install)

echo "==> Building pi binary from local source"
(cd "${PI_ROOT}" && npm run build:cli-binary)

if [[ ! -x "${BINARY_PATH}" ]]; then
	echo "Expected pi binary at ${BINARY_PATH}, but it was not built." >&2
	exit 1
fi

echo "==> Updating benchmark bundle manifest"
mkdir -p "$(dirname "${MANIFEST_PATH}")"
printf '{\n  "bundle_dir": "%s",\n  "binary_path": "%s"\n}\n' "${BUNDLE_DIR}" "${BINARY_PATH}" > "${MANIFEST_PATH}"

echo "==> Installing global pi wrapper at ${GLOBAL_PI_PATH}"
mkdir -p "${GLOBAL_BIN_DIR}"
TMP_WRAPPER="$(mktemp)"
cat > "${TMP_WRAPPER}" <<EOF
#!/usr/bin/env bash
exec "${BINARY_PATH}" "\$@"
EOF
chmod +x "${TMP_WRAPPER}"
mv "${TMP_WRAPPER}" "${GLOBAL_PI_PATH}"

echo
echo "pi bundle:   ${BUNDLE_DIR}"
echo "bench link:  ${MANIFEST_PATH}"
echo "global cli:  ${GLOBAL_PI_PATH}"
echo
"${GLOBAL_PI_PATH}" --version
