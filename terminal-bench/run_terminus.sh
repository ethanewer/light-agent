#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Configuration — edit these variables
# =============================================================================
N_ATTEMPTS=5                              # Number of attempts per task
N_CONCURRENT=12                           # Number of concurrent trials
MODEL="openrouter/minimax/minimax-m2.7"   # Model identifier
TASKS=(                                   # Task names to run (empty array = all tasks)
  chess-best-move
  circuit-fibsqrt
  compile-compcert
  extract-elf
  git-leak-recovery
  multi-source-data-merger
  path-tracing
  rstan-to-pystan
  sanitize-git-repo
  sparql-university
  sqlite-db-truncate
  torch-tensor-parallelism
)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TIMESTAMP="$(date -u +"%Y-%m-%d__%H-%M-%S")"
JOBS_DIR="${SCRIPT_DIR}/jobs"
RESULTS_DIR="${REPO_ROOT}/results"

# Check for --lpt flag
USE_LPT=false
for arg in "$@"; do
  [[ "$arg" == "--lpt" ]] && USE_LPT=true
done

# ---------------------------------------------------------------------------
# Resolve harbor command (or harbor_lpt.py wrapper for LPT scheduling)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Build and run
# ---------------------------------------------------------------------------
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
    --agent terminus-2
    -m "${MODEL}"
  )

  # Forward API keys
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    CMD+=(--ae "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}")
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    CMD+=(--ae "OPENAI_API_KEY=${OPENAI_API_KEY}")
  fi
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    CMD+=(--ae "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  fi

  # Task filters
  for task in "${TASKS[@]}"; do
    CMD+=(-i "${task}")
  done

  echo "==> Running Terminus 2 agent on terminal-bench@2.0"
  echo "    Model:       ${MODEL}"
  echo "    Attempts:    ${N_ATTEMPTS}"
  echo "    Concurrency: ${N_CONCURRENT}"
  echo "    Tasks:       ${TASKS[*]:-ALL}"
  echo "    LPT:         ${USE_LPT}"
  echo ""

  # Run from script dir
  (cd "${SCRIPT_DIR}" && "${CMD[@]}")

  # Copy results to top-level results/
  LATEST_JOB="$(ls -td "${JOBS_DIR}"/*/ 2>/dev/null | head -1)"
  if [[ -n "${LATEST_JOB}" ]]; then
    DEST="${RESULTS_DIR}/terminal-bench-terminus-${TIMESTAMP}"
    mkdir -p "${DEST}"
    cp -r "${LATEST_JOB}"/* "${DEST}"/
    echo ""
    echo "==> Results copied to ${DEST}"
  fi
}

main "$@"
