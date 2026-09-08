"""Generic projection-workbook reader driven by config/sources.json.

One reader serves every source. A column is addressed either by header text or
by 1-based index; the index form exists because Yahoo's sheet carries two
columns headed 'GP' (skater in 17, goalie in 36) and header lookup alone cannot
tell them apart.

Two file formats are supported behind the same spec. 'xlsx' is a real Excel
workbook read with openpyxl. 'html' is an HTML <table> saved with a .xls
extension, which is what stats sites hand you when you click "export to Excel" --
openpyxl cannot open those at all.
"""

import io
import os
import re

import openpyxl

from . import teams as teams_mod
from .config import source_path
from .names import normalize

# 'Y! Pos' style position strings carry noise we do not want in eligibility.
_POS_CLEAN = re.compile(r"[^A-Za-z,/]")
_POS_MAP = {"C": "C", "LW": "LW", "L": "LW", "RW": "RW", "R": "RW", "D": "D", "G": "G"}

# Some sources record a player only as a generic forward or winger. Treat those
# as eligible everywhere the label allows, rather than dropping the player.
_POS_EXPAND = {"F": ("C", "LW", "RW"), "W": ("LW", "RW")}

_MMSS = re.compile(r"^(\d+):([0-5]?\d)$")


class SourceRow(object):
    """One player as a single source sees them."""

    __slots__ = ("name", "key", "team", "pos", "age", "stats")

    def __init__(self, name, key, team, pos, age, stats):
        self.name = name
        self.key = key
        self.team = team
        self.pos = pos
        self.age = age
        self.stats = stats


def _xlsx_rows(workbook, sheet, max_col):
    worksheet = workbook[sheet]
    return list(worksheet.iter_rows(max_col=max_col, values_only=True))


def _html_rows(path, sheet=None):
    """Read an HTML <table> saved as .xls into a list of row tuples.

    The encoding has to be stated explicitly. These files are valid UTF-8 but
    carry no charset declaration, and lxml's sniffing then falls back to latin-1
    -- turning 'Anze Kopitar' into mojibake and silently breaking the name join.

    `sheet`, when given, selects among multiple tables by 0-based index.
    """
    from lxml import html as lxml_html

    doc = lxml_html.parse(path, lxml_html.HTMLParser(encoding="utf-8"))
    tables = doc.xpath("//table")
    if not tables:
        raise ValueError("%s contains no <table>" % path)
    table = tables[int(sheet) if sheet not in (None, "") else 0]

    rows = []
    for tr in table.xpath(".//tr"):
        cells = tr.xpath("./th|./td")
        rows.append(tuple((c.text_content() or "").strip() for c in cells))
    return rows


def _csv_rows(path):
    """Read a delimited text file into row tuples.

    'utf-8-sig' drops the byte-order mark most spreadsheet exports carry;
    leaving it on would make the first heading unmatchable.
    """
    import csv

    with io.open(path, "r", encoding="utf-8-sig", newline="") as handle:
        sample = handle.read(8192)
        handle.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
        except csv.Error:
            dialect = csv.excel
        return [tuple(row) for row in csv.reader(handle, dialect)]


_ROW_CACHE = {}


def load_rows(source, sheet, max_col):
    """Every row of one sheet as tuples, whichever format the file is in.

    Cached per (file, sheet, revision): a build reads Yahoo's sheet once for
    stats and again for its ADP table, and DtZ twice for its two sheets, so
    without this the same workbook gets parsed repeatedly. The cache key carries
    the file's size and mtime, so editing a source between runs is picked up.
    """
    path = source_path(source)
    try:
        stamp = os.stat(path)
        revision = (stamp.st_mtime, stamp.st_size)
    except OSError:
        revision = None
    key = (path, sheet, revision, max_col)
    if key in _ROW_CACHE:
        return _ROW_CACHE[key]

    if source.get("format") == "csv":
        rows = _csv_rows(path)
    elif source.get("format") == "html":
        rows = _html_rows(path, sheet)
    else:
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        try:
            rows = _xlsx_rows(workbook, sheet, max_col)
        finally:
            workbook.close()
    _ROW_CACHE[key] = rows
    return rows


def _header_index(rows, header_row):
    """Map lowercased, whitespace-collapsed header text -> 1-based column index.

    First occurrence wins; duplicates are exactly why integer addressing exists.
    """
    index = {}
    if header_row - 1 >= len(rows):
        return index
    for offset, value in enumerate(rows[header_row - 1]):
        if value is None:
            continue
        label = re.sub(r"\s+", " ", str(value)).strip().lower()
        if label and label not in index:
            index[label] = offset + 1
    return index


def _resolve_columns(mapping, headers, source_id):
    """Turn a {field: header-or-index} mapping into {field: 0-based offset}."""
    resolved = {}
    for field, spec in mapping.items():
        if isinstance(spec, int):
            resolved[field] = spec - 1
        else:
            label = re.sub(r"\s+", " ", str(spec)).strip().lower()
            if label not in headers:
                raise KeyError(
                    "source %r: no column headed %r (have: %s)"
                    % (source_id, spec, ", ".join(sorted(headers))[:200])
                )
            resolved[field] = headers[label] - 1
    return resolved


