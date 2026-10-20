"""Project-wide paths and constants."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
REPORTS_DIR = ROOT / "reports"
PREDICTIONS_DIR = ROOT / "predictions"

# Pinned data release. Bump after each Grand Prix (`f1predict download --latest`).
F1DB_VERSION = os.environ.get("F1PREDICT_F1DB_VERSION", "v2026.17.0")

# Technical-regulation resets, classified by how much the competitive order actually reshuffled
# (Spearman of constructor qualifying pace, last 6 races of y-1 vs first 6 of y): 2009 -0.10,
# 2005 0.52, 2026 0.54, 2007 0.59, 2022 0.62, 2014 0.64, 2017 0.79, 1998 0.86 -> 1989 behaves like a
# normal season and is not listed. Team state is regressed toward the field mean harder at resets.
MAJOR_RESETS = frozenset({2009, 2014, 2022, 2026})
MINOR_RESETS = frozenset({1998, 2005, 2006, 2007, 2017})
# Power-unit formula changes: engine-manufacturer state is discarded.
PU_RESETS = frozenset({2006, 2014, 2026})
# 2006-2009 Q3 was run on race fuel, so Q3 times do not measure pace.
RACE_FUEL_Q3_YEARS = frozenset({2006, 2007, 2008, 2009})
# Races whose result says little about pace: 2005 US GP (6 starters), 2021 Belgian GP (1 lap behind SC).
NON_REPRESENTATIVE_RACES = frozenset({740, 1047})

# Walk-forward evaluation splits (seasons).
VALIDATION_SEASONS = tuple(range(2014, 2023))
TEST_SEASONS = (2023, 2024, 2025)
HOLDOUT_SEASONS = (2026,)

# Earliest season whose races are used as training rows (state/ratings still warm up from 1950).
# Pre-2003 racing (DNF rates ~45%, DNQs, tyre wars, race-fuel qualifying) is a different sport.
DEFAULT_TRAIN_START = 2003
# Base-model predictions start here so the second-stage (stacking / calibration) layer has
# out-of-sample history before the first validation race.
STACK_BURN_IN_SEASONS = (2011, 2012, 2013)

MODES = ("pre_weekend", "pre_quali", "pre_race")
