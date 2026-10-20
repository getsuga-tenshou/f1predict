"""Command-line entry point: `f1predict <command>`."""

from __future__ import annotations

import argparse
import json

import pandas as pd

from f1predict.config import F1DB_VERSION, PREDICTIONS_DIR, REPORTS_DIR


def _load():
    from f1predict.data import canonical as C

    return C.load(F1DB_VERSION)


def cmd_download(args) -> None:
    from f1predict.data import canonical as C
    from f1predict.data.download import download_f1db, latest_version

    if args.latest:
        tag = latest_version()
        print(f"latest F1DB release: {tag} (pinned: {F1DB_VERSION})")
        if tag != F1DB_VERSION:
            print(f"set F1PREDICT_F1DB_VERSION={tag} (or bump config.F1DB_VERSION) to use it")
        return
    path = download_f1db(F1DB_VERSION)
    out = C.save(C.build_all(F1DB_VERSION))
    print(f"F1DB {F1DB_VERSION}: raw -> {path}\nprocessed -> {out}")


def cmd_oos(args) -> None:
    from f1predict import pipeline

    pipeline.oos_predictions(_load(), pipeline.load_config(), horizons=args.horizons, force=args.force)


def cmd_evaluate(args) -> None:
    from f1predict import pipeline
    from f1predict.evaluation.render import render

    res = pipeline.evaluate(pipeline.load_config(), horizons=args.horizons)
    (REPORTS_DIR / "evaluation.json").write_text(json.dumps(res, indent=1, default=float))
    md = render(res)
    print(f"wrote {REPORTS_DIR / 'evaluation.json'} and {md}")


def _entry_file(path: str | None, race_id: int) -> dict | None:
    if not path:
        return None
    df = pd.read_csv(path)
    return {race_id: df[["driver_id", "team_id", "engine_id"]]}


def cmd_predict(args) -> None:
    from f1predict import pipeline
    from f1predict.data.live import with_live_weekend

    data = _load()
    cfg = pipeline.load_config()
    upcoming = data.races[~data.races["race_id"].isin(data.results["race_id"])]
    if args.round:
        upcoming = upcoming[(upcoming["year"] == args.season) & (upcoming["round"] == args.round)]
    else:
        upcoming = upcoming.head(1)
    if upcoming.empty:
        raise SystemExit("no matching upcoming race")
    race = upcoming.iloc[0]
    if args.live or args.grid_file:
        overrides = pd.read_csv(args.grid_file) if args.grid_file else None
        data = with_live_weekend(data, int(race["race_id"]), overrides)
    res = pipeline.forecast(data, cfg, args.mode, [int(race["race_id"])], _entry_file(args.entry_file, int(race["race_id"])))
    _print_race(res)
    PREDICTIONS_DIR.mkdir(exist_ok=True)
    path = PREDICTIONS_DIR / f"{int(race['year'])}_r{int(race['round']):02d}_{race['circuit_id']}_{args.mode}.csv"
    res.to_csv(path, index=False)
    print(f"\nsaved {path}")


def cmd_outlook(args) -> None:
    from f1predict import pipeline

    res = pipeline.forecast(_load(), pipeline.load_config(), "pre_weekend")
    for _, g in res.groupby("date", sort=True):
        _print_race(g, top=args.top)
        print()
    PREDICTIONS_DIR.mkdir(exist_ok=True)
    path = PREDICTIONS_DIR / f"outlook_{int(res['year'].iloc[0])}_after_r{int(res['round'].min()) - 1:02d}.csv"
    res.to_csv(path, index=False)
    print(f"saved {path}")


def cmd_dashboard(args) -> None:
    from f1predict.dashboard import serve

    serve(args.host, args.port, open_browser=not args.no_browser)


def _print_race(df: pd.DataFrame, top: int = 10) -> None:
    r = df.iloc[0]
    print(f"{int(r['year'])} round {int(r['round'])}: {r['circuit_id']} ({pd.Timestamp(r['date']).date()}), horizon {int(r['h'])}")
    for i, (_, row) in enumerate(df.sort_values("p", ascending=False).head(top).iterrows()):
        bar = "█" * int(round(row["p"] * 40))
        print(f"  {row['driver_id']:<22s} {row['team_id']:<14s} {row['p']:6.1%}  {bar}")
        if i < 3 and isinstance(row.get("why"), str):
            print(f"  {'':<22s} {'':<14s}         why: {row['why']}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="f1predict", description="F1 race-winner probabilities")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("download", help="fetch + build the pinned F1DB release")
    p.add_argument("--latest", action="store_true", help="only report the newest release tag")
    p.set_defaults(fn=cmd_download)

    p = sub.add_parser("oos", help="walk-forward out-of-sample predictions for all configured models")
    p.add_argument("--horizons", type=int, default=6)
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_oos)

    p = sub.add_parser("evaluate", help="score the frozen config on validation / test / 2026 holdout")
    p.add_argument("--horizons", type=int, default=6)
    p.set_defaults(fn=cmd_evaluate)

    p = sub.add_parser("predict", help="win probabilities for the next (or a given) race")
    p.add_argument("--mode", choices=("pre_weekend", "pre_quali", "pre_race"), default="pre_weekend")
    p.add_argument("--season", type=int, default=2026)
    p.add_argument("--round", type=int)
    p.add_argument("--live", action="store_true", help="pull finished sessions of this weekend from OpenF1")
    p.add_argument("--grid-file", help="CSV driver_id,grid_pos[,pit_lane_start] (penalties)")
    p.add_argument("--entry-file", help="CSV driver_id,team_id,engine_id (line-up changes)")
    p.set_defaults(fn=cmd_predict)

    p = sub.add_parser("outlook", help="pre-weekend probabilities for every remaining race of the season")
    p.add_argument("--top", type=int, default=6)
    p.set_defaults(fn=cmd_outlook)

    p = sub.add_parser("dashboard", help="web dashboard: forecasts, new runs, predictions vs actual winners")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8050)
    p.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    p.set_defaults(fn=cmd_dashboard)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
