#!/usr/bin/env python3
"""Aggregate token usage, cost, and reward for a Grug-experiment TB2 run.

Scans the newest harbor jobs dirs whose name (ISO timestamp) is >= --started-after,
parses each trial's `artifacts/pi-output.log` for JSONL `turn_end` events, and
combines with the overall `result.json` + per-trial `result.json` reward values.

Writes a self-contained JSON summary compatible with the tb2-efficient-subset
baseline files already in this repo.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
TB_DIR = SCRIPT_DIR.parent
JOBS_DIR = TB_DIR / "jobs"


def parse_iso_dirname(name: str) -> datetime | None:
    """Harbor names job dirs with LOCAL wall-clock time, e.g. '2026-04-21__02-51-39'."""
    try:
        return datetime.strptime(name, "%Y-%m-%d__%H-%M-%S")
    except ValueError:
        return None


def find_job_dirs(started_after: datetime) -> list[Path]:
    """Return all job dirs with dir timestamp >= started_after, sorted ascending."""
    if not JOBS_DIR.exists():
        return []
    hits: list[tuple[datetime, Path]] = []
    for p in JOBS_DIR.iterdir():
        if not p.is_dir():
            continue
        ts = parse_iso_dirname(p.name)
        if ts is None:
            continue
        if ts >= started_after:
            hits.append((ts, p))
    hits.sort()
    return [p for _, p in hits]


def parse_pi_output(path: Path) -> dict:
    """Extract per-turn + total usage/cost from pi-output.log (JSONL after header)."""
    totals = {
        "turns": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost_input": 0.0,
        "cost_output": 0.0,
        "cost_cache_read": 0.0,
        "cost_cache_write": 0.0,
        "cost_total": 0.0,
        "model": None,
        "provider": None,
        "pi_exit_code": None,
    }
    if not path.exists():
        return totals

    with path.open("r", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line.startswith("{"):
                # Capture the trailer exit code line if present.
                if line.startswith("pi exited with code"):
                    try:
                        totals["pi_exit_code"] = int(line.rsplit(" ", 1)[-1])
                    except ValueError:
                        pass
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "turn_end":
                continue
            msg = obj.get("message") or {}
            usage = msg.get("usage") or {}
            cost = usage.get("cost") or {}
            totals["turns"] += 1
            totals["input_tokens"] += int(usage.get("input", 0) or 0)
            totals["output_tokens"] += int(usage.get("output", 0) or 0)
            totals["cache_read_tokens"] += int(usage.get("cacheRead", 0) or 0)
            totals["cache_write_tokens"] += int(usage.get("cacheWrite", 0) or 0)
            totals["total_tokens"] += int(usage.get("totalTokens", 0) or 0)
            totals["cost_input"] += float(cost.get("input", 0.0) or 0.0)
            totals["cost_output"] += float(cost.get("output", 0.0) or 0.0)
            totals["cost_cache_read"] += float(cost.get("cacheRead", 0.0) or 0.0)
            totals["cost_cache_write"] += float(cost.get("cacheWrite", 0.0) or 0.0)
            totals["cost_total"] += float(cost.get("total", 0.0) or 0.0)
            if totals["model"] is None and msg.get("model"):
                totals["model"] = msg["model"]
            if totals["provider"] is None and msg.get("provider"):
                totals["provider"] = msg["provider"]
    return totals


def extract_reward(trial_dir: Path) -> tuple[float | None, str | None]:
    result = trial_dir / "result.json"
    if not result.exists():
        return None, None
    try:
        data = json.loads(result.read_text())
    except Exception:
        return None, None
    reward = None
    rewards = (data.get("verifier_result") or {}).get("rewards") or {}
    if "reward" in rewards:
        try:
            reward = float(rewards["reward"])
        except (TypeError, ValueError):
            reward = None
    failure = data.get("failure_mode") or (data.get("exception") or {}).get("name")
    return reward, failure


def parse_task_name(trial_dir_name: str) -> str:
    # Trial dirs look like "<task>__<short-hash>".
    return trial_dir_name.rsplit("__", 1)[0]


def aggregate(
    experiment: str,
    started_after_str: str,
    output_path: Path,
    allowed_tasks: set[str] | None,
) -> None:
    # Compare as naive local time (same convention as Harbor job dir names).
    started_after = datetime.strptime(started_after_str, "%Y-%m-%d__%H-%M-%S")
    job_dirs = find_job_dirs(started_after)
    if not job_dirs:
        print(f"No job dirs found after {started_after_str}", file=sys.stderr)
        sys.exit(2)

    all_trials: list[dict] = []
    job_result_files: list[Path] = []

    for jd in job_dirs:
        top_result = jd / "result.json"
        if top_result.exists():
            job_result_files.append(top_result)
        for trial_dir in sorted(jd.iterdir()):
            if not trial_dir.is_dir():
                continue
            pi_log = trial_dir / "artifacts" / "pi-output.log"
            if not pi_log.exists():
                continue
            task = parse_task_name(trial_dir.name)
            if allowed_tasks is not None and task not in allowed_tasks:
                # Foreign trial from an unrelated concurrent run — skip.
                continue
            usage = parse_pi_output(pi_log)
            reward, failure = extract_reward(trial_dir)
            all_trials.append(
                {
                    "trial_id": trial_dir.name,
                    "task": task,
                    "reward": reward,
                    "failure": failure,
                    "job_dir": str(jd.relative_to(TB_DIR)),
                    **usage,
                }
            )

    # Aggregate per-task and overall.
    per_task: dict[str, dict] = {}
    overall = {
        "n_trials": 0,
        "n_scored": 0,
        "n_errors": 0,
        "reward_sum": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost_total": 0.0,
    }

    for t in all_trials:
        overall["n_trials"] += 1
        if t["reward"] is not None:
            overall["n_scored"] += 1
            overall["reward_sum"] += t["reward"]
        else:
            overall["n_errors"] += 1
        for k in (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "total_tokens",
        ):
            overall[k] += t[k]
        overall["cost_total"] += t["cost_total"]

        tb = per_task.setdefault(
            t["task"],
            {
                "n_trials": 0,
                "n_scored": 0,
                "reward_sum": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "total_tokens": 0,
                "cost_total": 0.0,
            },
        )
        tb["n_trials"] += 1
        if t["reward"] is not None:
            tb["n_scored"] += 1
            tb["reward_sum"] += t["reward"]
        for k in (
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "total_tokens",
        ):
            tb[k] += t[k]
        tb["cost_total"] += t["cost_total"]

    overall["mean_reward"] = (
        overall["reward_sum"] / overall["n_scored"] if overall["n_scored"] else None
    )
    for tn, tb in per_task.items():
        tb["mean_reward"] = tb["reward_sum"] / tb["n_scored"] if tb["n_scored"] else None

    # Pull top-level pass@k from harbor's own result.json (union across job dirs).
    job_level = []
    for rf in job_result_files:
        try:
            d = json.loads(rf.read_text())
        except Exception:
            continue
        job_level.append(
            {
                "job_id": d.get("id"),
                "started_at": d.get("started_at"),
                "finished_at": d.get("finished_at"),
                "n_total_trials": d.get("n_total_trials"),
                "stats": d.get("stats"),
                "path": str(rf.relative_to(TB_DIR)),
            }
        )

    summary = {
        "experiment": experiment,
        "generated_at": datetime.now().isoformat(),
        "started_after": started_after_str,
        "job_dirs": [str(p.relative_to(TB_DIR)) for p in job_dirs],
        "model": next((t["model"] for t in all_trials if t["model"]), None),
        "provider": next((t["provider"] for t in all_trials if t["provider"]), None),
        "overall": overall,
        "per_task": per_task,
        "harbor_jobs": job_level,
        "trials": all_trials,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2))

    print(f"==> Wrote {output_path}")
    print(f"    Trials scanned:    {overall['n_trials']}")
    print(f"    Scored trials:     {overall['n_scored']}")
    print(f"    Mean reward:       {overall['mean_reward']}")
    print(f"    Total tokens:      {overall['total_tokens']:,}")
    print(f"       input:          {overall['input_tokens']:,}")
    print(f"       output:         {overall['output_tokens']:,}")
    print(f"       cache read:     {overall['cache_read_tokens']:,}")
    print(f"       cache write:    {overall['cache_write_tokens']:,}")
    print(f"    Total API cost:    ${overall['cost_total']:.4f}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment", required=True)
    parser.add_argument(
        "--started-after",
        required=True,
        help="UTC timestamp in 'YYYY-MM-DD__HH-MM-SS' form; only jobs started at/after this are scanned.",
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--tasks-file",
        type=Path,
        default=SCRIPT_DIR / "tasks.txt",
        help="Newline-separated list of task names to include (defaults to the 12-task subset).",
    )
    args = parser.parse_args()

    allowed: set[str] | None = None
    if args.tasks_file.exists():
        allowed = {
            line.strip()
            for line in args.tasks_file.read_text().splitlines()
            if line.strip()
        }

    aggregate(args.experiment, args.started_after, args.output, allowed)


if __name__ == "__main__":
    main()
