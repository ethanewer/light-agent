#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
PI_ROOT="${REPO_ROOT}/pi"
BENCH_ROOT="${REPO_ROOT}/terminal-bench"
BUNDLE_DIR="${PI_ROOT}/packages/coding-agent/dist"
BINARY_PATH="${BUNDLE_DIR}/pi"
MACOS_CA_BUNDLE_PATH="${BUNDLE_DIR}/macos-keychain-certs.pem"
MANIFEST_PATH="${BENCH_ROOT}/bin/pi-benchmark-install.json"

OS_NAME="$(uname -s)"
LINUX_BASHRC="${HOME}/.bashrc"
LINUX_BASH_PROFILE="${HOME}/.bash_profile"
LINUX_PROFILE="${HOME}/.profile"
LINUX_LOCAL_BIN_DIR="${HOME}/.local/bin"
LINUX_BUN_INSTALL_DIR="${HOME}/.bun"
NVM_INSTALL_DIR="${HOME}/.nvm"

log() {
	echo "==> $*"
}

fail() {
	echo "$*" >&2
	exit 1
}

download_to_file() {
	local url="$1"
	local destination="$2"

	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "${url}" -o "${destination}"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "${destination}" "${url}"
	else
		fail "Neither curl nor wget is installed. Please install one of them and rerun install-cli.sh."
	fi
}

append_managed_block() {
	local file="$1"
	local start_marker="$2"
	local end_marker="$3"
	local block_content="$4"

	touch "${file}"
	if grep -Fq "${start_marker}" "${file}"; then
		return
	fi

	{
		printf '\n%s\n' "${start_marker}"
		printf '%s\n' "${block_content}"
		printf '%s\n' "${end_marker}"
	} >> "${file}"
}

file_contains_all_literals() {
	local file="$1"
	shift

	[[ -f "${file}" ]] || return 1

	local pattern
	for pattern in "$@"; do
		if ! grep -Fq "${pattern}" "${file}"; then
			return 1
		fi
	done

	return 0
}

ensure_linux_shell_setup() {
	local nvm_marker_start="# >>> light-agent nvm >>>"
	local nvm_marker_end="# <<< light-agent nvm <<<"
	local nvm_block='export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
fi
if [ -s "$NVM_DIR/bash_completion" ]; then
  . "$NVM_DIR/bash_completion"
fi'
	local path_marker_start="# >>> light-agent install-cli >>>"
	local path_marker_end="# <<< light-agent install-cli <<<"
	local path_block='export BUN_INSTALL="$HOME/.bun"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
case ":$PATH:" in
  *":$BUN_INSTALL/bin:"*) ;;
  *) export PATH="$BUN_INSTALL/bin:$PATH" ;;
esac'
	local source_bashrc_marker_start="# >>> light-agent source ~/.bashrc >>>"
	local source_bashrc_marker_end="# <<< light-agent source ~/.bashrc <<<"
	local source_bashrc_block='if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi'

	touch "${LINUX_BASHRC}"
	if ! file_contains_all_literals "${LINUX_BASHRC}" 'export NVM_DIR="$HOME/.nvm"' '"$NVM_DIR/nvm.sh"'; then
		append_managed_block "${LINUX_BASHRC}" "${nvm_marker_start}" "${nvm_marker_end}" "${nvm_block}"
	fi

	if ! file_contains_all_literals "${LINUX_BASHRC}" 'export BUN_INSTALL="$HOME/.bun"' '"$HOME/.local/bin:$PATH"' '"$BUN_INSTALL/bin:$PATH"'; then
		append_managed_block "${LINUX_BASHRC}" "${path_marker_start}" "${path_marker_end}" "${path_block}"
	fi

	if ! file_contains_all_literals "${LINUX_BASH_PROFILE}" '[ -f "$HOME/.bashrc" ]' '. "$HOME/.bashrc"'; then
		append_managed_block "${LINUX_BASH_PROFILE}" "${source_bashrc_marker_start}" "${source_bashrc_marker_end}" "${source_bashrc_block}"
	fi

	if ! file_contains_all_literals "${LINUX_PROFILE}" '[ -f "$HOME/.bashrc" ]' '. "$HOME/.bashrc"'; then
		append_managed_block "${LINUX_PROFILE}" "${source_bashrc_marker_start}" "${source_bashrc_marker_end}" "${source_bashrc_block}"
	fi
}

load_linux_shell_env() {
	export NVM_DIR="${NVM_INSTALL_DIR}"
	if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
		# shellcheck disable=SC1090
		. "${NVM_DIR}/nvm.sh"
	fi
	if [[ -s "${NVM_DIR}/bash_completion" ]]; then
		# shellcheck disable=SC1090
		. "${NVM_DIR}/bash_completion"
	fi

	export BUN_INSTALL="${LINUX_BUN_INSTALL_DIR}"
	case ":${PATH}:" in
		*":${LINUX_LOCAL_BIN_DIR}:"*) ;;
		*) export PATH="${LINUX_LOCAL_BIN_DIR}:${PATH}" ;;
	esac
	case ":${PATH}:" in
		*":${BUN_INSTALL}/bin:"*) ;;
		*) export PATH="${BUN_INSTALL}/bin:${PATH}" ;;
	esac
}

