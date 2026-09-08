"""Tests for the source readers and the merge, run against the real workbooks.

Spot values are transcribed from the spreadsheets themselves. Their job is to
catch a column mapping that has quietly shifted -- the failure mode that
produces a board full of plausible-looking but wrong numbers.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from drafttool import config as cfg_mod  # noqa: E402
from drafttool import export, sources  # noqa: E402
from drafttool.names import load_aliases  # noqa: E402
from drafttool.sources import parse_positions  # noqa: E402

HISTORY = cfg_mod.load_sources().get("history", {})


def _load():
    spec = cfg_mod.load_sources()
    cfg = cfg_mod.load_config()
    aliases = load_aliases(os.path.join(cfg_mod.CONFIG_DIR, "aliases.csv"))
    return spec, cfg, aliases


class TestParsePositions(unittest.TestCase):
    def test_yahoo_comma_form(self):
        self.assertEqual(parse_positions("C,LW", ","), ["C", "LW"])
        self.assertEqual(parse_positions("D", ","), ["D"])

    def test_apples_and_ginos_slash_form(self):
        self.assertEqual(parse_positions("C/LW/RW", "/"), ["C", "LW", "RW"])

    def test_either_delimiter_works_regardless_of_the_declared_one(self):
        # Sources are inconsistent; accepting both avoids a silent empty list.
        self.assertEqual(parse_positions("LW/RW", ","), ["LW", "RW"])

    def test_single_letter_wing_codes(self):
        self.assertEqual(parse_positions("L,R", ","), ["LW", "RW"])

    def test_strips_noise_and_deduplicates(self):
        self.assertEqual(parse_positions(" C , C ", ","), ["C"])
        self.assertEqual(parse_positions("C (1)", ","), ["C"])

    def test_blank_and_unknown(self):
        self.assertEqual(parse_positions(None), [])
        self.assertEqual(parse_positions("XX", ","), [])

    def test_generic_forward_and_wing_expand(self):
        # Hockey-Reference lists some players only as F or W. Dropping them
        # would leave a player with no position and no way to be valued.
        self.assertEqual(parse_positions("F", ","), ["C", "LW", "RW"])
        self.assertEqual(parse_positions("W", ","), ["LW", "RW"])


def _source(spec, source_id):
    """Look a source up by id. Index-based lookups broke the moment the shipped
    order changed, and the order is a deliberate setting now."""
    return [s for s in spec["sources"] if s["id"] == source_id][0]


DOM_FILE = os.path.join(cfg_mod.SOURCE_DIR, "2026-27-Fantasy-Projections-Yahoo-1.xlsx")


def _readable(path):
    """Present AND openable. Existing is not enough on Windows: a workbook open
    in Excel is locked, and the suite should skip rather than fail because
    someone happens to be looking at the file."""
    try:
        with open(path, "rb") as handle:
            handle.read(1)
        return True
    except (IOError, OSError):
        return False


HAS_DOM = _readable(DOM_FILE)

# Dom's workbook is a paid product. It is not built into the board and will not
# be present in a published checkout, so everything that reads it skips rather
# than failing.
DOM_SPEC = {
    "id": "DOM", "name": "Dom",
    "file": "2026-27-Fantasy-Projections-Yahoo-1.xlsx",
    "sheet": "Player Data", "header_row": 2, "first_data_row": 3,
    "per_game": True, "pos_delim": ",",
    "columns": {"name": 1, "team": 2, "age": 3, "pos": 4,
                "GP": 5, "ATOI": 6, "G": 7, "A": 8, "PTS": 9, "SOG": 10,
                "PPG": 11, "PPP": 12, "SHG": 13, "SHP": 14, "BLK": 15,
                "HIT": 16, "PM": 17, "PIM": 18, "GWG": 19, "FOW": 20, "FOL": 21},
    "goalie_columns": {"GP": 24, "W": 25, "L": 26, "OTL": 27, "SO": 28,
                       "SV": 29, "SV%": 30, "GA": 31, "GAA": 31},
    "adp": {"sheet": "ADP", "header_row": 1, "first_data_row": 2, "name": 1,
            "values": {"yahoo": 2, "fantrax": 3, "average": 4}},
}


class TestConfigValidation(unittest.TestCase):
    def test_shipped_config_is_valid(self):
        cfg = cfg_mod.load_config()
        self.assertEqual(cfg["league"]["teams"], 12)
        self.assertEqual(cfg["league"]["slots"]["D"], 4)

    def test_shipped_sources_are_valid(self):
        spec = cfg_mod.load_sources()
        # Most complete first: the leading source supplies display names.
        self.assertEqual([s["id"] for s in spec["sources"]],
                         ["DtZ", "DFO", "AGN", "AGB"])

    def test_no_paid_source_is_baked_into_the_build(self):
        """Dom's projections are a paid product and must not ship.

        The workbook may still sit in sources/ for local use through the UI
        importer; what matters is that build.py never reads it into the board.
        """
        spec = cfg_mod.load_sources()
        files = [s["file"] for s in spec["sources"]]
        self.assertNotIn("2026-27-Fantasy-Projections-Yahoo-1.xlsx", files)
        self.assertNotIn("2026-27-Fantasy-Projections-Fantrax-1.xlsx", files)

    def test_rejects_an_unknown_stat_key(self):
        spec = cfg_mod.load_sources()
        spec["sources"][0]["columns"]["NOT_A_STAT"] = 5
        # Re-validating the mutated spec must complain rather than drop the column.
        with self.assertRaises(cfg_mod.ConfigError):
            self._validate(spec)

    @staticmethod
    def _validate(spec):
        import json
        import tempfile
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                             encoding="utf-8")
        try:
            json.dump(spec, handle)
            handle.close()
            cfg_mod.load_sources(handle.name)
        finally:
            os.unlink(handle.name)


@unittest.skipUnless(HAS_DOM, "Dom's workbook is not present (it is paid, and "
                               "not part of the build)")
class TestDomWorkbook(unittest.TestCase):
    """Dom is imported through the UI, not baked in, but the reader still has
    to handle his per-game sheet -- so this pins that behaviour wherever the
    file happens to be available."""

    @classmethod
    def setUpClass(cls):
        spec, _, aliases = _load()
        cls.spec = spec
        cls.rows = sources.read_source(DOM_SPEC, spec, aliases)
        cls.by_key = dict((r.key, r) for r in cls.rows)

    def test_row_count(self):
        self.assertEqual(len(self.rows), 670)

    def test_it_reads_the_raw_sheet_not_the_adjusted_one(self):
        """Dom's 'The List' has his manual Boost/Bust baked into the numbers.

        'Player Data' is the same projection before that thumb goes on the
        scale. Weighting sources yourself only means something if you start
        from the projection, so the source must point at Player Data.
        """
        self.assertEqual(DOM_SPEC["sheet"], "Player Data")
        self.assertTrue(DOM_SPEC["per_game"])

    def test_the_raw_projection_is_what_gets_read(self):
        """Spot values from the unadjusted sheet.

        When this workbook carried a bust on Auston Matthews, 'The List' gave
        him 40.224 goals against the projection's own 42.342. Those hand
        adjustments come and go between exports; the raw numbers do not, so
        these are the ones pinned.
        """
        matthews = self.by_key["auston matthews"]
        self.assertAlmostEqual(matthews.stats["G"], 42.3416, places=3)
        self.assertAlmostEqual(matthews.stats["A"], 42.7940, places=3)
        self.assertAlmostEqual(matthews.stats["PTS"], 85.1356, places=3)
        self.assertAlmostEqual(matthews.stats["SOG"], 304.6748, places=3)

    def test_per_game_rates_are_scaled_back_to_season_totals(self):
        # 45.68 goals, not the 0.548 per game the sheet actually stores.
        mac = self.by_key["nathan mackinnon"]
        self.assertAlmostEqual(mac.stats["GP"], 83.2625, places=3)
        self.assertAlmostEqual(mac.stats["G"], 45.6800, places=3)

    def test_rate_stats_are_not_scaled(self):
        """A save percentage multiplied by games played would be nonsense.

        GA and GAA are read from the SAME column: scaled by GP it is the
        season total, unscaled it is already the per-game average.
        """
        vasy = self.by_key["andrei vasilevskiy"]
        self.assertAlmostEqual(vasy.stats["SV%"], 0.9117, places=4)
        self.assertAlmostEqual(vasy.stats["GA"], 142.2916, places=3)
        self.assertAlmostEqual(vasy.stats["GAA"], 2.5871, places=4)
        self.assertAlmostEqual(vasy.stats["GAA"],
                               vasy.stats["GA"] / vasy.stats["GP"], places=6)

    def test_the_two_sheets_agree_except_where_a_boost_was_applied(self):
        """The invariant that makes reading the raw sheet safe.

        Player Data x GP reproduces The List exactly, for every player on every
        stat, except where a manual Boost/Bust was set by hand. The expected
        set is read from the ADJ column rather than named here, because those
        adjustments are edited between exports.
        """
        spec, _, aliases = _load()
        listed = dict(DOM_SPEC)
        listed.pop("per_game", None)
        listed.update({
            "sheet": "The List", "header_row": 1, "first_data_row": 2,
            "columns": {"name": 2, "pos": 4, "team": 6, "age": 7,
                        "GP": 17, "ATOI": 18, "G": 19, "A": 20, "PTS": 21,
                        "SOG": 22, "PPG": 23, "PPP": 24, "SHG": 25, "SHP": 26,
                        "BLK": 27, "HIT": 28, "PM": 29, "PIM": 30, "GWG": 31,
                        "FOW": 32, "FOL": 33},
            "goalie_columns": {"GP": 36, "W": 37, "L": 38, "OTL": 39, "SO": 40,
                               "SV": 41, "GA": 42, "SV%": 43, "GAA": 44},
        })
        adjusted = dict((r.key, r.stats)
                        for r in sources.read_source(listed, spec, aliases))

        # Whoever currently carries a hand-set Boost/Bust.
        rows = sources.load_rows(listed, "The List", 60)
        expected = set()
        for raw in rows[1:]:
            who = sources._cell(raw, 1)
            flag = sources._cell(raw, 15)
            if not who or flag is None:
                continue
            text = str(flag).strip()
            if text and text != "0":
                expected.add(aliases.resolve(str(who).strip()))

        moved = set()
        for key, raw in self.by_key.items():
            for stat in set(list(raw.stats) + list(adjusted[key])):
                a = raw.stats.get(stat)
                b = adjusted[key].get(stat)
                if a is None or b is None:
                    if a != b:
                        moved.add(key)
                elif abs(a - b) > 1e-6:
                    moved.add(key)
        self.assertEqual(moved, expected)

    def test_skater_spot_values(self):
        mac = self.by_key["nathan mackinnon"]
        self.assertEqual(mac.team, "COL")
        self.assertEqual(mac.pos, ["C"])
        self.assertAlmostEqual(mac.stats["GP"], 83.2625, places=3)
        self.assertAlmostEqual(mac.stats["G"], 45.68001781563124, places=6)
        self.assertAlmostEqual(mac.stats["A"], 77.79931134642477, places=6)

    def test_goalie_uses_the_second_gp_column(self):
        # 'The List' carries two columns headed GP: skater in 17, goalie in 36.
        # Reading a goalie through the skater mapping yields a blank GP, which is
        # exactly the bug goalie_columns exists to prevent.
        vasy = self.by_key["andrei vasilevskiy"]
        self.assertEqual(vasy.pos, ["G"])
        self.assertAlmostEqual(vasy.stats["GP"], 55.0, places=6)
        self.assertAlmostEqual(vasy.stats["W"], 34.02185859390082, places=6)
        self.assertAlmostEqual(vasy.stats["SV"], 1469.1717368366005, places=6)

    def test_goalies_carry_no_skater_stats(self):
        vasy = self.by_key["andrei vasilevskiy"]
        for stat in ("G", "A", "HIT", "BLK"):
            self.assertNotIn(stat, vasy.stats)

    def test_team_codes_are_normalized(self):
        self.assertEqual(self.by_key["nikita kucherov"].team, "TBL")
        for row in self.rows:
            if row.team:
                self.assertNotIn(".", row.team, "%s has an un-normalized team" % row.name)

    def test_multi_position_eligibility(self):
        self.assertEqual(self.by_key["leon draisaitl"].pos, ["C", "LW"])

    def test_adp_table(self):
        _, _, aliases = _load()
        adp = sources.read_adp(DOM_SPEC, aliases)
        self.assertEqual(sorted(adp), ["average", "fantrax", "yahoo"])
        self.assertGreater(len(adp["average"]), 400)
        self.assertAlmostEqual(adp["average"]["nathan mackinnon"], 1.85, places=2)

    def test_the_two_platforms_are_read_as_separate_columns(self):
        """Yahoo and Fantrax are different boards, not two names for one.

        They disagree by 47.8 picks on average, so reading the average where
        the user asked for Yahoo would quietly misreport every row.
        """
        _, _, aliases = _load()
        adp = sources.read_adp(DOM_SPEC, aliases)
        self.assertAlmostEqual(adp["yahoo"]["nathan mackinnon"], 2.4, places=2)
        self.assertAlmostEqual(adp["fantrax"]["nathan mackinnon"], 1.3, places=2)
        # Yahoo's board is much shallower than Fantrax's; a settings menu that
        # did not say so would make the blanks look like a bug.
        self.assertEqual(len(adp["yahoo"]), 249)
        self.assertEqual(len(adp["fantrax"]), 426)


class TestApplesAndGinosSources(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec, _, aliases = _load()
        cls.nate = dict((r.key, r) for r in
                        sources.read_source(_source(spec, "AGN"), spec, aliases))
        cls.blake = dict((r.key, r) for r in
                         sources.read_source(_source(spec, "AGB"), spec, aliases))

    def test_row_counts(self):
        self.assertEqual(len(self.nate), 378)
        self.assertEqual(len(self.blake), 378)

    def test_the_two_sheets_are_genuinely_different_projections(self):
        # If a column mapping pointed both at the same sheet this would pass
        # silently everywhere else on the board.
        self.assertAlmostEqual(self.nate["nathan mackinnon"].stats["G"], 45.3, places=4)
        self.assertAlmostEqual(self.blake["nathan mackinnon"].stats["G"], 50.4, places=4)

    def test_spot_values(self):
        mac = self.nate["nathan mackinnon"]
        self.assertEqual(mac.team, "COL")
        self.assertAlmostEqual(mac.stats["GP"], 84.0, places=6)
        self.assertAlmostEqual(mac.stats["A"], 83.7, places=4)

    def test_unpublished_stats_are_absent_not_zero(self):
        # A&G publish no shorthanded points and no goalie stats. Storing zeros
        # would drag the blended average down instead of dropping out of it.
        mac = self.nate["nathan mackinnon"]
        for stat in ("SHP", "SHG", "W", "SV", "GA"):
            self.assertNotIn(stat, mac.stats)

    def test_slash_positions_are_parsed(self):
        self.assertEqual(self.nate["leon draisaitl"].pos, ["C", "LW"])

    def test_team_codes_agree_with_yahoo(self):
        self.assertEqual(self.nate["nikita kucherov"].team, "TBL")


class TestDatsyukToZetterbergSource(unittest.TestCase):
    """DtZ splits skaters and goalies across two sheets with different layouts.

    Nothing else in the project does that, so the goalie_sheet path is only
    exercised here.
    """

    @classmethod
    def setUpClass(cls):
        spec, _, aliases = _load()
        cls.spec = spec
        cls.source = [s for s in spec["sources"] if s["id"] == "DtZ"][0]
        cls.rows = sources.read_source(cls.source, spec, aliases)
        cls.by_key = dict((r.key, r) for r in cls.rows)
        cls.skaters = [r for r in cls.rows if r.pos != ["G"]]
        cls.goalies = [r for r in cls.rows if r.pos == ["G"]]

    def test_both_sheets_are_read(self):
        self.assertEqual(len(self.skaters), 721)
        self.assertEqual(len(self.goalies), 74)
        self.assertEqual(len(self.rows), 795)

    def test_skater_spot_values(self):
        mac = self.by_key["nathan mackinnon"]
        self.assertEqual(mac.team, "COL")
        self.assertEqual(mac.pos, ["C"])
        self.assertAlmostEqual(mac.stats["GP"], 80.0, places=6)
        self.assertAlmostEqual(mac.stats["G"], 43.0, places=6)
        self.assertAlmostEqual(mac.stats["A"], 74.0, places=6)
        self.assertAlmostEqual(mac.stats["SOG"], 313.0, places=6)

    def test_goalie_spot_values_come_from_the_goalie_sheet(self):
        # Reading a goalie through the skater mapping would put a team name in
        # a stat column and a shot total in games played.
        vasy = self.by_key["andrei vasilevskiy"]
        self.assertEqual(vasy.team, "TBL")
        self.assertEqual(vasy.pos, ["G"])
        self.assertAlmostEqual(vasy.stats["GP"], 56.0, places=6)
        self.assertAlmostEqual(vasy.stats["W"], 34.552, places=3)
        self.assertAlmostEqual(vasy.stats["SV"], 1382.64, places=2)
        self.assertAlmostEqual(vasy.stats["SA"], 1521.52, places=2)

    def test_goalies_carry_no_skater_stats(self):
        vasy = self.by_key["andrei vasilevskiy"]
        for stat in ("G", "A", "HIT", "BLK", "SOG"):
            self.assertNotIn(stat, vasy.stats)

    def test_skaters_carry_no_goalie_stats(self):
        mac = self.by_key["nathan mackinnon"]
        for stat in ("W", "L", "SV", "GA", "SV%"):
            self.assertNotIn(stat, mac.stats)

    def test_positions_tolerate_spaces_after_the_comma(self):
        # The sheet mixes "C,LW" and "C, LW" in the same column.
        self.assertEqual(self.by_key["leon draisaitl"].pos, ["C", "LW"])

    def test_adp_is_read_from_both_sheets(self):
        _, _, aliases = _load()
        adp = sources.read_adp(self.source, aliases)
        # DtZ publishes one unlabelled ADP column and it tracks Fantrax.
        self.assertEqual(sorted(adp), ["fantrax"])
        self.assertAlmostEqual(adp["fantrax"]["nathan mackinnon"], 1.3, places=2)
        self.assertAlmostEqual(adp["fantrax"]["andrei vasilevskiy"], 83.6, places=2)


class TestGoalieSheetFallback(unittest.TestCase):
    """A source without goalie_sheet must keep reading goalies inline."""

    def test_daily_faceoff_still_uses_the_second_column_mapping(self):
        spec, _, aliases = _load()
        dfo = _source(spec, "DFO")
        self.assertNotIn("goalie_sheet", dfo)
        rows = sources.read_source(dfo, spec, aliases)
        vasy = [r for r in rows if r.key == "andrei vasilevskiy"][0]
        # Goalies leave GP blank here and record games in GS, the second mapping.
        self.assertAlmostEqual(vasy.stats["GP"], 59.0, places=6)


class TestMerge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec, cfg, aliases = _load()
        cls.spec, cls.cfg = spec, cfg
        cls.players, cls.rows_by_source, cls.stat_keys, _ = export.merge(spec, aliases, cfg)
        cls.by_name = dict((p["name"], p) for p in cls.players)

    def test_merged_count(self):
        # DtZ's 795 plus the players only the other three sources carry.
        self.assertEqual(len(self.players), 806)

    def test_a_player_in_every_source_keeps_every_line(self):
        mac = self.by_name["Nathan MacKinnon"]
        self.assertEqual(sorted(mac["src"]), ["AGB", "AGN", "DFO", "DtZ"])

    def test_identity_comes_from_the_first_source_that_has_it(self):
        mac = self.by_name["Nathan MacKinnon"]
        self.assertEqual(mac["team"], "COL")
        self.assertEqual(mac["pos"], ["C"])

    def test_a_player_only_apples_and_ginos_have_still_lands(self):
        # Nate leaves him out, so identity and stats come from the others.
        kuz = self.by_name["Andrei Kuzmenko"]
        self.assertNotIn("AGN", kuz["src"])
        self.assertIn("AGB", kuz["src"])
        self.assertTrue(kuz["pos"])

    def test_every_player_has_a_position(self):
        for player in self.players:
            self.assertTrue(player["pos"], "%s has no position" % player["name"])

    def test_aliases_actually_merged_rather_than_duplicating(self):
        # 'Tommy Novak' (A&G) and 'Thomas Novak' (Yahoo) must be one player.
        novaks = [p for p in self.players if p["name"].endswith("Novak")]
        self.assertEqual(len(novaks), 1)
        self.assertEqual(sorted(novaks[0]["src"]), ["AGB", "AGN", "DFO", "DtZ"])

    def test_same_named_players_are_not_merged(self):
        # Two different real players; only the forward appears outside Yahoo.
        petterssons = dict((p["name"], p) for p in self.players
                           if p["name"].startswith("Elias Pettersson"))
        self.assertEqual(sorted(petterssons),
                         ["Elias Pettersson", "Elias Pettersson (D)"])
        self.assertEqual(petterssons["Elias Pettersson"]["pos"], ["C"])
        self.assertEqual(petterssons["Elias Pettersson (D)"]["pos"], ["D"])
        self.assertEqual(sorted(petterssons["Elias Pettersson (D)"]["src"]), ["DFO"])

    def test_a_bare_name_aliases_onto_its_suffixed_form(self):
        # DtZ writes "Daniil Tarasov"; Yahoo writes "Daniil Tarasov (G)".
        tarasovs = [p for p in self.players if "Tarasov" in p["name"]]
        self.assertEqual(len(tarasovs), 1)
        self.assertEqual(sorted(tarasovs[0]["src"]), ["DFO", "DtZ"])

    def test_unmatched_report_suggestions_are_all_different_players(self):
        """Every remaining suggestion must be distinguishable at a glance.

        The suggester matches on surname, so brothers and namesakes still show
        up -- that is why the report carries team and position. What must not
        survive is a candidate matching on BOTH, which would mean a real alias
        is missing from config/aliases.csv.
        """
        report = export.unmatched_report(self.spec, self.rows_by_source, self.players)
        for row in report:
            if not row["closest_in_DtZ"]:
                continue
            self.assertFalse(
                row["team"] == row["closest_team"] and row["pos"] == row["closest_pos"],
                "%s (%s %s) looks like the same player as %s (%s %s) -- add an alias"
                % (row["name"], row["team"], row["pos"], row["closest_in_DtZ"],
                   row["closest_team"], row["closest_pos"]))

    def test_unmatched_report_carries_the_columns_needed_to_triage(self):
        report = export.unmatched_report(self.spec, self.rows_by_source, self.players)
        self.assertTrue(report)
        for key in ("source", "name", "team", "pos", "closest_in_DtZ",
                    "closest_team", "closest_pos"):
            self.assertIn(key, report[0])


class TestDailyFaceoffSource(unittest.TestCase):
    """A plain CSV export, and the only source read through the csv path.

    It also carries the awkward shapes the UI importer was built for, so the
    build reading it correctly is a second check on the same file.
    """

    @classmethod
    def setUpClass(cls):
        spec, _, aliases = _load()
        cls.spec = spec
        cls.source = [s for s in spec["sources"] if s["id"] == "DFO"][0]
        cls.rows = sources.read_source(cls.source, spec, aliases)
        cls.by_key = dict((r.key, r) for r in cls.rows)

    def test_row_count(self):
        self.assertEqual(len(self.rows), 643)

    def test_the_byte_order_mark_does_not_break_the_first_column(self):
        # The file opens with a BOM; utf-8-sig drops it.
        self.assertIn("nathan mackinnon", self.by_key)

    def test_skater_spot_values(self):
        mac = self.by_key["nathan mackinnon"]
        self.assertAlmostEqual(mac.stats["G"], 45.6, places=4)
        self.assertAlmostEqual(mac.stats["A"], 80.9, places=4)
        self.assertAlmostEqual(mac.stats["SOG"], 335.0, places=4)

    def test_the_points_column_is_the_one_that_is_goals_plus_assists(self):
        """Two columns are headed PTS and only one is hockey points.

        Column 6 holds fantasy points under the site's own scoring (1047.5 for
        MacKinnon) and column 8 holds goals + assists (126). Addressing them by
        index is what keeps the wrong one out.
        """
        mac = self.by_key["nathan mackinnon"]
        self.assertAlmostEqual(mac.stats["PTS"], 126.0, places=4)
        # The site rounds points, so 45.6 + 80.9 = 126.5 shows as 126. Close
        # enough to identify the column, and nowhere near the 1047.5 alternative.
        self.assertLess(abs(mac.stats["G"] + mac.stats["A"] - mac.stats["PTS"]), 1.0)

    def test_team_nicknames_resolve_to_codes(self):
        self.assertEqual(self.by_key["nathan mackinnon"].team, "COL")
        self.assertEqual(self.by_key["andrei vasilevskiy"].team, "TBL")

    def test_goalie_games_come_from_games_started(self):
        # Goalies leave GP blank in this file and record games in GS.
        vasy = self.by_key["andrei vasilevskiy"]
        self.assertEqual(vasy.pos, ["G"])
        self.assertAlmostEqual(vasy.stats["GP"], 59.0, places=4)
        self.assertAlmostEqual(vasy.stats["W"], 33.0, places=4)
        self.assertAlmostEqual(vasy.stats["OTL"], 6.0, places=4, msg="T/O")
        self.assertAlmostEqual(vasy.stats["SV%"], 0.902, places=4)

    def test_em_dashes_are_absent_not_zero(self):
        # 7,274 cells hold an em dash. A zero there would drag the blend down.
        vasy = self.by_key["andrei vasilevskiy"]
        for stat in ("G", "A", "SOG", "HIT", "BLK"):
            self.assertNotIn(stat, vasy.stats)

    def test_apostrophe_escaped_numbers_parse(self):
        # The plus/minus column is headed '+/- and Excel escapes such values.
        self.assertAlmostEqual(self.by_key["nathan mackinnon"].stats["PM"],
                               11.6, places=4)

    def test_adp_is_read(self):
        _, _, aliases = _load()
        adp = sources.read_adp(self.source, aliases)
        # Daily Faceoff's single ADP column tracks Yahoo.
        self.assertEqual(sorted(adp), ["yahoo"])
        self.assertAlmostEqual(adp["yahoo"]["nathan mackinnon"], 2.4, places=2)


class TestHistorySource(unittest.TestCase):
    """Last season's actuals, which arrive in a different file format entirely.

    The two exports are HTML tables saved with a .xls extension -- openpyxl
    cannot open them at all -- and they carry three shapes nothing else in the
    project has: a two-row header, repeated rows for traded players, and power
    play points split across separate goal and assist columns.
    """

    @classmethod
    def setUpClass(cls):
        spec, _, aliases = _load()
        cls.spec = spec
        cls.sheets = dict((s["id"], s) for s in spec["history"]["sheets"])
        cls.skaters = sources.read_source(cls.sheets["HIST-SK"], spec, aliases)
        cls.goalies = sources.read_source(cls.sheets["HIST-G"], spec, aliases)
        cls.by_key = dict((r.key, r) for r in cls.skaters + cls.goalies)

    def test_row_counts_after_deduping(self):
        # 499 skater rows collapse to 435 players, 102 goalie rows to 98.
        self.assertEqual(len(self.skaters), 435)
        self.assertEqual(len(self.goalies), 98)

    def test_traded_players_use_the_aggregate_row(self):
        """A traded player keeps the 2TM totals, not one team's share.

        Alexandre Texier played 8 games for STL and 43 for MTL; the 2TM row
        holds the combined 51. Picking either team row would understate him.
        """
        texier = self.by_key["alex texier"]
        self.assertEqual(texier.team, "2TM")
        self.assertAlmostEqual(texier.stats["GP"], 51.0, places=6)

    def test_no_player_appears_twice(self):
        keys = [r.key for r in self.skaters] + [r.key for r in self.goalies]
        self.assertEqual(len(keys), len(set(keys)))

    def test_utf8_names_survive_parsing(self):
        """lxml guesses latin-1 without an explicit encoding and mangles these.

        The failure is silent and costly: a mojibake name simply fails to join,
        and the player quietly shows no last-season rank.
        """
        names = set(r.name for r in self.skaters)
        for name in (u"An\u017ee Kopitar", u"Alexis Lafreni\u00e8re",
                     u"David Pastr\u0148\u00e1k"):
            self.assertIn(name, names)

    def test_power_play_points_are_derived_from_goals_plus_assists(self):
        # The sheet has PP goals (13) and PP assists (17) but no PPP column.
        mcdavid = self.by_key["connor mcdavid"]
        self.assertAlmostEqual(mcdavid.stats["PPP"], 54.0, places=6)
        self.assertAlmostEqual(mcdavid.stats["SHP"], 2.0, places=6)

    def test_time_on_ice_is_parsed_from_mmss(self):
        mcdavid = self.by_key["connor mcdavid"]
        self.assertAlmostEqual(mcdavid.stats["ATOI"], 22 + 59 / 60.0, places=6)

    def test_skater_spot_values(self):
        mcdavid = self.by_key["connor mcdavid"]
        self.assertEqual(mcdavid.team, "EDM")
        self.assertAlmostEqual(mcdavid.stats["G"], 48.0, places=6)
        self.assertAlmostEqual(mcdavid.stats["A"], 90.0, places=6)
        self.assertAlmostEqual(mcdavid.stats["SOG"], 306.0, places=6)

    def test_goalie_spot_values(self):
        vejmelka = self.by_key["karel vejmelka"]
        self.assertEqual(vejmelka.pos, ["G"])
        self.assertAlmostEqual(vejmelka.stats["W"], 38.0, places=6)
        self.assertAlmostEqual(vejmelka.stats["SA"], 1625.0, places=6)
        self.assertAlmostEqual(vejmelka.stats["SV"], 1456.0, places=6)
        self.assertAlmostEqual(vejmelka.stats["OTL"], 3.0, places=6)

    def test_summary_rows_are_excluded(self):
        # The goalie table ends with a 'League Average' line carrying real
        # numbers; only its blank team column gives it away.
        self.assertNotIn("league average", self.by_key)

    def test_every_row_has_a_team_and_a_position(self):
        for row in self.skaters + self.goalies:
            self.assertTrue(row.team, "%s has no team" % row.name)
            self.assertTrue(row.pos, "%s has no position" % row.name)


class TestHistoryJoin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec, cfg, aliases = _load()
        cls.spec, cls.cfg = spec, cfg
        cls.players, _, cls.stat_keys, _ = export.merge(spec, aliases, cfg)
        cls.history, cls.matches = export.read_history(spec, aliases, cls.players)
        cls.payload = export.build_payload(spec, cfg, cls.players, cls.stat_keys,
                                           cls.history, cls.matches)

    def test_history_covers_both_sheets(self):
        self.assertEqual(len(self.history), 533)

    def test_most_of_the_board_joins(self):
        self.assertEqual(len(self.matches), 503)

    def test_matched_players_use_the_board_position(self):
        """Last season is valued by the eligibility your league actually uses.

        Hockey-Reference lists Celebrini as a generic 'F'; the board has him at
        C. Valuing him as a forward-anywhere would put him in the wrong
        replacement pool and make the two ranks incomparable.
        """
        index = [i for i, p in enumerate(self.players)
                 if p["name"] == "Macklin Celebrini"][0]
        self.assertIn(index, self.matches)
        entry = self.history[self.matches[index]]
        self.assertEqual(entry["pos"], self.players[index]["pos"])

    def test_history_only_players_keep_their_own_position(self):
        # Kopitar retired, so he is not on the board but still belongs in last
        # season's replacement pool.
        kopitar = [h for h in self.history if "Kopitar" in h["name"]]
        self.assertEqual(len(kopitar), 1)
        self.assertTrue(kopitar[0]["pos"])

    def test_payload_carries_the_index_not_the_name(self):
        """The browser follows an integer, never a name.

        Doing the join here is what lets the history ranking recompute live as
        scoring changes without a second name-matching implementation in JS.
        """
        block = self.payload["history"]
        self.assertEqual(block["season"], "2025-26")
        self.assertEqual(len(block["players"]), 533)
        with_index = [p for p in self.payload["players"] if "h" in p]
        self.assertEqual(len(with_index), 503)
        mac = [p for p in self.payload["players"] if p["n"] == "Nathan MacKinnon"][0]
        self.assertEqual(block["players"][mac["h"]]["n"], "Nathan MacKinnon")

    def test_history_stat_arrays_match_the_stat_list(self):
        width = len(self.payload["stats"])
        for entry in self.payload["history"]["players"]:
            self.assertEqual(len(entry["s"][export.HISTORY_SOURCE_ID]), width)

    def test_history_never_reaches_the_projection_blend(self):
        # The single most important property here: actuals must not be blended
        # into a projection. No board player may carry the history source.
        for player in self.payload["players"]:
            self.assertNotIn(export.HISTORY_SOURCE_ID, player["s"])
        source_ids = [s["id"] for s in self.payload["sources"]]
        self.assertNotIn(export.HISTORY_SOURCE_ID, source_ids)

    def test_a_player_who_missed_the_season_has_no_row(self):
        # Barkov missed 2025-26 entirely, so he is absent from the export.
        barkov = [i for i, p in enumerate(self.players)
                  if p["name"] == "Aleksander Barkov"]
        if barkov:
            self.assertNotIn(barkov[0], self.matches)


class TestPayload(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec, cfg, aliases = _load()
        players, _, stat_keys, _ = export.merge(spec, aliases, cfg)
        cls.payload = export.build_payload(spec, cfg, players, stat_keys)

    def test_stat_arrays_line_up_with_the_stat_list(self):
        width = len(self.payload["stats"])
        for player in self.payload["players"]:
            for sid, line in player["s"].items():
                self.assertEqual(len(line), width,
                                 "%s/%s has a ragged stat array" % (player["n"], sid))

    def test_coverage_reports_which_source_has_goalies(self):
        coverage = dict((s["id"], s) for s in self.payload["sources"])
        self.assertTrue(coverage["DtZ"]["has_goalies"])
        self.assertTrue(coverage["DFO"]["has_goalies"])
        self.assertFalse(coverage["AGN"]["has_goalies"])
        self.assertFalse(coverage["AGB"]["has_goalies"])

    def test_two_goalie_sources_means_goalie_weights_do_something(self):
        # While only one source projected goalies the weight sliders were inert
        # for them, and the board said so. That notice should now be gone.
        with_goalies = [s["id"] for s in self.payload["sources"] if s["has_goalies"]]
        self.assertGreater(len(with_goalies), 1)

    def test_config_travels_with_the_payload(self):
        self.assertEqual(self.payload["config"]["league"]["teams"], 12)
        self.assertIn("G", self.payload["config"]["scoring"])

    def test_adp_is_attached(self):
        mac = [p for p in self.payload["players"] if p["n"] == "Nathan MacKinnon"][0]
        self.assertAlmostEqual(mac["adp"]["average"], 1.9, places=1)
        self.assertAlmostEqual(mac["adp"]["yahoo"], 2.4, places=1)
        self.assertAlmostEqual(mac["adp"]["fantrax"], 1.3, places=1)

    def test_providers_are_declared_with_their_coverage(self):
        got = dict((p["id"], p["players"]) for p in self.payload["adp_providers"])
        self.assertEqual(sorted(got), ["average", "fantrax", "yahoo"])
        # One free source per platform now that Dom's ADP sheet is gone.
        self.assertEqual(got["yahoo"], 254)      # Daily Faceoff
        self.assertEqual(got["fantrax"], 429)    # DtZ
        # The average is computed, not read, so it covers the union of the two.
        self.assertEqual(got["average"], 434)

    def test_the_average_is_the_mean_of_the_platforms_that_rank_a_player(self):
        """The rule Dom's own AVG column followed, reproduced from free data.

        Verified against all 670 of his rows with no exceptions: the mean of
        whichever columns exist, so a player only one platform ranks still
        gets an average rather than a blank.
        """
        mac = [p for p in self.payload["players"]
               if p["k"] == "nathan mackinnon"][0]
        self.assertAlmostEqual(mac["adp"]["yahoo"], 2.4, places=1)
        self.assertAlmostEqual(mac["adp"]["fantrax"], 1.3, places=1)
        self.assertAlmostEqual(mac["adp"]["average"], 1.9, places=1)

        both = only_one = 0
        for player in self.payload["players"]:
            adp = player.get("adp") or {}
            if "average" not in adp:
                continue
            parts = [adp[k] for k in ("yahoo", "fantrax") if k in adp]
            self.assertTrue(parts, player["n"])
            # The payload stores ADP to one decimal, and the average is taken
            # before that rounding, so re-deriving it from the rounded parts
            # can be out by half a step.
            self.assertAlmostEqual(adp["average"], sum(parts) / float(len(parts)),
                                   delta=0.051, msg=player["n"])
            if len(parts) == 2:
                both += 1
            else:
                only_one += 1
        self.assertGreater(both, 200)
        self.assertGreater(only_one, 0)


if __name__ == "__main__":
    unittest.main()
