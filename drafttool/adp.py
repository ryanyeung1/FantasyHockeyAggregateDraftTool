# -*- coding: utf-8 -*-
"""Yahoo's average draft position, read from Yahoo rather than inferred.

The projection sources publish ADP columns with no label saying which platform
they track, so each was assigned by matching it against a paid workbook's
labelled columns: DtZ's matched Fantrax and never Yahoo, Daily Faceoff's matched
Yahoo. That reasoning held, but it made Yahoo's number a second-hand copy of a
snapshot taken on somebody else's schedule -- measured against Yahoo's own
current board, Daily Faceoff's column sits 26.8 picks away on average.

So Yahoo ADP now comes from Yahoo's draft-analysis page, extracted into
config/adp_yahoo.csv by make_reference.py. A missing file is not an error: the
provider simply has no players and drops out of the menu, exactly as it would
if no source published the column.
"""

from __future__ import unicode_literals

import csv
import io
import os


def load(directory, filename="adp_yahoo.csv", alias_table=None):
    """Read {key: adp} from config/adp_yahoo.csv, or {} when it is not there.

    Keyed the same way every other table in this project is -- through the
    alias table -- so a spelling Yahoo uses and the board does not still joins.
    """
    path = os.path.join(directory, filename)
    if not os.path.exists(path):
        return {}
    out = {}
    with io.open(path, "r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.reader(handle):
            if not row or not row[0].strip() or row[0].lstrip().startswith("#"):
                continue
            name = row[0].strip()
            if name.lower() == "name":
                continue
            if len(row) < 2 or not row[1].strip():
                continue
            try:
                value = float(row[1])
            except ValueError:
                continue
            key = alias_table.resolve(name) if alias_table else name.lower()
            if key:
                out[key] = value
    return out
