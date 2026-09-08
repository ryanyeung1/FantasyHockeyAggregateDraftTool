"""Player-name normalization and alias resolution.

Sources disagree on given names ('Alexander Wennberg' vs 'Alex Wennberg'),
transliteration ('Egor' vs 'Yegor'), accents, and punctuation. Joining on the raw
string silently drops a player from the blend, so every name passes through
`normalize` and then the alias table before it is used as a key.
"""

import csv
import difflib
import os
import re
import unicodedata

_SUFFIXES = re.compile(r"\b(jr|sr|ii|iii|iv)\b")
_NONSPACE = re.compile(r"\s+")


def normalize(name):
    """Fold a display name to a join key.

    Strips accents, lowercases, removes periods and apostrophes, turns hyphens
    into spaces, and drops generational suffixes. 'J.J. Moser' and 'JJ Moser'
    both become 'jj moser'.
    """
    if name is None:
        return ""
    text = unicodedata.normalize("NFKD", str(name))
    text = text.encode("ascii", "ignore").decode("ascii")
    text = text.lower().replace(".", "").replace("'", "").replace("`", "")
    text = text.replace("-", " ")
    text = _SUFFIXES.sub("", text)
    return _NONSPACE.sub(" ", text).strip()


class AliasTable(object):
    """Maps normalized source spellings onto normalized canonical spellings."""

    def __init__(self, pairs=None):
        # Stored normalized on both sides so lookups never re-normalize twice.
        self._map = {}
        for alias, canonical in (pairs or []):
            self.add(alias, canonical)

    def add(self, alias, canonical):
        key = normalize(alias)
        target = normalize(canonical)
        if key and target and key != target:
            self._map[key] = target

    def resolve(self, name):
        """Return the canonical join key for a raw source name."""
        key = normalize(name)
        # One hop is enough for a curated table, but follow a short chain so an
        # A -> B -> C entry pair does not silently half-resolve.
        seen = set()
        while key in self._map and key not in seen:
            seen.add(key)
            key = self._map[key]
        return key

    def __len__(self):
        return len(self._map)

    def pairs(self):
        """The resolved map, for shipping to the browser."""
        return dict(self._map)


def load_aliases(path):
    """Read config/aliases.csv. Blank lines and '#' comments are ignored."""
    pairs = []
    if not os.path.exists(path):
        return AliasTable()
    with open(path, "r", encoding="utf-8-sig") as handle:
        rows = [line for line in handle if line.strip() and not line.lstrip().startswith("#")]
    for row in csv.DictReader(rows):
        alias = (row.get("alias") or "").strip()
        canonical = (row.get("canonical") or "").strip()
        if alias and canonical:
            pairs.append((alias, canonical))
    return AliasTable(pairs)


def surname(key):
    """Last name from an already-normalized key, ignoring a position suffix.

    'daniil tarasov (g)' -> 'tarasov'. Yahoo appends '(D)' / '(G)' to tell two
    players with the same name apart, and that suffix must not be mistaken for
    the surname.
    """
    tokens = key.split()
    while tokens and tokens[-1].startswith("("):
        tokens.pop()
    return tokens[-1] if tokens else ""


def suggest(unknown_key, candidate_keys, display_by_key, cutoff=0.70):
    """Best match for a name that failed to join, for the triage report.

    Returns the *display* spelling of the closest candidate, or '' when nothing
    is worth a human look.

    Requires the surname to match exactly, then scores the full name. Overall
    similarity alone cannot do this job -- measured against the aliases this
    project actually needs, real ones score 0.74 to 0.97 and false ones 0.83 to
    0.91, so the two ranges overlap completely and no threshold separates them.
    Every genuine alias here is a given-name variant (Alexander/Alex,
    Egor/Yegor, Anthony/Tony) sharing a surname, while the false positives
    ('Patrik Laine' -> 'Patrick Kane', 'Ryan Reaves' -> 'Ryan Graves') are
    different surnames that merely look alike.

    The score still matters once surnames agree, to reject two genuinely
    different players who share one -- 'Alexandre Carrier' is not 'William
    Carrier', and scores 0.56.

    The cost is that a source misspelling a surname will not be suggested. That
    is the right trade: this report is meant to be skimmed and acted on, and a
    suggestion needing verification is worse than none at all.
    """
    target = surname(unknown_key)
    if not target:
        return ""
    best = None
    best_score = cutoff
    for key in candidate_keys:
        if surname(key) != target:
            continue
        score = difflib.SequenceMatcher(None, unknown_key, key).ratio()
        if score >= best_score:
            best_score = score
            best = key
    return display_by_key.get(best, "") if best else ""
