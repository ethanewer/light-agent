#!/usr/bin/env bash
set -euo pipefail

N_ATTEMPTS="${PI_BENCH_ATTEMPTS:-5}"
N_CONCURRENT="${PI_BENCH_CONCURRENT:-24}"
MODEL="${PI_BENCH_MODEL:-openrouter/minimax/minimax-m2.7}"
THINKING="${PI_BENCH_THINKING:-high}"
TOOLS="${PI_BENCH_TOOLS:-read,bash,edit,write}"
SYSTEM_PROMPT="${PI_BENCH_SYSTEM_PROMPT:-}"
EXTRA_ARGS="${PI_BENCH_EXTRA_ARGS:-}"
TASKS=(
  chess-best-move
  compile-compcert
  extract-elf
  git-leak-recovery
  multi-source-data-merger
  rstan-to-pystan
  sanitize-git-repo
  sparql-university
  sqlite-db-truncate
  torch-tensor-parallelism
)

if [[ -n "${PI_BENCH_TASKS:-}" ]]; then
  # shellcheck disable=SC2206
  TASKS=(${PI_BENCH_TASKS})
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date -u +"%Y-%m-%d__%H-%M-%S")"
JOBS_DIR="${SCRIPT_DIR}/jobs"
RESULTS_DIR="${REPO_ROOT}/results"

export PI_BENCH_THINKING="${THINKING}"
export PI_BENCH_TOOLS="${TOOLS}"
export PI_BENCH_SYSTEM_PROMPT="${SYSTEM_PROMPT}"
export PI_BENCH_EXTRA_ARGS="${EXTRA_ARGS}"

USE_LPT=true
for arg in "$@"; do
  case "${arg}" in
    --lpt) USE_LPT=true ;;
    --no-lpt) USE_LPT=false ;;
  esac
done

resolve_harbor() {
  if [[ "${USE_LPT}" == "true" ]]; then
    if command -v harbor >/dev/null 2>&1; then
      HARBOR_CMD=(python3 "${SCRIPT_DIR}/harbor_lpt.py")
    elif command -v uvx >/dev/null 2>&1; then
      HARBOR_CMD=(uvx --from harbor python3 "${SCRIPT_DIR}/harbor_lpt.py")
    else
      echo "ERROR: Neither 'harbor' nor 'uvx' found on PATH." >&2
      exit 127
    fi
    return
  fi
  if command -v harbor >/dev/null 2>&1; then
    HARBOR_CMD=(harbor)
    return
  fi
  if command -v uvx >/dev/null 2>&1; then
    HARBOR_CMD=(uvx --from harbor harbor)
    return
  fi
  echo "ERROR: Neither 'harbor' nor 'uvx' found on PATH." >&2
  echo "Install the Harbor CLI or uv (uvx) to run this script." >&2
  exit 127
}

main() {
  resolve_harbor

  CMD=(
    "${HARBOR_CMD[@]}"
    run
    -d "terminal-bench@2.0"
    --env docker
    --no-force-build
    --no-delete
    --jobs-dir "${JOBS_DIR}"
    -k "${N_ATTEMPTS}"
    -n "${N_CONCURRENT}"
    --agent-import-path "pi_agent:PiBenchAgent"
    -m "${MODEL}"
    --artifact /tmp/pi-output.log
  )

  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    CMD+=(--ae "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}")
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    CMD+=(--ae "OPENAI_API_KEY=${OPENAI_API_KEY}")
  fi
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    CMD+=(--ae "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  fi
  if [[ -n "${PI_BENCH_BUNDLE_DIR:-}" ]]; then
    CMD+=(--ae "PI_BENCH_BUNDLE_DIR=${PI_BENCH_BUNDLE_DIR}")
  fi

  if [[ ${#TASKS[@]} -gt 0 ]]; then
    for task in "${TASKS[@]}"; do
      CMD+=(-i "${task}")
    done
  fi

  echo "==> Running pi agent on terminal-bench@2.0"
  echo "    Model:       ${MODEL}"
  echo "    Thinking:    ${THINKING}"
  echo "    Tools:       ${TOOLS}"
  echo "    Attempts:    ${N_ATTEMPTS}"
  echo "    Concurrency: ${N_CONCURRENT}"
  echo "    Tasks:       ${TASKS[*]:-ALL}"
  echo "    LPT:         ${USE_LPT}"
  echo ""

  (cd "${SCRIPT_DIR}" && "${CMD[@]}")

  LATEST_JOB="$(ls -td "${JOBS_DIR}"/*/ 2>/dev/null | head -1)"
  if [[ -n "${LATEST_JOB}" ]]; then
    DEST="${RESULTS_DIR}/terminal-bench-pi-${TIMESTAMP}"
    mkdir -p "${DEST}"
    cp -r "${LATEST_JOB}"/* "${DEST}"/
    echo ""
    echo "==> Results copied to ${DEST}"
  fi
}

main "$@"
