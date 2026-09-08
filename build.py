#!/usr/bin/env python
"""Build the fantasy hockey draft board.

    python build.py             # build out/draft_board.html + rankings.csv
    python build.py --verify    # also print the top 25 and compare to the
                                # reference spreadsheet's published values

Reads every workbook listed in config/sources.json, joins them on normalized
player names, and inlines the result into a single self-contained HTML file that
opens by double-click -- no server, no network, works on draft day offline.
"""

from __future__ import print_function

import argparse
import datetime
import io
import json
import os
import subprocess
import sys

from drafttool import config as cfg_mod
from drafttool import ages as ages_mod
from drafttool import eligibility as eligibility_mod
from drafttool import export
from drafttool import schedule as schedule_mod
from drafttool.names import load_aliases

BOARD_FILES = ("template.html", "style.css", "valuation.js", "importer.js", "app.js")


def _read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _node():
    """Locate node, or return None so the build degrades instead of failing.

    The CSV and --verify output are conveniences; the board itself needs no
    Node at all and can export its own CSV from the browser.
    """
    for candidate in ("node", "node.exe"):
        try:
            subprocess.check_output([candidate, "--version"], stderr=subprocess.STDOUT)
            return candidate
        except (OSError, subprocess.CalledProcessError):
            continue
    return None


def render_board(payload, out_path):
    """Inline data, styles and scripts into one standalone HTML file."""
    template = _read(os.path.join(cfg_mod.BOARD_DIR, "template.html"))
    css = _read(os.path.join(cfg_mod.BOARD_DIR, "style.css"))
    valuation = _read(os.path.join(cfg_mod.BOARD_DIR, "valuation.js"))
    app = _read(os.path.join(cfg_mod.BOARD_DIR, "app.js"))
    importer = _read(os.path.join(cfg_mod.BOARD_DIR, "importer.js"))

    # A literal '</script' anywhere in inlined content would close the tag early
    # and silently truncate the board. Fail loudly rather than ship that.
    for name, blob in (("valuation.js", valuation), ("app.js", app),
                       ("importer.js", importer), ("style.css", css)):
        if "</script" in blob.lower():
            raise SystemExit("%s contains a literal '</script' and cannot be inlined" % name)

    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    data = data.replace("</", "<\\/")  # safe inside a JSON string literal

    html = template
    for token, value in (("__SEASON__", payload["meta"]["season"]),
                         ("__CSS__", css),
                         ("__DATA__", data),
                         ("__VALUATION__", valuation),
                         ("__IMPORTER__", importer),
                         ("__APP__", app)):
        html = html.replace(token, value)

    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(html)
    return len(html)


def verify(node, data_path, source_count):
    """Print the top 25 next to the reference sheet's published numbers.

    The reference blends ten sources where this build has its own set, so the
    values will not match and are not supposed to. What matters is that the same
    names are near the top in roughly the same order -- a big rank divergence
    means a parsing or scoring bug, not a difference of opinion.
    """
    print("\n" + "=" * 84)
    print("TOP 25")
    print("=" * 84)
    top = subprocess.check_output([node, os.path.join(cfg_mod.BOARD_DIR, "rank_cli.js"),
                                   data_path, "top", "25"])
    print(top.decode("utf-8"))

    ref_path = os.path.join(cfg_mod.ROOT, "tests", "reference_top.json")
    if not os.path.exists(ref_path):
        return
    with open(ref_path, "r", encoding="utf-8") as handle:
        reference = json.load(handle)

    ours = json.loads(subprocess.check_output(
        [node, os.path.join(cfg_mod.BOARD_DIR, "rank_cli.js"), data_path, "json"]
    ).decode("utf-8"))
    rank_by_name = dict((row["name"], row["rank"]) for row in ours)
    fp_by_name = dict((row["name"], row["fp"]) for row in ours)

    print("=" * 84)
    print("CROSS-CHECK vs %s" % reference.get("_source", "reference sheet"))
    print("=" * 84)
    print("%-24s %10s %10s %8s %8s %7s" %
          ("Player", "ref FanPts", "our FanPts", "ref rk", "our rk", "delta"))
    print("-" * 84)

    deltas = []
    for entry in reference["players"]:
        name = entry["name"]
        our_rank = rank_by_name.get(name)
        our_fp = fp_by_name.get(name)
        if our_rank is None:
            print("%-24s %10.1f %10s %8d %8s %7s"
                  % (name, entry["fp"], "MISSING", entry["rank"], "-", "-"))
            continue
        delta = our_rank - entry["rank"]
        deltas.append(abs(delta))
        print("%-24s %10.1f %10.1f %8d %8d %+7d"
              % (name, entry["fp"], our_fp, entry["rank"], our_rank, delta))

    if deltas:
        print("-" * 84)
        print("mean |rank delta| %.1f   max %d   (%d source(s) vs the reference's ten)"
              % (sum(deltas) / float(len(deltas)), max(deltas), source_count))


HEADERS = """/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: geolocation=(), microphone=(), camera=()
  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'
"""


