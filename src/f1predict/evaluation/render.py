"""Render reports/evaluation.json into reports/EVALUATION.md + static figures."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

from f1predict.config import REPORTS_DIR  # noqa: E402

# Reference light palette (dataviz skill): series 1 blue, reference series in muted ink.
INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
BLUE, ORANGE = "#2a78d6", "#eb6834"
MODE_TITLE = {"pre_weekend": "Before the weekend", "pre_quali": "After practice", "pre_race": "After qualifying"}
SPLIT_TITLE = {"validation": "Validation 2014–22", "test": "Test 2023–25", "holdout_2026": "2026 (new regs)"}
BASE_TITLE = {"grid": "grid-slot prior", "elo": "Elo softmax", "pace": "pace softmax", "practice": "practice softmax"}


def _style(ax) -> None:
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(AXIS)
    ax.tick_params(colors=MUTED, labelsize=8)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def _per_season_frame(mres: dict) -> pd.DataFrame:
    rows = []
    for split, entry in mres["splits"].items():
        for r in entry["per_season"]:
            if r["season"] != "all":
                rows.append({**r, "split": split})
    return pd.DataFrame(rows).sort_values("season")


def fig_per_season(res: dict, out: Path) -> Path:
    modes = list(res["modes"])
    fig, axes = plt.subplots(1, len(modes), figsize=(4.2 * len(modes), 3.2), sharey=True, facecolor=SURFACE)
    for ax, mode in zip(axes, modes):
        mres = res["modes"][mode]
        df = _per_season_frame(mres)
        df["base_ll"] = df["logloss"] - df["vs_base"]
        _style(ax)
        ax.axvspan(2022.5, 2026.5, color="#f0efec", zorder=0)
        ax.plot(df["season"], df["base_ll"], color=MUTED, lw=2, marker="o", ms=4, label=BASE_TITLE.get(mres["reference_baseline"], mres["reference_baseline"]))
        ax.plot(df["season"], df["logloss"], color=BLUE, lw=2, marker="o", ms=4, label="final model")
        ax.set_title(MODE_TITLE[mode], color=INK, fontsize=10, loc="left")
        ax.set_xticks([2014, 2018, 2022, 2026])
        ax.text(2024.5, 0.02, "test + 2026", transform=ax.get_xaxis_transform(), ha="center", color=MUTED, fontsize=7)
        ax.legend(frameon=False, fontsize=7, labelcolor=INK2, loc="upper left")
    axes[0].set_ylabel("winner log-loss (lower is better)", color=INK2, fontsize=8)
    fig.tight_layout()
    path = out / "fig_per_season.png"
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)
    return path


def fig_reliability(res: dict, out: Path) -> Path:
    modes = list(res["modes"])
    fig, axes = plt.subplots(1, len(modes), figsize=(4.2 * len(modes), 3.4), sharey=True, facecolor=SURFACE)
    for ax, mode in zip(axes, modes):
        _style(ax)
        ax.plot([0, 1], [0, 1], color=AXIS, lw=1, ls="--")
        for split, color in (("validation", MUTED), ("test", BLUE)):
            fav = pd.DataFrame(res["modes"][mode]["splits"][split]["favourite"])
            if fav.empty:
                continue
            ax.errorbar(
                fav["mean_p"], fav["win_rate"], yerr=[fav["win_rate"] - fav["lo"], fav["hi"] - fav["win_rate"]],
                fmt="o", ms=5, color=color, ecolor=color, elinewidth=1, capsize=0, label=SPLIT_TITLE[split],
            )  # fmt: skip
            offset = (5, -9) if split == "test" else (-24, 4)
            for _, r in fav.iterrows():
                ax.annotate(f"n={int(r['n'])}", (r["mean_p"], r["win_rate"]), textcoords="offset points", xytext=offset, fontsize=6, color=MUTED)
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1.02)
        ax.set_title(MODE_TITLE[mode], color=INK, fontsize=10, loc="left")
        ax.set_xlabel("favourite's predicted win probability", color=INK2, fontsize=8)
        ax.legend(frameon=False, fontsize=7, labelcolor=INK2, loc="upper left")
    axes[0].set_ylabel("how often the favourite won", color=INK2, fontsize=8)
    fig.tight_layout()
    path = out / "fig_reliability.png"
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)
    return path


def fig_horizon(res: dict, out: Path) -> Path | None:
    hz = res["modes"].get("pre_weekend", {}).get("horizons")
    if not hz:
        return None
    hs = sorted(int(h) for h in hz)
    fig, ax = plt.subplots(figsize=(4.6, 3.0), facecolor=SURFACE)
    _style(ax)
    for split, color in (("validation", MUTED), ("test", BLUE), ("holdout_2026", ORANGE)):
        ys = [hz[str(h) if str(h) in hz else h][split]["logloss"] for h in hs]
        ax.plot(hs, ys, color=color, lw=2, marker="o", ms=4, label=SPLIT_TITLE[split])
    ax.set_xticks(hs)
    ax.set_xlabel("races ahead (1 = next race)", color=INK2, fontsize=8)
    ax.set_ylabel("winner log-loss", color=INK2, fontsize=8)
    ax.set_title("Season outlook: accuracy vs horizon", color=INK, fontsize=10, loc="left")
    ax.legend(frameon=False, fontsize=7, labelcolor=INK2)
    fig.tight_layout()
    path = out / "fig_horizon.png"
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)
    return path


def _f(x, nd=3) -> str:
    return "–" if x is None or (isinstance(x, float) and pd.isna(x)) else f"{x:.{nd}f}"


def render(res: dict, out: Path = REPORTS_DIR) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    figs = [fig_per_season(res, out), fig_reliability(res, out), fig_horizon(res, out)]
    L = ["# Evaluation report", ""]
    L.append(f"Data: F1DB `{res['config'].get('data_version', '?')}`. Every number below is out-of-sample: "
             "each race is predicted by models fitted only on earlier races, and every second-stage parameter is "
             "fitted only on earlier out-of-sample predictions. Selection used the validation seasons only; the "
             "test seasons and 2026 were scored once, after the configuration was frozen.")  # fmt: skip
    L.append("")
    L.append("Metric: **winner log-loss** = −log P(actual winner), averaged over races (uniform guessing ≈ 3.0). "
             "Δ is the paired difference to the reference baseline, with a 95% race-bootstrap interval.")  # fmt: skip
    L.append("")
    for mode, mres in res["modes"].items():
        base = BASE_TITLE.get(mres["reference_baseline"], mres["reference_baseline"])
        L += [f"## {MODE_TITLE[mode]} (`{mode}`)", "", f"Reference baseline: {base}.", ""]
        L.append("| split | races | log-loss | Δ vs baseline [95% CI] | seasons better | top-1 | top-3 | Brier | T* [95% CI] |")
        L.append("|---|---|---|---|---|---|---|---|---|")
        for split, e in mres["splits"].items():
            f, v, t = e["final"], e["vs_baseline"], e["temperature"]
            L.append(
                f"| {SPLIT_TITLE[split]} | {f['races']} | {_f(f['logloss'])} | {_f(v['diff'])} [{_f(v['ci_low'])}, {_f(v['ci_high'])}] "
                f"| {v['seasons_better']}/{v['seasons']} | {f['top1']:.0%} | {f['top3']:.0%} | {_f(f['brier'])} | {_f(t['T'], 2)} [{_f(t['T_lo'], 2)}, {_f(t['T_hi'], 2)}] |"
            )
        L += ["", "Per-model log-loss (members and baselines, before the second stage):", ""]
        names = list(next(iter(mres["splits"].values()))["models"])
        L.append("| model | " + " | ".join(SPLIT_TITLE[s] for s in mres["splits"]) + " |")
        L.append("|---|" + "---|" * len(mres["splits"]))
        for n in names:
            L.append(f"| {n} | " + " | ".join(_f(mres["splits"][s]["models"][n]["logloss"]) for s in mres["splits"]) + " |")
        tails = mres["splits"]["test"]["tails"]
        L += ["", f"Tails (test): winners given <1%: {tails['winners_p_lt_1pct']}, <0.1%: {tails['winners_p_lt_0.1pct']}; "
                  f"the 5 worst races carry {tails['worst_share_of_total_ll']:.0%} of total log-loss.", ""]  # fmt: skip
        for w in tails["worst"]:
            L.append(f"- {w['year']} R{w['round']}: {w['driver_id']} won with p = {w['p_winner']:.3f}")
        L.append("")
    hz = res["modes"].get("pre_weekend", {}).get("horizons")
    if hz:
        L += ["## Season outlook: horizon backtest", "", "| races ahead | " + " | ".join(SPLIT_TITLE[s] for s in SPLIT_TITLE) + " |", "|---|---|---|---|"]
        for h in sorted(hz, key=int):
            L.append(f"| {h} | " + " | ".join(_f(hz[h][s]["logloss"]) for s in SPLIT_TITLE) + " |")
        L.append("")
    L += ["## Figures", ""] + [f"![{p.stem}]({p.name})" for p in figs if p is not None]
    path = out / "EVALUATION.md"
    path.write_text("\n".join(L) + "\n", encoding="utf-8")
    return path
