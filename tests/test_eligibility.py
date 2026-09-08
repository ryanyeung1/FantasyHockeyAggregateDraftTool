# -*- coding: utf-8 -*-
"""Per-platform position eligibility."""

from __future__ import unicode_literals

import io
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from drafttool import eligibility
from drafttool.names import AliasTable

PROVIDERS = [
    {"id": "yahoo", "name": "Yahoo", "file": "eligibility_yahoo.csv"},
    {"id": "espn", "name": "ESPN", "file": "eligibility_espn.csv"},
]


class TestPositionParsing(unittest.TestCase):
    def test_slash_and_comma_both_separate(self):
        self.assertEqual(eligibility._positions("C/LW"), ["C", "LW"])
        self.assertEqual(eligibility._positions("C,LW"), ["C", "LW"])

    def test_slot_names_the_board_cannot_price_are_dropped(self):
        """Exports pad this field with lineup slots, not positions.

        'F' and 'UTIL' are places a player can be *used*, not positions they
        are eligible at, and letting them through would invent a position the
        replacement-level maths has no pool for.
        """
        self.assertEqual(eligibility._positions("C/F/UTIL"), ["C"])
        self.assertEqual(eligibility._positions("UTIL"), [])

    def test_duplicates_collapse_and_case_is_ignored(self):
        self.assertEqual(eligibility._positions("lw / LW / rw"), ["LW", "RW"])


class TestShippedLists(unittest.TestCase):
    """The two lists generated from Dom's pair of workbooks."""

    @classmethod
    def setUpClass(cls):
        import json
        from drafttool import config as cfg_mod
        from drafttool import export
        from drafttool.names import load_aliases
        cls.aliases = load_aliases(os.path.join(cfg_mod.CONFIG_DIR, "aliases.csv"))
        with io.open(os.path.join(cfg_mod.CONFIG_DIR, "sources.json"),
                     encoding="utf-8") as fh:
            cls.spec = json.load(fh)
        with io.open(os.path.join(cfg_mod.CONFIG_DIR, "config.json"),
                     encoding="utf-8") as fh:
            cls.config = json.load(fh)
        cls.tables = eligibility.load(cfg_mod.CONFIG_DIR,
                                      cls.spec.get("eligibility_providers"),
                                      cls.aliases)
        cls.players, _, _, _ = export.merge(cls.spec, cls.aliases, cls.config)

    def test_both_platforms_load(self):
        self.assertEqual(sorted(self.tables), ["fantrax", "yahoo"])
        self.assertEqual(len(self.tables["yahoo"]), 670)
        self.assertEqual(len(self.tables["fantrax"]), 670)

    def test_espn_is_not_offered(self):
        ids = [p["id"] for p in self.spec["eligibility_providers"]]
        self.assertEqual(ids, ["yahoo", "fantrax"])

    def test_the_generated_comment_header_is_not_read_as_a_player(self):
        for table in self.tables.values():
            for key in table:
                self.assertFalse(key.startswith("#"), key)

    def test_the_two_platforms_disagree_on_133_players(self):
        """The whole point of the feature, pinned to a number.

        If a regenerated pair of workbooks ever produces 0 here, the two files
        are the same export and the Fantrax column is not what it claims.
        """
        yahoo, fantrax = self.tables["yahoo"], self.tables["fantrax"]
        shared = set(yahoo) & set(fantrax)
        self.assertEqual(len(shared), 670)
        differ = [k for k in shared if yahoo[k] != fantrax[k]]
        self.assertEqual(len(differ), 133)

    def test_every_position_is_one_the_valuation_can_price(self):
        # Fantrax rules Ian Moore RW,D -- a combination Yahoo never uses -- so
        # the parser has to survive more than the familiar forward pairs.
        for table in self.tables.values():
            for key, positions in table.items():
                self.assertTrue(positions, key)
                for pos in positions:
                    self.assertIn(pos, eligibility.VALID, key)

    def test_yahoo_barely_moves_the_board_but_is_not_a_no_op(self):
        """The free sources mostly agree with Yahoo, but not everywhere.

        When Dom was baked in the board took its positions straight from his
        Yahoo workbook and this list agreed on all 670. The free sources have
        their own readings, so picking Yahoo now corrects a handful of them --
        which is the feature doing its job.
        """
        base = dict((p["key"], p["pos"]) for p in self.players)
        differ = sorted(k for k, v in self.tables["yahoo"].items()
                        if k in base and v != base[k])
        self.assertEqual(differ, ["jonathan huberdeau", "roman kantserov",
                                  "stefan noesen"])
        # Still far smaller than the gap between the two platforms, which is
        # what the setting exists to let you choose between.
        fantrax = [k for k, v in self.tables["fantrax"].items()
                   if k in base and v != base[k]]
        self.assertGreater(len(fantrax), 100)

    def test_fantrax_moves_a_known_player(self):
        self.assertEqual(self.tables["yahoo"]["brady tkachuk"], ["C", "LW"])
        self.assertEqual(self.tables["fantrax"]["brady tkachuk"], ["LW"])

    def test_almost_every_listed_player_is_on_the_board(self):
        """The lists came from Dom, who is no longer a source.

        A handful of players he carried and the free sources do not are left
        in the files: an override for someone not on the board is an inert
        row, not a bug, and pruning them would mean regenerating the lists
        every time a source changes.
        """
        keys = set(p["key"] for p in self.players)
        for provider, table in self.tables.items():
            missing = [k for k in table if k not in keys]
            self.assertLess(len(missing), 30, "%s: %d" % (provider, len(missing)))


