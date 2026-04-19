#!/usr/bin/env python3
"""harbor-lpt: Harbor CLI wrapper with LPT scheduling, prefetching, and OOM-aware concurrency.

Three optimizations over the standard Harbor CLI:

1. LPT (Longest Processing Time first) scheduling — sorts trial configs by
   descending expected task runtime so the longest tasks start first. This
   minimizes total wall-clock time when running with concurrent workers.
   Harbor's TrialQueue uses asyncio.Semaphore (FIFO in CPython), so reordering
   the trial config list is sufficient to control execution order.

2. Docker image prefetching — before any trials start, sequentially pulls all
   Docker images needed by the job's tasks. This prevents concurrent pull storms
   that crash high-concurrency runs and avoids Docker API rate limits by checking
   the local cache first.

3. Weighted OOM-aware concurrency — replaces Harbor's flat semaphore with a
   weighted semaphore. Memory-heavy tasks consume multiple concurrency slots,
   preventing host-level OOM when many containers run simultaneously. Tasks that
   OOM at runtime are automatically retried with an escalated weight.

Usage: python3 harbor_lpt.py run [harbor flags...]
       (accepts all standard harbor CLI flags)
"""

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

import harbor.job as _harbor_job
import harbor.trial.queue as _harbor_queue

# ---------------------------------------------------------------------------
# 1. LPT Scheduling
# ---------------------------------------------------------------------------

