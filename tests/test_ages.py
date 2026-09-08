# -*- coding: utf-8 -*-
"""Player ages and the pre/post-prime bands."""

from __future__ import unicode_literals

import io
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from drafttool import ages, config as cfg_mod, export
from drafttool.names import AliasTable, load_aliases


class TestBands(unittest.TestCase):
    def test_the_boundaries_are_exact(self):
        """24/25 and 30/31, matching how the source workbook colours them."""
        self.assertEqual(ages.band(24), ages.PRE_PRIME)
        self.assertEqual(ages.band(25), ages.PRIME)
        self.assertEqual(ages.band(30), ages.PRIME)
        self.assertEqual(ages.band(31), ages.POST_PRIME)

    def test_an_unknown_age_has_no_band(self):
        # Better a blank cell than guessing a player into a band.
        self.assertIsNone(ages.band(None))

    def test_the_bands_are_configurable(self):
        custom = {"pre_prime_max": 22, "post_prime_min": 33}
        self.assertEqual(ages.band(23, custom), ages.PRIME)
        self.assertEqual(ages.band(32, custom), ages.PRIME)
        self.assertEqual(ages.band(33, custom), ages.POST_PRIME)

    def test_the_shipped_config_carries_the_bands(self):
        model = cfg_mod.load_config()["model"]
        self.assertEqual(model["age_bands"]["pre_prime_max"], 24)
        self.assertEqual(model["age_bands"]["post_prime_min"], 31)


class TestLoading(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, text):
        with io.open(os.path.join(self.dir, "ages.csv"), "w",
                     encoding="utf-8") as fh:
            fh.write(text)

    def test_a_missing_file_is_not_an_error(self):
        self.assertEqual(ages.load(self.dir), {})

    def test_comments_and_the_header_are_skipped(self):
        self._write("# generated\nname,age\nNathan MacKinnon,30\n")
        got = ages.load(self.dir, alias_table=AliasTable())
        self.assertEqual(got, {"nathan mackinnon": 30})

    def test_a_non_numeric_age_is_dropped_not_guessed(self):
        self._write("name,age\nSomebody,\nOther Guy,n/a\nReal Player,27\n")
        got = ages.load(self.dir, alias_table=AliasTable())
        self.assertEqual(got, {"real player": 27})

    def test_aliases_are_applied(self):
        self._write("name,age\nTommy Novak,29\n")
        table = AliasTable([("Tommy Novak", "Thomas Novak")])
        self.assertIn("thomas novak", ages.load(self.dir, alias_table=table))


class TestApplying(unittest.TestCase):
    """The extracted age wins, except where it cannot possibly be right."""

    def _players(self):
        return [
            {"key": "a", "age": 30.0},   # same
            {"key": "b", "age": 31.0},   # one year apart: a difference of
                                         # reference date, not an error
            {"key": "c", "age": 39.0},   # twenty years apart: a typo
            {"key": "d", "age": None},   # no source age at all
            {"key": "e", "age": 27.0},   # not in the extracted list
        ]

    def test_the_extracted_age_wins_within_a_year(self):
        players = self._players()
        ages.apply(players, {"a": 30, "b": 30})
        self.assertEqual(players[0]["age"], 30)
        self.assertEqual(players[1]["age"], 30)

    def test_an_implausible_age_is_rejected_and_reported(self):
        """A workbook typo would put a 39-year-old in the pre-prime band.

        Claude Giroux is listed as 19 in the source, Patrick Kane as 26. The
        source's own age is kept and the rejection handed back so the build
        can say so rather than silently mislabelling a veteran as a prospect.
        """
        players = self._players()
        rejected = ages.apply(players, {"c": 19})
        self.assertEqual(players[2]["age"], 39.0)
        self.assertEqual(rejected, [("c", 39.0, 19)])

    def test_a_player_with_no_source_age_takes_the_extracted_one(self):
        players = self._players()
        ages.apply(players, {"d": 22})
        self.assertEqual(players[3]["age"], 22)

    def test_players_the_list_does_not_carry_are_left_alone(self):
        players = self._players()
        ages.apply(players, {})
        self.assertEqual(players[4]["age"], 27.0)


class TestShippedAges(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.aliases = load_aliases(os.path.join(cfg_mod.CONFIG_DIR, "aliases.csv"))
        cls.table = ages.load(cfg_mod.CONFIG_DIR, alias_table=cls.aliases)
        spec = cfg_mod.load_sources()
        cfg = cfg_mod.load_config()
        cls.players, _, _, cls.rejected = export.merge(
            spec, cls.aliases, cfg, age_table=cls.table)

    def test_the_file_ships_and_covers_the_workbook(self):
        self.assertEqual(len(self.table), 670)

    def test_every_age_is_a_plausible_hockey_age(self):
        for key, age in self.table.items():
            self.assertTrue(16 <= age <= 50, "%s: %s" % (key, age))

    def test_nearly_every_board_player_ends_up_with_an_age(self):
        missing = [p for p in self.players if p.get("age") is None]
        self.assertLess(len(missing), 20, "%d without an age" % len(missing))

    def test_the_known_bad_rows_are_rejected(self):
        # These are real errors in the source workbook, not name collisions:
        # same player, same team, an age two decades out.
        rejected = dict((k, (kept, dropped)) for k, kept, dropped in self.rejected)
        self.assertIn("claude giroux", rejected)
        self.assertEqual(rejected["claude giroux"][1], 19)
        self.assertGreater(rejected["claude giroux"][0], 35)

    def test_a_top_player_keeps_the_extracted_age_not_the_sources(self):
        """MacKinnon is 30 on the extracted list and 31 to DtZ.

        The bands were calibrated against the extracted reference date, so
        using the source age here would call him post-prime.
        """
        mac = [p for p in self.players if p["key"] == "nathan mackinnon"][0]
        self.assertEqual(mac["age"], 30)
        self.assertEqual(ages.band(mac["age"]), ages.PRIME)


if __name__ == "__main__":
    unittest.main()
