# Design notes

The reasoning behind the board: how a player is valued, what every indicator
means, how sources are read and joined, and what the tests pin down. The
[README](README.md) covers using it; this covers why it works the way it does.

---

## How a player's value is calculated

**1. Blend the sources.** For each stat, a weighted average across the sources
that actually published a number for that player:

```
value = Σ(weight × source value) / Σ(weight of sources that have a value)
```

The denominator is the important part. Apples & Ginos publish no shorthanded
points and no goalie stats at all; those sources drop out of that stat's average
rather than dragging it toward zero.

**2. Apply the games-played model.** Sources disagree about what "games played"
even means — Apples & Ginos give nearly everyone a full 84-game season, while
Yahoo projects a real injury discount (77.6 games on average). Three options:

- **Rate × blended GP** *(default)* — blend per-game rates, then apply a blended
  games estimate. Keeps A&G's opinion about production without their opinion
  about availability.
- **Rate × GP from one source** — same, but games come only from a source you
  trust on durability. It sets **games played only**; every other stat still
  comes from the full weighted blend, and a player that source has no line for
  falls back to the blended estimate. The **Games-played source** setting does
  nothing under the other two models, and hides itself accordingly.
- **Straight totals** — plain weighted average of season totals, which is what
  the reference spreadsheet does.

**3. Score it.** `FanPts = Σ(stat × your league's point value)`.

Two scoring categories are positional rather than plain stats. **D pts** (`DPT`)
awards extra on every point a defenceman scores, on top of the goal and assist
values — `PTS × value`, defencemen only, matching how the source workbook
applies it. It ships at **0**, so it costs nothing until you set it.

It applies to anyone **D-eligible** under the current eligibility ruling, so it
follows that setting like everything else. On the default Yahoo ruling no
player is D-eligible and something else, so the distinction is academic today;
Fantrax introduces exactly one. Because it reads the blended `PTS`, a manual
`Adj` boost flows through it automatically. Where an imported source maps goals
and assists but no points column, it falls back to `G + A` rather than silently
awarding nothing.

**GS** (`GS`) pays per game a goalie starts — `GP × value`, goalies only, and
also 0 by default. Negative values are meaningful and supported: plenty of
leagues charge per start rather than paying for one.

Worth knowing what that number is: the board keeps a goalie's starts in `GP`,
but the two goalie sources do not publish the same thing. **DtZ publishes `GP`
(appearances); Daily Faceoff publishes `GS` (starts)**, and both are mapped
onto the one stat. So the category pays on a blend of the two. For the 64
goalies both project, the mean gap is 3.8 games — mostly the sources
disagreeing about workload rather than the appearances-versus-starts
distinction (Devon Levi: DtZ 25, Daily Faceoff 10).

**4. Find replacement level.** Two methods:

- **Draft-based** *(default)* — slot counts alone understate forward scarcity.
  A 12-team league with 2C/2LW/2RW plus flex and bench absorbs about 104
  forwards. Of those top 104, **56 are eligible at centre** — 31 centre-only
  plus 25 who also qualify at a wing — so the centre pool is drained to #57, not
  the ~35 the C slots imply. A centre drafted to fill somebody's left-wing slot
  is still gone. So: take the forwards the league's forward spots will actually
  absorb, ranked by projected points, count how many are eligible at each
  forward position, and set replacement just past that count. Defence and goal
  have nothing competing for their spots, so they use their slot counts
  directly.

  (Those three counts sum to more than 104 because they are three independent
  questions asked of the same players, not a partition — most forwards can play
  more than one position.)
- **Position-based** — the first player past the league's starting slots at that
  position. Simpler, and it understates forward scarcity.

**5. VORP** = `FanPts − replacement`, taken at whichever eligible position gives
the player the largest surplus. A centre who also qualifies at left wing is
valued wherever they help you more.

The replacement panel names the rank it used — `C 329.0, 55th best C` — because
that one line explains any disagreement with another ranking tool. Most
differences between two VORP numbers are not disagreements about a player at
all; they are disagreements about how deep the draftable pool goes.

**6. Tiers** cut each position's list wherever the drop to the next player is
unusually large — the "is there another one like this if I wait?" question. The
label is the position plus the tier number, so `C3` is the third tier of
centres; the letter is the position a player is *most valuable* at, and tier
numbers are not comparable across positions.

