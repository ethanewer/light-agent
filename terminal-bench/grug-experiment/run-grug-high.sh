#!/usr/bin/env bash
# Experiment 2: GPT-5.4, high reasoning, GRUG-INFUSED system prompt.
# 12-task TB2 efficient subset × 5 attempts = 60 trials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXPERIMENT="grug-high"
TIMESTAMP="$(date +"%Y-%m-%d__%H-%M-%S")"
JOB_TAG="grug-exp-${EXPERIMENT}-${TIMESTAMP}"

TASKS="$(tr '\n' ' ' < "${SCRIPT_DIR}/tasks.txt")"

export PI_BENCH_ATTEMPTS=5
export PI_BENCH_CONCURRENT=24
export PI_BENCH_MODEL="openai/gpt-5.4"
export PI_BENCH_THINKING="high"
export PI_BENCH_TOOLS="read,bash,edit,write"
export PI_BENCH_TASKS="${TASKS}"
export PI_BENCH_SYSTEM_PROMPT="$(cat "${SCRIPT_DIR}/grug-system-prompt.txt")"

echo "==> Experiment: ${EXPERIMENT}"
echo "    Model:     ${PI_BENCH_MODEL}"
echo "    Thinking:  ${PI_BENCH_THINKING}"
echo "    Tools:     ${PI_BENCH_TOOLS}"
echo "    Prompt:    grug-system-prompt.txt ($(wc -c < "${SCRIPT_DIR}/grug-system-prompt.txt" | tr -d ' ') bytes)"
echo "    Tasks:     $(echo "${TASKS}" | wc -w | tr -d ' ')"
echo "    Attempts:  ${PI_BENCH_ATTEMPTS}"
echo "    Tag:       ${JOB_TAG}"
echo ""

echo "${TIMESTAMP}" > "${SCRIPT_DIR}/.${EXPERIMENT}.started"

bash "${TB_DIR}/run_pi.sh" "$@"

python3 "${SCRIPT_DIR}/aggregate-usage.py" \
  --experiment "${EXPERIMENT}" \
  --started-after "${TIMESTAMP}" \
  --output "${SCRIPT_DIR}/results-${EXPERIMENT}.json"
