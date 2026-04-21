#!/usr/bin/env bash
# Experiment 1: GPT-5.4, high reasoning, DEFAULT pi system prompt.
# 12-task TB2 efficient subset × 5 attempts = 60 trials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXPERIMENT="default-high"
TIMESTAMP="$(date +"%Y-%m-%d__%H-%M-%S")"
JOB_TAG="grug-exp-${EXPERIMENT}-${TIMESTAMP}"

# 12-task subset, whitespace-separated for PI_BENCH_TASKS.
TASKS="$(tr '\n' ' ' < "${SCRIPT_DIR}/tasks.txt")"

export PI_BENCH_ATTEMPTS=5
export PI_BENCH_CONCURRENT=24
export PI_BENCH_MODEL="openai/gpt-5.4"
export PI_BENCH_THINKING="high"
export PI_BENCH_TOOLS="read,bash,edit,write"
export PI_BENCH_TASKS="${TASKS}"
# No PI_BENCH_SYSTEM_PROMPT → pi builds its default coding-agent prompt.
unset PI_BENCH_SYSTEM_PROMPT

echo "==> Experiment: ${EXPERIMENT}"
echo "    Model:     ${PI_BENCH_MODEL}"
echo "    Thinking:  ${PI_BENCH_THINKING}"
echo "    Tools:     ${PI_BENCH_TOOLS}"
echo "    Prompt:    default (pi built-in)"
echo "    Tasks:     $(echo "${TASKS}" | wc -w | tr -d ' ')"
echo "    Attempts:  ${PI_BENCH_ATTEMPTS}"
echo "    Tag:       ${JOB_TAG}"
echo ""

# Record the launch timestamp so the aggregator can pick the right jobs dir.
echo "${TIMESTAMP}" > "${SCRIPT_DIR}/.${EXPERIMENT}.started"

bash "${TB_DIR}/run_pi.sh" "$@"

# After the run, aggregate tokens, cost, and reward into a JSON report.
python3 "${SCRIPT_DIR}/aggregate-usage.py" \
  --experiment "${EXPERIMENT}" \
  --started-after "${TIMESTAMP}" \
  --output "${SCRIPT_DIR}/results-${EXPERIMENT}.json"
