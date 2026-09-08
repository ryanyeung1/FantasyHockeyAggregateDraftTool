"""Merge per-source rows into the single JSON blob the board consumes.

The output deliberately keeps every source's raw numbers rather than a
pre-blended line: the whole point of the tool is that source weights are tuned
live, so blending has to happen in the browser on every change.
"""

import json
import os
from collections import OrderedDict

from . import ages as ages_mod
from . import schedule as schedule_mod
from . import sources as sources_mod
from . import teams as teams_mod
from .config import OUT_DIR
from .names import normalize, suggest


def _round(value, places=6):
    """Trim float noise so the inlined JSON stays small and diffs stay readable.

    Six places rather than four costs about 8% on the payload and keeps a
    player's blended fantasy points within ~2e-6 of the source workbook's own
    figure, so cross-checking this board against a source spreadsheet agrees to
    every digit either one displays. At four places the accumulated rounding
    reached 2e-4, which is still invisible on screen but shows up the moment
    somebody compares raw numbers -- and people do.
    """
    if value is None:
        return None
    return round(value, places)


def merge(spec, alias_table, config, age_table=None):
    """Read every source and fold them into one player list.

    Identity fields (display name, team, position eligibility, age) are taken
    from the first source in sources.json order that supplies them, so the
    ordering in that file doubles as a trust ranking. Stat values are never
    merged here -- each source's line is preserved separately.
    """
    source_defs = spec["sources"]
    stat_keys = spec["stats"]

    by_key = OrderedDict()
    rows_by_source = OrderedDict()
    adp = {}
    display_by_key = {}

    for source in source_defs:
        rows = sources_mod.read_source(source, spec, alias_table)
        rows_by_source[source["id"]] = rows
        for row in rows:
            display_by_key.setdefault(row.key, row.name)
            player = by_key.get(row.key)
            if player is None:
                player = {
                    "key": row.key,
                    "name": row.name,
                    "team": row.team,
                    "pos": list(row.pos),
                    "age": row.age,
                    "src": {},
                }
                by_key[row.key] = player
            else:
                # First source wins on identity; later sources only fill blanks.
                if not player["team"] and row.team:
                    player["team"] = row.team
                if not player["pos"] and row.pos:
                    player["pos"] = list(row.pos)
                if player["age"] is None and row.age is not None:
                    player["age"] = row.age
            player["src"][source["id"]] = row.stats

        # Per provider, the first source carrying a value wins. Dom is read
        # first, so its Yahoo and Fantrax columns are authoritative and the
        # later single-column sources only fill players it left blank.
        for provider, table in sources_mod.read_adp(source, alias_table).items():
            into = adp.setdefault(provider, {})
            for key, value in table.items():
                into.setdefault(key, value)

    # Providers computed from other providers rather than read from a file.
    # The mean of whichever of them rank a player -- so a player only one
    # platform has still gets an average, which is the rule Dom's own AVG
    # column followed and what tests/test_sources.py pins.
    for provider in spec.get("adp_providers", []):
        parts = provider.get("mean_of")
        if not parts:
            continue
        computed = {}
        for key in set(k for part in parts for k in adp.get(part, {})):
            values = [adp[part][key] for part in parts
                      if key in adp.get(part, {})]
            if values:
                computed[key] = sum(values) / float(len(values))
        if computed:
            adp[provider["id"]] = computed

    for provider, table in adp.items():
        for key, value in table.items():
            if key in by_key:
                by_key[key].setdefault("adp", {})[provider] = value

    # A player with no position can never be valued against a replacement level,
    # so fall back to UTIL-ish forward eligibility rather than dropping them.
    for player in by_key.values():
        if not player["pos"]:
            player["pos"] = ["C"]

    players = list(by_key.values())
    # The extracted ages are the ones the prime bands were calibrated against,
    # so they win where they exist; the sources fill the rest.
    rejected_ages = ages_mod.apply(players, age_table or {})
    return players, rows_by_source, stat_keys, rejected_ages


HISTORY_SOURCE_ID = "ACT"