A cut happens when a gap exceeds `median + k × MAD`, where **k is the Tier
sensitivity** setting (default 1.0, lower = more tiers). Two details matter:

- **The threshold is calibrated on the draftable range only** — down to the
  replacement depth, not all 236 centres. Including the replacement-level tail,
  whose gaps are near zero, drags the threshold down until the top of the board
  shatters into two-player slivers while 178 centres share one tier.
- **Median and MAD, not mean and standard deviation.** Gaps are heavily
  right-skewed: across the top 57 centres the mean gap is 5.0, the median 3.5
  and the standard deviation 7.2, because a few enormous gaps at the very top
  set the scale. `mean + 1σ` lands at 12.2, which only four gaps in the entire
  draftable range clear.

There is no minimum tier size. A tier of one is a real statement — MacKinnon
stands alone, and Kucherov is 39 points clear of the next right wing.

---

## The columns and what they mean

### Which ADP, and whose position rules

**ADP is not one number.** Yahoo's board and Fantrax's disagree by **47.8 picks
on average, by as much as 164**, so which one you read genuinely changes what
looks like value. **Settings -> ADP column** picks which one the `ADP` column
and its sort show.

| Column | Ranks | Where it comes from |
|---|---|---|
| Average (Yahoo + Fantrax) | 434 | computed — the default |
| Yahoo | 254 | Daily Faceoff's ADP column |
| Fantrax | 429 | DtZ's ADP column |

DtZ and Daily Faceoff each publish one unlabelled ADP, assigned to the platform
it tracks: DtZ's matches Fantrax and never Yahoo, Daily Faceoff's matches Yahoo
45% exactly and Fantrax never.

The **average is computed**, not read from anywhere: the mean of whichever
platforms rank a player, so someone only one of them lists still gets a number.
That rule was checked against a published average column over 670 players with
no exceptions. It is not the *same* number that column held, though — the two
free sources snapshot their platforms on different dates, so half the board
lands within a pick and about a third sits 30 or more picks away. It is a
Yahoo + Fantrax average, not a reproduction of anyone else's.

The menu shows each column's depth, because a blank ADP means *this column does
not rank him*, not that a number went missing.

### Position eligibility

Yahoo and Fantrax each rule for themselves what a player is eligible at, and
they disagree — on **133 of the 670 players** the lists cover. Yahoo is the more generous
reading: it grants an extra position to 69 players where Fantrax grants one to
45, and the two name genuinely different sets for 19 more.

| | Yahoo | Fantrax |
|---|---|---|
| Brady Tkachuk | `C,LW` | `LW` |
| Mikko Rantanen | `LW,RW` | `RW` |
| William Nylander | `C,RW` | `RW` |

That is not cosmetic. Eligibility decides which replacement level a player is
measured against, so it moves VORP, position ranks and the drop-off column
together.

**The projection sources cannot answer this.** They ship a single position
string each and agree with each other almost everywhere — they describe NHL
roles, not a platform's rulebook.

The lists were extracted from a pair of workbooks published against each
platform, identical apart from `POS` and some hand-set adjustments, by
`make_reference.py`. **Only the `POS` column is taken** — no projections —
and the rulings are Yahoo's and Fantrax's own, published free on both sites.
The script skips silently if those workbooks are not present:

```
python make_reference.py       # only if you have the source workbooks
```

```
config/eligibility_yahoo.csv
config/eligibility_fantrax.csv
```

```
name,positions
Nathan MacKinnon,C
Leon Draisaitl,C/LW
```

Positions may be separated by `/` or `,`; `#` starts a comment. Lineup slots
that are not positions (`F`, `UTIL`, `W`, `IR`) are dropped — they are places a
player can be *used*, and the replacement-level maths has no pool for them.
Names go through the same normalizer and alias table as everything else, so the
files are safe to hand-edit when a platform reclassifies someone mid-season.

**Settings -> Position eligibility** switches between them, and **defaults to
Yahoo**. The sources happen to agree with Yahoo's ruling on all but three
players (Huberdeau, Kantserov, Noesen), so that option barely moves the board
while Fantrax moves 129 — which is why the menu offers the two platforms and no
neutral "projection sources" entry, rather than a third option that would
behave almost exactly like the first.

