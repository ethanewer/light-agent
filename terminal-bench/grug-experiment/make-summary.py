#!/usr/bin/env python3
"""Build summary.json + a human-readable table from the three experiment files."""

from __future__ import annotations

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

EXPERIMENTS = [
    ("default-high", "results-default-high.json", "GPT-5.4 high, default pi prompt"),
    ("grug-high", "results-grug-high.json", "GPT-5.4 high, Grug-infused prompt"),
    ("grug-medium", "results-grug-medium.json", "GPT-5.4 medium, Grug-infused prompt"),
]

TASKS = [
    "chess-best-move",
    "circuit-fibsqrt",
    "compile-compcert",
    "extract-elf",
    "git-leak-recovery",
    "multi-source-data-merger",
    "path-tracing",
    "rstan-to-pystan",
    "sanitize-git-repo",
    "sparql-university",
    "sqlite-db-truncate",
    "torch-tensor-parallelism",
]


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def pass_at_k(rewards: list[float], k: int) -> float:
    """Sampling-free pass@k (task passes if any of first k trials has reward==1)."""
    return 1.0 if any(r >= 0.5 for r in rewards[:k]) else 0.0


def main() -> None:
    per_experiment: dict[str, dict] = {}

    for name, filename, _desc in EXPERIMENTS:
        data = load(SCRIPT_DIR / filename)

        # Group trials by task for pass@k (preserving file order).
        per_task_rewards: dict[str, list[float]] = {t: [] for t in TASKS}
        for t in data["trials"]:
            if t["task"] in per_task_rewards and t["reward"] is not None:
                per_task_rewards[t["task"]].append(t["reward"])

        per_task_summary = {}
        pass5_hits = 0
        for task in TASKS:
            rewards = per_task_rewards[task]
            pt = data["per_task"].get(task, {})
            p5 = pass_at_k(rewards, 5) if rewards else 0.0
            if p5 >= 0.5:
                pass5_hits += 1
            per_task_summary[task] = {
                "n_scored": pt.get("n_scored", 0),
                "mean_reward": pt.get("mean_reward"),
                "pass_at_5": p5,
                "rewards": rewards,
                "input_tokens": pt.get("input_tokens", 0),
                "output_tokens": pt.get("output_tokens", 0),
                "cache_read_tokens": pt.get("cache_read_tokens", 0),
                "total_tokens": pt.get("total_tokens", 0),
                "cost_total": round(pt.get("cost_total", 0.0), 4),
            }

        harbor = data.get("harbor_jobs") or [{}]
        harbor_stats = (harbor[0].get("stats") or {}).get("evals", {}).get(
            "pi__terminal-bench", {}
        )
        harbor_metrics = harbor_stats.get("metrics") or [{}]
        harbor_mean = harbor_metrics[0].get("mean")
        harbor_passk = harbor_stats.get("pass_at_k") or {}

        o = data["overall"]
        per_experiment[name] = {
            "description": _desc,
            "model": data.get("model"),
            "provider": data.get("provider"),
            "mean_reward": o.get("mean_reward"),
            "n_trials": o.get("n_trials"),
            "n_scored": o.get("n_scored"),
            "n_tasks_solved_any": pass5_hits,
            "harbor_reported_mean": harbor_mean,
            "harbor_pass_at_k": harbor_passk,
            "tokens": {
                "input": o["input_tokens"],
                "output": o["output_tokens"],
                "cache_read": o["cache_read_tokens"],
                "cache_write": o["cache_write_tokens"],
                "total": o["total_tokens"],
            },
            "cost_total": round(o["cost_total"], 4),
            "per_task": per_task_summary,
            "job_dirs": data.get("job_dirs", []),
        }

    summary = {
        "config": {
            "model": "openai/gpt-5.4",
            "tools": ["read", "bash", "edit", "write"],
            "attempts_per_task": 5,
            "concurrency": 24,
            "tasks": TASKS,
            "bench": "terminal-bench@2.0 — tb2-efficient-subset n=12",
        },
        "experiments": per_experiment,
    }

    out = SCRIPT_DIR / "summary.json"
    out.write_text(json.dumps(summary, indent=2))
    print(f"Wrote {out}")

    # Print comparison table to stdout.
    print()
    print(f"{'experiment':<15} {'mean':>7} {'pass@5(any)':>12} {'tokens':>14} {'cost':>10}")
    print("-" * 65)
    for name, _, _ in EXPERIMENTS:
        e = per_experiment[name]
        print(
            f"{name:<15} "
            f"{e['mean_reward']:>7.3f} "
            f"{e['n_tasks_solved_any']:>4d}/{len(TASKS):<7d} "
            f"{e['tokens']['total']:>14,} "
            f"${e['cost_total']:>8.2f}"
        )

    print()
    print(f"{'task':<28} {'default-high':>13} {'grug-high':>10} {'grug-medium':>12}")
    print("-" * 68)
    for task in TASKS:
        row = [task]
        for name, _, _ in EXPERIMENTS:
            pt = per_experiment[name]["per_task"][task]
            mean = pt["mean_reward"]
            row.append(f"{mean:.2f}" if mean is not None else "   -")
        print(f"{row[0]:<28} {row[1]:>13} {row[2]:>10} {row[3]:>12}")


if __name__ == "__main__":
    main()