def read_history(spec, alias_table, players):
    """Read last season's actuals and join them to the board by name.

    Returns (history_players, matches) where `matches` maps a board player's
    index to its index in history_players.

    The join is done here, in Python, with the real normalizer and alias table.
    The browser then follows an integer index and never has to normalize a name
    -- which is what lets the history ranking recompute live as scoring changes
    without shipping a second name-matching implementation to JavaScript.
    """
    history = spec.get("history")
    if not history:
        return [], {}

    rows = []
    for sheet in history["sheets"]:
        rows.extend(sources_mod.read_source(sheet, spec, alias_table))

    # A player traded mid-season can appear in both sheets only if they somehow
    # played both ways; first wins, which keeps the skater line.
    by_key = OrderedDict()
    for row in rows:
        by_key.setdefault(row.key, row)

    board_by_key = {}
    for index, player in enumerate(players):
        board_by_key.setdefault(player["key"], index)

    history_players = []
    matches = {}
    for key, row in by_key.items():
        board_index = board_by_key.get(key)
        entry = {
            "name": row.name,
            "team": row.team,
            # Value last season by the eligibility the board uses, so a player's
            # two ranks are computed on the same footing. Players who are not on
            # the board (retired, or dropped from the projections) keep the
            # source's own position so they still occupy the right replacement
            # pool.
            "pos": list(players[board_index]["pos"]) if board_index is not None
                   else list(row.pos),
            "stats": row.stats,
        }
        if not entry["pos"]:
            continue
        if board_index is not None:
            matches[board_index] = len(history_players)
        history_players.append(entry)

    return history_players, matches


def unmatched_report(spec, rows_by_source, players):
    """Rows from secondary sources that did not join to the primary source.

    Some are genuinely absent from the primary source (deep prospects); the rest
    are spellings that belong in config/aliases.csv. The suggestion column
    separates the two, and it carries the candidate's team and position because
    that is what settles the call: 'Zack Bolduc / Zachary Bolduc, both MTL,
    both LW,RW' is one player, while 'James / Trevor van Riemsdyk, DET LW and
    PIT D' are brothers. Without those columns every row is a lookup.
    """
    source_ids = [s["id"] for s in spec["sources"]]
    if not source_ids:
        return []
    primary = source_ids[0]
    primary_rows = rows_by_source.get(primary, [])
    primary_keys = set(row.key for row in primary_rows)
    display_by_key = {}
    row_by_display = {}
    for row in primary_rows:
        display_by_key.setdefault(row.key, row.name)
        row_by_display.setdefault(row.name, row)

    name_col = "closest_in_%s" % primary
    seen = set()
    report = []
    for source in spec["sources"][1:]:
        for row in rows_by_source.get(source["id"], []):
            if row.key in primary_keys or (source["id"], row.key) in seen:
                continue
            seen.add((source["id"], row.key))
            match = suggest(row.key, primary_keys, display_by_key)
            candidate = row_by_display.get(match)
            report.append({
                "source": source["id"],
                "name": row.name,
                "team": row.team,
                "pos": ",".join(row.pos),
                name_col: match,
                "closest_team": candidate.team if candidate else "",
                "closest_pos": ",".join(candidate.pos) if candidate else "",
            })
    return report