class TestLoading(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.aliases = AliasTable()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _write(self, name, text):
        with io.open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_a_missing_file_is_not_an_error(self):
        # This is the shipped state: no platform lists installed at all.
        self.assertEqual(eligibility.load(self.dir, PROVIDERS, self.aliases), {})

    def test_only_platforms_with_a_file_are_returned(self):
        self._write("eligibility_yahoo.csv", "name,positions\nLeon Draisaitl,C/LW\n")
        got = eligibility.load(self.dir, PROVIDERS, self.aliases)
        self.assertEqual(sorted(got), ["yahoo"])
        self.assertEqual(got["yahoo"]["leon draisaitl"], ["C", "LW"])

    def test_unquoted_multi_position_rows_still_parse(self):
        """'Name,C,LW' is what an unquoted export looks like to a CSV reader.

        Columns past the second are more positions, not junk.
        """
        self._write("eligibility_yahoo.csv", "name,positions\nLeon Draisaitl,C,LW\n")
        got = eligibility.load(self.dir, PROVIDERS, self.aliases)
        self.assertEqual(got["yahoo"]["leon draisaitl"], ["C", "LW"])

    def test_header_row_is_skipped_and_names_normalize(self):
        self._write("eligibility_espn.csv",
                    "Player,Positions\n\u00c9lias P\u00e9tterss\u00f6n,C\n")
        got = eligibility.load(self.dir, PROVIDERS, self.aliases)
        self.assertIn("elias pettersson", got["espn"])

    def test_a_file_of_unusable_rows_offers_no_platform(self):
        # Every row is a lineup slot, so there is nothing to rule on.
        self._write("eligibility_yahoo.csv", "name,positions\nSomebody,UTIL\n")
        self.assertEqual(eligibility.load(self.dir, PROVIDERS, self.aliases), {})

    def test_aliases_are_applied_so_a_platform_name_joins(self):
        self._write("eligibility_yahoo.csv", "name,positions\nTommy Novak,C\n")
        table = AliasTable([("Tommy Novak", "Thomas Novak")])
        got = eligibility.load(self.dir, PROVIDERS, table)
        self.assertIn("thomas novak", got["yahoo"])


if __name__ == "__main__":
    unittest.main()
