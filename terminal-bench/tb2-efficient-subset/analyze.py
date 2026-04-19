#!/usr/bin/env python3
"""
TerminalBench 2.0 — Efficient Subset Analysis

Identifies optimal task subsets and per-task weights for predicting the full
TerminalBench 2.0 score. Outputs results.json with all data needed by plot.py
and README.md.

Usage:
    python analyze.py                          # uses default leaderboard path
    python analyze.py --data-dir /path/to/2.0  # custom leaderboard path
"""

import argparse
import json
import os
import glob
import time
import numpy as np
import pandas as pd
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════
# 1. Data Extraction
# ═══════════════════════════════════════════════════════════════════════

DEFAULT_DATA_DIR = os.path.join(
    os.path.dirname(__file__),
    "..",
    "terminal-bench-2-leaderboard",
    "submissions",
    "terminal-bench",
    "2.0",
)

CACHE_CSV = os.path.join(os.path.dirname(__file__), "trial_data_cache.csv")


def _parse_iso(s):
    if s is None:
        return None
    s = s.rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def extract_all_trials(data_dir):
    """Walk all result.json files under the TB2 leaderboard directory."""
    if os.path.exists(CACHE_CSV):
        print(f"Loading cached data from {CACHE_CSV}")
        return pd.read_csv(CACHE_CSV)

    print("Extracting trial data from result.json files...")
    pattern = os.path.join(data_dir, "*", "*", "*", "result.json")
    files = glob.glob(pattern)
    print(f"Found {len(files)} result.json files")

    rows, errors = [], 0
    for i, fpath in enumerate(files):
        if (i + 1) % 2000 == 0:
            print(f"  Processed {i + 1}/{len(files)} files...")
        try:
            parts = fpath.split(os.sep)
            sub_idx = next(j for j, p in enumerate(parts) if p == "2.0") + 1
            submission = parts[sub_idx]

            with open(fpath, "r") as f:
                data = json.load(f)

            task_name = data.get("task_name")
            reward = data.get("verifier_result", {}).get("rewards", {}).get("reward")
            started = _parse_iso(data.get("started_at"))
            finished = _parse_iso(data.get("finished_at"))
            total_time = (
                (finished - started).total_seconds() if started and finished else None
            )

            if task_name is not None and reward is not None:
                rows.append(
                    {
                        "submission": submission,
                        "task": task_name,
                        "reward": float(reward),
                        "total_time_sec": total_time,
                    }
                )
        except Exception:
            errors += 1

    print(f"Extracted {len(rows)} trials ({errors} errors)")
    df = pd.DataFrame(rows)
    df.to_csv(CACHE_CSV, index=False)
    return df


# ═══════════════════════════════════════════════════════════════════════
# 2. Build Score Matrix & Runtime Vector
# ═══════════════════════════════════════════════════════════════════════


def build_matrices(df):
    """Return (P, F, R, submissions, tasks)."""
    trial_counts = df.groupby(["submission", "task"]).size().reset_index(name="n")
    all_tasks = sorted(df["task"].unique())
    sub_stats = trial_counts.groupby("submission").agg(n_tasks=("task", "nunique"))
    min_coverage = len(all_tasks) - 4
    subs = sub_stats[sub_stats["n_tasks"] >= min_coverage].index.tolist()

    df_c = df[df["submission"].isin(subs)]
    common = sorted(
        set.intersection(*df_c.groupby("submission")["task"].apply(set).values)
    )

    pr = df_c.groupby(["submission", "task"])["reward"].mean().reset_index()
    P_df = (
        pr.pivot(index="submission", columns="task", values="reward")[common]
        .loc[subs]
        .dropna()
    )

    submissions = P_df.index.tolist()
    tasks = P_df.columns.tolist()
    P = P_df.values
    F = P.mean(axis=1)

    rt = df.groupby("task")["total_time_sec"].mean()
    R = np.array([rt.get(t, np.nanmedian(rt.values)) for t in tasks])
    R[np.isnan(R)] = np.nanmedian(R)

    print(f"Score matrix: {P.shape[0]} submissions x {P.shape[1]} tasks")
    print(f"Full scores: [{F.min():.3f}, {F.max():.3f}], mean={F.mean():.3f}")
    return P, F, R, submissions, tasks


# ═══════════════════════════════════════════════════════════════════════
# 3. OLS Helpers
# ═══════════════════════════════════════════════════════════════════════


def _ols(X, y):
    U, s, Vt = np.linalg.svd(X, full_matrices=False)
    eps = 1e-12 * s[0] if len(s) > 0 else 1e-12
    s_inv = np.where(s > eps, 1.0 / s, 0.0)
    beta = Vt.T @ (np.diag(s_inv) @ (U.T @ y))
    resid = y - X @ beta
    h = np.sum(U**2, axis=1)
    return beta, resid, h