Board players the lists do not cover keep their source positions under either
platform, and a handful of listed players are not on the board at all — an
override for someone absent is an inert row, not an error. Only
players a platform rules *differently* are stored, so the whole feature costs
the payload 133 short arrays.

Drop in a file for a platform that has no list and it joins the menu; remove
both and the control hides itself again.

### Schedule strength on the Team column

Two schedule facts move a player's real value and appear in no projection, so
the `Tm` column carries a mark for each: **off-nights first, fantasy playoff
weeks second**. `WSH ▲▲` is strong at both, `STL ▼▲` is poor all season but
strong in the playoff weeks, a blank slot is middling.

**Off-nights** are games on a night the league is quiet (8 or fewer games).
A roster only starts so many skaters, so a game on a light night is one you
actually get to use, while a fifth game on a 12-game Tuesday sits on your
bench. Washington plays 40 of its 84 there; Vegas 22.

**Playoff weeks** are games during the fantasy playoffs, scored
`games + 0.5 × off-night games`.

They are shown as two marks rather than one rating because they are close to
**independent** — rank correlation 0.19. St Louis is 31st for off-nights and
5th for the playoffs; Philadelphia is 11th and 32nd. A combined score would
hide exactly the thing worth seeing.

A team is marked favourable at or above the 75th percentile of the league and
unfavourable at or below the 25th, computed from the data rather than
hardcoded, so the bands follow whichever playoff window you pick.

**Settings -> Fantasy playoff weeks** chooses between them, defaulting to
**Ends Apr 4**, which skips the final week and matches most Yahoo leagues.
This is not a cosmetic setting: skipping the last week shifts the whole
three-round window a week earlier rather than just dropping a round, and
Boston and Dallas swing from unfavourable to favourable between the two.

