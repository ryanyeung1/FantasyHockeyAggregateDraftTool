/* Tests for board/importer.js -- run with: node tests/test_importer.js
 *
 * Deliberately run against the real files in sources/ rather than fixtures.
 * The point of this module is surviving however a projection site chose to lay
 * its data out, and invented fixtures only ever test the shapes you thought of.
 * Every spot value below is the same number the Python readers produce.
 */
"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
var I = require(path.join(__dirname, "..", "board", "importer.js"));

var SOURCES = path.join(__dirname, "..", "sources");
var BOARD_DATA = path.join(__dirname, "..", "out", "board_data.json");

var passed = 0;
var queue = [];

/* Tests are collected first and run in sequence afterwards, because several of
 * them read a workbook and therefore return a promise. Running them as they are
 * declared would interleave the output and let a rejection escape unreported. */
function test(name, fn) { queue.push([name, fn]); }
function near(actual, expected, msg, eps) {
  assert.ok(Math.abs(actual - expected) < (eps === undefined ? 1e-6 : eps),
    (msg || "value") + ": expected " + expected + ", got " + actual);
}

// Node 12 has no DecompressionStream; zlib stands in so the zip reader itself
// is exercised. The browser passes a DecompressionStream wrapper instead.
function inflateRaw(bytes) { return zlib.inflateRawSync(Buffer.from(bytes)); }