def write_deploy_headers(out_dir):
    """Response headers for a static host that reads a _headers file.

    Cloudflare Pages and Netlify both use this format. Upload it alongside the
    page; a host that does not understand it just ignores the file.

    The board is one inline script and one inline style, so a policy cannot
    use nonces without rewriting the build -- unsafe-inline has to stay, and
    the CSP is therefore NOT a defence against injected markup. What it does
    buy is the exfiltration path: connect-src none leaves script that somehow
    ran with nowhere to send anything, and img-src closes the other common
    beacon. The rest costs nothing.
    """
    path = os.path.join(out_dir, "_headers")
    with io.open(path, "w", encoding="utf-8", newline=chr(10)) as handle:
        handle.write(HEADERS)
    return path


def main():
    parser = argparse.ArgumentParser(description="Build the draft board.")
    parser.add_argument("--verify", action="store_true",
                        help="print the top 25 and compare to the reference sheet")
    parser.add_argument("--out", default=cfg_mod.OUT_DIR, help="output directory")
    args = parser.parse_args()

    if not os.path.isdir(args.out):
        os.makedirs(args.out)

    config = cfg_mod.load_config()
    spec = cfg_mod.load_sources()
    aliases = load_aliases(os.path.join(cfg_mod.CONFIG_DIR, "aliases.csv"))

    for source in spec["sources"]:
        path = cfg_mod.source_path(source)
        if not os.path.exists(path):
            raise SystemExit("missing source workbook: %s" % path)

    print("Reading %d source(s)..." % len(spec["sources"]))
    age_table = ages_mod.load(cfg_mod.CONFIG_DIR, alias_table=aliases)
    players, rows_by_source, stat_keys, rejected_ages = export.merge(
        spec, aliases, config, age_table=age_table)
    history, matches = export.read_history(spec, aliases, players)
    eligibility = eligibility_mod.load(
        cfg_mod.CONFIG_DIR, spec.get("eligibility_providers"), aliases)
    team_schedule = schedule_mod.load(spec.get("schedule"))
    payload = export.build_payload(spec, config, players, stat_keys, history, matches,
                                   aliases.pairs(), eligibility=eligibility,
                                   schedule=team_schedule)
    payload["meta"]["generated"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    for source in payload["sources"]:
        print("  %-24s %4d players  %2d stats  %s"
              % (source["name"], source["players"], len(source["stats"]),
                 "skaters + goalies" if source["has_goalies"] else "skaters only"))
    print("  %-24s %4d players" % ("MERGED", len(players)))
    if team_schedule:
        print("  %-24s %4d teams    off-nights + %d playoff window(s)"
              % ("schedule", team_schedule["count"], len(team_schedule["windows"])))
    if rejected_ages:
        # A workbook typo -- Claude Giroux listed as 19 -- would put a veteran
        # in the pre-prime band, so the source's age is kept and said so.
        print("  %-24s %4d age(s) rejected as implausible, source age kept:"
              % ("", len(rejected_ages)))
        for key, kept, dropped in rejected_ages[:6]:
            print("       %-26s kept %s, ignored %s" % (key, kept, dropped))

    if history:
        label = spec["history"].get("season", "last season")
        print("  %-24s %4d players  %d matched to the board, %d with no row"
              % (label + " actuals", len(history), len(matches),
                 len(players) - len(matches)))

    # Keep the raw payload on disk: it is what rank_cli.js reads, and it is the
    # thing to look at first when a number on the board looks wrong.
    data_path = os.path.join(args.out, "board_data.json")
    export.write_json(data_path, payload)

    unmatched = export.unmatched_report(spec, rows_by_source, players)
    primary = spec["sources"][0]["id"]
    name_col = "closest_in_%s" % primary
    export.write_csv(os.path.join(args.out, "unmatched.csv"), unmatched,
                     ["source", "name", "team", "pos", name_col,
                      "closest_team", "closest_pos"])
    if unmatched:
        suggested = [u for u in unmatched if u[name_col]]
        print("\n%d name(s) did not join to %s (see out/unmatched.csv)"
              % (len(unmatched), primary))
        if suggested:
            # Same surname is only a candidate, never a confirmation -- brothers
            # and namesakes look identical here until you check team and spot.
            print("  %d share a surname with a %s player. Same team and position "
                  "means the same player;" % (len(suggested), primary))
            print("  add those to config/aliases.csv. Check each one:")
            for row in suggested[:12]:
                print("     %-26s %-4s %-9s  ~  %-26s %-4s %s"
                      % (row["name"], row["team"], row["pos"],
                         row[name_col], row["closest_team"], row["closest_pos"]))

    board_path = os.path.join(args.out, "draft_board.html")
    size = render_board(payload, board_path)
    print("\nBuilt %s  (%.1f MB)" % (board_path, size / 1024.0 / 1024.0))
    write_deploy_headers(args.out)

    node = _node()
    if node:
        csv_path = os.path.join(args.out, "rankings.csv")
        with open(csv_path, "wb") as handle:
            handle.write(subprocess.check_output(
                [node, os.path.join(cfg_mod.BOARD_DIR, "rank_cli.js"), data_path, "csv"]
            ))
        print("Wrote  %s" % csv_path)
        if args.verify:
            verify(node, data_path, len(spec["sources"]))
    else:
        print("Node not found -- skipped rankings.csv "
              "(the board's own 'Export rankings CSV' button still works).")
        if args.verify:
            print("--verify needs Node as well.")

    print("\nOpen out/draft_board.html in a browser.")


if __name__ == "__main__":
    sys.exit(main())