Both tables are read straight from `sources/2026-27 NHL schedule sheet.xlsx`
(the [@HockeyBangers](https://x.com/HockeyBangers) schedule pack), already
aggregated per team — nothing is computed from the raw game list, and the two
windows are read from their own rows rather than derived from each other. A
missing workbook is not an error; the marks simply do not appear.

**This is an indicator only.** It never touches the blend or VORP — the
projections already price the player, and this is context for the pick.

### Age, and the prime bands

The **Age** column marks the two ends of the curve: `22 ▲` **pre-prime** (24 and
under, chance to break out) in blue, `33 ▼` **post-prime** (31 and over, chance
to decline) in orange, plain number in between. It is a rule of thumb about age
alone — the projections have already priced the player, and the marker changes
nothing about their value. The thresholds live in `config.json` under
`model.age_bands`.

Blue and orange rather than the more obvious green and amber, because those two
differ almost only on the red-green channel — the one red-green colour blindness
removes — and their luminance is identical, so lightness does not separate them
either. Blue and orange sit **254** apart on the blue-yellow channel against
green/amber's **104**, and both still clear WCAG AA on every row background. The
arrows are what covers the cases hue cannot.

Ages come from `config/ages.csv`, extracted by `make_reference.py` alongside the
eligibility lists, falling back to whatever a projection source gives. That
split matters, because **sources disagree about age**: the extracted list counts
age at the start of the season, while DtZ and Hockey-Reference report the age a
player reaches during it, so they run a year higher for roughly 40% of the
board. The bands were calibrated against the extracted convention — take DtZ's
ages instead and MacKinnon, Draisaitl, Barkov and Reinhart all flip from prime
to post-prime at 31.

The extracted ages are not blindly trusted. Where one differs from a projection
source by **more than a year** it is treated as a typo and the source's age is
kept, with the build printing what it ignored. That is not hypothetical: the
workbook lists Claude Giroux as 19 and Patrick Kane as 26, which would have put
two veterans in the breakout band.

---

## Draft-time behaviour

### Live scarcity, and the `Next` column

With **Live scarcity** on, players are priced against the pool still on the
board and the roster spots still unfilled.

**Expect it to sit still while the draft follows the board — that is the correct
answer, not a broken toggle.** Replacement level is the marginal *rostered*
player at a position, and if picks go in projected-value order, who that is was
settled before the first pick. Taking the best eight goalies teaches you nothing
you did not already know. It moves when the draft deviates:

- **A position gets over-drafted.** Once all 32 goalie spots are gone, nobody
  needs a goalie: replacement becomes the best one still available and every
  remaining goalie correctly falls to zero VORP or below.
- **Picks are burned on weak players.** Twenty goalie spots spent on the 40th-
  to 60th-best goalies means the marginal rostered goalie is now much better, so
  the surplus above them shrinks and replacement rises sharply.

The signal that tracks a run *as it happens* is the **`Next` column**: how far a
player is above the next one still available at their position — the cost of
waiting. A big number is a cliff. It updates on every pick, and it answers the
question replacement level cannot: *if I pass here, what do I actually lose?*

### Your shortlist

The **Mark** column holds two opinions the projections cannot: `★` **watch**
for players to keep an eye on, and `⊘` **do not draft** for players you have
ruled out whatever the numbers say. They are mutually exclusive, clicking an
active mark clears it, and the row picks up a coloured left edge so a mark
catches your eye while scanning rather than only in a far-right column. The
**★ Watch** and **⊘ Avoid** filter chips narrow the board to each.

**An avoided player drops out of Best Available, and out of nothing else.**
That line matters. Best Available answers *"who should I take"*, so it has to
respect your list — and it says how many names it is hiding, so a gap reads as
your decision rather than a bug. Replacement level and the `Next` column
answer a different question: what the **rest of the league** will do. Somebody
else will happily draft the player you crossed off, so removing them there
would quietly corrupt every VORP on the board. A test asserts an avoided
player leaves Best Available while still appearing as somebody else's `Next`.

Marks are prep, not draft state: **Clear draft** leaves them alone, they ride
along in a snapshot, and **Clear marks** is the button that removes them.

### Your own read on a player

The **Adj** column applies your judgement on top of the blended projection, the
same way the Yahoo sheet's Boost or Bust column does. Each `+` or `−` step moves
a player's projected **scoring** by a set percentage — 5%, 10%, 20% by default,
editable in Settings:

```
PLAYER              ADJ      VORP   FanPts
Nathan MacKinnon   − +++ +   392.4    721.3    +20%  =  +110.8 FanPts
Moritz Seider      −  ·  +   172.7    438.6
Mika Zibanejad     −  −− +    98.1    412.7    −10%
```

It feeds the blend *before* scoring, so it flows through fantasy points, VORP,
tiers, the drop-off and your rank together. Hovering the value tells you what
the adjustment was actually worth in points.

**Only scoring stats move**: goals, assists, points, shots, power play and +/−
for skaters; wins, losses, saves and goals against for goalies. Hits, blocks,
PIM, faceoffs and games played never move. That is deliberate and it is Yahoo's
rule — a boost says *"I think this player scores more than the projections do"*,
and hits and blocks are role stats that do not rise with better finishing. The
practical consequence is that a physical defenceman gains less from `+++` than a
pure scorer: Seider picks up 50.9 points where MacKinnon picks up 110.8.

A boost always makes a player **better**, whichever way the stat runs — a
boosted goalie wins more *and* allows fewer goals. That has a side effect worth
knowing: goalies move all four of their stats and two of them are penalties, so
a 5% tier is worth about 9% of a goalie's total rather than 5%. The tooltip
shows the real points figure for exactly this reason.

Two things sit outside it. Save percentage and GAA are excluded even though
Yahoo lists them, because multiplying a save percentage by 1.2 would push it
past 1.000. And last season's actuals are never adjusted — a manual move is an
opinion about next season, and last season already happened.

The **Adj** filter chip shows only the players you have touched, which is how
you review your own edits. **Clear all adjustments** is in Settings, and
adjustments ride along in **Save snapshot**, keyed by name like everything
else.

### Last season's finish

The **`25-26 (VORP)`** column shows where each player actually finished last season
under *your* scoring — ranked by VORP through the same pipeline as the board, so
the two numbers mean the same thing and can be read side by side. **`25-26 FP`**
is the raw fantasy points they scored.

The gap is the point. `▲` in green means the board ranks a player well above
where they finished; `▼` in red means well below. The arrow matters as much as
the colour — green and red are the hardest pair to tell apart, so neither this
column nor `ADP` uses colour as its only signal. Hovering gives points, **games
played** and team, because missed time explains most large gaps:

```
#   PLAYER              VORP   25-26
1   Nathan MacKinnon    281.6      2
7   Auston Matthews     195.7    126 ↑   hover: 126th · 345.4 FP · 60 GP · TOR
20  Connor Hellebuyck   143.0    112 ↑   hover: 112th · 262.6 FP · 57 GP · WPG
44  Aleksander Barkov    72.1      —     no row: missed the whole season
```

Both columns recompute the moment you change a scoring value — last season is
scored live, not baked in at build time. Draft state never affects it; who has
been picked this year cannot change what happened last year.

**A blank means "not in the season file"**, which is usually a rookie or a
fringe player rather than someone who did not play. The export covers 533
players (435 skaters, 98 goalies), so 317 of the 820 on the board have no row.

### Replacement depth

**Replacement depth** in Settings chooses whether bench spots count. On a
12-team roster of 2C/2LW/2RW/4D/2G/4BN, using identical projections:

| | starters only | full roster (default) |
|---|---|---|
| C | 37th best | 57th best |
| D | 49th best | 57th best |
| G | 25th best | 33rd best |

Full roster assumes bench spots get filled with real, draftable players — true
in most leagues. Starters-only matches what the Yahoo workbook assumes. Neither
is objectively right; flip between them and see which board you believe.

---

---

## Adding a projection source

Two ways in. **Import through the board** for a quick addition, or add it to
`config/sources.json` and rebuild to make it permanent.

### Importing from the board

**Settings → Import projections…** takes a `.csv` or `.xlsx` file (nothing else
is accepted) and turns it into another weighted source straight away — no
rebuild. It reads the file, guesses what every column is, and then **shows you
the guess before committing anything**:

```
Importing 5v5-2027-players-projections.csv
643 players · 640 matched to the board · 3 new · 23 stats mapped

  Player   → Player name      Pos      → Position
  Team     → Team             '+/-     → PM
  PTS  ?   → — ignore —       does not match goals + assists
  PTS      → PTS              T/O      → OTL
  GS   ?   → GP               GP is blank for goalies in this file
```

Each column shows a **sample value**, which is how you tell two identically
named columns apart, and anything the guesser is unsure about is flagged with a
`?`. Every column is a dropdown, so a wrong guess is one click to fix rather
than a silently wrong projection. For a workbook you also get a sheet picker and
an adjustable header row.

What it copes with, all of it exercised against real files in the test suite:

| | |
|---|---|
| Byte-order marks, CRLF, quoted commas, doubled quotes | |
| Delimiter sniffing | comma, tab, semicolon, pipe — counted outside quotes, so `"Smith, J."` does not vote |
| Blank markers | `—`, `–`, `-`, `--`, `N/A`, `null` stay **absent**, never zero |
| Number formats | `1,047.5`, `'11.6` (spreadsheet text escape), `90.2%`, `22:59` as time on ice |
| Header buried under a banner | Apples & Ginos hides its header on row 7 |
| Synonyms | `Shots`/`S`/`SOG`, `T/O`/`OTL`, `+/-`/`PM`, `Goals`/`G`, and so on |
| Two columns, one stat | some sheets head both the skater and goalie games columns `GP`; first non-empty wins, so each player gets the right one |
| Two columns, same name | the 5v5 file has two `PTS` — fantasy points and hockey points. Only the one that equals goals + assists is mapped; the other is left off and flagged |
| Team nicknames | `Avalanche` → `COL` |
| Repeated stat blocks | A&G repeat every stat weighted; the raw block wins and the copies are flagged |
| Per-game rates | a rate sheet holds 0.55 goals a game, not 45.7. Detected and shown as a toggle you can override |

Names join through the same normalizer and alias table the build uses, shipped
into the page — so an import matches players exactly the way `build.py` does. A
test asserts the JavaScript normalizer reproduces every key the build wrote.

Players the file has and the board does not are **added**. That shifts row ids,
which is safe because saved state is keyed by name. Imports persist with the
rest of your work.

**A sheet of per-game rates** is spotted automatically and scaled back up by
games played, with rate stats (`ATOI`, `SV%`, `GAA`) left alone. Across the four
real workbooks the largest goal figure is 45+ on a totals sheet and under 0.6 on
a rate sheet, so the two are told apart with two orders of magnitude to spare —
but the answer is still a checkbox in the dialog, because a silent guess about
what every number means is not something to hide.

### Removing sources

**Every** source has a **remove** link beside its weight slider — the ones baked
into the build as well as the ones you import. Removing is not the same as
sliding a weight to zero: a zero weight leaves the player on the board with
nothing behind them, while removing takes the source's exclusive players off it
too.

A built-in source is only hidden, never lost — it reappears as an **add back**
link, so removing one is not a dead end that needs the original file again. An
imported source is discarded, since the board never had it to begin with.

Remove them all and the board empties cleanly and tells you how to get started,
rather than erroring or showing 820 players it can no longer value.

**A source re-imported through the UI is worth exactly what the baked-in one
was.** Every built-in source was removed, re-imported from its own file, and
compared: identical FanPts, VORP, ranks and replacement levels, to the last
decimal the payload stores. DtZ needs two imports, since it splits goalies onto
a second sheet; a test does the Daily Faceoff round trip on every run.

**This is how to use a paid source.** Nothing you have to pay for is baked into
the build, so the published page carries none of it — import the file yourself
and your board is identical to one that had it built in.

An `.xlsx` is unzipped using the browser's own decompression rather than a
bundled library, so the board stays a single small offline file. A browser
without it says so and suggests saving as CSV.

### Adding it permanently

Drop the workbook in `sources/`, add an entry to `config/sources.json`, rebuild.
No code changes.

```json
{
  "id": "DFO",
  "name": "Daily Faceoff",
  "file": "dailyfaceoff-2026-27.xlsx",
  "sheet": "Projections",
  "header_row": 1,
  "first_data_row": 2,
  "pos_delim": ",",
  "columns": {
    "name": "Player", "team": "Team", "pos": "Pos",
    "GP": "GP", "G": "G", "A": "A", "SOG": "Shots"
  }
}
```

Column values are either a **header name** or a **1-based column index**. Use an
index when headers repeat — Daily Faceoff has two columns headed `PTS`, only one
of which is goals + assists, and sheets that carry goalies inline often head
both games columns `GP`. `goalie_columns` remaps the columns that differ for goalies.
Map only the stats a source publishes; the blend skips the rest.

`format` may be `csv` (delimiter sniffed, byte-order mark stripped) or `html`
for an HTML table saved as `.xls`; omit it for a real `.xlsx`.

`per_game: true` says the sheet holds **per-game rates** rather than season
totals, so counting stats get multiplied back up by `GP` while rate stats
(`ATOI`, `SV%`, `GAA`) are left alone. That split is the one the spec already
draws for the blender, and it lets one column serve twice: a goals-against-per-
game column is `GA` when scaled and `GAA` when not.

If a source keeps goalies on a **separate sheet** with a different layout (as
DtZ does), set `goalie_sheet` and make `goalie_columns` the full mapping for it.
Leave both out when goalies sit inline with the skaters.

**Stats sites often hand you an HTML table named `.xls`.** Set `"format": "html"`
and it is read with lxml instead of openpyxl. A few options exist for the shapes
those exports come in, all usable by any source:

| Option | For |
|---|---|
| `derived: {"PPP": {"sum": [13, 17]}}` | a stat split across columns — Hockey-Reference separates power-play goals from power-play assists |
| `formats: {"ATOI": "mmss"}` | `22:59` parsed as 22.983 minutes |
| `dedupe_by: "name"` + `prefer_team_suffix: "TM"` | traded players listed once per team plus a `2TM` aggregate; keeps the aggregate |
| `require: ["team"]` | drops summary rows such as the `League Average` line that ends the goalie table |

One trap worth knowing: those files are valid UTF-8 but declare no charset, and
lxml then guesses latin-1 and turns `Anže Kopitar` into `AnÅ¾e Kopitar`. The
reader states the encoding explicitly. The failure is silent — a mangled name
simply fails to join and the player quietly loses a source — so there is a test
holding it in place.

New sources start at weight 1 in `config/config.json`; adjust there or on the
sliders. After rebuilding, check **`out/unmatched.csv`** — every player whose
name did not join is listed with a suggestion, plus both players' team and
position.

The suggester requires the **surname to match**, then scores the full name.
Similarity alone cannot do this job: measured against the aliases this project
actually needs, genuine ones score 0.74–0.97 and false ones 0.83–0.91, so the
ranges overlap completely and no cutoff separates them. Every real alias here is
a given-name variant sharing a surname (`Alexander`/`Alex`, `Egor`/`Yegor`,
`Anthony`/`Tony`), while the lookalikes are different surnames.

**A suggestion is a candidate, never a confirmation.** Brothers and namesakes
share surnames too, which is why the report carries team and position — that is
what settles it:

```
Zack Bolduc          MTL  LW,RW  ~  Zachary Bolduc       MTL  LW,RW   <- same player
James van Riemsdyk   DET  LW     ~  Trevor van Riemsdyk  PIT  D       <- brothers
```

### The same check inside the import dialog

`out/unmatched.csv` only covers sources the **build** reads. A file imported
through the UI got no such triage: a name the source spelled differently just
became a second row for a player already on the board. That is the worst shape
a failure can take here — the import reports success, the duplicate carries
half the projections, and nothing points at it until mid-draft.

So the dialog runs the same suggester before you commit. Near-misses are listed
with the board player each resembles, and merge on a click; `Merge all` takes
the lot. Nothing merges on its own, because the rule that a suggestion is a
candidate and not a confirmation does not relax just because the UI is faster
than a CSV.

`board/importer.js` reimplements `difflib.SequenceMatcher`'s matching-block
total rather than approximating it, so the browser cannot propose a merge the
build would not. A test drives both over 3,000+ pairs and asserts the ratios
agree exactly. The junk and autojunk heuristics are deliberately omitted:
autojunk only engages at 200+ characters and Python passes no `isjunk`, so for
player names both are no-ops.

**LineupExperts** was the source that prompted this. Five of its 300 names were
given-name variants the board spells differently, and the suggester found all
five and nothing else:

```
Matthew Boldy        -> Matt Boldy
Matthew Beniers      -> Matty Beniers
Zachary Benson       -> Zach Benson
John-Jason Peterka   -> JJ Peterka
Matthew Samoskevich  -> Mackie Samoskevich
```

`Mackie` is the case that rules out a simpler fix: it shares no prefix with
`Matthew`, so nickname expansion or prefix matching would miss it where the
surname-plus-score rule does not. All five are now in `config/aliases.csv`,
which ships to the browser, so the file joins cleanly without any merging.

---

---

## How sources are joined

The four sources merge to **806 players**, with 29 name aliases resolved
(`Tommy Novak` → `Thomas Novak`, `Egor Chinakhov` → `Yegor Chinakhov`,
`Anthony DeAngelo` → `Tony DeAngelo`, …).

**Every baked-in source is free to redistribute.** Paid projections are
deliberately not built in — import them through the UI instead, which produces
an identical board (see *Removing sources*). If you publish this project rather
than just the built page, check what is sitting in `sources/`: the build only
reads what `sources.json` lists, but the directory may hold files you have
bought.

**Order matters, but only for identity.** The first source carrying a player
supplies the display name, team and position; later sources fill blanks. They
are listed most-complete-first so one source names nearly everyone, rather than
the board taking spellings from whichever file happens to be listed earliest. It
has no effect on the blend.

Two players can also share a name. Vancouver has both a centre and a defenceman
called Elias Pettersson, and Daily Faceoff writes both as plain `Elias
Pettersson`; a `disambiguate` rule keyed on position keeps them apart, and the
rules ship into the page so an imported file resolves identity the same way.

DtZ and Daily Faceoff project goalies, so those two weight sliders are the only
ones that affect goalies. Players carried by only some sources are blended from
whoever has them — the `Source` dots on each row show which contributed.

Last season's actuals (`skaters_25-26.xls`, `goalies_25-26.xls`) sit **outside**
that list, in a `history` block. They are measured results, not opinions about
next season, so they are never blended into a projection — they are scored and
ranked separately for the `25-26` columns. A test asserts no board player ever
carries the history source.

**Watch out for same-named players.** Vancouver has both a centre and a
defenceman called `Elias Pettersson`. Sources that disambiguate write the
second as `Elias Pettersson (D)`, and name normalization deliberately keeps
parentheses so the two never merge — there is a test pinning that down, and if
you ever "tidy up" punctuation in `drafttool/names.py` it is the one that will
stop you. Sources that *do not* disambiguate need a `disambiguate` rule in
`sources.json`, keyed on the position that separates them; without it a
defenceman's line gets blended into a top-50 centre's.

---

---

## Layout

```
build.py                 build the board
run_tests.py             run every suite
make_reference.py        regenerate the eligibility and age lists
config/
  config.json            scoring, roster, source weights, model options
  sources.json           per-source column mappings
  aliases.csv            name fixes
  eligibility_*.csv      per-platform position eligibility (generated)
  ages.csv               player ages, for the prime bands (generated)
sources/                 the projection workbooks
drafttool/               Python ETL: read, normalize, join, export
board/
  valuation.js           ALL the math, and the only copy of it
  app.js, style.css, template.html
  rank_cli.js            headless ranking for the CSV export
out/
  draft_board.html       ← the tool
  rankings.csv           same rankings, offline
  _headers               response headers for a static host
  board_data.json        the joined raw data
  unmatched.csv          names that did not join
```

The valuation math lives only in `board/valuation.js`. Python never scores a
player, and the offline CSV is produced by running that same file under Node —
so there is no second implementation to drift out of sync.

---

---

## Tests

```
python run_tests.py
```

- **158 Python tests** — name and team normalization, alias resolution, the
  same-name trap, the surname-based suggester, source parsing against known spot
  values from every workbook, the HTML reader (encoding, `2TM` deduping, derived
  stats, summary-row exclusion), the merge, and the history join.
- **28 importer tests** — run against the real files in `sources/`, not
  fixtures: CSV quirks, delimiter sniffing, xlsx zip and shared strings, sheet
  order, header detection, the synonym table, the two-columns-one-stat rule, the
  `PTS` arithmetic check, and normalizer equivalence with the shipped keys.
- **55 JavaScript tests** — blending in all three GP modes, weight-skipping,
  replacement level and its depth, VORP, tiering (cliff detection, calibration
  window, outlier robustness), drop-off, bench depth, last
  season's parallel ranking, manual adjustments (scope, direction and the points
  swing they are really worth), and the live view — including the two cases that
  distinguish a correct live model from a broken one: over-drafting a position,
  and spots burned on weak players.
- **262 UI checks** — the built page loaded in a headless DOM and driven through
  search, filters, drafting, adjusting, the settings drawer, sorting, the
  last-season columns and persistence. Needs `npm install`; skips cleanly
  without it.

`python build.py --verify` prints the top 25 next to the reference spreadsheet's
published numbers. They are not expected to match — that sheet blends ten
sources to this build's four — but the same names should cluster at the top in a
similar order. Mean rank difference is currently about 10 places over the
reference's top 20, with the outliers being genuine projection disagreements
rather than parsing errors.

To sanity-check against a single source, set that source's weight to 1 and the
rest to 0: the board's FanPts will then match that workbook's own to every digit
it displays. VORP will still differ, because tools disagree about replacement
depth — the replacement panel names the rank this one used.

---

## Publishing it

The board is one self-contained file: no external scripts, styles, fonts or
images, and no network calls at runtime. The number inputs use their own −/+
buttons rather than the browser's native spinner, which renders three different
ways (Chrome hides it until hover, Firefox always draws it, Safari draws none) —
so the settings panel looks and behaves the same everywhere. Upload **`out/draft_board.html` alone**,
renamed `index.html` so it sits at the bare domain. Do not upload
`board_data.json` — the same data is already inside the page, and there is no
reason to also serve it as a clean download.

`out/_headers` is generated next to it for hosts that read that format
(Cloudflare Pages, Netlify): `nosniff`, `no-referrer`, `DENY` framing, and a
CSP. Because the page is one inline script and one inline style the policy has
to allow `unsafe-inline`, so **it is not a defence against injected markup** —
what it buys is the exfiltration path, since `connect-src 'none'` leaves any
script that did run with nowhere to send anything. Confirm the CSV export still
works in a real browser once, and drop the CSP line if it does not.

Everything a viewer does stays in their own browser: state is `localStorage`
under the page's own origin, with no cookies, no accounts and no server. Two
viewers never see each other's drafts.

**Treat a snapshot file as untrusted** — it is the one input that arrives from
someone else. Numeric settings from it are coerced and rejected unless they are
finite numbers; before that, a crafted snapshot could inject markup into the
settings panel. A projection file is lower risk but still untrusted, and every
name, team and position it carries is escaped on the way into the page.

---