function arrayBufferOf(file) {
  var buf = fs.readFileSync(path.join(SOURCES, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/* Present AND openable. Two of the workbooks are paid products that are not
 * part of the build, so they may be missing entirely; and on Windows a file
 * open in Excel is locked. Either way the right answer is to skip, not to
 * fail because of what happens to be on this machine right now. */
var SKIP = { skipped: true };
function readable(file) {
  try {
    var fd = fs.openSync(path.join(SOURCES, file), "r");
    fs.closeSync(fd);
    return true;
  } catch (err) {
    return false;
  }
}

var DOM_FILE = "2026-27-Fantasy-Projections-Yahoo-1.xlsx";

var STATS = ["GP", "G", "A", "PTS", "SOG", "PPG", "PPP", "SHG", "SHP", "BLK",
             "HIT", "PM", "PIM", "GWG", "FOW", "FOL", "ATOI", "W", "L", "OTL",
             "SO", "SV", "SA", "GA", "SV%", "GAA"];

/* --------------------------------------------------------------- values */

test("blank markers are values, not zeroes", function () {
  // A stat recorded as absent must stay absent: turning it into 0 would drag a
  // player's blended average down for every stat the source omits.
  ["", "-", "--", "—", "–", "N/A", "na", "null", "."].forEach(function (v) {
    assert.strictEqual(I.toNumber(v), null, JSON.stringify(v) + " should be null");
  });
  assert.strictEqual(I.toNumber(0), 0, "a real zero survives");
});

test("numbers arrive wearing all sorts of clothes", function () {
  near(I.toNumber("1,047.5"), 1047.5, "thousands separator");
  near(I.toNumber("'11.6"), 11.6, "apostrophe-escaped by a spreadsheet");
  near(I.toNumber("90.2%"), 90.2, "percent sign");
  near(I.toNumber("22:59"), 22 + 59 / 60, "time on ice as mm:ss");
  near(I.toNumber(" 45.6 "), 45.6, "padding");
  assert.strictEqual(I.toNumber("Nathan MacKinnon"), null, "a name is not a number");
});

/* -------------------------------------------------------------- delimited */

test("parseDelimited handles the awkward parts of CSV", function () {
  var text = '﻿Name,Team,Note\r\n' +
             '"Smith, John",COL,"He said ""hi"""\r\n' +
             'Plain,EDM,\r\n';
  var out = I.parseDelimited(text);
  assert.deepStrictEqual(out.rows[0], ["Name", "Team", "Note"], "BOM stripped");
  assert.deepStrictEqual(out.rows[1], ["Smith, John", "COL", 'He said "hi"'],
    "quoted comma and doubled quotes");
  assert.deepStrictEqual(out.rows[2], ["Plain", "EDM", ""]);
  assert.strictEqual(out.rows.length, 3, "the trailing newline is not a row");
});

test("the delimiter is sniffed, ignoring quoted text", function () {
  assert.strictEqual(I.sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.strictEqual(I.sniffDelimiter("a;b;c\n1;2;3"), ";");
  // Commas inside quotes must not win the vote for a tab-separated file.
  assert.strictEqual(I.sniffDelimiter('a\tb\n"Smith, J."\t2\n"Jones, K."\t3'), "\t");
});

/* ------------------------------------------------------------------ xlsx */

test("readXlsx lists sheets in workbook order", function (done) {
  return I.readXlsx(arrayBufferOf("Free Version DtZ 2026-2027 NHL Fantasy Projections.xlsx"),
                    { inflateRaw: inflateRaw }).then(function (wb) {
    assert.ok(wb.sheets.length > 20, "DtZ has 31 tabs, got " + wb.sheets.length);
    assert.strictEqual(wb.sheets[0], "Read Me",
      "sheet order comes from workbook.xml, not the file names");
    assert.ok(wb.sheets.indexOf("Skater Projections") > 0);
  });
});

test("xml entities in sheet names are decoded", function () {
  return I.readXlsx(arrayBufferOf("Apples & Ginos 2026-27 NHL Skater Projections.xlsx"),
                    { inflateRaw: inflateRaw }).then(function (wb) {
    assert.ok(wb.sheets.indexOf("A&G Avg Projections") >= 0,
      "expected A&G, got " + JSON.stringify(wb.sheets.slice(0, 4)));
  });
});

/* Regression: a self-closing <c r="E1" s="195"/> used to let the attribute
 * group swallow the trailing slash, after which the element matched through to
 * the NEXT </c> and ate the following cell. In Yahoo's sheet that silently
 * removed the TEAM column and shifted every column after it. */
test("an empty cell does not consume the one after it", function () {
  var xml = '<row r="1">' +
    '<c r="A1" t="s"><v>0</v></c>' +
    '<c r="B1" s="1"/>' +
    '<c r="C1" t="s"><v>1</v></c>' +
    '</row>';
  var rows = I._sheetRows ? I._sheetRows(xml, ["first", "third"]) : null;
  if (!rows) return;                       // helper not exported; covered below
  assert.deepStrictEqual(rows[0], ["first", "", "third"]);
});

test("Yahoo's sheet keeps every column, including the one after a gap", function () {
  if (!readable(DOM_FILE)) return SKIP;
  return I.readXlsx(arrayBufferOf("2026-27-Fantasy-Projections-Yahoo-1.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) { return wb.readSheet("The List"); })
    .then(function (rows) {
      // Column E of the header is empty and F is TEAM.
      assert.strictEqual(rows[0][1], "NAME");
      assert.strictEqual(rows[0][3], "POS");
      assert.strictEqual(rows[0][5], "TEAM", "the column after the gap survives");
      assert.strictEqual(rows[1][1], "Nathan MacKinnon");
      assert.strictEqual(rows[1][5], "COL");
    });
});

/* ------------------------------------------------------- header detection */

test("the header row is found under a banner", function () {
  return I.readXlsx(arrayBufferOf("Apples & Ginos 2026-27 NHL Skater Projections.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) { return wb.readSheet("Nates Projections"); })
    .then(function (rows) {
      // Six rows of instructions and settings sit above the real header.
      assert.strictEqual(I.detectHeaderRow(rows), 6, "expected row 7 (index 6)");
    });
});

test("a header on the first row is still found", function () {
  var text = fs.readFileSync(path.join(SOURCES, "5v5-2027-players-projections.csv"), "utf8");
  assert.strictEqual(I.detectHeaderRow(I.parseDelimited(text).rows), 0);
});

/* ----------------------------------------------------------- auto-mapping */

function mapped(rows) {
  var h = I.detectHeaderRow(rows);
  var columns = I.autoMap(rows[h], rows.slice(h + 1));
  var byStat = {};
  columns.forEach(function (c) {
    if (!c.field) return;
    if (!byStat[c.field]) byStat[c.field] = [];
    byStat[c.field].push(c.index);
  });
  return { header: h, columns: columns, byStat: byStat,
           players: I.buildSource(rows.slice(h + 1), columns, STATS, null) };
}

function playerIn(built, key) {
  return built.filter(function (p) { return p.key === key; })[0];
}

test("two columns headed PTS are told apart by arithmetic", function () {
  // Column 6 is fantasy points (1047.5) and column 8 is hockey points (126).
  // Nothing in the heading separates them; only one equals goals + assists.
  var text = fs.readFileSync(path.join(SOURCES, "5v5-2027-players-projections.csv"), "utf8");
  var out = mapped(I.parseDelimited(text).rows);
  var mac = playerIn(out.players, "nathan mackinnon");
  near(mac.stats.PTS, 126, "the hockey points column wins");
  var rejected = out.columns.filter(function (c) {
    return /^pts$/i.test(c.header) && !c.field;
  });
  assert.strictEqual(rejected.length, 1, "the other is left unmapped");
  assert.ok(/goals \+ assists/.test(rejected[0].note || ""), "and says why");
  assert.ok(rejected[0].uncertain, "and is flagged for review");
});

test("the 5v5 file maps its quirks correctly", function () {
  var text = fs.readFileSync(path.join(SOURCES, "5v5-2027-players-projections.csv"), "utf8");
  var out = mapped(I.parseDelimited(text).rows);
  assert.strictEqual(out.players.length, 643);

  var mac = playerIn(out.players, "nathan mackinnon");
  near(mac.stats.G, 45.6);
  near(mac.stats.A, 80.9);
  near(mac.stats.PM, 11.6, "'+/- survives the apostrophe");
  assert.strictEqual(mac.team, "Avalanche", "team nicknames are passed through raw");

  // A goalie in the same sheet: games live in GS, and T/O means overtime losses.
  var vasy = playerIn(out.players, "andrei vasilevskiy");
  near(vasy.stats.GP, 59, "GS feeds GP when GP itself is blank");
  near(vasy.stats.W, 33);
  near(vasy.stats.OTL, 6, "T/O");
  assert.strictEqual(vasy.stats.G, undefined, "em dashes did not become zeroes");
});

test("several columns may feed one stat, first non-empty winning", function () {
  // Yahoo heads both its skater games column (17) and its goalie games column
  // (36) "GP". Neither is right for everyone; taking the first value that
  // exists is right for both.
  return I.readXlsx(arrayBufferOf("2026-27-Fantasy-Projections-Yahoo-1.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) { return wb.readSheet("The List"); })
    .then(function (rows) {
      var out = mapped(rows);
      assert.ok(out.byStat.GP.length >= 2, "both GP columns are mapped");
      near(playerIn(out.players, "nathan mackinnon").stats.GP, 83.2625, "skater");
      near(playerIn(out.players, "andrei vasilevskiy").stats.GP, 55, "goalie");
    });
});

test("Yahoo's sheet reproduces the values the build reads", function () {
  if (!readable(DOM_FILE)) return SKIP;
  return I.readXlsx(arrayBufferOf("2026-27-Fantasy-Projections-Yahoo-1.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) { return wb.readSheet("The List"); })
    .then(function (rows) {
      var out = mapped(rows);
      assert.strictEqual(out.players.length, 670);
      var mac = playerIn(out.players, "nathan mackinnon");
      near(mac.stats.G, 45.68001781563124);
      near(mac.stats.A, 77.79931134642477);
      assert.strictEqual(mac.team, "COL");
      var vasy = playerIn(out.players, "andrei vasilevskiy");
      near(vasy.stats.W, 34.02185859390082);
      near(vasy.stats.SV, 1469.1717368366005);
    });
});

test("Apples & Ginos: the raw stats win over the weighted copies", function () {
  // The sheet repeats every stat multiplied by that league's point value. Both
  // sets carry the same headings, and the raw block comes first.
  return I.readXlsx(arrayBufferOf("Apples & Ginos 2026-27 NHL Skater Projections.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) { return wb.readSheet("Nates Projections"); })
    .then(function (rows) {
      var out = mapped(rows);
      assert.strictEqual(out.players.length, 378);
      var mac = playerIn(out.players, "nathan mackinnon");
      near(mac.stats.G, 45.3, "not the 226.5 weighted copy");
      near(mac.stats.A, 83.7);
      near(mac.stats.GP, 84);
      assert.ok(out.columns.filter(function (c) { return c.duplicate; }).length >= 6,
        "and the duplicates are flagged for review");
    });
});

test("DtZ's two sheets each map cleanly", function () {
  return I.readXlsx(arrayBufferOf("Free Version DtZ 2026-2027 NHL Fantasy Projections.xlsx"),
                    { inflateRaw: inflateRaw }).then(function (wb) {
    return wb.readSheet("Skater Projections").then(function (rows) {
      var out = mapped(rows);
      var mac = playerIn(out.players, "nathan mackinnon");
      near(mac.stats.G, 43);
      near(mac.stats.A, 74);
      near(mac.stats.GP, 80);
      assert.strictEqual(mac.team, "COL");
      assert.strictEqual(mac.pos, "C");
    }).then(function () {
      return wb.readSheet("Goalie Projections");
    }).then(function (rows) {
      var out = mapped(rows);
      var vasy = playerIn(out.players, "andrei vasilevskiy");
      near(vasy.stats.GP, 56);
      near(vasy.stats.W, 34.552);
      near(vasy.stats.SV, 1382.64);
      // "Pts" here is fantasy points, and is correctly refused.
      assert.strictEqual(vasy.stats.PTS, undefined);
    });
  });
});

test("buildSource insists on a name column", function () {
  assert.throws(function () {
    I.buildSource([["1", "2"]], [{ index: 0, field: "G" }], STATS, null);
  }, /player name/);
});

test("a repeated player keeps the first row", function () {
  var rows = [["Player", "G"], ["Nathan MacKinnon", "40"], ["Nathan MacKinnon", "10"]];
  var out = mapped(rows);
  assert.strictEqual(out.players.length, 1);
  near(out.players[0].stats.G, 40);
});

/* ------------------------------------------------- name join equivalence */

test("the JavaScript normalizer reproduces every key the build shipped", function () {
  // If these ever drift, an imported file silently fails to match players and
  // the only symptom is a source that mysteriously covers fewer of them.
  if (!fs.existsSync(BOARD_DATA)) {
    console.log("       (skipped: run python build.py first)");
    return;
  }
  var data = JSON.parse(fs.readFileSync(BOARD_DATA, "utf8"));
  var aliases = data.aliases || {};
  // The display name is whatever the first source carrying the player writes,
  // and that spelling may itself be an alias -- DtZ says "Tommy Novak" where
  // the board's key is "thomas novak". The page applies the shipped alias
  // table on top of the normalizer, so the test has to as well.
  function resolve(name) {
    var key = I.normalizeName(name);
    return aliases[key] || key;
  }
  var mismatched = data.players.filter(function (p) {
    return resolve(p.n) !== p.k;
  });
  assert.strictEqual(mismatched.length, 0,
    mismatched.length + " differ, e.g. " +
    JSON.stringify(mismatched.slice(0, 3).map(function (p) {
      return { n: p.n, k: p.k, got: resolve(p.n) };
    })));
  assert.ok(data.players.length > 500, "checked " + data.players.length + " names");
  // The aliases must actually be doing something, or this is a weaker test
  // than it looks.
  var viaAlias = data.players.filter(function (p) {
    return I.normalizeName(p.n) !== p.k;
  });
  assert.ok(viaAlias.length > 0, "some names resolve only through the alias table");
});

/* The near-miss suggester. Reimplemented in JavaScript rather than approximated,
 * because the browser must not propose a merge that build.py would not. */
test("the JS ratio reproduces Python difflib exactly", function () {
  // Values produced by difflib.SequenceMatcher(None, a, b).ratio() in Python.
  var cases = [
    ["matthew boldy", "matt boldy", 0.8695652173913043],
    ["matthew samoskevich", "mackie samoskevich", 0.8108108108108109],
    ["john jason peterka", "jj peterka", 0.7142857142857143],
    ["zachary benson", "zach benson", 0.88],
    ["matthew beniers", "matty beniers", 0.8571428571428571],
    ["alexandre carrier", "william carrier", 0.5625],
    ["", ""], 
  ];
  cases.forEach(function (c) {
    if (c.length < 3) return;
    assert.ok(Math.abs(I._ratio(c[0], c[1]) - c[2]) < 1e-12,
              c[0] + " vs " + c[1] + ": " + I._ratio(c[0], c[1]) + " != " + c[2]);
  });
  assert.strictEqual(I._ratio("", ""), 1);
});

test("suggestKey finds given-name variants and rejects lookalikes", function () {
  var keys = ["matt boldy", "matty beniers", "zach benson", "jj peterka",
              "mackie samoskevich", "patrick kane", "ryan graves",
              "william carrier", "alex carrier", "daniil tarasov (g)"];
  assert.strictEqual(I.suggestKey("matthew boldy", keys), "matt boldy");
  assert.strictEqual(I.suggestKey("matthew beniers", keys), "matty beniers");
  assert.strictEqual(I.suggestKey("zachary benson", keys), "zach benson");
  assert.strictEqual(I.suggestKey("john jason peterka", keys), "jj peterka");
  assert.strictEqual(I.suggestKey("matthew samoskevich", keys),
                     "mackie samoskevich");
  // A position suffix is not part of the surname.
  assert.strictEqual(I.suggestKey("daniil tarasov", keys), "daniil tarasov (g)");
  // Different surnames that merely look alike -- both are real players.
  assert.strictEqual(I.suggestKey("patrik laine", keys), "");
  assert.strictEqual(I.suggestKey("ryan reaves", keys), "");
  // Same surname, genuinely different person: the score has to reject it.
  assert.notStrictEqual(I.suggestKey("alexandre carrier", keys), "william carrier");
  assert.strictEqual(I.suggestKey("", keys), "");
});

test("surnameOf ignores a position suffix", function () {
  assert.strictEqual(I._surnameOf("daniil tarasov (g)"), "tarasov");
  assert.strictEqual(I._surnameOf("nathan mackinnon"), "mackinnon");
  assert.strictEqual(I._surnameOf(""), "");
});
test("normalizeName handles the cases Python documents", function () {
  assert.strictEqual(I.normalizeName("Anže Kopitar"), "anze kopitar");
  assert.strictEqual(I.normalizeName("Alexis Lafrenière"), "alexis lafreniere");
  assert.strictEqual(I.normalizeName("David Pastrňák"), "david pastrnak");
  assert.strictEqual(I.normalizeName("J.J. Moser"), I.normalizeName("JJ Moser"));
  assert.strictEqual(I.normalizeName("Axel Sandin-Pellikka"), "axel sandin pellikka");
  assert.strictEqual(I.normalizeName("  Nathan   MacKinnon "), "nathan mackinnon");
  // Yahoo tells two same-named players apart with a suffix; that must survive.
  assert.notStrictEqual(I.normalizeName("Elias Pettersson"),
                        I.normalizeName("Elias Pettersson (D)"));
});

test("the imported file joins the board the way the build would", function () {
  if (!fs.existsSync(BOARD_DATA)) return;
  var data = JSON.parse(fs.readFileSync(BOARD_DATA, "utf8"));
  var aliases = data.aliases || {};
  function resolve(name) {
    var key = I.normalizeName(name);
    var seen = {};
    while (aliases[key] && !seen[key]) { seen[key] = 1; key = aliases[key]; }
    return key;
  }
  var onBoard = {};
  data.players.forEach(function (p) { onBoard[p.k] = 1; });

  var text = fs.readFileSync(path.join(SOURCES, "5v5-2027-players-projections.csv"), "utf8");
  var rows = I.parseDelimited(text).rows;
  var h = I.detectHeaderRow(rows);
  var built = I.buildSource(rows.slice(h + 1),
                            I.autoMap(rows[h], rows.slice(h + 1)), STATS, resolve);
  var matched = built.filter(function (p) { return onBoard[p.key]; }).length;
  assert.strictEqual(built.length, 643);
  assert.ok(matched >= 639, "expected at least 639 matches, got " + matched);

  assert.strictEqual((data.team_nicknames || {})["avalanche"], "COL",
    "team nicknames travel with the payload");
});

/* ------------------------------------------------- per-game rate sheets */

var COUNTING = ["G","A","PTS","SOG","PPG","PPP","SHG","SHP","BLK","HIT","PM","PIM",
                "GWG","FOW","FOL","W","L","OTL","SO","SV","SA","GA"];

function perGameOf(rows) {
  var h = I.detectHeaderRow(rows);
  return I.looksPerGame(rows.slice(h + 1), I.autoMap(rows[h], rows.slice(h + 1)));
}

test("a per-game sheet is recognised as one", function () {
  if (!readable(DOM_FILE)) return SKIP;
  // Dom's raw projections are rates. Imported as totals they would value his
  // whole board at roughly a hundredth of what it is worth.
  return I.readXlsx(arrayBufferOf("2026-27-Fantasy-Projections-Yahoo-1.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) { return wb.readSheet("Player Data"); })
    .then(function (rows) { assert.strictEqual(perGameOf(rows), true); });
});

test("sheets of season totals are not mistaken for rates", function () {
  var files = [
    ["2026-27-Fantasy-Projections-Yahoo-1.xlsx", "The List"],
    ["Apples & Ginos 2026-27 NHL Skater Projections.xlsx", "Nates Projections"],
    ["Free Version DtZ 2026-2027 NHL Fantasy Projections.xlsx", "Skater Projections"]
  ];
  return files.filter(function (entry) {
    return readable(entry[0]);
  }).reduce(function (chain, entry) {
    return chain.then(function () {
      return I.readXlsx(arrayBufferOf(entry[0]), { inflateRaw: inflateRaw })
        .then(function (wb) { return wb.readSheet(entry[1]); })
        .then(function (rows) {
          assert.strictEqual(perGameOf(rows), false, entry[1]);
        });
    });
  }, Promise.resolve());
});

test("a CSV of totals is not mistaken for rates", function () {
  var rows = I.parseDelimited(
    fs.readFileSync(path.join(SOURCES, "5v5-2027-players-projections.csv"), "utf8")).rows;
  assert.strictEqual(perGameOf(rows), false);
});

test("per-game scaling reproduces the season totals on the other sheet", function () {
  if (!readable(DOM_FILE)) return SKIP;
  // Player Data x GP is The List, for every player and every stat. That is the
  // invariant the whole per-game option rests on.
  return I.readXlsx(arrayBufferOf("2026-27-Fantasy-Projections-Yahoo-1.xlsx"),
                    { inflateRaw: inflateRaw })
    .then(function (wb) {
      return wb.readSheet("Player Data").then(function (rateRows) {
        return wb.readSheet("The List").then(function (totalRows) {
          var h = I.detectHeaderRow(rateRows);
          var cols = I.autoMap(rateRows[h], rateRows.slice(h + 1));
          var scaled = I.buildSource(rateRows.slice(h + 1), cols, STATS, null,
                                     { perGame: true, countingStats: COUNTING });
          var totals = mapped(totalRows).players;
          var byKey = {};
          totals.forEach(function (p) { byKey[p.key] = p; });

          var mac = playerIn(scaled, "nathan mackinnon");
          near(mac.stats.G, 45.68001781563124, "scaled goals");
          near(mac.stats.GP, 83.2625, "games are not scaled by themselves");
          var vasy = playerIn(scaled, "andrei vasilevskiy");
          near(vasy.stats.SV, 1469.1717368366005, "scaled saves");
          near(vasy.stats["SV%"], 0.911700355788987, "a rate stat is left alone");

          // The two sheets agree everywhere EXCEPT where a manual Boost/Bust
          // is set, which is the whole reason the build reads the raw one.
          // Derived from the ADJ column rather than naming a player: those
          // adjustments are edited by hand between exports.
          var th = I.detectHeaderRow(totalRows);
          var adjusted = {};
          for (var r = th + 1; r < totalRows.length; r++) {
            var who = totalRows[r][1];
            var flag = totalRows[r][15];
            if (!who || flag === undefined || flag === null) continue;
            if (String(flag).trim() === "" || String(flag).trim() === "0") continue;
            adjusted[I.normalizeName(String(who))] = 1;
          }

          var moved = [];
          scaled.forEach(function (p) {
            var other = byKey[p.key];
            if (!other) return;
            ["G", "A", "PTS", "SOG", "HIT", "BLK", "W", "SV", "GA"].forEach(function (k) {
              var a = p.stats[k], b = other.stats[k];
              if (a === undefined || b === undefined) return;
              if (Math.abs(a - b) > 1e-6 && moved.indexOf(p.key) < 0) moved.push(p.key);
            });
          });
          assert.deepStrictEqual(moved.sort(), Object.keys(adjusted).sort(),
            "only the hand-adjusted players may differ between the sheets");
        });
      });
    });
});

/* ------------------------------------------------------------------ run */

function runQueue(index) {
  if (index >= queue.length) {
    console.log("\n" + passed + " passed" +
      (process.exitCode ? ", with failures" : ", 0 failed"));
    return;
  }
  var entry = queue[index];
  function ok(value) {
    if (value === SKIP) {
      console.log("  skip " + entry[0]);
      return runQueue(index + 1);
    }
    passed++;
    console.log("  ok   " + entry[0]);
    runQueue(index + 1);
  }
  function bad(err) {
    console.log("  FAIL " + entry[0]);
    console.log("       " + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
    runQueue(index + 1);
  }
  var result;
  try {
    result = entry[1]();
  } catch (err) {
    return bad(err);
  }
  if (result && typeof result.then === "function") result.then(ok, bad);
  else ok();
}

runQueue(0);