install_nvm_and_node_on_linux() {
	local install_script

	log "Installing nvm into ${NVM_INSTALL_DIR}"
	install_script="$(mktemp)"
	download_to_file "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh" "${install_script}"
	PROFILE=/dev/null bash "${install_script}"
	rm -f "${install_script}"

	load_linux_shell_env

	if ! command -v nvm >/dev/null 2>&1; then
		fail "nvm installation completed, but nvm is still not available in this shell."
	fi

	log "Installing Node.js LTS via nvm"
	nvm install --lts
	nvm alias default 'lts/*'
	nvm use --lts
}

install_bun_on_linux() {
	local install_script

	log "Installing Bun into ${LINUX_BUN_INSTALL_DIR}"
	install_script="$(mktemp)"
	download_to_file "https://bun.sh/install" "${install_script}"
	BUN_INSTALL="${LINUX_BUN_INSTALL_DIR}" bash "${install_script}"
	rm -f "${install_script}"

	load_linux_shell_env

	if ! command -v bun >/dev/null 2>&1; then
		fail "Bun installation completed, but bun is still not available in this shell."
	fi
}

ensure_linux_toolchain() {
	ensure_linux_shell_setup
	load_linux_shell_env

	if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
		install_nvm_and_node_on_linux
	fi

	if ! command -v bun >/dev/null 2>&1; then
		install_bun_on_linux
	fi
}

determine_global_bin_dir() {
	if [[ "${OS_NAME}" == "Linux" ]]; then
		echo "${PI_GLOBAL_BIN_DIR:-${LINUX_LOCAL_BIN_DIR}}"
		return
	fi

	if [[ -n "${PI_GLOBAL_BIN_DIR:-}" ]]; then
		echo "${PI_GLOBAL_BIN_DIR}"
	elif [[ -n "${PI_GLOBAL_PREFIX:-}" ]]; then
		echo "${PI_GLOBAL_PREFIX}/bin"
	else
		echo "$(npm config get prefix)/bin"
	fi
}

seed_google_oauth_stub_if_missing() {
	local oauth_secrets_dir="${PI_ROOT}/packages/ai/src/utils/oauth"
	local oauth_secrets_file="${oauth_secrets_dir}/google-oauth-secrets.ts"
	local oauth_secrets_example="${oauth_secrets_dir}/google-oauth-secrets.example.ts"

	if [[ ! -f "${oauth_secrets_file}" ]]; then
		log "Seeding ${oauth_secrets_file} from example (Google OAuth login will be disabled)"
		cp "${oauth_secrets_example}" "${oauth_secrets_file}"
	fi
}

create_macos_ca_bundle() {
	[[ "${OS_NAME}" == "Darwin" ]] || return 0
	command -v security >/dev/null 2>&1 || return 0

	log "Exporting macOS keychain certificates for the Bun binary"
	local tmp_bundle
	tmp_bundle="$(mktemp)"

	local keychain
	for keychain in \
		"${HOME}/Library/Keychains/login.keychain-db" \
		"/Library/Keychains/System.keychain" \
		"/System/Library/Keychains/SystemRootCertificates.keychain"; do
		if [[ -f "${keychain}" ]]; then
			security find-certificate -a -p "${keychain}" >> "${tmp_bundle}" 2>/dev/null || true
		fi
	done

	if grep -Fq -- "-----BEGIN CERTIFICATE-----" "${tmp_bundle}"; then
		mv "${tmp_bundle}" "${MACOS_CA_BUNDLE_PATH}"
	else
		rm -f "${tmp_bundle}"
		log "No macOS keychain certificates exported; continuing without ${MACOS_CA_BUNDLE_PATH}"
	fi
}

GLOBAL_BIN_DIR="$(determine_global_bin_dir)"
GLOBAL_PI_PATH="${GLOBAL_BIN_DIR}/pi"

if [[ "${OS_NAME}" == "Linux" ]]; then
	ensure_linux_toolchain
	GLOBAL_BIN_DIR="$(determine_global_bin_dir)"
	GLOBAL_PI_PATH="${GLOBAL_BIN_DIR}/pi"
fi

log "Installing workspace dependencies"
(cd "${PI_ROOT}" && npm install)

seed_google_oauth_stub_if_missing

log "Building pi binary from local source"
(cd "${PI_ROOT}" && npm run build:cli-binary)

if [[ ! -x "${BINARY_PATH}" ]]; then
	fail "Expected pi binary at ${BINARY_PATH}, but it was not built."
fi

create_macos_ca_bundle

log "Updating benchmark bundle manifest"
mkdir -p "$(dirname "${MANIFEST_PATH}")"
printf '{\n  "bundle_dir": "%s",\n  "binary_path": "%s"\n}\n' "${BUNDLE_DIR}" "${BINARY_PATH}" > "${MANIFEST_PATH}"

log "Installing global pi wrapper at ${GLOBAL_PI_PATH}"
mkdir -p "${GLOBAL_BIN_DIR}"
TMP_WRAPPER="$(mktemp)"
cat > "${TMP_WRAPPER}" <<EOF
#!/usr/bin/env bash
if [[ -z "\${NODE_EXTRA_CA_CERTS:-}" && -f "${MACOS_CA_BUNDLE_PATH}" ]]; then
	export NODE_EXTRA_CA_CERTS="${MACOS_CA_BUNDLE_PATH}"
fi
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
