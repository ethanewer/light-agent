"""Harbor agent that runs the locally built pi CLI inside task containers."""

from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import os
import shlex
from pathlib import Path
from typing import Any

_base_agent_cls: type[object] = object
try:
    _harbor_base_module = importlib.import_module("harbor.agents.base")
    candidate = getattr(_harbor_base_module, "BaseAgent", object)
    if isinstance(candidate, type):
        _base_agent_cls = candidate
except Exception:
    _base_agent_cls = object

HarborBaseAgent = _base_agent_cls

_SCRIPT_DIR = Path(__file__).resolve().parent
_MANIFEST_PATH = _SCRIPT_DIR / "bin" / "pi-benchmark-install.json"
_REMOTE_BUNDLE_DIR = "/tmp/pi-bundle"
_ARCH_MAP = {
    "aarch64": "pi-linux-arm64",
    "arm64": "pi-linux-arm64",
    "x86_64": "pi-linux-x64",
    "amd64": "pi-linux-x64",
}

_FORWARD_ENV_KEYS = (
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
)

# Default task-focused guidance appended to pi's interactive-oriented system prompt when
# running on terminal-bench. Keeps the default behavior (documented tools, etc.) but nudges
# the model to treat the instruction as a binding spec, verify its own work, and avoid
# modifying unrelated files. Empirically raised rstan / sanitize / sparql pass-rates in
# round-1 experiments (pre provider-pin). Override with PI_BENCH_APPEND_SYSTEM_PROMPT=""
# or set PI_BENCH_APPEND_SYSTEM_PROMPT=<path:...> / <raw text> to customize.
_DEFAULT_BENCH_APPEND_PROMPT = """\
You are running a single batch task end-to-end in a sandboxed container. Follow these rules:
- First, examine the environment (working dir, relevant files, tool versions) before acting.
- Treat every numeric threshold, exact filename, file format, and output schema in the task as a binding hard constraint. Do not relax them.
- When replacing values, substitute the exact value (no rounding, no reformatting) unless the task explicitly says otherwise.
- Do not edit files that the task does not tell you to edit. Preserve everything else byte-for-byte.
- Before declaring the task done, re-read the success criteria and verify each one against the actual produced files/output.
- Prefer small, targeted tool calls. Read files before editing; run commands non-interactively; avoid long speculative reasoning chains when a quick tool call would resolve the question.
"""

