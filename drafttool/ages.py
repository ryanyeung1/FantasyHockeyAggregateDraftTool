# -*- coding: utf-8 -*-
"""Player ages, and the pre/post-prime bands built on them.

Age is a public fact rather than projection work, so it is extracted out of the
paid workbooks into config/ages.csv (see make_reference.py) and read from there.
Missing file is not an error -- the projection sources carry ages of their own.

Sources disagree about age because each picks its own reference date: the
extracted list is age at the start of the season, while DtZ and Hockey-Reference
report the age a player reaches during it, so they run one year higher for
roughly 40% of players. The bands below were calibrated against the extracted
convention, which is why it wins where it has a player.
"""

from __future__ import unicode_literals

import csv
import io
import os

PRE_PRIME = "pre"
PRIME = "prime"
POST_PRIME = "post"

# How far the extracted age may sit from what a projection source says before
# it is treated as a typo rather than a difference of convention. A one-year
# gap is the convention; the workbook also carries a handful of outright
# errors -- Claude Giroux as 19, Patrick Kane as 26 -- and those would land a
# 39-year-old in the pre-prime band.
MAX_PLAUSIBLE_DRIFT = 1


def load(directory, filename="ages.csv", alias_table=None):
    """Read {key: age} from config/ages.csv, or {} when it is not there."""
    path = os.path.join(directory, filename)
    if not os.path.exists(path):
        return {}
    out = {}
    with io.open(path, "r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.reader(handle):
            if len(row) < 2:
                continue
            name = (row[0] or "").strip()
            if not name or name.startswith("#"):
                continue
            if name.lower() in ("name", "player"):
                continue
            try:
                age = int(round(float(row[1])))
            except (TypeError, ValueError):
                continue
            # "is not None", not a truth test: an empty AliasTable defines
            # __len__ and is therefore falsy, which would skip normalization
            # altogether and key the table by display name.
            key = alias_table.resolve(name) if alias_table is not None else name
            out[key] = age
    return out


def band(age, bands=None):
    """Which prime band an age falls in, or None when the age is unknown."""
    if age is None:
        return None
    bands = bands or {}
    pre_max = bands.get("pre_prime_max", 24)
    post_min = bands.get("post_prime_min", 31)
    if age <= pre_max:
        return PRE_PRIME
    if age >= post_min:
        return POST_PRIME
    return PRIME


def apply(players, table):
    """Overwrite each player's age from the extracted list.

    Returns the keys whose extracted age was rejected as implausible, so the
    build can report them rather than silently mislabelling a veteran as a
    prospect.
    """
    rejected = []
    for player in players:
        extracted = table.get(player["key"])
        if extracted is None:
            continue
        current = player.get("age")
        if (current is not None
                and abs(extracted - current) > MAX_PLAUSIBLE_DRIFT):
            rejected.append((player["key"], current, extracted))
            continue
        player["age"] = extracted
    return rejected