def build_payload(spec, config, players, stat_keys, history=None, matches=None,
                  alias_pairs=None, eligibility=None, schedule=None):
    """Assemble the object that gets inlined into the board.

    Stats are stored as arrays parallel to `stats` (nulls for 'not projected')
    rather than per-player objects -- with ~670 players x 3 sources the key
    repetition in object form roughly triples the inlined payload.
    """
    coverage = {}
    for source in spec["sources"]:
        sid = source["id"]
        present = [k for k in stat_keys if any(k in p["src"].get(sid, {}) for p in players)]
        coverage[sid] = {
            "players": sum(1 for p in players if p["src"].get(sid)),
            "stats": present,
            "has_goalies": any(
                p["src"].get(sid) and "G" in p["pos"] for p in players
            ),
        }

    matches = matches or {}
    out_players = []
    eligibility = eligibility or {}
    adp_counts = {}
    for player in players:
        for prov in (player.get("adp") or {}):
            adp_counts[prov] = adp_counts.get(prov, 0) + 1

    for index, player in enumerate(players):
        entry = {
            "n": player["name"],
            "t": player["team"],
            "p": player["pos"],
            "s": {},
        }
        if player.get("age") is not None:
            entry["age"] = _round(player["age"], 1)
        if player.get("adp"):
            # {provider: pick}. Only providers that actually rank the player are
            # present, so the menu can grey out the ones with no number.
            entry["adp"] = dict((prov, _round(val, 1))
                                for prov, val in player["adp"].items())
        # The normalized join key, shipped rather than recomputed in the
        # browser so a file imported through the UI matches names exactly the
        # way the build does. tests/test_importer.js asserts the JavaScript
        # normalizer reproduces every one of these.
        entry["k"] = player["key"]
        overrides = {}
        for provider, table in eligibility.items():
            positions = table.get(player["key"])
            if positions and positions != player["pos"]:
                overrides[provider] = positions
        if overrides:
            entry["pe"] = overrides
        if index in matches:
            # Index into history.players; absent means no row last season.
            entry["h"] = matches[index]
        for sid, stats in player["src"].items():
            if stats:
                entry["s"][sid] = [_round(stats.get(k)) for k in stat_keys]
        out_players.append(entry)

    payload = {
        "meta": {
            "season": config.get("season", ""),
            "games_in_season": config.get("games_in_season", 82),
            "generated": None,  # filled by build.py so tests stay deterministic
        },
        "stats": stat_keys,
        "counting_stats": spec.get("counting_stats", []),
        "rate_stats": spec.get("rate_stats", []),
        "sources": [
            {
                "id": s["id"],
                "name": s["name"],
                "players": coverage[s["id"]]["players"],
                "stats": coverage[s["id"]]["stats"],
                "has_goalies": coverage[s["id"]]["has_goalies"],
            }
            for s in spec["sources"]
        ],
        # The ADP columns on offer, with how many players each actually ranks
        # so the settings menu can say so rather than leaving you to discover
        # that Yahoo covers 249 players and Fantrax 426.
        "adp_providers": [
            {
                "id": prov["id"],
                "name": prov["name"],
                "players": adp_counts.get(prov["id"], 0),
            }
            for prov in spec.get("adp_providers", [])
            if adp_counts.get(prov["id"])
        ],
        # Platforms whose eligibility list was found in config/. Absent means
        # no file, which is why the menu can be honest about what it offers
        # instead of listing three identical options.
        "eligibility_providers": [
            {
                "id": prov["id"],
                "name": prov["name"],
                "players": len(eligibility.get(prov["id"], {})),
                "differs": sum(
                    1 for p in players
                    if eligibility.get(prov["id"], {}).get(p["key"])
                    and eligibility[prov["id"]][p["key"]] != p["pos"]
                ),
            }
            for prov in spec.get("eligibility_providers", [])
            if eligibility.get(prov["id"])
        ],
        "players": out_players,
        "config": config,
        # Per-team off-night and fantasy-playoff strength. Joined in the page by
        # team code rather than stamped onto each player, so switching the
        # playoff window costs one re-render and no rebuild.
        "schedule": schedule or None,
        "age_bands": (config.get("model") or {}).get("age_bands") or {},
        # Everything the browser needs to join an imported file the same way
        # this build joins its own sources.
        "aliases": alias_pairs or {},
        "team_nicknames": teams_mod.NICKNAMES,
        # Two players sharing a name, told apart by position. Shipped for the
        # same reason the aliases are: an imported file has to resolve identity
        # exactly the way the build does, or it silently merges them again.
        "disambiguate": [
            rule
            for source in spec["sources"]
            for rule in (source.get("disambiguate") or [])
        ],
    }

    if history:
        meta = spec.get("history", {})
        payload["history"] = {
            "season": meta.get("season", ""),
            "label": meta.get("label", "last season"),
            # Shaped exactly like a board player with one pseudo-source, so the
            # browser can build a model from it and reuse the same valuation
            # pipeline rather than growing a parallel one.
            "players": [
                {
                    "n": h["name"],
                    "t": h["team"],
                    "p": h["pos"],
                    "s": {HISTORY_SOURCE_ID: [_round(h["stats"].get(k)) for k in stat_keys]},
                }
                for h in history
            ],
        }
    return payload


def write_csv(path, rows, fieldnames):
    import csv

    if not os.path.isdir(os.path.dirname(path)):
        os.makedirs(os.path.dirname(path))
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), ensure_ascii=False)
