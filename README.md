# f1predict — who wins the next Grand Prix?

A probabilistic Formula 1 race-winner model. For every entrant of a Grand Prix it outputs
**P(driver wins)**, summing to 1 across the field, at three moments of a race weekend:

| mode | when | knows |
|---|---|---|
| `pre_weekend` | days or weeks ahead | everything up to the previous race |
| `pre_quali` | after practice | + practice (and, on 2024+ sprint weekends, sprint qualifying + sprint) |
| `pre_race` | after qualifying | + qualifying, starting grid, penalties, pit-lane starts |

Every number in this README is **out-of-sample**: each race was predicted by a model fitted only on
earlier races, with features computed only from what was known at the time.

## Results

Test seasons 2023–25 (70 races), scored once after the configuration was frozen on 2014–22.
Winner log-loss = −log P(actual winner); uniform guessing ≈ 3.0, lower is better. Δ is the
race-paired difference to the strongest simple model for that moment, with a 95% bootstrap interval.

| mode | log-loss | simple model | Δ [95% CI] | seasons better | favourite won | winner in top 3 |
|---|---|---|---|---|---|---|
| `pre_weekend` | **1.428** | pace-only 1.564 | −0.137 [−0.247, −0.025] | 3 / 3 | 44% | 83% |
| `pre_quali` | **1.497** | pace-only 1.564 | −0.067 [−0.227, +0.120] | 2 / 3 | 47% | 80% |
| `pre_race` | **1.118** | grid-slot prior 1.439 | −0.322 [−0.687, −0.030] | 2 / 3 | 63% | 89% |

* **Calibrated:** the max-likelihood winner temperature is 0.91–1.05 on validation and test (1 = calibrated).
* **Known weakness — sprint weekends.** On standard weekends practice helps as intended (test
  log-loss 1.366 after practice vs 1.446 before the weekend), but on the 18 sprint weekends of
  2023–25 the weekend models do much worse (1.876 / 1.673). Since 2024 the sprint runs *before*
  qualifying, a format the model had almost no history of, and it over-trusts the sprint result.
  Until a fix is validated on new races, use the `pre_weekend` forecast on sprint weekends until
  qualifying.
* **2026 (new regulations, 17 races):** `pre_race` 1.278 vs 1.420 for the grid prior, but the
  model is under-confident (T* = 0.67): this era's grid order is more decisive than history's.
  `pre_weekend` is level with the pace-only model (1.99 vs 1.93).
* **What lost:** gradient boosting, a boosted-linear hybrid, rank-ordered (Plackett–Luce) training,
  recency weighting and a stacking/calibration layer were all tried and none beat the plain
  conditional logit on validation.
* **Season outlook:** accuracy falls from 1.42 one race ahead to 1.58 six races ahead (test).

Full report: `f1predict oos && f1predict evaluate` regenerates it as `reports/EVALUATION.md` with figures.

### Next race (made 2026-10-20, from data up to the Singapore GP)

```
$ f1predict predict
2026 round 18 — austin (2026-10-25), horizon 1
  kimi-antonelli         mercedes        21.9%  █████████
  max-verstappen         red-bull        19.5%  ████████
  george-russell         mercedes        16.1%  ██████
  charles-leclerc        ferrari         14.2%  ██████
  lewis-hamilton         ferrari         11.6%  █████
  lando-norris           mclaren          7.9%  ███
  oscar-piastri          mclaren          3.7%  █
  ...
```

Re-run after practice (`--mode pre_quali --live`) and after qualifying (`--mode pre_race --live`)
for sharper forecasts: the after-qualifying model's favourite won 63% of test races.

## How it works

```
F1DB release (1950-2026, SHA-256 checked) ──► canonical tables ──► chronological state replay ──► features
OpenF1 (live weekend sessions) ────────────────┘                    (snapshot, then update)          │
                                                                                                    ▼
                    walk-forward backtest  ◄── conditional logit / GBM (per-race softmax likelihood)
                    (refit before every race)                   │
                                                                ▼
                               online second stage (pooling + calibration; identity in the frozen config)
                                                                │
                                                                ▼
                                   P(win) per driver · per mode · up to 6 races ahead
```