def _loocv_r2(X, y):
    beta, resid, h = _ols(X, y)
    cv = resid / (1.0 - h)
    return 1.0 - np.sum(cv**2) / np.sum((y - y.mean()) ** 2)


# ═══════════════════════════════════════════════════════════════════════
# 4. Greedy Forward Selection + Local Search (per-task weights)
# ═══════════════════════════════════════════════════════════════════════


def greedy_forward(P, F, R, max_tasks=None):
    S, T = P.shape
    if max_tasks is None:
        max_tasks = min(T, S - 3)
    selected, remaining, results = [], list(range(T)), []

    print("\nGreedy forward selection (per-task weights, LOOCV R²)...")
    for step in range(max_tasks):
        best_r2, best_t = -np.inf, None
        for t in remaining:
            cand = selected + [t]
            r2 = _loocv_r2(np.column_stack([P[:, cand], np.ones(S)]), F)
            if r2 > best_r2:
                best_r2, best_t = r2, t
        selected.append(best_t)
        remaining.remove(best_t)
        results.append({"n": len(selected), "r2cv": best_r2, "sel": list(selected)})
        if (step + 1) <= 15 or (step + 1) % 5 == 0:
            print(f"  step {step + 1}: R²(cv)={best_r2:.6f}")
    return results


def local_search(P, F, S_total, selected, max_iters=200):
    T = P.shape[1]
    sel = set(selected)
    cur_r2 = _loocv_r2(np.column_stack([P[:, list(sel)], np.ones(S_total)]), F)

    for _ in range(max_iters):
        improved = False
        best_swap, best_r2 = None, cur_r2
        for t_out in list(sel):
            for t_in in set(range(T)) - sel:
                cand = list((sel - {t_out}) | {t_in})
                r2 = _loocv_r2(np.column_stack([P[:, cand], np.ones(S_total)]), F)
                if r2 > best_r2 + 1e-10:
                    best_r2, best_swap = r2, (t_out, t_in)
        if best_swap:
            sel.discard(best_swap[0])
            sel.add(best_swap[1])
            cur_r2 = best_r2
            improved = True
        if not improved:
            break
    return list(sel), cur_r2


# ═══════════════════════════════════════════════════════════════════════
# 5. LOOCV + Trial Resampling Error Bounds
# ═══════════════════════════════════════════════════════════════════════


def error_bounds_loocv_resample(
    P, F, R, selected, tasks, df_c, submissions, N_vals, M=2000, seed=42
):
    """Compute LOOCV + resampling error bounds for given selected tasks at each N."""
    rng = np.random.default_rng(seed)
    S = len(F)
    task_names = [tasks[i] for i in selected]
    T = len(task_names)
    X_full = np.column_stack([P[:, selected], np.ones(S)])

    # Build trial pools
    pools = []
    for s_idx, sub in enumerate(submissions):
        sp = []
        for tn in task_names:
            trials = df_c[(df_c["submission"] == sub) & (df_c["task"] == tn)][
                "reward"
            ].values
            sp.append(trials)
        pools.append(sp)

    results = []
    for N in N_vals:
        all_errors = []
        for s in range(S):
            mask = np.ones(S, dtype=bool)
            mask[s] = False
            beta, _, _, _ = np.linalg.lstsq(X_full[mask], F[mask], rcond=None)
            for _ in range(M):
                feat = np.empty(T + 1)
                for t in range(T):
                    feat[t] = rng.choice(pools[s][t], size=N, replace=True).mean()
                feat[T] = 1.0
                all_errors.append(feat @ beta - F[s])
        errs = np.abs(np.array(all_errors))
        serial_h = N * sum(R[i] for i in selected) / 3600
        results.append(
            {
                "n_tasks": len(selected),
                "N": N,
                "serial_h": round(serial_h, 1),
                "e95": round(float(np.percentile(errs, 95) * 100), 1),
                "e99": round(float(np.percentile(errs, 99) * 100), 1),
            }
        )
    return results


# ═══════════════════════════════════════════════════════════════════════
# 6. Concurrency Simulation
# ═══════════════════════════════════════════════════════════════════════


def concurrency_sim(task_names, N, runtime_pools, concurrencies, n_sims=10000, seed=42):
    rng = np.random.default_rng(seed)
    results = []
    for C in concurrencies:
        times = np.empty(n_sims)
        for i in range(n_sims):
            rts = np.concatenate(
                [rng.choice(runtime_pools[t], N, replace=True) for t in task_names]
            )
            rng.shuffle(rts)
            workers = np.zeros(C)
            for rt in rts:
                workers[workers.argmin()] += rt
            times[i] = workers.max()
        results.append(
            {
                "concurrency": C,
                "mean_h": round(times.mean() / 3600, 1),
                "std_h": round(times.std() / 3600, 1),
            }
        )
    return results