# Load per-task runtime estimates
_RUNTIMES_PATH = Path(__file__).parent / "task_runtimes.json"
_runtimes = json.loads(_RUNTIMES_PATH.read_text()) if _RUNTIMES_PATH.exists() else {}
_fallback = sorted(_runtimes.values())[len(_runtimes) // 2] if _runtimes else 0

_original_init_trial_configs = _harbor_job.Job._init_trial_configs


def _lpt_init(self):
    _original_init_trial_configs(self)

    def _task_runtime(tc):
        name = tc.task.get_task_id().get_name().split("/")[-1]
        return _runtimes.get(name, _fallback)

    self._trial_configs.sort(key=_task_runtime, reverse=True)


_harbor_job.Job._init_trial_configs = _lpt_init

# ---------------------------------------------------------------------------
# 2. Docker Image Prefetching
# ---------------------------------------------------------------------------


def _image_exists_locally(image: str) -> bool:
    """Check if a Docker image is already present in the local cache."""
    result = subprocess.run(
        ["docker", "image", "inspect", image],
        capture_output=True,
    )
    return result.returncode == 0


def _pull_image(image: str) -> bool:
    """Pull a Docker image. Returns True on success."""
    result = subprocess.run(
        ["docker", "pull", image],
        stdout=sys.stderr,  # stream pull progress to stderr
        stderr=subprocess.STDOUT,
    )
    return result.returncode == 0


def _prefetch_docker_images(job: _harbor_job.Job) -> None:
    """Pre-pull all unique Docker images needed by the job's tasks.

    Reads each task's task.toml to find the docker_image field. Images that
    are already cached locally are skipped. Pulls happen sequentially to
    avoid concurrent pull storms and Docker API rate limits.
    """
    from harbor.models.task.task import Task

    images: dict[str, str] = {}  # image -> task_name
    seen_paths: set[Path] = set()

    for tc in job._task_configs:
        try:
            local_path = tc.get_local_path()
            if local_path in seen_paths:
                continue
            seen_paths.add(local_path)
            if not local_path.exists():
                continue

            task = Task(local_path)
            docker_image = task.config.environment.docker_image
            if docker_image and docker_image not in images:
                images[docker_image] = task.name
        except Exception:
            continue

    if not images:
        return

    print(f"\n==> Prefetching {len(images)} Docker image(s)...", file=sys.stderr)

    cached, pulled, failed = 0, 0, 0
    for image, task_name in sorted(images.items(), key=lambda kv: kv[1]):
        if _image_exists_locally(image):
            print(f"    {image} (cached)", file=sys.stderr)
            cached += 1
            continue

        print(f"    Pulling {image} (for {task_name})...", file=sys.stderr)
        if _pull_image(image):
            pulled += 1
        else:
            print(f"    WARNING: Failed to pull {image}", file=sys.stderr)
            failed += 1

    summary_parts = []
    if cached:
        summary_parts.append(f"{cached} cached")
    if pulled:
        summary_parts.append(f"{pulled} pulled")
    if failed:
        summary_parts.append(f"{failed} failed")
    print(
        f"==> Prefetch complete ({', '.join(summary_parts)})\n",
        file=sys.stderr,
    )


# Monkey-patch Job.run to prefetch images before starting trials
_original_run = _harbor_job.Job.run


async def _prefetch_and_run(self):
    _prefetch_docker_images(self)
    return await _original_run(self)


_harbor_job.Job.run = _prefetch_and_run

# ---------------------------------------------------------------------------
# 3. Weighted OOM-Aware Concurrency
# ---------------------------------------------------------------------------

_WEIGHTS_PATH = Path(__file__).parent / "task_weights.json"
_static_weights: dict[str, int] = (
    json.loads(_WEIGHTS_PATH.read_text()) if _WEIGHTS_PATH.exists() else {}
)

_dynamic_weights: dict[str, int] = {}

_MAX_OOM_RETRIES = 1
_MAX_WEIGHT_FRACTION = 0.5  # single task can use at most half the capacity


class WeightedSemaphore:
    """Semaphore that atomically acquires N slots, avoiding partial-allocation deadlocks."""

    def __init__(self, capacity: int):
        self._capacity = capacity
        self._used = 0
        self._cond = asyncio.Condition()

    async def acquire(self, weight: int = 1) -> None:
        async with self._cond:
            while self._used + weight > self._capacity:
                await self._cond.wait()
            self._used += weight

    async def release(self, weight: int = 1) -> None:
        async with self._cond:
            self._used -= weight
            self._cond.notify_all()


def _task_name_from_config(trial_config) -> str:
    return trial_config.task.get_task_id().get_name().split("/")[-1]


def _get_weight(task_name: str) -> int:
    return max(
        _static_weights.get(task_name, 1),
        _dynamic_weights.get(task_name, 1),
    )


def _is_oom(result) -> bool:
    """Detect OOM from a TrialResult.

    Checks two patterns:
    1. Container-level OOM: Docker exit 137 in exception_info
    2. Process-level OOM: agent reports exit_code=137 in result metadata
    """
    # Check container-level OOM via exception_info
    info = getattr(result, "exception_info", None)
    if info is not None:
        msg = getattr(info, "exception_message", "")
        first_line = msg.split("\n", 1)[0]
        if "137" in first_line:
            return True

    # Check process-level OOM via agent result metadata
    agent_result = getattr(result, "agent_result", None)
    if agent_result is not None:
        metadata = getattr(agent_result, "metadata", None) or {}
        if isinstance(metadata, dict):
            tool_result = metadata.get("pi_result", {})
            if isinstance(tool_result, dict) and tool_result.get("exit_code") == 137:
                return True

    return False


_original_queue_init = _harbor_queue.TrialQueue.__init__


def _weighted_queue_init(self, n_concurrent, **kwargs):
    _original_queue_init(self, n_concurrent, **kwargs)
    self._wsem = WeightedSemaphore(n_concurrent)
    self._wsem_capacity = n_concurrent


_harbor_queue.TrialQueue.__init__ = _weighted_queue_init


async def _weighted_run_trial(self, trial_config):
    """Run a trial using weighted semaphore slots; retry with higher weight on OOM."""
    task_name = _task_name_from_config(trial_config)
    max_weight = min(
        max(2, int(self._wsem_capacity * _MAX_WEIGHT_FRACTION)),
        self._wsem_capacity,
    )

    for oom_attempt in range(_MAX_OOM_RETRIES + 1):
        weight = min(_get_weight(task_name), max_weight)
        await self._wsem.acquire(weight)
        try:
            result = await self._execute_trial_with_retries(trial_config)
        finally:
            await self._wsem.release(weight)

        if _is_oom(result) and oom_attempt < _MAX_OOM_RETRIES:
            new_weight = min(_get_weight(task_name) + 1, max_weight)
            _dynamic_weights[task_name] = new_weight
            print(
                f"[harbor-lpt] OOM detected for {task_name}, "
                f"retrying with weight {new_weight}/{self._wsem_capacity} "
                f"(attempt {oom_attempt + 2}/{_MAX_OOM_RETRIES + 1})",
                file=sys.stderr,
            )
            trial_dir = trial_config.trials_dir / trial_config.trial_name
            shutil.rmtree(trial_dir, ignore_errors=True)
            continue

        return result

    return result  # exhausted retries, return last result


_harbor_queue.TrialQueue._run_trial = _weighted_run_trial

# ---------------------------------------------------------------------------
# 4. Run the normal Harbor CLI
# ---------------------------------------------------------------------------

from harbor.cli.main import app  # noqa: E402

app()