**Data.** [F1DB](https://github.com/f1db/f1db) — every championship race since 1950 with results,
qualifying segments, starting grids (penalties, pit lane), practice and sprint sessions. A race
weekend in progress is pulled from [OpenF1](https://openf1.org) into the same tables; a contract test
confirmed the adapter reproduces F1DB exactly for an already-released weekend.

**State replay.** All 1,161 races of the pinned release are replayed in order. Before each race the
engine *snapshots* features for its entrants, then *updates* with the result — so a race can never leak
into its own features (verified with a mutation test that scrambles every outcome from race r onward).

The core signal is a **Kalman pace filter**: each team's qualifying pace (gap to pole, stitched across
Q1/Q2/Q3 so eliminated drivers are comparable) is a local-level state with more process noise early in
a season and a regression toward the field at regulation resets (major: 2009/14/22/26). Driver offsets
come from same-segment teammate deltas through a 2-D Kalman update (robust to compromised laps).
Around it: race Elo (mechanical DNFs don't count against drivers), exponentially weighted form,
power-unit pace and reliability, championship context, and — per mode — practice gaps, sprint results,
qualifying gap, grid slot and penalties.

**Models.** A conditional logit (McFadden's choice model: one softmax per race) is the workhorse; a
LightGBM trained on the same per-race softmax likelihood (custom objective) and a hybrid (shallow
trees on top of the linear scores) compete with it. A rank-ordered (Plackett–Luce) variant with a
learned stage scale was tried and didn't help. The code also has a walk-forward second stage that
pools members and recalibrates (for `pre_race` it can fall back toward the `pre_weekend` model); it
did not beat the plain conditional logit on validation, so the frozen config (`configs/final.json`)
uses the conditional logit alone.

**Evaluation.** Walk-forward, refit before every race, training rows from 2003. Validation 2014–22
(all selection), **test 2023–25** (scored once after freezing), 2026 reported separately (new
regulations). Primary metric: winner log-loss = −log P(actual winner). Comparisons against the
strongest simple baseline are *paired* by race with bootstrap intervals.

## Quickstart

```bash
uv venv --python 3.12 && uv pip install -e .
source .venv/bin/activate           # Windows: .venv\Scripts\activate
f1predict download                  # pinned F1DB release -> data/raw, canonical tables -> data/processed
f1predict oos                       # walk-forward backtest -> reports/oos (15-20 min; forecasts are calibrated on it)
f1predict predict                   # next race, pre_weekend
f1predict outlook                   # every remaining race of the season
f1predict predict --mode pre_quali --live          # during the weekend, after practice (OpenF1)
f1predict predict --mode pre_race --live           # after qualifying (grid = OpenF1 qualifying order)
f1predict predict --mode pre_race --live --grid-file grid.csv   # + penalties: CSV driver_id,grid_pos[,pit_lane_start]
f1predict evaluate                  # score the backtest -> reports/EVALUATION.md
```

`grid.csv` is a file you write. It adjusts the qualifying order pulled from OpenF1, so it only takes
effect once qualifying has finished; for a fully hand-set grid, use the dashboard.

## Dashboard

```bash
uv pip install -e ".[dashboard]"
cd dashboard && npm install && npm run build && cd ..   # builds the frontend into src/f1predict/dashboard/static
f1predict dashboard                 # http://127.0.0.1:8050 (after `f1predict oos` and `f1predict evaluate`)
```

A local web app over the same pipeline as the CLI:

* **Forecast.** The latest forecast for any remaining race, with the top three feature contributions
  behind each driver's probability. The run form starts a new forecast: pick the race and the moment,
  pull this weekend's sessions from OpenF1, set a starting grid by hand (drag to reorder, mark penalties
  and pit-lane starts), or swap drivers between seats. Runs execute in the background and are saved to
  `predictions/runs/`. Any two runs for the same race can be compared driver by driver. Below that:
  expected wins over the rest of the season.
* **History.** Predictions vs actual winners for every race from 2014 to 2026, for each of the three
  moments. Every one is a walk-forward forecast, and the numbers match `reports/EVALUATION.md`. It shows
  the probability given to each winner against the simple baseline, a calibration chart, a sortable race
  table, and a drill-down showing how each race's forecast moved through the weekend. Forecasts logged
  before a race (dashboard runs and `f1predict predict` CSVs) are scored here once the result is in the data.

A hand-set grid has no lap times, so the model sees positions only and its probabilities come out
flatter than with real qualifying; the run says so. A line-up change replays every race since 1950 for
the new field (about 30 s the first time, cached afterwards). After-practice and after-qualifying
forecasts are only offered for the next race, the only one with weekend sessions.

Frontend development: `cd dashboard && npm install && npm run dev` (Vite on :5173, proxying `/api` to
the dashboard server); `npm run test`, `npm run build` (writes `src/f1predict/dashboard/static`).

## Repository layout

```
src/f1predict/
  data/        download (pinned + checksum), canonical tables, OpenF1 live adapter
  features/    state engine (pace filter, Elo, form, reliability), weekend features, dataset builder
  models/      baselines, conditional logit + GBM (per-race softmax), online stacking
  evaluation/  walk-forward backtest, metrics, paired comparisons, calibration, report rendering
  dashboard/   FastAPI app + service for the web dashboard (static/ = built frontend, generated)
  pipeline.py  OOS predictions -> stacking -> evaluation -> forecasting
  cli.py       `f1predict` command
dashboard/     React + Vite + Tailwind frontend (API contract: src/api/types.ts)
configs/       final.json (frozen configuration)
```

Created locally by the commands above (not in the repository): `.venv/`, `dashboard/node_modules/`,
`src/f1predict/dashboard/static/` (built frontend), `data/` (F1DB tables), `reports/` (backtest
predictions, EVALUATION.md, evaluation.json, figures) and `predictions/` (forecasts from the CLI;
`runs/` holds forecasts run in the dashboard).

## Limitations

* No bookmaker odds as a benchmark (no free historical source), no weather, tyre strategy or
  telemetry long-run pace.
* 2026 is a new-regulation season with 17 completed races; its numbers are descriptive and the
  design process (critiques, reviews) was aware of how 2026 has gone so far, so it isn't a pristine
  holdout. The 2023–25 test seasons are.
* Multi-race-ahead forecasts assume today's line-ups. To change one race's line-up, run
  `f1predict predict --round N --entry-file lineup.csv` (CSV `driver_id,team_id,engine_id`) or swap
  seats in the dashboard; `f1predict outlook` always uses the current line-ups.
