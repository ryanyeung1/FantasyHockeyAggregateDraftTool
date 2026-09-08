"""NHL team-code normalization.

Sources spell the same franchise differently: Yahoo writes 'T.B' where Apples &
Ginos writes 'TBL'. Everything is folded to the three-letter code used by the
majority of sources so player rows join and the board displays one spelling.
"""

# Only the codes that actually differ between our sources need an entry; anything
# already three letters passes through untouched.
_ALIASES = {
    "L.A": "LAK", "LA": "LAK",
    "N.J": "NJD", "NJ": "NJD",
    "S.J": "SJS", "SJ": "SJS",
    "T.B": "TBL", "TB": "TBL",
    "MON": "MTL",
    "WAS": "WSH",
    "CLS": "CBJ",
    "TBY": "TBL",
    "VEG": "VGK", "LVK": "VGK",
    "ARI": "UTA", "ARZ": "UTA", "PHX": "UTA",  # relocated franchise
    "NAS": "NSH",
    "CLB": "CBJ",
    "ANH": "ANA",
    "CAL": "CGY",
    "WNP": "WPG", "WIN": "WPG",
}

# Some sources name the club rather than coding it -- the 5v5 projections write
# "Avalanche", not "COL". Shipped to the browser so a file imported through the
# UI resolves teams the same way the build does.
NICKNAMES = {
    "ducks": "ANA", "bruins": "BOS", "sabres": "BUF", "flames": "CGY",
    "hurricanes": "CAR", "blackhawks": "CHI", "avalanche": "COL",
    "blue jackets": "CBJ", "stars": "DAL", "red wings": "DET", "oilers": "EDM",
    "panthers": "FLA", "kings": "LAK", "wild": "MIN", "canadiens": "MTL",
    "predators": "NSH", "devils": "NJD", "islanders": "NYI", "rangers": "NYR",
    "senators": "OTT", "flyers": "PHI", "penguins": "PIT", "sharks": "SJS",
    "kraken": "SEA", "blues": "STL", "lightning": "TBL", "maple leafs": "TOR",
    "leafs": "TOR", "canucks": "VAN", "golden knights": "VGK",
    "knights": "VGK", "capitals": "WSH", "jets": "WPG",
    "mammoth": "UTA", "utah": "UTA", "utah hockey club": "UTA",
}

# The 32 codes we expect to end up with, used to flag typos in new sources.
KNOWN = {
    "ANA", "BOS", "BUF", "CAR", "CBJ", "CGY", "CHI", "COL", "DAL", "DET", "EDM",
    "FLA", "LAK", "MIN", "MTL", "NJD", "NSH", "NYI", "NYR", "OTT", "PHI", "PIT",
    "SEA", "SJS", "STL", "TBL", "TOR", "UTA", "VAN", "VGK", "WPG", "WSH",
}


def normalize(team):
    """Fold a source's team spelling to a canonical three-letter code.

    Returns '' for blank input so callers can treat missing teams uniformly.
    """
    if team is None:
        return ""
    text = str(team).strip()
    if not text:
        return ""
    nickname = NICKNAMES.get(text.lower())
    if nickname:
        return nickname
    code = text.upper()
    return _ALIASES.get(code, code)


def is_known(code):
    return code in KNOWN