def _cell(row, offset):
    if offset is None or offset < 0 or offset >= len(row):
        return None
    return row[offset]


def _number(value, fmt=None):
    """Coerce a cell to float, treating blanks and stray text as 'not projected'.

    A missing value must stay None rather than becoming 0.0 -- the blender skips
    absent values, and turning them into zeros would drag a player's average down
    for every stat a source happens not to publish.

    `fmt` handles the one shape that is not a plain number: 'mmss' turns a time
    on ice written as '22:59' into 22.983 decimal minutes.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text or text in ("-", "--", "–", "—", "N/A", "NA", "null", "None"):
        return None
    # Spreadsheets prefix a value with an apostrophe to force it to text.
    text = text.lstrip("'").strip()
    if not text:
        return None
    if fmt == "mmss":
        match = _MMSS.match(text)
        if match:
            return int(match.group(1)) + int(match.group(2)) / 60.0
        # Fall through: some rows in a mm:ss column are already decimal.
    try:
        return float(text)
    except ValueError:
        return None


def parse_positions(raw, delim=","):
    """Split a source's position string into canonical eligibility codes.

    A generic 'F' or 'W' expands to every spot it covers -- Hockey-Reference
    lists some players that way, and dropping them would leave a player with no
    position and no way to be valued.
    """
    if raw is None:
        return []
    text = _POS_CLEAN.sub("", str(raw).upper())
    if not text:
        return []
    parts = re.split(r"[,/]", text)
    out = []
    for part in parts:
        part = part.strip()
        for code in _POS_EXPAND.get(part, (_POS_MAP.get(part),)):
            if code and code not in out:
                out.append(code)
    return out


_MULTI_TEAM = re.compile(r"^\d+TM$")


def _dedupe(rows, teams_by_row, suffix):
    """Collapse repeated players, preferring an aggregate multi-team row.

    Season totals from Hockey-Reference list a traded player once per team plus
    a '2TM' row holding the combined totals. Summing the per-team rows would be
    equivalent, but picking the aggregate the source already publishes avoids
    guessing how it treats rate columns.
    """
    if not suffix:
        return rows
    order = []
    grouped = {}
    for index, row in enumerate(rows):
        if row.key not in grouped:
            grouped[row.key] = []
            order.append(row.key)
        grouped[row.key].append((index, row))

    out = []
    for key in order:
        group = grouped[key]
        if len(group) == 1:
            out.append(group[0][1])
            continue
        aggregate = [r for i, r in group
                     if _MULTI_TEAM.match((teams_by_row.get(i) or "").upper())]
        if aggregate:
            out.append(aggregate[0])
        else:
            # No aggregate published: keep the row with the most games, which is
            # the least-wrong single row available.
            out.append(max((r for _, r in group),
                           key=lambda r: r.stats.get("GP") or 0))
    return out


def _read_sheet(source, spec, alias_table, sheet, columns,
                goalie_columns, header_row, first_data_row):
    """Read one sheet into SourceRow objects.

    Split out from read_source because sources disagree about where goalies
    live: Yahoo keeps them on the same sheet behind a second set of columns
    (its header row has two columns called 'GP'), while DatsyukToZetterberg
    puts them on a sheet of their own with an entirely different layout.
    """
    stat_keys = spec["stats"]
    derived = source.get("derived") or {}
    formats = source.get("formats") or {}
    required = source.get("require") or []
    # A sheet of per-game rates rather than season totals. Counting stats get
    # multiplied back up by games played; rate stats (ATOI, SV%, GAA) are
    # already per-game and must be left alone, which is exactly the split the
    # spec already draws for the blender.
    per_game = bool(source.get("per_game"))
    counting = set(spec.get("counting_stats") or [])

    max_col = max(
        [v for v in list(columns.values()) +
         list((goalie_columns or {}).values()) if isinstance(v, int)] or [1]
    )
    for rule in derived.values():
        max_col = max([max_col] + list(rule.get("sum") or []))
    max_col = max(max_col, 60)

    all_rows = load_rows(source, sheet, max_col)
    headers = _header_index(all_rows, header_row)
    skater_cols = _resolve_columns(columns, headers, source["id"])
    goalie_cols = dict(skater_cols)
    if goalie_columns:
        goalie_cols.update(_resolve_columns(goalie_columns, headers, source["id"]))

    delim = source.get("pos_delim", ",")
    rows = []
    teams_by_row = {}
    for raw in all_rows[first_data_row - 1:]:
        display = _cell(raw, skater_cols.get("name"))
        if display is None or not str(display).strip():
            continue
        display = str(display).strip()
        # Long HTML tables repeat their header every so often.
        if display.lower() in headers:
            continue

        positions = parse_positions(_cell(raw, skater_cols.get("pos")), delim)
        cols = goalie_cols if positions == ["G"] else skater_cols

        # Two different players can share a name. Most sources disambiguate in
        # the name itself ("Elias Pettersson (D)"); the ones that do not would
        # otherwise blend a defenceman's line into a centre's. A rule names the
        # collision and the position that tells them apart.
        for rule in source.get("disambiguate") or []:
            if display != rule["name"]:
                continue
            if rule["pos"] in positions:
                display = rule["as"]
                break

        # Summary rows sit in the data and carry real-looking numbers -- the
        # Hockey-Reference goalie table ends with a 'League Average' line. They
        # give themselves away by leaving an identity field blank, so a source
        # can name the fields every genuine player must have.
        if any(not str(_cell(raw, cols.get(field)) or "").strip()
               for field in required):
            continue

        stats = {}
        for key in stat_keys:
            if key not in cols:
                continue
            value = _number(_cell(raw, cols[key]), formats.get(key))
            if value is not None:
                stats[key] = value

        if per_game:
            games = stats.get("GP")
            if games is None:
                continue  # a rate with no games behind it is not a projection
            for key in list(stats):
                if key in counting:
                    stats[key] = stats[key] * games

        # Derived stats come last so they can overwrite a mapped column, and are
        # only recorded when at least one part is present.
        for key, rule in derived.items():
            parts = [_number(_cell(raw, col - 1)) for col in rule.get("sum") or []]
            present = [p for p in parts if p is not None]
            if present:
                stats[key] = sum(present)

        if not stats:
            continue  # a header artifact or a totals row, not a player

        teams_by_row[len(rows)] = str(_cell(raw, cols.get("team")) or "")
        rows.append(SourceRow(
            name=display,
            key=alias_table.resolve(display),
            team=teams_mod.normalize(_cell(raw, cols.get("team"))),
            pos=positions,
            age=_number(_cell(raw, cols.get("age"))),
            stats=stats,
        ))

    if source.get("dedupe_by") == "name":
        rows = _dedupe(rows, teams_by_row, source.get("prefer_team_suffix", "TM"))
    return rows


def read_source(source, spec, alias_table):
    """Read one source into a list of SourceRow.

    A source may declare a 'goalie_sheet' (a separate worksheet holding goalies,
    read through 'goalie_columns') or leave goalies on the main sheet, where
    'goalie_columns' remaps just the columns that differ.
    """
    goalie_sheet = source.get("goalie_sheet")
    rows = _read_sheet(
        source, spec, alias_table,
        sheet=source["sheet"],
        columns=source["columns"],
        # When goalies live elsewhere, the main sheet has no goalie columns
        # to remap -- passing them would misread skater rows.
        goalie_columns=None if goalie_sheet else source.get("goalie_columns"),
        header_row=source.get("header_row", 1),
        first_data_row=source.get("first_data_row", 2),
    )
    if goalie_sheet:
        rows += _read_sheet(
            source, spec, alias_table,
            sheet=goalie_sheet,
            columns=source.get("goalie_columns") or source["columns"],
            goalie_columns=None,
            header_row=source.get("goalie_header_row", source.get("header_row", 1)),
            first_data_row=source.get("goalie_first_data_row",
                                      source.get("first_data_row", 2)),
        )
    return rows


def _read_adp_sheet(source, alias_table, sheet, name_col, value_col,
                    header_row, first_data_row):
    rows = load_rows(source, sheet, 40)
    headers = _header_index(rows, header_row)
    cols = _resolve_columns({"name": name_col, "value": value_col},
                            headers, source["id"])
    out = {}
    for raw in rows[first_data_row - 1:]:
        display = _cell(raw, cols["name"])
        value = _number(_cell(raw, cols["value"]))
        if display and value is not None:
            out[alias_table.resolve(str(display).strip())] = value
    return out


def read_adp(source, alias_table):
    """Read a source's ADP table, if it declares one.

    Returns {provider: {key: adp}}. A source may publish several ADP columns --
    Dom's sheet carries Yahoo, Fantrax and their average -- so 'values' maps a
    provider id to a column. A bare 'value' is the older single-column form and
    is read as the 'average' provider.

    A source that splits skaters and goalies may declare 'sheets' (a list) so
    both are picked up; 'sheet' remains the single-sheet shorthand.
    """
    adp_spec = source.get("adp")
    if not adp_spec:
        return {}
    values = adp_spec.get("values")
    if not values:
        values = {"average": adp_spec["value"]}
    sheets = adp_spec.get("sheets") or [adp_spec["sheet"]]
    out = {}
    for provider in values:
        merged = {}
        for sheet in sheets:
            merged.update(_read_adp_sheet(
                source, alias_table, sheet,
                adp_spec["name"], values[provider],
                adp_spec.get("header_row", 1),
                adp_spec.get("first_data_row", 2),
            ))
        if merged:
            out[provider] = merged
    return out
