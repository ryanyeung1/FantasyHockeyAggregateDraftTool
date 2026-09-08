# -*- coding: utf-8 -*-
"""Team schedule strength: off-nights and the fantasy playoff weeks.

Two things that move a player's real value and appear in no projection:

  * OFF-NIGHTS -- games on a night the league is quiet. A roster only starts so
    many skaters, so a game on a light night is one you actually get to use,
    while a fifth game on a 12-game Tuesday sits on your bench.
  * PLAYOFF WEEKS -- games during the fantasy playoffs, when a single extra
    start decides a matchup.

Both are read straight from the schedule pack, already aggregated per team.
Nothing is computed from the raw game list.

The playoff sheet holds two windows and they are NOT one subtraction apart:
skipping the final week shifts the whole three-round window a week earlier, so
each is read from its own row range. Deriving one from the other produces a
two-round window and quite different answers.

This is an indicator only -- it never touches the blend or VORP.
"""

from __future__ import unicode_literals

from . import sources as sources_mod

# A team is flagged favourable at or above this percentile of the league and
# unfavourable at or below the other. Computed from the data rather than
# hardcoded so the thresholds follow the other playoff window, and next
# season's pack, without being re-tuned.
GOOD_PCTILE = 75
BAD_PCTILE = 25


def _percentile(values, pct):
    """Linear-interpolated percentile. statistics.quantiles is 3.8+, and this
    project still targets Python 2-compatible syntax elsewhere."""
    ordered = sorted(values)
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * (pct / 100.0)
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (pos - low)


def _read_table(spec, table, extra_keys):
    """Read one team table into {team: {key: number}}."""
    source = {"id": "SCHED", "file": spec["file"]}
    rows = sources_mod.load_rows(source, table["sheet"], 40)
    cols = table["columns"]
    first = table["first_data_row"]
    last = table.get("last_data_row") or len(rows)
    out = {}
    for raw in rows[first - 1:last]:
        team = sources_mod._cell(raw, cols["team"] - 1)
        if not team:
            continue
        team = str(team).strip().upper()
        # A totals row ("LEAGUE") sits under the table and is not a team.
        if len(team) > 4:
            continue
        entry = {}
        for key in extra_keys:
            if key not in cols:
                continue
            entry[key] = sources_mod._number(sources_mod._cell(raw, cols[key] - 1))
        out[team] = entry
    return out


def _tier(value, good, bad):
    """1 favourable, -1 unfavourable, 0 middling -- the same shape the board's
    other direction markers use."""
    if value is None or good is None:
        return 0
    if value >= good:
        return 1
    if value <= bad:
        return -1
    return 0


def load(spec):
    """Read the schedule block. Returns None when it is absent or unreadable.

    A missing schedule is not an error: the board simply shows no marks.
    """
    if not spec:
        return None
    try:
        off_raw = _read_table(spec, spec["off_nights"],
                              ("games", "off", "off_pct", "prime", "rank"))
    except (IOError, OSError, KeyError):
        return None
    if not off_raw:
        return None

    off_values = [d["off"] for d in off_raw.values() if d.get("off") is not None]
    off_good = _percentile(off_values, GOOD_PCTILE)
    off_bad = _percentile(off_values, BAD_PCTILE)

    teams = {}
    for team, d in off_raw.items():
        teams[team] = {
            "games": d.get("games"),
            "off": d.get("off"),
            "offPct": d.get("off_pct"),
            "prime": d.get("prime"),
            "offRank": d.get("rank"),
            "offTier": _tier(d.get("off"), off_good, off_bad),
            "po": {},
        }

    windows = []
    for window in spec.get("playoff_windows") or []:
        table = _read_table(spec, window, ("games", "off", "score", "rank"))
        scores = [d["score"] for d in table.values() if d.get("score") is not None]
        good = _percentile(scores, GOOD_PCTILE)
        bad = _percentile(scores, BAD_PCTILE)
        for team, d in table.items():
            if team not in teams:
                continue
            teams[team]["po"][window["id"]] = {
                "games": d.get("games"),
                "off": d.get("off"),
                "score": d.get("score"),
                "rank": d.get("rank"),
                "tier": _tier(d.get("score"), good, bad),
            }
        windows.append({"id": window["id"], "name": window["name"],
                        "short": window.get("short") or window["name"],
                        "good": good, "bad": bad, "teams": len(table)})

    return {
        "teams": teams,
        "windows": windows,
        "off_good": off_good,
        "off_bad": off_bad,
        "count": len(teams),
    }