def _resolve_bundle_dir() -> Path:
    env_dir = os.environ.get("PI_BENCH_BUNDLE_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve()

    if _MANIFEST_PATH.exists():
        data = json.loads(_MANIFEST_PATH.read_text())
        bundle_dir = data.get("bundle_dir")
        if isinstance(bundle_dir, str) and bundle_dir:
            return Path(bundle_dir).expanduser().resolve()

    return (_SCRIPT_DIR.parent / "pi" / "packages" / "coding-agent" / "dist").resolve()


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _env_exec(
    *,
    environment: Any,
    command: str,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout_sec: int | None = None,
) -> Any:
    executor = getattr(environment, "exec", None)
    if not callable(executor):
        raise RuntimeError("Harbor environment does not expose an exec method.")

    attempts: list[dict[str, Any]] = [
        {"command": command, "cwd": cwd, "env": env, "timeout_sec": timeout_sec},
        {"command": command, "cwd": cwd, "env": env},
        {"command": command},
    ]
    for kwargs in attempts:
        try:
            return await _maybe_await(executor(**kwargs))
        except TypeError:
            continue
    return await _maybe_await(executor(command))


def _extract(result: Any) -> tuple[int, str, str]:
    if result is None:
        return 0, "", ""
    if isinstance(result, tuple):
        if len(result) >= 3:
            return int(result[0]), str(result[1] or ""), str(result[2] or "")
        if len(result) == 2:
            return int(result[0]), str(result[1] or ""), ""
    if isinstance(result, str):
        return 0, result, ""
    if isinstance(result, dict):
        ec = int(result.get("exit_code", result.get("returncode", 0)))
        return ec, str(result.get("stdout", "")), str(result.get("stderr", ""))
    ec = int(getattr(result, "exit_code", getattr(result, "returncode", 0)))
    return ec, str(getattr(result, "stdout", "")), str(getattr(result, "stderr", ""))


def _raise_on_failure(result: Any, action: str) -> None:
    ec, stdout, stderr = _extract(result)
    if ec != 0:
        detail = stderr.strip() or stdout.strip() or "no output"
        raise RuntimeError(f"{action} failed (exit_code={ec}): {detail}")


def _safe_set(obj: Any, name: str, value: Any) -> None:
    try:
        setattr(obj, name, value)
    except Exception:
        pass


def _set_result(
    context: Any,
    *,
    success: bool,
    exit_code: int,
    stdout: str,
    stderr: str,
    config: dict[str, Any] | None = None,
) -> None:
    _safe_set(context, "success", success)
    _safe_set(context, "exit_code", exit_code)
    _safe_set(context, "stdout", stdout)
    _safe_set(context, "stderr", stderr)
    metadata = getattr(context, "metadata", None)
    if not isinstance(metadata, dict):
        metadata = {}
        _safe_set(context, "metadata", metadata)
    if isinstance(metadata, dict):
        metadata["pi_result"] = {
            "success": success,
            "exit_code": exit_code,
            "stdout": stdout,
            "stderr": stderr,
            "config": config or {},
        }


class PiBenchAgent(HarborBaseAgent):  # type: ignore[misc]
    def __init__(
        self,
        *,
        model_name: str | None = None,
        **kwargs: object,
    ) -> None:
        try:
            super().__init__(**kwargs)
        except TypeError:
            try:
                super().__init__()
            except Exception:
                pass

        self.model: str = (
            model_name
            or os.environ.get("PI_BENCH_MODEL", "")
            or "openrouter/minimax/minimax-m2.7"
        )
        self.thinking: str = os.environ.get("PI_BENCH_THINKING", "high")
        self.tools: str = os.environ.get("PI_BENCH_TOOLS", "read,bash,edit,write")
        self.system_prompt: str = os.environ.get("PI_BENCH_SYSTEM_PROMPT", "")
        # Appended to the default pi system prompt (does NOT replace it). Empty string disables.
        self.append_system_prompt: str = os.environ.get(
            "PI_BENCH_APPEND_SYSTEM_PROMPT", _DEFAULT_BENCH_APPEND_PROMPT
        )
        self.extra_args: str = os.environ.get("PI_BENCH_EXTRA_ARGS", "")
        self.bundle_dir = _resolve_bundle_dir()
        self._remote_binary = f"{_REMOTE_BUNDLE_DIR}/pi-linux-arm64"

    @staticmethod
    def name() -> str:
        return "pi"

    def version(self) -> str | None:
        return "0.1.0"

    async def setup(self, environment: Any) -> None:
        max_retries = 3
        for attempt in range(max_retries + 1):
            try:
                await self._install_bundle(environment)
                return
            except (ProcessLookupError, TimeoutError, OSError):
                if attempt >= max_retries:
                    raise
                await asyncio.sleep(float(2**attempt))

    async def _install_bundle(self, environment: Any) -> None:
        uploader = getattr(environment, "upload_dir", None)
        if not callable(uploader):
            raise RuntimeError("Harbor environment does not expose upload_dir. Cannot install the pi bundle.")

        bundle_dir = str(self.bundle_dir)
        if not self.bundle_dir.exists():
            raise RuntimeError(f"pi bundle directory does not exist: {bundle_dir}")

        attempts: list[dict[str, Any]] = [
            {"source_dir": bundle_dir, "target_dir": _REMOTE_BUNDLE_DIR},
            {"source_dir": self.bundle_dir, "target_dir": _REMOTE_BUNDLE_DIR},
        ]
        for kwargs in attempts:
            try:
                await _maybe_await(uploader(**kwargs))
                break
            except TypeError:
                continue
        else:
            await _maybe_await(uploader(bundle_dir, _REMOTE_BUNDLE_DIR))

        arch_result = await _env_exec(
            environment=environment,
            command="uname -m",
            timeout_sec=5,
        )
        _, arch_stdout, _ = _extract(arch_result)
        arch = arch_stdout.strip()
        binary_name = _ARCH_MAP.get(arch, "pi-linux-arm64")
        self._remote_binary = f"{_REMOTE_BUNDLE_DIR}/{binary_name}"

        result = await _env_exec(
            environment=environment,
            command=f"set -e; chmod +x {self._remote_binary}; {self._remote_binary} --version",
            timeout_sec=120,
        )
        _raise_on_failure(result, "pi bundle setup")

    async def run(
        self,
        instruction: str,
        environment: Any,
        context: Any,
    ) -> None:
        instruction = instruction.strip()
        if not instruction:
            _set_result(
                context,
                success=False,
                exit_code=1,
                stdout="",
                stderr="Empty instruction.",
                config={
                    "model": self.model,
                    "thinking": self.thinking,
                    "tools": self.tools,
                    "system_prompt_provided": bool(self.system_prompt),
                    "extra_args": self.extra_args,
                },
            )
            return

        env: dict[str, str] = {}
        for key in _FORWARD_ENV_KEYS:
            value = os.environ.get(key)
            if value:
                env[key] = value
        env["PI_LOG_RUNTIME_CONFIG"] = "1"

        binary = getattr(self, "_remote_binary", f"{_REMOTE_BUNDLE_DIR}/pi-linux-arm64")
        # Event stream is tee'd into pi-output.log as it streams, so the artifact captures
        # partial traces even when the trial times out. Pi's own stdout also ends up in
        # event_log for completeness; the tee makes the artifact copy incremental instead of
        # waiting for pi to exit.
        log_file = "/tmp/pi-output.log"
        event_log = "/tmp/pi-events.jsonl"
        debug_log = "/tmp/pi-debug.log"
        config_block = "\n".join(
            [
                "=== PI BENCH CONFIG ===",
                f"model={self.model}",
                f"thinking={self.thinking}",
                f"tools={self.tools}",
                f"system_prompt_provided={'yes' if self.system_prompt else 'no'}",
                f"append_system_prompt_chars={len(self.append_system_prompt)}",
                f"extra_args={self.extra_args or '<none>'}",
                "=== PI EVENT STREAM (JSONL) ===",
            ]
        )
        prompt_flag = f" --system-prompt {shlex.quote(self.system_prompt)}" if self.system_prompt else ""
        append_prompt_flag = (
            f" --append-system-prompt {shlex.quote(self.append_system_prompt)}"
            if self.append_system_prompt
            else ""
        )
        extra_args = ""
        if self.extra_args.strip():
            extra_args = " " + " ".join(shlex.quote(arg) for arg in shlex.split(self.extra_args))
        command = (
            f"cat <<'EOF' >{log_file}\n{config_block}\nEOF\n"
            f"{binary} --mode json --no-session --no-context-files --no-extensions --no-skills "
            f"--no-prompt-templates --no-themes --tools {shlex.quote(self.tools)} --thinking {shlex.quote(self.thinking)} "
            f"--model {shlex.quote(self.model)}{prompt_flag}{append_prompt_flag}{extra_args} "
            f"{shlex.quote(instruction)} 2>{debug_log} | tee -a {log_file} >{event_log}; "
            "PI_EXIT=${PIPESTATUS[0]}; "
            f"echo '' >> {log_file}; "
            f"echo '=== STDERR/DEBUG LOG ===' >> {log_file}; "
            f"cat {debug_log} >> {log_file} 2>/dev/null; "
            'echo "pi exited with code $PI_EXIT"; '
            "exit $PI_EXIT"
        )

        result = await _env_exec(
            environment=environment,
            command=command,
            env=env,
            timeout_sec=None,
        )

        exit_code, stdout, stderr = _extract(result)
        _set_result(
            context,
            success=exit_code == 0,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            config={
                "model": self.model,
                "thinking": self.thinking,
                "tools": self.tools,
                "system_prompt_provided": bool(self.system_prompt),
                "extra_args": self.extra_args,
            },
        )
