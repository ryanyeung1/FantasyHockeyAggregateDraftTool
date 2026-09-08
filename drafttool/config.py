"""Loading and validation for config/config.json and config/sources.json.

Both files are plain JSON so the browser can consume the same shapes the ETL
does without a parser dependency on either side.
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_DIR = os.path.join(ROOT, "config")
SOURCE_DIR = os.path.join(ROOT, "sources")
OUT_DIR = os.path.join(ROOT, "out")
BOARD_DIR = os.path.join(ROOT, "board")

POSITIONS = ["C", "LW", "RW", "D", "G"]


class ConfigError(Exception):
    pass


def _read_json(path):
    if not os.path.exists(path):
        raise ConfigError("missing config file: %s" % path)
    with open(path, "r", encoding="utf-8-sig") as handle:
        try:
            return json.load(handle)
        except ValueError as exc:
            raise ConfigError("%s is not valid JSON: %s" % (os.path.basename(path), exc))


def load_config(path=None):
    cfg = _read_json(path or os.path.join(CONFIG_DIR, "config.json"))
    for key in ("league", "scoring", "source_weights", "model"):
        if key not in cfg:
            raise ConfigError("config.json is missing the '%s' section" % key)
    slots = cfg["league"].get("slots") or {}
    if not cfg["league"].get("teams"):
        raise ConfigError("config.json: league.teams must be a positive number")
    if not sum(slots.values()):
        raise ConfigError("config.json: league.slots are all zero")
    return cfg


def load_sources(path=None):
    spec = _read_json(path or os.path.join(CONFIG_DIR, "sources.json"))
    if not spec.get("sources"):
        raise ConfigError("sources.json defines no sources")

    stats = spec["stats"]
    seen = set()
    for source in spec["sources"]:
        for field in ("id", "name", "file", "sheet", "columns"):
            if field not in source:
                raise ConfigError("source %r is missing '%s'" % (source.get("id", "?"), field))
        if source["id"] in seen:
            raise ConfigError("duplicate source id %r" % source["id"])
        seen.add(source["id"])
        if "name" not in source["columns"]:
            raise ConfigError("source %r must map a 'name' column" % source["id"])
        _check_columns(source, stats)

    # Last season's actuals: same column grammar, but kept out of 'sources' so
    # nothing can blend measured results into a projection.
    history = spec.get("history")
    if history:
        if not history.get("sheets"):
            raise ConfigError("sources.json: history defines no sheets")
        for sheet in history["sheets"]:
            for field in ("id", "file", "columns"):
                if field not in sheet:
                    raise ConfigError(
                        "history sheet %r is missing '%s'" % (sheet.get("id", "?"), field)
                    )
            if "name" not in sheet["columns"]:
                raise ConfigError("history sheet %r must map a 'name' column" % sheet["id"])
            _check_columns(sheet, stats)
            for key in sheet.get("derived", {}):
                if key not in stats:
                    raise ConfigError(
                        "history sheet %r derives unknown stat %r" % (sheet["id"], key)
                    )
    return spec


def _check_columns(source, stats):
    """Catch typo'd stat keys now rather than silently dropping the column."""
    for group in ("columns", "goalie_columns"):
        for key in source.get(group, {}):
            if key not in stats and key not in ("name", "team", "pos", "age"):
                raise ConfigError(
                    "source %r maps unknown stat %r (not in sources.json 'stats')"
                    % (source["id"], key)
                )


def source_path(source):
    return os.path.join(SOURCE_DIR, source["file"])
