# -*- coding: utf-8 -*-
"""Per-platform position eligibility.

Yahoo, Fantrax and ESPN each decide for themselves what a player is eligible
at, and they disagree: the thresholds differ (games played at a position this
season vs last), and so does how generously each grants a second position. The
projection sources cannot answer this -- all five of them ship a single
position string, and they agree with each other on 683 of the 687 players more
than one of them carries. So eligibility has to come from the platform.

Each platform's list is an optional file in config/. Missing files are not an
error; the board simply does not offer that platform. Format:

    name,positions
    Nathan MacKinnon,C
    Leon Draisaitl,C/LW

Positions may be separated by '/' or by ',' inside a quoted field, since that
is how the various exports write them. Lines starting with '#' are comments.
"""

from __future__ import unicode_literals

import csv
import io
import os
import re

VALID = ("C", "LW", "RW", "D", "G")


def _positions(text):
    """Split a positions cell into canonical codes, dropping anything unknown.

    Platform exports pad this field with slot names the board has no concept of
    -- 'F', 'UTIL', 'W', 'IR', 'Skater' -- and letting those through would
    invent positions the valuation cannot price.
    """
    parts = re.split(r"[/,;|]", text or "")
    out = []
    for part in parts:
        code = part.strip().upper().replace(".", "")
        if code in VALID and code not in out:
            out.append(code)
    return out


def load(directory, providers, alias_table):
    """Read the declared eligibility files that exist.

    Returns {provider_id: {key: [positions]}}, omitting providers with no file
    or no usable rows.
    """
    out = {}
    for provider in providers or []:
        path = os.path.join(directory, provider["file"])
        if not os.path.exists(path):
            continue
        table = {}
        with io.open(path, "r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.reader(handle):
                if len(row) < 2:
                    continue
                name = (row[0] or "").strip()
                if not name or name.startswith("#"):
                    continue
                if name.lower() in ("name", "player"):
                    continue
                # Anything past the second column is more positions, which is
                # what an unquoted 'C,LW' export looks like once csv splits it.
                positions = _positions("/".join(c for c in row[1:] if c))
                if positions:
                    table[alias_table.resolve(name)] = positions
        if table:
            out[provider["id"]] = table
    return out
