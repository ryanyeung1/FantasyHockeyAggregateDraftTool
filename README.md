# Fantasy Hockey Draft Tool — 2026-27

**https://fantasy-hockey-aggregate.pages.dev/**

A ranked big board that blends several projection sources with weights you tune
by hand. Python reads the spreadsheets; the board itself is a single
self-contained HTML file without relying on a server, network, or installation.

Built for **points leagues**, not categories.

```
python build.py
```

then open **`out/draft_board.html`**.

> Design notes, and the reasoning behind every number on the board, live in
> **[DESIGN.md](DESIGN.md)**.

---

## Using it during a draft

| Action | How |
|---|---|
| Mark a player gone | click their row |
| Add to **your** roster | double-click their row |
| Undo | click again |
| Nudge a projection up or down | the `−` / `+` buttons in the **Adj** column |
| Shortlist or rule out a player | `★` / `⊘` in the **Mark** column |
| See a player's per-source projections | click their **name** (a chevron appears on hover) |
| Jump to the search box | press `/` |
| Sort | click any column header |
| Rank by a different metric | the dropdown in the **#** header |

Filter chips narrow the table by position, plus **Mine**, **Adj**, **Drafted**,
**★ Watch** and **⊘ Avoid**. The right rail shows the best available at each
position, your roster with the slots still open, and the current replacement
level. The **Settings** drawer holds every knob to adjust scoring, source weights,
roster shape, and model options. The board re-ranks automatically.
Nothing needs rebuilding unless the projections themselves change.

Everything saves to the browser automatically, **keyed by player name** so it
survives a rebuild. **Save snapshot** writes it all to a file, for carrying a
setup to another machine or keeping a backup before you experiment.

---

## What the columns tell you

| Column | Meaning |
|---|---|
| **VORP** | value over the replacement player at your most valuable eligible position |
| **Next** | how far it is to the next available player at that position — the cost of waiting |
| **Tier** | a cliff in VORP, not a fixed bucket size |
| **Tm** | two schedule marks: off-nights, then the fantasy playoff weeks |
| **Age** | `▲` pre-prime (≤24), `▼` post-prime (≥31) |
| **ADP** | Yahoo, Fantrax or their average, with `▲` value / `▼` reach |
| **25-26** | last season re-scored under your settings, ranked the same way |
| **Source** | which projection sources have a line for this player |

---

## Current sources

| Source | Players | Coverage |
|---|---|---|
| [DatsyukToZetterberg](https://www.reddit.com/r/fantasyhockey/comments/1w167wt/dtz_20262027_fantasy_hockey_projections_free/) | 795 | 25 stats, skaters **and goalies** |
| [Daily Faceoff](https://www.dailyfaceoff.com/projections) | 643 | 23 stats, skaters **and goalies** |
| [Apples & Ginos](https://www.reddit.com/r/fantasyhockey/comments/1w4hm18/ag_202627_fantasy_hockey_projections_385_players/) | 378 | 10 stats, skaters only |

806 players after joining. Team schedule strength comes from the
[HockeyBangers](https://hockeybangers.substack.com/p/analyzing-the-2026-27-nhl-schedule) 2026-27 schedule pack.

Add your own with **Import projections** in Settings (CSV or XLSX, columns
auto-detected), or permanently via `config/sources.json`. Any source can be
removed, built-in ones included. See [DESIGN.md](DESIGN.md).

---

## Requirements

Python 3 with `openpyxl` (`pip install -r requirements.txt`). Node is optional —
it produces `rankings.csv` and runs the JS tests, but the board works without it
and can export its own CSV from the browser.

```
python build.py          # build the board
python build.py --verify # and cross-check against a reference sheet
python run_tests.py      # 158 Python, 63 JS, 28 importer, 280 UI checks
python make_reference.py # regenerate eligibility and age lists
```
