# -*- coding: utf-8 -*-
"""Yahoo ADP, read from Yahoo's own board rather than inferred from a column."""

from __future__ import unicode_literals

import io
import os
import shutil
import tempfile
import unittest

from drafttool import adp
from drafttool.names import AliasTable


class TestLoad(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, text, name="adp_yahoo.csv"):
        with io.open(os.path.join(self.dir, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def test_missing_file_is_not_an_error(self):
        """The provider just drops out, the same as an unpublished column."""
        self.assertEqual(adp.load(self.dir), {})

    def test_reads_names_and_values(self):
        self.write("# a banner\nname,adp\nConnor McDavid,1.5\nCale Makar,9\n")
        got = adp.load(self.dir)
        self.assertAlmostEqual(got["connor mcdavid"], 1.5)
        self.assertAlmostEqual(got["cale makar"], 9.0)

    def test_comments_blanks_and_the_header_are_skipped(self):
        self.write("# note\n\nname,adp\nConnor McDavid,1.5\n\n# trailing\n")
        self.assertEqual(list(adp.load(self.dir)), ["connor mcdavid"])

    def test_a_player_with_no_number_is_left_out_entirely(self):
        """Blank means Yahoo does not rank him -- not zero, and not first."""
        self.write("name,adp\nConnor McDavid,1.5\nNobody Ranked,\n")
        got = adp.load(self.dir)
        self.assertNotIn("nobody ranked", got)
        self.assertEqual(len(got), 1)

    def test_junk_in_the_number_is_skipped_rather_than_crashing(self):
        self.write("name,adp\nConnor McDavid,1.5\nBroken Row,#VALUE!\n")
        self.assertEqual(list(adp.load(self.dir)), ["connor mcdavid"])

    def test_names_go_through_the_alias_table(self):
        """Yahoo's spelling and the board's need not agree."""
        self.write("name,adp\nMatthew Boldy,7.5\n")
        table = AliasTable([("Matthew Boldy", "Matt Boldy")])
        self.assertEqual(list(adp.load(self.dir, alias_table=table)),
                         ["matt boldy"])
