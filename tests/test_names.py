"""Tests for name and team normalization.

These are the join keys. If normalization is wrong a player silently loses a
source and their projection quietly shifts, with nothing to see on the board --
which makes this the cheapest place in the project to catch a real problem.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from drafttool import teams  # noqa: E402
from drafttool.names import (  # noqa: E402
    AliasTable, load_aliases, normalize, suggest, surname,
)

CONFIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "config", "aliases.csv")


class TestNormalize(unittest.TestCase):
    def test_lowercases_and_collapses_whitespace(self):
        self.assertEqual(normalize("  Nathan   MacKinnon "), "nathan mackinnon")

    def test_strips_accents(self):
        self.assertEqual(normalize(u"Tim Stützle"), "tim stutzle")
        self.assertEqual(normalize(u"Erik Brännström"), "erik brannstrom")

    def test_drops_periods_so_initials_join(self):
        self.assertEqual(normalize("J.J. Moser"), normalize("JJ Moser"))
        self.assertEqual(normalize("T.J. Oshie"), "tj oshie")

    def test_hyphens_become_spaces(self):
        self.assertEqual(normalize("Axel Sandin-Pellikka"), "axel sandin pellikka")

    def test_drops_generational_suffixes(self):
        self.assertEqual(normalize("Trevor Zegras Jr"), normalize("Trevor Zegras"))

    def test_handles_empty_input(self):
        self.assertEqual(normalize(None), "")
        self.assertEqual(normalize(""), "")


class TestAliasTable(unittest.TestCase):
    def test_resolves_a_known_alias(self):
        table = AliasTable([("Alexander Wennberg", "Alex Wennberg")])
        self.assertEqual(table.resolve("Alexander Wennberg"), normalize("Alex Wennberg"))

    def test_passes_through_unknown_names(self):
        table = AliasTable([("A", "B")])
        self.assertEqual(table.resolve("Nathan MacKinnon"), "nathan mackinnon")

    def test_follows_a_chain_without_looping(self):
        table = AliasTable([("A B", "C D"), ("C D", "E F")])
        self.assertEqual(table.resolve("A B"), "e f")
        cyclic = AliasTable([("A B", "C D"), ("C D", "A B")])
        self.assertIn(cyclic.resolve("A B"), ("a b", "c d"))  # terminates either way

    def test_ignores_self_referential_entries(self):
        table = AliasTable([("Same Name", "Same Name")])
        self.assertEqual(len(table), 0)


class TestShippedAliases(unittest.TestCase):
    """The pairs found when joining Apples & Ginos and DtZ onto Yahoo."""

    def setUp(self):
        self.table = load_aliases(CONFIG)

    def test_file_loads(self):
        self.assertEqual(len(self.table), 29)

    def test_each_pair_resolves(self):
        pairs = [
            ("Alexander Nikishin", "Alex Nikishin"),
            ("Alexander Wennberg", "Alex Wennberg"),
            ("Alexandre Texier", "Alex Texier"),
            ("Dimitri Voronkov", "Dmitri Voronkov"),
            ("Egor Chinakhov", "Yegor Chinakhov"),
            ("J.J. Moser", "Janis Moser"),
            ("Matthew Savoie", "Matt Savoie"),
            ("Maxim Shabanov", "Max Shabanov"),
            ("Nick Robertson", "Nicholas Robertson"),
            ("Tommy Novak", "Thomas Novak"),
            # Added when DatsyukToZetterberg was brought in.
            ("Anthony DeAngelo", "Tony DeAngelo"),
            ("Alexander Kerfoot", "Alex Kerfoot"),
            ("Alexander Romanov", "Alex Romanov"),
            ("Alexandre Carrier", "Alex Carrier"),
            ("Alexey Toropchenko", "Alexei Toropchenko"),
            ("Jake Middleton", "Jacob Middleton"),
            ("Will Borgen", "William Borgen"),
            ("Daniil Tarasov", "Daniil Tarasov (G)"),
            ("Zack Bolduc", "Zachary Bolduc"),
            ("Emil Lilleberg", "Emil Martinsen Lilleberg"),
            # Added when last season's actuals were brought in.
            ("Benjamin Kindel", "Ben Kindel"),
            ("Cameron York", "Cam York"),
            (u"Daniel Vlada\u0159", "Dan Vladar"),
            ("Gabriel Perreault", "Gabe Perreault"),
            ("Joshua Norris", "Josh Norris"),
            ("Matthew Coronato", "Matt Coronato"),
            ("Michael Anderson", "Mikey Anderson"),
            ("William Cuylle", "Will Cuylle"),
            # Surfaced by the 5v5 projections imported through the UI.
            ("Alexander Holtz", "Alex Holtz"),
        ]
        for alias, canonical in pairs:
            self.assertEqual(self.table.resolve(alias), normalize(canonical),
                             "%s should resolve to %s" % (alias, canonical))

    def test_comments_and_blank_lines_are_ignored(self):
        # The shipped file opens with several '#' comment lines.
        self.assertEqual(self.table.resolve("Nathan MacKinnon"), "nathan mackinnon")


class TestDuplicateNames(unittest.TestCase):
    """Yahoo tells same-named players apart with a position suffix.

    It lists both 'Elias Pettersson' (C, VAN) and 'Elias Pettersson (D)'
    (D, VAN) -- two different, real players. Stripping punctuation in
    normalize() would merge them and silently blend one player's projection
    into the other's, so this behaviour is pinned down deliberately.
    """

    def test_position_suffix_keeps_players_apart(self):
        self.assertNotEqual(normalize("Elias Pettersson"),
                            normalize("Elias Pettersson (D)"))

    def test_a_suffixed_name_is_not_aliased_away_by_accident(self):
        table = load_aliases(CONFIG)
        # The bare form must still resolve to the bare form.
        self.assertEqual(table.resolve("Elias Pettersson"), "elias pettersson")

    def test_surname_ignores_the_suffix(self):
        self.assertEqual(surname(normalize("Daniil Tarasov (G)")), "tarasov")
        self.assertEqual(surname(normalize("Elias Pettersson (D)")), "pettersson")

    def test_surname_of_ordinary_and_empty_names(self):
        self.assertEqual(surname(normalize("Nathan MacKinnon")), "mackinnon")
        self.assertEqual(surname(normalize("Emil Martinsen Lilleberg")), "lilleberg")
        self.assertEqual(surname(""), "")


class TestSuggest(unittest.TestCase):
    """The unmatched-name suggester.

    Similarity alone cannot do this job: against the aliases this project needs,
    genuine ones score 0.74-0.97 and false ones 0.83-0.91, so the ranges overlap
    and no cutoff separates them. Requiring the surname to match does separate
    them, because every real alias here is a given-name variant.
    """

    CANDIDATES = [
        "Alex Wennberg", "Alex Nikishin", "Tony DeAngelo", "Nicholas Robertson",
        "Zachary Bolduc", "Emil Martinsen Lilleberg", "Daniil Tarasov (G)",
        "Patrick Kane", "Ryan Graves", "Jake Evans", "Adam Edstrom",
        "William Carrier", "Alex Carrier", "Nathan MacKinnon",
    ]

    def setUp(self):
        self.display = dict((normalize(n), n) for n in self.CANDIDATES)
        self.keys = list(self.display)

    def _suggest(self, name):
        return suggest(normalize(name), self.keys, self.display)

    def test_finds_given_name_variants(self):
        for source_name, expected in [
            ("Alexander Wennberg", "Alex Wennberg"),
            ("Alexander Nikishin", "Alex Nikishin"),
            ("Anthony DeAngelo", "Tony DeAngelo"),
            ("Nick Robertson", "Nicholas Robertson"),
            ("Zack Bolduc", "Zachary Bolduc"),
            ("Emil Lilleberg", "Emil Martinsen Lilleberg"),
            ("Daniil Tarasov", "Daniil Tarasov (G)"),
        ]:
            self.assertEqual(self._suggest(source_name), expected,
                             "%s should suggest %s" % (source_name, expected))

    def test_rejects_lookalikes_with_different_surnames(self):
        # Every one of these scored above a plain 0.83 similarity cutoff, and
        # every one is a different, real NHL player.
        for name in ("Patrik Laine", "Ryan Reaves", "Jake Bean", "Adam Engstrom"):
            self.assertEqual(self._suggest(name), "",
                             "%s must not be suggested as anyone" % name)

    def test_namesakes_still_surface_as_candidates(self):
        """A shared surname is a candidate, not a verdict -- by design.

        Marcus Johansson (a winger) and Jonas Johansson (a goalie) are different
        people, and no name-only rule can tell them apart. The suggester's job is
        to narrow 154 unmatched names down to a handful worth looking at; what
        settles each one is the team and position the report prints beside it,
        checked by test_sources.TestMerge.
        """
        display = dict(self.display)
        display[normalize("Jonas Johansson")] = "Jonas Johansson"
        self.assertEqual(
            suggest(normalize("Marcus Johansson"), list(display), display),
            "Jonas Johansson")

    def test_rejects_a_different_player_sharing_a_surname(self):
        # Alexandre Carrier is not William Carrier; the score settles it.
        self.assertNotEqual(self._suggest("Alexandre Carrier"), "William Carrier")

    def test_returns_blank_when_nothing_is_close(self):
        for name in ("Viggo Bjorck", "Ryan Ufko", "Carter Yakemchuk"):
            self.assertEqual(self._suggest(name), "")

    def test_handles_empty_input(self):
        self.assertEqual(suggest("", self.keys, self.display), "")


class TestTeams(unittest.TestCase):
    def test_folds_the_codes_that_differ_between_sources(self):
        # Yahoo writes these with periods; Apples & Ginos use three letters.
        self.assertEqual(teams.normalize("T.B"), "TBL")
        self.assertEqual(teams.normalize("N.J"), "NJD")
        self.assertEqual(teams.normalize("L.A"), "LAK")
        self.assertEqual(teams.normalize("S.J"), "SJS")

    def test_leaves_canonical_codes_alone(self):
        for code in ("COL", "EDM", "TOR", "UTA"):
            self.assertEqual(teams.normalize(code), code)

    def test_is_case_and_whitespace_insensitive(self):
        self.assertEqual(teams.normalize(" t.b "), "TBL")

    def test_blank_input(self):
        self.assertEqual(teams.normalize(None), "")
        self.assertEqual(teams.normalize(""), "")

    def test_every_alias_target_is_a_real_team(self):
        for code in ("T.B", "N.J", "L.A", "S.J", "ARI", "VEG", "WAS", "MON"):
            self.assertTrue(teams.is_known(teams.normalize(code)),
                            "%s maps to an unknown team code" % code)


if __name__ == "__main__":
    unittest.main()