# ═══════════════════════════════════════════════════════════════════════
# 7. Pareto Extraction
# ═══════════════════════════════════════════════════════════════════════


def extract_pareto(rows, runtime_key, error_key):
    ordered = sorted(rows, key=lambda r: r[runtime_key])
    frontier, best = [], float("inf")
    for r in ordered:
        if r[error_key] < best - 0.01:
            frontier.append(r)
            best = r[error_key]
    return frontier


# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════


def main():
    parser = argparse.ArgumentParser(description="TerminalBench 2.0 subset analysis")
    parser.add_argument(
        "--data-dir",
        default=DEFAULT_DATA_DIR,
        help="Path to the TB2 leaderboard 2.0/ submissions directory",
    )
    args = parser.parse_args()

    t0 = time.time()
    out_dir = os.path.dirname(__file__)

    # ── Extract data ─────────────────────────────────────────────────
    df = extract_all_trials(args.data_dir)
    print(
        f"Trials: {len(df)}, Submissions: {df['submission'].nunique()}, Tasks: {df['task'].nunique()}"
    )

    P, F, R, submissions, tasks = build_matrices(df)
    S, T = P.shape

    # Filtered dataframe for trial resampling later
    sub_set = set(submissions)
    common_set = set(tasks)
    df_c = df[(df["submission"].isin(sub_set)) & (df["task"].isin(common_set))]

    # Runtime pools for concurrency sim
    runtime_pools = {
        t: g["total_time_sec"].dropna().values
        for t, g in df.groupby("task")
        if t in common_set
    }

    # ── Greedy selection + local search ──────────────────────────────
    greedy = greedy_forward(P, F, R, max_tasks=min(T, S - 3))

    print("\nLocal search refinement for n=5..15...")
    best_by_n = {}
    for n in range(5, 16):
        if n > len(greedy):
            continue
        gr = greedy[n - 1]
        sel, r2 = local_search(P, F, S, gr["sel"])
        if r2 > gr["r2cv"] + 1e-6:
            print(f"  n={n}: improved R²(cv) {gr['r2cv']:.6f} -> {r2:.6f}")
        # Fit final weights
        X = np.column_stack([P[:, sel], np.ones(S)])
        beta, resid, h = _ols(X, F)
        weights = beta[:-1].tolist()
        intercept = float(beta[-1])
        task_names = [tasks[i] for i in sel]

        best_by_n[n] = {
            "selected_tasks": task_names,
            "selected_indices": sel,
            "weights": {tn: round(w, 6) for tn, w in zip(task_names, weights)},
            "intercept": round(intercept, 6),
            "r2_loocv": round(float(r2), 6),
            "runtime_per_trial_h": round(sum(R[i] for i in sel) / 3600, 2),
        }

    # ── LOOCV + resampling error bounds for all (n, N) combos ───────
    print("\nComputing LOOCV + resampling error bounds...")
    all_error_bounds = []
    for n in range(5, 16):
        info = best_by_n[n]
        sel = info["selected_indices"]
        bounds = error_bounds_loocv_resample(
            P, F, R, sel, tasks, df_c, submissions, [1, 2, 3, 4, 5]
        )
        all_error_bounds.extend(bounds)
        print(f"  {n} tasks: N=5 -> ε₉₅={bounds[4]['e95']}%, ε₉₉={bounds[4]['e99']}%")

    # ── Concurrency simulation for 12t×5 ────────────────────────────
    print("\nRunning concurrency simulation for 12t×5...")
    rec_tasks = best_by_n[12]["selected_tasks"]
    conc_results = concurrency_sim(rec_tasks, 5, runtime_pools, [1, 4, 8, 12, 16])
    for c in conc_results:
        print(f"  C={c['concurrency']:>2}: {c['mean_h']:.1f}h ± {c['std_h']:.1f}h")

    # ── Pareto frontiers ─────────────────────────────────────────────
    pareto_95 = extract_pareto(all_error_bounds, "serial_h", "e95")
    pareto_99 = extract_pareto(all_error_bounds, "serial_h", "e99")

    # ── Assemble results ─────────────────────────────────────────────
    # Strip internal indices before writing JSON
    best_subsets_out = {}
    for n, info in best_by_n.items():
        best_subsets_out[str(n)] = {
            "selected_tasks": info["selected_tasks"],
            "weights": info["weights"],
            "intercept": info["intercept"],
            "r2_loocv": info["r2_loocv"],
            "runtime_per_trial_h": info["runtime_per_trial_h"],
        }

    results = {
        "best_subsets": best_subsets_out,
        "error_bounds": all_error_bounds,
        "concurrency": {"12t5": conc_results},
        "pareto_95": pareto_95,
        "pareto_99": pareto_99,
    }

    out_path = os.path.join(out_dir, "results.json")
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults written to {out_path}")
    print(f"Total time: {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
