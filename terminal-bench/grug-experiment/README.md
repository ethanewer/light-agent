# Grug experiment — terminal-bench 2.0 (12-task efficient subset)

Three runs against the `tb2-efficient-subset` n=12 task list (5 attempts each,
60 trials per run, concurrency 24) to measure the impact of a **Grug-brained
coding agent** system prompt on GPT-5.4.

## Configuration

- **Model:** `openai/gpt-5.4` (OpenAI Responses API, `openai-responses`)
- **Tools:** `read, bash, edit, write`
- **Attempts per task:** 5
- **Concurrency:** 24
- **Bench:** `terminal-bench@2.0`, tasks from `tb2-efficient-subset` (n=12, see `tasks.txt`)
- **Agent:** pi (local bundle, `pi_agent:PiBenchAgent`)

Grug prompt source: [replete/grug](https://github.com/replete/grug) SKILL.md,
rewritten as `grug-system-prompt.txt` so the Grug identity, voice, and
philosophy are woven into pi's coding-agent role — not just concatenated.

## Results

| experiment      | reasoning | system prompt            | mean reward | pass@5 (any) | timeouts | total tokens | API cost |
|-----------------|-----------|--------------------------|-------------|--------------|----------|--------------|----------|
| `default-high`  | high      | pi default               | **0.850**   | 11 / 12      | 3        | 27.7 M       | **$19.49** |
| `grug-high`     | high      | Grug-infused             | 0.667       | 11 / 12      | 6        | 26.1 M       | $18.71 |
| `grug-medium`   | medium    | Grug-infused             | 0.717       | 11 / 12      | 9        | 17.1 M       | $12.61 |

`total tokens = input + output + cache-read + cache-write` across every
`turn_end` event in each trial's `artifacts/pi-output.log`.

### Per-task mean reward (5 trials each)

| task                        | default-high | grug-high | grug-medium |
|-----------------------------|--------------|-----------|-------------|
| chess-best-move             |         1.00 |      0.80 |        0.80 |
| circuit-fibsqrt             |         1.00 |      0.80 |        1.00 |
| compile-compcert            |         1.00 |      0.80 |        1.00 |
| extract-elf                 |         1.00 |      0.20 |        0.60 |
| git-leak-recovery           |         0.80 |      1.00 |        1.00 |
| multi-source-data-merger    |         1.00 |      1.00 |        1.00 |
| path-tracing                |         1.00 |      0.60 |        0.40 |
| rstan-to-pystan             |         0.60 |      0.20 |        0.20 |
| sanitize-git-repo           |         0.80 |      0.60 |        0.80 |
| sparql-university           |         1.00 |      1.00 |        1.00 |
| sqlite-db-truncate          |         1.00 |      1.00 |        0.80 |
| torch-tensor-parallelism    |         0.00 |      0.00 |        0.00 |

### Observations

- **Grug hurts overall accuracy on GPT-5.4/high** (0.850 → 0.667, −18 pts).
  The persona interferes with precise-output tasks: `extract-elf`
  (1.00 → 0.20), `path-tracing` (1.00 → 0.60), `rstan-to-pystan`
  (0.60 → 0.20).
- **Grug *helps* on `git-leak-recovery`** (0.80 → 1.00, both reasoning
  levels). The "respect the fence, keep refactor small" beliefs seem to pay
  off when the task is "audit existing state carefully".
- **Pass@5-any is identical across all three runs** (11 / 12). Every run
  misses `torch-tensor-parallelism` entirely; every other task gets at least
  one passing trial.
- **Lowering reasoning from high → medium partially recovers Grug's
  accuracy** (0.667 → 0.717) and cuts tokens ~38 % and cost ~33 %. On this
  subset, the Grug style seems to over-think at high reasoning and
  occasionally talk itself out of the correct answer; at medium it commits
  faster.
- **3 → 6 → 9 agent timeouts** across the three runs. Grug is chattier in
  its reasoning (more narrative, more "grug look, grug ponder") which eats
  the per-trial time budget.

## Files

```
grug-experiment/
├── README.md                   # this file
├── grug-system-prompt.txt      # Grug-infused system prompt (replaces pi default)
├── tasks.txt                   # 12-task list, newline-separated
├── run-default-high.sh         # Experiment 1: default prompt, high reasoning
├── run-grug-high.sh            # Experiment 2: Grug prompt, high reasoning
├── run-grug-medium.sh          # Experiment 3: Grug prompt, medium reasoning
├── aggregate-usage.py          # parses pi-output.log → per-trial tokens + cost
├── make-summary.py             # builds summary.json + prints comparison table
├── results-default-high.json   # full per-trial results for Experiment 1
├── results-grug-high.json      # full per-trial results for Experiment 2
├── results-grug-medium.json    # full per-trial results for Experiment 3
├── summary.json                # cross-experiment comparison
└── logs/                       # stdout/stderr + PID for each background run
```

Each `results-*.json` contains:
- `experiment`, `model`, `provider`, `job_dirs`
- `overall` — aggregate tokens, cache tokens, cost, reward
- `per_task` — same metrics broken down by task name
- `harbor_jobs` — verbatim `jobs/<timestamp>/result.json` (includes Harbor's
  own pass@k)
- `trials` — full per-trial record (trial id, reward, tokens, cost)

## Reproducing

```bash
# Environment expected: OPENAI_API_KEY set, Docker running, harbor/uvx on PATH
# and the pi bundle present at pi/packages/coding-agent/dist/.
cd /Users/ethanewer/light-agent/terminal-bench/grug-experiment

./run-default-high.sh    # ~1h 12m
./run-grug-high.sh       # ~1h 20m
./run-grug-medium.sh     # ~1h 13m

python3 make-summary.py  # regenerates summary.json + the comparison table
```

Each `run-*.sh` exports the right `PI_BENCH_*` env vars, calls
`../run_pi.sh` (which shells out to the monkey-patched Harbor CLI via
`../harbor_lpt.py`), then invokes `aggregate-usage.py` on the new job dir.
The aggregator scans `../jobs/<ts>/<trial>/artifacts/pi-output.log`, sums
`turn_end.message.usage` across every turn, and joins with each trial's
`result.json` reward to produce `results-<experiment>.json`.

### Notes / caveats

- Trials that hit `AgentTimeoutError` are counted as reward 0 (Harbor
  convention), not "N/A", so they drag the mean down in addition to
  whatever cost the model already burned.
- Cost numbers come straight from the pi AI layer's `cost` fields (pi
  applies the provider-published per-token rates at stream-end). They are
  invoice-accurate to within rounding.
- A separate pre-flight fix was needed in
  `../validate_pi_bench_config.mjs`: the validator imported `allTools`
  (doesn't exist) instead of `allToolNames`. Fixed in place as part of
  this experiment.
