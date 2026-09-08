# -*- coding: utf-8 -*-
"""Team schedule strength: off-nights and the fantasy playoff weeks."""

from __future__ import unicode_literals

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from drafttool import config as cfg_mod, export, schedule
from drafttool.names import load_aliases


class TestPercentile(unittest.TestCase):
    def test_it_interpolates_like_a_quantile(self):
        self.assertEqual(schedule._percentile([1, 2, 3, 4, 5], 50), 3)
        self.assertEqual(schedule._percentile([1, 2, 3, 4], 50), 2.5)
        self.assertEqual(schedule._percentile([5], 75), 5)
        self.assertIsNone(schedule._percentile([], 50))


class TestTiers(unittest.TestCase):
    def test_a_value_on_the_threshold_counts_as_favourable(self):
        # The cuts land on real values with ties behind them, so ">=" and "<="
        # keep tied teams in the same band.
        self.assertEqual(schedule._tier(36, 36, 29), 1)
        self.assertEqual(schedule._tier(29, 36, 29), -1)
        self.assertEqual(schedule._tier(32, 36, 29), 0)

    def test_a_missing_value_is_middling_not_bad(self):
        self.assertEqual(schedule._tier(None, 36, 29), 0)


class TestMissingFile(unittest.TestCase):
    def test_no_schedule_block_yields_nothing(self):
        self.assertIsNone(schedule.load(None))

    def test_an_absent_workbook_is_not_an_error(self):
        spec = {
            "file": "does-not-exist.xlsx",
            "off_nights": {"sheet": "off-nights", "header_row": 29,
                           "first_data_row": 30, "last_data_row": 61,
                           "columns": {"team": 2, "off": 4}},
            "playoff_windows": [],
        }
        # The board simply shows no marks rather than failing the build.
        self.assertIsNone(schedule.load(spec))


class TestShippedSchedule(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = cfg_mod.load_sources()
        cls.data = schedule.load(cls.spec.get("schedule"))

    def test_all_thirty_two_teams_are_read(self):
        self.assertEqual(self.data["count"], 32)
        for window in self.data["windows"]:
            self.assertEqual(window["teams"], 32)

    def test_both_playoff_windows_are_present(self):
        self.assertEqual([w["id"] for w in self.data["windows"]], ["skip", "full"])

    def test_the_league_totals_row_is_not_read_as_a_team(self):
        # A "LEAGUE / 32 teams" row sits under each table.
        self.assertNotIn("LEAGUE", self.data["teams"])

    def test_the_skip_window_is_read_not_derived(self):
        """The two windows are not one subtraction apart.

        Skipping the final week shifts the whole three-round window a week
        earlier, so it is still three rounds. Deriving it by taking the full
        table minus its CHAMP column gives a two-round window and quite
        different numbers -- these values only come out right if the second
        table is read from its own rows.
        """
        wsh = self.data["teams"]["WSH"]["po"]["skip"]
        self.assertEqual(wsh["games"], 12)
        self.assertEqual(wsh["score"], 15.0)
        bos = self.data["teams"]["BOS"]["po"]["skip"]
        self.assertEqual(bos["games"], 9)
        self.assertEqual(bos["score"], 9.5)
        # Subtracting would have given Boston 6 games; the sheet says 9.
        self.assertNotEqual(bos["games"],
                            self.data["teams"]["BOS"]["po"]["full"]["games"] - 4)

    def test_the_window_choice_actually_changes_ratings(self):
        """If it did not, the setting would be decoration.

        Boston and Dallas are the clearest case: unfavourable when the last
        week is skipped, favourable when it is played.
        """
        for team in ("BOS", "DAL"):
            po = self.data["teams"][team]["po"]
            self.assertEqual(po["skip"]["tier"], -1, team)
            self.assertEqual(po["full"]["tier"], 1, team)

    def test_every_band_is_populated(self):
        for key in ("offTier",):
            tiers = [t[key] for t in self.data["teams"].values()]
            self.assertGreater(tiers.count(1), 3)
            self.assertGreater(tiers.count(-1), 3)
            self.assertGreater(tiers.count(0), 3)

    def test_off_nights_and_playoffs_are_independent_enough_to_show_separately(self):
        """The reason there are two marks rather than one combined score.

        A team can be near the top for off-nights and near the bottom for the
        playoff weeks; St Louis and Philadelphia are opposite cases.
        """
        teams = self.data["teams"]
        self.assertEqual(teams["STL"]["offTier"], -1)
        self.assertEqual(teams["STL"]["po"]["skip"]["tier"], 1)
        self.assertEqual(teams["PHI"]["po"]["skip"]["tier"], -1)

    def test_every_board_team_has_a_schedule_row(self):
        aliases = load_aliases(os.path.join(cfg_mod.CONFIG_DIR, "aliases.csv"))
        players, _, _, _ = export.merge(self.spec, aliases, cfg_mod.load_config())
        missing = sorted(set(p["team"] for p in players
                             if p["team"] and p["team"] not in self.data["teams"]))
        self.assertEqual(missing, [])


class TestPayload(unittest.TestCase):
    def test_the_schedule_reaches_the_board(self):
        path = os.path.join(cfg_mod.OUT_DIR, "board_data.json")
        if not os.path.exists(path):
            self.skipTest("run python build.py first")
        with open(path, "rb") as handle:
            payload = json.loads(handle.read().decode("utf-8"))
        self.assertEqual(len(payload["schedule"]["teams"]), 32)
        self.assertEqual(payload["config"]["model"]["playoff_window"], "skip")


if __name__ == "__main__":
    unittest.main()
