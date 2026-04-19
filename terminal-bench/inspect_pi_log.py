#!/usr/bin/env python3
"""Inspect pi benchmark artifacts and print a compact failure-oriented summary."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
JOBS_DIR = SCRIPT_DIR / "jobs"
EVENT_HEADER = "=== PI EVENT STREAM (JSONL) ==="
DEBUG_HEADER = "=== STDERR/DEBUG LOG ==="


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect a pi benchmark artifact and summarize config, errors, and tool activity."
    )
    parser.add_argument(
        "path",
        nargs="?",
        help="Path to a trial directory, pi-output.log, or result.json. Defaults to latest trial.",
    )
    parser.add_argument(
        "--latest-failed",
        action="store_true",
        help="Select the most recent failed trial instead of the latest trial.",
    )
    parser.add_argument(
        "--events",
        type=int,
        default=8,
        help="Number of trailing event lines to show from the JSONL stream.",
    )
    return parser.parse_args()


def latest_trials() -> list[Path]:
    return sorted(
        (path for path in JOBS_DIR.glob("*/*") if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
    )


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def reward_value(result: dict[str, Any] | None) -> Any:
    if not result:
        return None
    verifier = result.get("verifier_result") or {}
    rewards = verifier.get("rewards") or {}
    return rewards.get("reward")


def is_failed_trial(trial_dir: Path) -> bool:
    result = load_json(trial_dir / "result.json")
    reward = reward_value(result)
    if reward not in (None, 1.0):
        return True
    return bool((result or {}).get("exception_info"))


def resolve_target(args: argparse.Namespace) -> Path:
    if args.path:
        raw = Path(args.path).expanduser().resolve()
        if raw.is_dir():
            return raw
        if raw.name in {"pi-output.log", "result.json"}:
            return raw.parent.parent if raw.parent.name == "artifacts" else raw.parent
        raise SystemExit(f"Unsupported path: {raw}")

    trials = latest_trials()
    if not trials:
        raise SystemExit(f"No trials found under {JOBS_DIR}")

    if args.latest_failed:
        for trial in reversed(trials):
            if is_failed_trial(trial):
                return trial
        raise SystemExit("No failed trials found.")

    return trials[-1]


def split_log_sections(log_text: str) -> tuple[dict[str, str], list[str], list[str]]:
    lines = log_text.splitlines()
    config: dict[str, str] = {}
    events: list[str] = []
    debug: list[str] = []
    mode = "config"

    for line in lines:
        if line == EVENT_HEADER:
            mode = "events"
            continue
        if line == DEBUG_HEADER:
            mode = "debug"
            continue
        if mode == "config":
            if "=" in line and not line.startswith("==="):
                key, value = line.split("=", 1)
                config[key.strip()] = value.strip()
        elif mode == "events":
            if line.strip():
                events.append(line)
        elif mode == "debug":
            debug.append(line)
    return config, events, debug


def _snippet(text: str | None, limit: int = 140) -> str | None:
    if not text:
        return text
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    return flat[: limit - 3] + "..."


def summarize_events(
    event_lines: list[str],
) -> tuple[list[dict[str, Any]], dict[str, int], dict[str, Any], list[str]]:
    parsed: list[dict[str, Any]] = []
    counts = {
        "assistant_messages": 0,
        "tool_calls": 0,
        "tool_errors": 0,
        "tool_results": 0,
        "thinking_updates": 0,
    }
    summary: dict[str, Any] = {
        "provider": None,
        "model": None,
        "final_text": None,
        "last_tool_call": None,
        "last_tool_result": None,
    }
    trail: list[str] = []

    for raw in event_lines:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        parsed.append(event)
        event_type = event.get("type")

        if event_type == "message_start":
            message = event.get("message") or {}
            if message.get("role") == "assistant":
                counts["assistant_messages"] += 1
                summary["provider"] = message.get("provider") or summary["provider"]
                summary["model"] = message.get("model") or summary["model"]
                trail.append(f"assistant_start model={message.get('model')}")

        if event_type == "message_update":
            inner = event.get("assistantMessageEvent") or {}
            inner_type = inner.get("type")
            if inner_type and inner_type.startswith("thinking_"):
                counts["thinking_updates"] += 1
                if inner_type == "thinking_end":
                    trail.append(f"thinking {_snippet(inner.get('content'))}")
            elif inner_type == "text_end":
                trail.append(f"assistant {_snippet(inner.get('content'))}")

        if event_type == "turn_end":
            message = event.get("message") or {}
            content = message.get("content") or []
            for block in content:
                if block.get("type") == "text":
                    summary["final_text"] = block.get("text")
            for tool_result in event.get("toolResults") or []:
                counts["tool_results"] += 1
                if tool_result.get("isError"):
                    counts["tool_errors"] += 1
                summary["last_tool_result"] = tool_result
                content = tool_result.get("content") or []
                text = None
                if content and isinstance(content, list):
                    first = content[0] or {}
                    text = first.get("text")
                trail.append(
                    f"tool_result name={tool_result.get('toolName')} error={bool(tool_result.get('isError'))} output={_snippet(text)}"
                )

        if event_type == "agent_end":
            for message in event.get("messages") or []:
                for block in message.get("content") or []:
                    if block.get("type") == "toolCall":
                        counts["tool_calls"] += 1
                        summary["last_tool_call"] = block
                        args = block.get("arguments") or {}
                        trail.append(
                            f"tool_call name={block.get('name')} target={_snippet(args.get('command') or args.get('path'))}"
                        )
                    if block.get("type") == "text" and message.get("role") == "assistant":
                        summary["final_text"] = block.get("text") or summary["final_text"]
    return parsed, counts, summary, trail


def print_section(title: str, value: str | None) -> None:
    print(f"{title}: {value if value not in (None, '') else '<none>'}")


def main() -> None:
    args = parse_args()
    trial_dir = resolve_target(args)
    result_path = trial_dir / "result.json"
    log_path = trial_dir / "artifacts" / "pi-output.log"

    if not log_path.exists():
        raise SystemExit(f"Missing artifact log: {log_path}")

    result = load_json(result_path) or {}
    config = result.get("config") or {}
    exception = result.get("exception_info") or {}
    log_text = log_path.read_text()
    log_config, event_lines, debug_lines = split_log_sections(log_text)
    _, counts, event_summary, trail = summarize_events(event_lines)
    runtime_line = next(
        (line for line in debug_lines if line.startswith("PI_RUNTIME_CONFIG ")),
        None,
    )
    if runtime_line is None:
        runtime_line = next(
            (line for line in log_text.splitlines() if line.startswith("PI_RUNTIME_CONFIG ")),
            None,
        )

    print(f"trial: {trial_dir}")
    print(f"log:   {log_path}")
    print()
    print("config")
    print_section("  task", result.get("task_name"))
    print_section("  reward", str(reward_value(result)))
    print_section("  model", log_config.get("model") or ((config.get("agent") or {}).get("model_name")))
    print_section("  thinking", log_config.get("thinking"))
    print_section("  tools", log_config.get("tools"))
    print_section("  system_prompt_provided", log_config.get("system_prompt_provided"))
    print()
    print("outcome")
    print_section("  exception_type", exception.get("exception_type"))
    print_section("  exception_message", exception.get("exception_message"))
    print_section("  pi_runtime_config", runtime_line)
    print()
    print("event summary")
    print_section("  provider", event_summary.get("provider"))
    print_section("  model", event_summary.get("model"))
    print_section("  assistant_messages", str(counts["assistant_messages"]))
    print_section("  tool_calls", str(counts["tool_calls"]))
    print_section("  tool_results", str(counts["tool_results"]))
    print_section("  tool_errors", str(counts["tool_errors"]))
    print_section("  thinking_updates", str(counts["thinking_updates"]))

    last_tool_call = event_summary.get("last_tool_call") or {}
    if last_tool_call:
        args_block = last_tool_call.get("arguments") or {}
        print_section("  last_tool", last_tool_call.get("name"))
        print_section("  last_tool_command", args_block.get("command") or args_block.get("path"))

    last_tool_result = event_summary.get("last_tool_result") or {}
    if last_tool_result:
        content = last_tool_result.get("content") or []
        snippet = None
        if content and isinstance(content, list):
            first = content[0] or {}
            snippet = first.get("text")
        print_section("  last_tool_result_error", str(bool(last_tool_result.get("isError"))))
        print_section("  last_tool_result_snippet", snippet)

    print()
    print("final assistant text")
    print(event_summary.get("final_text") or "<none>")

    if debug_lines:
        print()
        print("stderr tail")
        tail = [line for line in debug_lines if line.strip()][-8:]
        for line in tail:
            print(f"  {line}")

    if trail:
        print()
        print(f"last {args.events} events")
        for line in trail[-args.events :]:
            print(f"  {line}")


if __name__ == "__main__":
    main()
