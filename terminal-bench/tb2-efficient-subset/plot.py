#!/usr/bin/env python3
"""
Generate the Pareto frontier figure from results.json.

Usage:
    python plot.py                    # reads results.json, writes pareto_frontier.png
    python plot.py -i res.json -o fig.png
"""

import argparse
import json
import numpy as np
import matplotlib.pyplot as plt


def extract_pareto(rows, runtime_key, error_key):
    ordered = sorted(rows, key=lambda r: r[runtime_key])
    frontier, best = [], float("inf")
    for r in ordered:
        if r[error_key] < best - 0.01:
            frontier.append(r)
            best = r[error_key]
    return frontier


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input", default="results.json")
    parser.add_argument("-o", "--output", default="pareto_frontier.png")
    args = parser.parse_args()

    with open(args.input) as f:
        data = json.load(f)

    rows = data["error_bounds"]
    n_tasks = [r["n_tasks"] for r in rows]
    N_vals = [r["N"] for r in rows]
    serial = [r["serial_h"] for r in rows]
    e95 = [r["e95"] for r in rows]
    e99 = [r["e99"] for r in rows]

    pareto_95 = extract_pareto(rows, "serial_h", "e95")
    pareto_99 = extract_pareto(rows, "serial_h", "e99")

    colors = {1: "#d62728", 2: "#ff7f0e", 3: "#2ca02c", 4: "#1f77b4", 5: "#9467bd"}
    markers = {1: "v", 2: "D", 3: "s", 4: "^", 5: "o"}

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(18, 8))

    for ax, err, pareto, ylabel, title in [
        (ax1, e95, pareto_95, "\u03b5\u2089\u2085 (%)", "95% Confidence Error Bound"),
        (ax2, e99, pareto_99, "\u03b5\u2089\u2089 (%)", "99% Confidence Error Bound"),
    ]:
        for Nv in [1, 2, 3, 4, 5]:
            mask = [i for i in range(len(rows)) if N_vals[i] == Nv]
            ax.scatter(
                [serial[i] for i in mask],
                [err[i] for i in mask],
                c=colors[Nv],
                marker=markers[Nv],
                s=50,
                alpha=0.6,
                label=f"N={Nv}",
                zorder=2,
            )

        px = [p["serial_h"] for p in pareto]
        py_key = "e95" if "95" in title else "e99"
        py = [p[py_key] for p in pareto]
        ax.plot(px, py, "k-", linewidth=2.5, zorder=3, label="Pareto frontier")

        for p in pareto:
            label = f"{p['n_tasks']}t\u00d7{p['N']}"
            ax.annotate(
                label,
                xy=(p["serial_h"], p[py_key]),
                xytext=(6, 6),
                textcoords="offset points",
                fontsize=7,
                fontweight="bold",
                color="black",
                bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="gray", alpha=0.8),
            )
            ax.scatter(
                [p["serial_h"]], [p[py_key]], c="black", s=80, zorder=4, marker="*"
            )

        ax.set_xlabel("Total Serial Runtime (hours)", fontsize=12)
        ax.set_ylabel(ylabel, fontsize=12)
        ax.set_title(f"TerminalBench 2.0 Subset: {title}", fontsize=13)
        ax.legend(loc="upper right", fontsize=9)
        ax.grid(True, alpha=0.3)
        ax.set_ylim(bottom=0)

    plt.tight_layout()
    plt.savefig(args.output, dpi=150, bbox_inches="tight")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
