/* Tests for board/valuation.js -- run with: node tests/test_valuation.js
 *
 * Every expected number here is hand-computed in the comments so a failure
 * tells you which assumption broke, not just that two floats differ.
 */
"use strict";

var assert = require("assert");
var path = require("path");
var V = require(path.join(__dirname, "..", "board", "valuation.js"));

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok   " + name);
  } catch (err) {
    console.log("  FAIL " + name);
    console.log("       " + err.message);
    process.exitCode = 1;
  }
}
function near(actual, expected, msg, eps) {
  assert.ok(
    Math.abs(actual - expected) < (eps === undefined ? 1e-9 : eps),
    (msg || "value") + ": expected " + expected + ", got " + actual
  );
}

/* ------------------------------------------------------------------ fixture */
/* Three stats, two sources. S2 does not publish assists for player X and has no
 * line at all for player Y -- the two ways a source can be absent. */
var fixture = {
  stats: ["GP", "G", "A"],
  counting_stats: ["G", "A"],
  rate_stats: [],
  sources: [{ id: "S1", name: "One" }, { id: "S2", name: "Two" }],
  meta: {},
  players: [
    { n: "X", t: "AAA", p: ["C"], s: { S1: [80, 40, 40], S2: [100, 50, null] } },
    { n: "Y", t: "BBB", p: ["C"], s: { S1: [82, 30, 30] } }
  ]
};
var model = V.createModel(fixture);
var X = model.players[0];
var Y = model.players[1];
var equalWeights = { S1: 1, S2: 1 };

/* ----------------------------------------------------------- weighted blend */

test("weightedMean skips sources with no value", function () {
  // Only S1 reports, so the S2 weight must not appear in the denominator.
  var v = V.weightedMean(["S1", "S2"], equalWeights, function (sid) {
    return sid === "S1" ? 40 : null;
  });
  near(v, 40, "single-source mean");
});

test("weightedMean skips zero-weighted sources", function () {
  var v = V.weightedMean(["S1", "S2"], { S1: 1, S2: 0 }, function (sid) {
    return sid === "S1" ? 40 : 100;
  });
  near(v, 40, "zeroed source must not contribute");
});

test("weightedMean returns null when nothing contributes", function () {
  var v = V.weightedMean(["S1"], equalWeights, function () { return null; });
  assert.strictEqual(v, null);
});

test("totals mode averages season totals", function () {
  var line = V.blendPlayer(X, model, { weights: equalWeights, gpModel: "totals" });
  near(line[0], 90, "GP (80+100)/2");
  near(line[1], 45, "G (40+50)/2");
  near(line[2], 40, "A: only S1 reports, so the average is S1's value");
});

test("totals mode honours unequal weights", function () {
  var line = V.blendPlayer(X, model, { weights: { S1: 3, S2: 1 }, gpModel: "totals" });
  near(line[0], 85, "GP (3*80 + 1*100)/4");
  near(line[1], 42.5, "G (3*40 + 1*50)/4");
});

test("rate mode blends per-game rates then re-applies blended GP", function () {
  var line = V.blendPlayer(X, model, {
    weights: equalWeights, gpModel: "rate_blended_gp"
  });
  // GP 90. G rate (40/80 + 50/100)/2 = 0.5 -> 45. A rate (40/80)/1 = 0.5 -> 45.
  near(line[0], 90, "GP");
  near(line[1], 45, "G");
  near(line[2], 45, "A must be rate-scaled up, unlike totals mode's 40");
});

test("rate_source_gp takes games from the chosen source only", function () {
  var line = V.blendPlayer(X, model, {
    weights: equalWeights, gpModel: "rate_source_gp", gpSource: "S2"
  });
  // GP is S2's 100; rates are still blended across both sources at 0.5/gp.
  near(line[0], 100, "GP from S2 alone");
  near(line[1], 50, "G 0.5 * 100");
  near(line[2], 50, "A 0.5 * 100");
});

test("rate_source_gp falls back when the chosen source has no line", function () {
  var line = V.blendPlayer(Y, model, {
    weights: equalWeights, gpModel: "rate_source_gp", gpSource: "S2"
  });
  // Y is missing from S2 entirely; dropping to zero games would erase them.
  near(line[0], 82, "GP falls back to the sources that do have Y");
  near(line[1], 30, "G");
});

test("GP itself is never rate-scaled", function () {
  var totals = V.blendPlayer(X, model, { weights: equalWeights, gpModel: "totals" });
  var rates = V.blendPlayer(X, model, { weights: equalWeights, gpModel: "rate_blended_gp" });
  near(totals[0], rates[0], "GP identical in both modes");
});

/* ------------------------------------------------------------------ scoring */

test("fantasyPoints applies per-stat values and ignores nulls", function () {
  var line = [80, 40, 40];
  near(V.fantasyPoints(line, model, { G: 4, A: 2.5 }), 260, "40*4 + 40*2.5");
  near(V.fantasyPoints([80, 40, null], model, { G: 4, A: 2.5 }), 160, "null assists add nothing");
  near(V.fantasyPoints(line, model, {}), 0, "empty scoring scores nothing");
});

/* Defence points: an extra award on every point a defenceman scores, on top of
   the goal and assist values. The one positional term in the scoring. */

var withPts = V.createModel({
  meta: {}, stats: ["GP", "G", "A", "PTS"], counting_stats: ["G", "A", "PTS"],
  rate_stats: [], sources: [{ id: "S1", name: "S1" }],
  players: [{ n: "D Man", t: "COL", p: ["D"], k: "d man",
              s: { S1: [80, 10, 30, 40] } }],
  config: {}
});

test("defence points award on top, for defencemen only", function () {
  var line = [80, 10, 30, 40];
  var scoring = { G: 4, A: 2.5, DPT: 1 };
  // 10*4 + 30*2.5 = 115 either way; the D bonus is the 40 points on top.
  near(V.fantasyPoints(line, withPts, scoring, false), 115, "a forward gets nothing extra");
  near(V.fantasyPoints(line, withPts, scoring, true), 155, "a defenceman gets PTS x DPT");
});

test("defence points do nothing when the value is zero", function () {
  var line = [80, 10, 30, 40];
  near(V.fantasyPoints(line, withPts, { G: 4, A: 2.5, DPT: 0 }, true), 115,
       "the category is off by default and must cost nothing");
});

test("defence points fall back to goals + assists without a points column", function () {
  // An imported file may map G and A but no PTS. Awarding nothing there would
  // look like the setting had been ignored.
  near(V.fantasyPoints([80, 10, 30], model, { DPT: 1 }, true), 40, "10 + 30");
  near(V.fantasyPoints([80, 10, null], model, { DPT: 1 }, true), 10, "missing assists count as none");
  near(V.fantasyPoints([80, null, null], model, { DPT: 1 }, true), 0, "no goals or assists, no award");
});

test("defence points scale with the value", function () {
  var line = [80, 10, 30, 40];
  near(V.fantasyPoints(line, withPts, { DPT: 0.5 }, true), 20, "40 * 0.5");
  near(V.fantasyPoints(line, withPts, { DPT: -1 }, true), -40, "a negative value is honoured too");
});

/* -------------------------------------------------------- replacement level */

test("positionalSlots reproduces the reference sheet's standard league", function () {
  var s = V.positionalSlots(
    { C: 2, LW: 2, RW: 2, W: 0, F: 0, D: 4, UTIL: 0, G: 2, BN: 4 }, 12
  );
  // Per team: 2 + 4*(2/3)/3 = 2.889 forwards each, 4 + 4/6 = 4.667 D, 2.667 G.
  near(s.C / 12, 2.888888888888889, "C per team", 1e-9);
  near(s.LW / 12, 2.888888888888889, "LW per team", 1e-9);
  near(s.D / 12, 4.666666666666667, "D per team", 1e-9);
  near(s.G / 12, 2.6666666666666665, "G per team", 1e-9);
  near(s.C, 34.666666666666664, "C league-wide", 1e-9);
  near(s.D, 56, "D league-wide", 1e-9);
  near(s.G, 32, "G league-wide", 1e-9);
});

test("positionalSlots sends W to wings and F across all forwards", function () {
  var s = V.positionalSlots({ C: 1, LW: 0, RW: 0, W: 2, F: 3, D: 0, G: 0, BN: 0 }, 1);
  near(s.C, 1 + 1, "C gets its own slot plus F/3");
  near(s.LW, 1 + 1, "LW gets W/2 plus F/3");
  near(s.RW, 1 + 1, "RW gets W/2 plus F/3");
});

test("positionalSlots does not split dedicated slots evenly", function () {
  // A 3C/1LW/1RW lineup must not report 1.667 at every forward spot.
  var s = V.positionalSlots({ C: 3, LW: 1, RW: 1, D: 0, G: 0, BN: 0 }, 1);
  near(s.C, 3, "C keeps all three");
  near(s.LW, 1, "LW keeps one");
});

test("replacementByPosition is the first player past the starters", function () {
  // 2 teams x 1 C: two centres start, so replacement is the third best.
  var pool = [100, 90, 80, 70, 60].map(function (fp, i) {
    return { id: i, fp: fp, posSet: { C: true } };
  });
  var repl = V.replacementByPosition(pool, { C: 1, D: 1, G: 1 }, 2);
  near(repl.level.C, 80, "third-best centre");
  assert.strictEqual(repl.depth.C, 3, "and reports that it was the 3rd best");
});

test("positionalSlots can exclude bench spots", function () {
  var slots = { C: 2, LW: 2, RW: 2, W: 0, F: 0, D: 4, UTIL: 0, G: 2, BN: 4 };
  var withBench = V.positionalSlots(slots, 12, true);
  var starters = V.positionalSlots(slots, 12, false);
  // Starters-only is what the Yahoo workbook assumes: 12 x 4 D and 12 x 2 G.
  near(starters.D, 48, "D starters only");
  near(starters.G, 24, "G starters only");
  near(starters.C, 24, "C starters only");
  assert.ok(withBench.D > starters.D && withBench.G > starters.G,
    "counting the bench must reach deeper");
});

test("bestVorp takes the most valuable eligible position", function () {
  var repl = { C: 100, LW: 60, RW: 0, D: 0, G: 0 };
  var dual = { fp: 120, posSet: { C: true, LW: true } };
  near(V.bestVorp(dual, repl), 60, "LW surplus (60) beats C surplus (20)");
  var only = { fp: 120, posSet: { C: true } };
  near(V.bestVorp(only, repl), 20, "single position uses that position");
});

/* -------------------------------------------------------------------- tiers */

function tiersOf(values, k, window) {
  var ranked = values.map(function (v) { return { vorp: v }; });
  V.assignTiers(ranked, k, window);
  return ranked.map(function (r) { return r.tier; });
}

test("assignTiers cuts at unusually large gaps", function () {
  var tiers = tiersOf([100, 99, 98, 60, 59, 58], 1.0);
  assert.deepStrictEqual(tiers, [1, 1, 1, 2, 2, 2],
    "one cut, at the 38-point cliff");
});

/* Regression: an earlier version enforced a minimum of two players per tier and
 * reset a counter after each cut, so a large gap immediately following another
 * large gap was silently ignored. On the real board that swallowed 14 genuine
 * cliffs inside the top 40 of each position -- Kucherov to Pastrnak is 39 VORP
 * and they shared a tier -- and put several boundaries a row late. */
test("consecutive cliffs each start a tier", function () {
  // Two 30-point drops back to back, against a body of 1-3 point gaps -- the
  // shape of the real board, where Celebrini to Matthews (26.4) followed
  // Celebrini's own cut and used to be swallowed.
  var gaps = [30, 30, 1, 2, 3, 2, 1, 3, 2, 1, 2, 3];
  var values = [200];
  gaps.forEach(function (g) { values.push(values[values.length - 1] - g); });

  var tiers = tiersOf(values, 1.0);
  assert.strictEqual(tiers[1], 2, "first cliff cuts");
  assert.strictEqual(tiers[2], 3, "so does the second, immediately after it");
  assert.strictEqual(tiers[3], 3, "and the tight group below stays together");
  assert.strictEqual(Math.max.apply(null, tiers), 3, tiers.join(","));
});

test("a tier of one is allowed", function () {
  // A player clear of the field really is a tier by themselves.
  var tiers = tiersOf([200, 100, 99, 98, 97], 1.0);
  assert.strictEqual(tiers[0], 1);
  assert.strictEqual(tiers[1], 2, "the runaway leader stands alone");
  assert.deepStrictEqual(tiers.slice(1), [2, 2, 2, 2]);
});

/* The threshold is calibrated on the draftable range only. Past replacement
 * level players are interchangeable and their near-zero gaps would otherwise
 * drag the threshold down until the top of the board shattered into slivers. */
test("assignTiers calibrates on the window, not the whole list", function () {
  var top = [100, 90, 80, 70, 60];          // gaps of 10
  var tail = [];
  for (var i = 0; i < 200; i++) tail.push(59.9 - i * 0.01);   // gaps of 0.01

  var windowed = tiersOf(top.concat(tail), 1.0, top.length);
  var everything = tiersOf(top.concat(tail), 1.0);

  assert.strictEqual(windowed[1], 1,
    "against a typical gap of 10, another 10 is not a cliff");
  assert.ok(everything[1] > 1,
    "calibrating on the flat tail makes every top gap look enormous");
});

/* Gaps are heavily right-skewed -- on the real board the top 57 centres have a
 * mean gap of 5.0, a median of 3.5 and a standard deviation of 7.2, because a
 * few enormous gaps at the very top set the scale. A mean/stdev threshold lands
 * at 12.2, which almost nothing clears, leaving the whole middle of the board
 * as one block. Median and MAD ignore those outliers. */
test("one huge gap does not swamp the threshold", function () {
  // A 500-point chasm, then a clean 20-point cliff among 2-point gaps.
  var values = [1000, 500, 498, 496, 494, 474, 472, 470];
  var tiers = tiersOf(values, 1.0);
  assert.strictEqual(tiers[1], 2, "the chasm cuts");
  assert.ok(tiers[5] > tiers[4],
    "and the 20-point cliff still cuts despite the chasm, got " + tiers.join(","));
});

test("assignTiers survives a degenerate spread", function () {
  // Every gap identical, so the median absolute deviation is zero.
  var tiers = tiersOf([50, 40, 30, 20, 10], 1.0);
  assert.deepStrictEqual(tiers, [1, 1, 1, 1, 1],
    "evenly spaced players have no cliff between them");
});

test("tier sensitivity raises the bar", function () {
  var values = [100, 90, 85, 83, 60, 58, 57, 40];
  var sensitive = tiersOf(values, 0.5);
  var relaxed = tiersOf(values, 3.0);
  assert.ok(Math.max.apply(null, sensitive) >= Math.max.apply(null, relaxed),
    "a higher k must never produce more tiers (" +
    sensitive.join(",") + " vs " + relaxed.join(",") + ")");
});

test("assignTiers handles degenerate lists", function () {
  var one = [{ vorp: 5 }];
  V.assignTiers(one, 1.0);
  assert.strictEqual(one[0].tier, 1);
  V.assignTiers([], 1.0); // must not throw
});

/* ------------------------------------------------------------- end-to-end */

function board(n) {
  // n centres and n defencemen with clean, separated point totals.
  var players = [];
  for (var i = 0; i < n; i++) {
    players.push({ n: "C" + i, t: "AAA", p: ["C"], s: { S1: [82, 40 - i, 0] } });
  }
  for (var j = 0; j < n; j++) {
    players.push({ n: "D" + j, t: "BBB", p: ["D"], s: { S1: [82, 20 - j, 0] } });
  }
  return V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {}, players: players
  });
}

var baseSettings = {
  weights: { S1: 1 },
  scoring: { G: 1 },
  gpModel: "totals",
  teams: 2,
  slots: { C: 1, D: 1, G: 0, BN: 0 },
  replacementMethod: "position",
  tierK: 1.0
};

test("compute ranks, labels positions, and assigns tiers", function () {
  var out = V.compute(board(8), baseSettings);
  assert.strictEqual(out.rows.length, 16);
  assert.strictEqual(out.rows[0].rank, 1);
  assert.strictEqual(out.rows[0].prnk, "C1", "top player is the best centre");
  // 2 teams x 1 C -> replacement is the 3rd centre (38 pts); best centre is 40.
  near(out.replacement.C, 38, "C replacement");
  near(out.rows[0].vorp, 2, "top centre VORP");
  assert.ok(out.rows[0].tier >= 1);
});

test("compute gives multi-position players their best surplus", function () {
  var m = V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {},
    players: [
      { n: "cOnly", t: "A", p: ["C"], s: { S1: [82, 40, 0] } },
      { n: "cA", t: "A", p: ["C"], s: { S1: [82, 39, 0] } },
      { n: "cB", t: "A", p: ["C"], s: { S1: [82, 38, 0] } },
      { n: "dual", t: "A", p: ["C", "D"], s: { S1: [82, 37, 0] } },
      { n: "d1", t: "A", p: ["D"], s: { S1: [82, 10, 0] } },
      { n: "d2", t: "A", p: ["D"], s: { S1: [82, 9, 0] } },
      { n: "d3", t: "A", p: ["D"], s: { S1: [82, 8, 0] } }
    ]
  });
  var out = V.compute(m, baseSettings);
  var dual = out.rows.filter(function (r) { return r.name === "dual"; })[0];
  // C replacement is the 3rd centre; D replacement is the 3rd D (9 pts), so the
  // dual-eligible player is worth far more as a defenceman.
  assert.strictEqual(dual.bestPos, "D", "dual player is most valuable at D");
  near(dual.vorp, 37 - 9, "surplus measured against D");
  assert.ok(dual.prnk.indexOf("C") === 0 && dual.prnk.indexOf("D") > 0,
    "position ranks list both eligibilities, got " + dual.prnk);
});

test("draft-based replacement digs deeper than the raw slot count", function () {
  // Twelve teams starting 2C/2LW/2RW absorb ~104 forwards. Because most of them
  // are eligible at more than one forward spot, far more than 35 centres come
  // off the board, so the centre pool is drained deeper than slot math implies.
  var players = [];
  for (var i = 0; i < 200; i++) {
    // Alternate single- and dual-eligible forwards.
    var pos = i % 2 === 0 ? ["C"] : ["C", "LW"];
    players.push({ n: "F" + i, t: "A", p: pos, s: { S1: [82, 200 - i, 0] } });
  }
  var m = V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {}, players: players
  });
  var settings = {
    weights: { S1: 1 }, scoring: { G: 1 }, gpModel: "totals", teams: 12,
    slots: { C: 2, LW: 2, RW: 2, D: 0, G: 0, BN: 0 }, tierK: 1
  };
  var byPosition = V.compute(m, Object.assign({}, settings, {
    replacementMethod: "position"
  }));
  var byDraft = V.compute(m, Object.assign({}, settings, {
    replacementMethod: "draft"
  }));
  assert.ok(byDraft.replacement.C < byPosition.replacement.C,
    "draft-based must reach a worse centre than the slot count alone (" +
    byDraft.replacement.C + " vs " + byPosition.replacement.C + ")");
});

/* Regression: an earlier draft-based implementation ranked the drafted slice by
 * VORP, which is circular -- a shallow forward replacement suppresses forward
 * VORP, which lets goalies and defencemen fill the slice, which pushes the
 * forward replacement shallower still.
 *
 * The fixture below is symmetric by construction: the C, LW and RW pools are
 * built from the same score curve, so their replacement levels must come out
 * nearly equal. The old code produced C 409 / LW 412 / RW 310 and a top 24 made
 * up of 16 right wings and 8 goalies, with no centre at all. */
test("draft-based replacement stays stable across symmetric forward pools", function () {
  var players = [];
  for (var i = 0; i < 260; i++) {
    var r = i % 4;
    var pos = r === 0 ? ["C"] : r === 1 ? ["LW"] : r === 2 ? ["RW"] : ["C", "LW"];
    players.push({ n: "F" + i, t: "A", p: pos, s: { S1: [82, 520 - i * 1.4, 0] } });
  }
  for (var j = 0; j < 200; j++) {
    players.push({ n: "D" + j, t: "A", p: ["D"], s: { S1: [82, 400 - j * 1.1, 0] } });
  }
  // A shallow goalie pool with a steep curve is what triggered the collapse:
  // the top goalies show enormous VORP and crowd every forward out of the slice.
  for (var g = 0; g < 64; g++) {
    players.push({ n: "G" + g, t: "A", p: ["G"], s: { S1: [60, 390 - g * 4.5, 0] } });
  }

  var m = V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {}, players: players
  });
  var out = V.compute(m, {
    weights: { S1: 1 }, scoring: { G: 1 }, gpModel: "totals", teams: 12,
    slots: { C: 2, LW: 2, RW: 2, W: 0, F: 0, D: 4, UTIL: 0, G: 2, BN: 4 },
    replacementMethod: "draft", tierK: 1
  });

  var forwardLevels = [out.replacement.C, out.replacement.LW, out.replacement.RW];
  var spread = Math.max.apply(null, forwardLevels) - Math.min.apply(null, forwardLevels);
  assert.ok(spread < 20,
    "symmetric forward pools must yield similar replacement levels, spread was " +
    spread.toFixed(1) + " (" + forwardLevels.map(function (v) {
      return v.toFixed(1);
    }).join(" / ") + ")");

  var top24 = out.rows.slice(0, 24);
  ["C", "LW", "RW"].forEach(function (pos) {
    assert.ok(top24.some(function (r) { return r.bestPos === pos; }),
      "no " + pos + " reached the top 24 -- the forward pool collapsed");
  });
});

/* --------------------------------------------------------------- live view */

/* Fixture with a shallow goalie pool, which is where the two candidate models
 * for live scarcity disagree most sharply. */
function boardWithGoalies() {
  var players = [];
  for (var i = 0; i < 60; i++) {
    players.push({ n: "F" + i, t: "A", p: [["C", "LW", "RW"][i % 3]],
                   s: { S1: [82, 500 - i * 2, 0] } });
  }
  for (var j = 0; j < 40; j++) {
    players.push({ n: "D" + j, t: "A", p: ["D"], s: { S1: [82, 300 - j * 2, 0] } });
  }
  for (var g = 0; g < 24; g++) {
    players.push({ n: "G" + g, t: "A", p: ["G"], s: { S1: [60, 300 - g * 8, 0] } });
  }
  return V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {}, players: players
  });
}

// 4 teams x (1C 1D 1G) -> 4 forward spots, 4 D spots, 4 G spots.
var liveSettings = {
  weights: { S1: 1 }, scoring: { G: 1 }, gpModel: "totals", teams: 4,
  slots: { C: 1, D: 1, G: 1, BN: 0 }, replacementMethod: "draft", tierK: 1
};

function draftNamed(model, names) {
  var base = V.compute(model, liveSettings);
  var drafted = {};
  base.rows.forEach(function (r) { if (names.indexOf(r.name) >= 0) drafted[r.id] = true; });
  return {
    before: base,
    after: V.compute(model, Object.assign({}, liveSettings, {
      dynamic: true, drafted: drafted
    }))
  };
}

test("dynamic mode leaves untouched positions alone", function () {
  var m = boardWithGoalies();
  var r = draftNamed(m, ["G0", "G1"]);
  assert.strictEqual(r.after.draftedCount, 2);
  near(r.after.replacement.D, r.before.replacement.D,
    "defence is untouched when only goalies are taken");
  near(r.after.replacement.C, r.before.replacement.C,
    "centres are untouched too");
});

/* Replacement level is the marginal ROSTERED player at a position. Under an
 * efficient draft its identity is fixed before the first pick, so the number
 * must not move -- removing the top k while asking for the (n-k)th of the
 * remainder lands on the same player.
 *
 * A previous version treated that invariance as a bug and held demand at the
 * full league count to force movement. The two tests after this one are the
 * cases that broke. */
test("efficient drafting does not move replacement level", function () {
  var m = boardWithGoalies();
  var r = draftNamed(m, ["G0", "G1", "G2"]);
  near(r.after.replacement.G, r.before.replacement.G,
    "taking the best three goalies teaches you nothing new");
});

test("oversaturating a position drives replacement to best-available", function () {
  var m = boardWithGoalies();
  // 4 goalie spots exist league-wide; take 6, so demand is exhausted.
  var taken = ["G0", "G1", "G2", "G3", "G4", "G5"];
  var r = draftNamed(m, taken);
  var bestLeft = r.after.rows.filter(function (x) { return x.name === "G6"; })[0];
  near(r.after.replacement.G, bestLeft.fp,
    "with no goalie spots left, replacement is the best one still available");
  // Every goalie STILL on the board is now worthless -- nobody needs one. The
  // ones already drafted keep their value; they were bought before the run.
  r.after.rows.forEach(function (x) {
    if (x.bestPos !== "G" || taken.indexOf(x.name) >= 0) return;
    assert.ok(x.vorp <= 1e-9,
      x.name + " should be worth nothing once no team needs a goalie, got " + x.vorp);
  });
});

test("spots burned on weak players raise replacement level", function () {
  var m = boardWithGoalies();
  // Two of the WORST goalies are taken. Those roster spots are gone, so the
  // marginal rostered goalie is now better and the surplus above them shrinks.
  var r = draftNamed(m, ["G22", "G23"]);
  assert.ok(r.after.replacement.G > r.before.replacement.G,
    "burning goalie spots on weak players must raise the bar (" +
    r.before.replacement.G + " -> " + r.after.replacement.G + ")");
});

test("fantasy points never depend on draft state", function () {
  var m = boardWithGoalies();
  var r = draftNamed(m, ["G0", "G1", "F0"]);
  ["D0", "F5", "G7"].forEach(function (name) {
    var a = r.before.rows.filter(function (x) { return x.name === name; })[0];
    var b = r.after.rows.filter(function (x) { return x.name === name; })[0];
    near(b.fp, a.fp, name + " projection is unchanged by the draft");
  });
});

/* ------------------------------------------------------------- drop-off */

test("dropoff measures the gap to the next available player at the position", function () {
  var m = boardWithGoalies();
  var base = V.compute(m, liveSettings);
  var g0 = base.rows.filter(function (x) { return x.name === "G0"; })[0];
  // Goalies are 8 points apart by construction.
  near(g0.dropoff, 8, "G0 to G1");
  assert.strictEqual(g0.nextUp, "G1");
});

test("dropoff grows as the players behind you are taken", function () {
  var m = boardWithGoalies();
  var r = draftNamed(m, ["G1", "G2", "G3"]);
  var before = r.before.rows.filter(function (x) { return x.name === "G0"; })[0];
  var after = r.after.rows.filter(function (x) { return x.name === "G0"; })[0];
  near(before.dropoff, 8, "originally the next goalie is 8 points back");
  near(after.dropoff, 32, "with G1-G3 gone the next one is 32 points back");
  assert.strictEqual(after.nextUp, "G4");
});

test("dropoff is zero for the last player at a position", function () {
  var m = boardWithGoalies();
  var base = V.compute(m, liveSettings);
  var last = base.rows.filter(function (x) { return x.name === "G23"; })[0];
  near(last.dropoff, 0, "nobody left behind them");
  assert.strictEqual(last.nextUp, "");
});

/* ------------------------------------------------------------ bench depth */

test("excluding the bench makes replacement shallower", function () {
  var m = boardWithGoalies();
  var withBench = V.compute(m, Object.assign({}, liveSettings, {
    slots: { C: 1, D: 1, G: 1, BN: 3 }, countBench: true
  }));
  var starters = V.compute(m, Object.assign({}, liveSettings, {
    slots: { C: 1, D: 1, G: 1, BN: 3 }, countBench: false
  }));
  assert.ok(starters.replacement.D > withBench.replacement.D,
    "starters-only should stop at a better defenceman");
  assert.ok(starters.replacementDepth.D < withBench.replacementDepth.D,
    "and report a shallower depth");
});

test("compute reports the depth behind each replacement level", function () {
  var m = boardWithGoalies();
  var out = V.compute(m, liveSettings);
  V.POSITIONS.forEach(function (pos) {
    var el = out.rows.filter(function (r) { return r.posSet[pos]; })
                     .map(function (r) { return r.fp; })
                     .sort(function (a, b) { return b - a; });
    if (!el.length) return;
    near(el[out.replacementDepth[pos] - 1], out.replacement[pos],
      pos + ": depth index must point at the replacement value");
  });
});

/* ------------------------------------------------------- last season */

/* Last season's actuals ride through the very same pipeline as the projections,
 * so both ranks are VORP-based and position-adjusted and can be compared
 * directly. These tests pin that reuse down. */

function withHistory() {
  var players = [];
  var history = [];
  for (var i = 0; i < 40; i++) {
    players.push({ n: "C" + i, t: "AAA", p: ["C"], s: { S1: [82, 40 - i, 0] }, h: i });
    // Last season deliberately runs in the OPPOSITE order, so a rank copied
    // from the projections instead of computed would be obvious.
    history.push({ n: "C" + i, t: "AAA", p: ["C"], s: { ACT: [82, i + 1, 0] } });
  }
  for (var j = 0; j < 20; j++) {
    players.push({ n: "D" + j, t: "BBB", p: ["D"], s: { S1: [82, 20 - j, 0] } });
  }
  return {
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {}, players: players,
    history: { season: "2025-26", label: "25-26", players: history }
  };
}

var histSettings = {
  weights: { S1: 1 }, scoring: { G: 1 }, gpModel: "totals", teams: 2,
  slots: { C: 1, D: 1, G: 0, BN: 0 }, replacementMethod: "draft", tierK: 1
};

test("createHistoryModel returns null when there is no history block", function () {
  var data = withHistory();
  delete data.history;
  assert.strictEqual(V.createHistoryModel(data), null);
  data.history = { players: [] };
  assert.strictEqual(V.createHistoryModel(data), null);
});

test("last season is ranked by its own numbers, not the projections", function () {
  var data = withHistory();
  var hist = V.computeHistory(V.createHistoryModel(data), histSettings);
  // History scores ascend with the index, so C39 was last season's best.
  assert.strictEqual(hist.rows[0].name, "C39");
  assert.strictEqual(hist.rows[hist.rows.length - 1].name, "C0");
});

test("last season's rank responds to a scoring change", function () {
  var data = withHistory();
  data.history.players[0].s.ACT = [82, 0, 500];   // all assists, no goals
  var model = V.createHistoryModel(data);
  var goalsOnly = V.computeHistory(model, histSettings);
  var withAssists = V.computeHistory(model, Object.assign({}, histSettings, {
    scoring: { G: 1, A: 1 }
  }));
  var before = goalsOnly.rows.filter(function (r) { return r.name === "C0"; })[0];
  var after = withAssists.rows.filter(function (r) { return r.name === "C0"; })[0];
  assert.ok(after.rank < before.rank,
    "turning on assists must promote an assist-heavy season (" +
    before.rank + " -> " + after.rank + ")");
});

test("last season ignores draft state entirely", function () {
  var data = withHistory();
  var model = V.createHistoryModel(data);
  var plain = V.computeHistory(model, histSettings);
  var drafted = {};
  plain.rows.slice(0, 10).forEach(function (r) { drafted[r.id] = true; });
  // Who has been picked this year cannot change what happened last year.
  var withDraft = V.computeHistory(model, Object.assign({}, histSettings, {
    drafted: drafted, dynamic: true
  }));
  assert.strictEqual(withDraft.rows[0].name, plain.rows[0].name);
  near(withDraft.replacement.C, plain.replacement.C, "replacement unchanged");
});

test("the history index joins a board player to their season", function () {
  var data = withHistory();
  var hist = V.computeHistory(V.createHistoryModel(data), histSettings);
  var byIndex = {};
  hist.rows.forEach(function (r) { byIndex[r.id] = r; });

  var board = V.compute(V.createModel(data), histSettings);
  var top = board.rows[0];                       // C0, the best projection
  var last = byIndex[data.players[top.id].h];
  assert.strictEqual(last.name, "C0");
  assert.strictEqual(last.rank, hist.rows.length,
    "C0 was last season's worst, which is the whole point of the column");

  // A defenceman carries no history index at all.
  var dman = board.rows.filter(function (r) { return r.name === "D0"; })[0];
  assert.strictEqual(data.players[dman.id].h, undefined);
});

test("history uses the same replacement machinery as the board", function () {
  var data = withHistory();
  var model = V.createHistoryModel(data);
  // Same roster both times; only the bench toggle differs. 2 teams x (1 C +
  // 3 bench shared out) reaches deeper than 2 teams x 1 C.
  var bench = { C: 1, D: 1, G: 0, BN: 3 };
  var full = V.computeHistory(model, Object.assign({}, histSettings, {
    slots: bench, countBench: true
  }));
  var starters = V.computeHistory(model, Object.assign({}, histSettings, {
    slots: bench, countBench: false
  }));
  assert.ok(starters.replacementDepth.C < full.replacementDepth.C,
    "roster settings must reach last season's valuation too (" +
    starters.replacementDepth.C + " vs " + full.replacementDepth.C + ")");
});

/* ------------------------------------------------------ manual adjustment */

/* A player scored on both offence (goals) and role stats (hits), so the tests
 * can prove the adjustment reaches one and not the other. */
var adjModel = V.createModel({
  stats: ["GP", "G", "HIT", "W", "GA"],
  counting_stats: ["G", "HIT", "W", "GA"],
  rate_stats: [],
  sources: [{ id: "S1", name: "One" }],
  meta: {},
  players: [
    { n: "Skater", t: "A", p: ["C"], s: { S1: [82, 100, 200, null, null] } },
    { n: "Goalie", t: "A", p: ["G"], s: { S1: [60, null, null, 30, 150] } }
  ]
});

var adjConfig = {
  tiers: [0.05, 0.10, 0.20],
  skaterStats: ["G"],
  goalieStats: ["W", "GA"]
};
var adjScoring = { G: 1, HIT: 1, W: 1, GA: -1 };

function adjust(name, level) {
  var player = adjModel.players.filter(function (p) { return p.name === name; })[0];
  var line = V.blendPlayer(player, adjModel, { weights: { S1: 1 }, gpModel: "totals" });
  return V.applyAdjustment(line, adjModel, level, {
    adjust: adjConfig, scoring: adjScoring, isGoalie: !!player.posSet.G
  });
}

test("adjustmentPct maps levels onto the configured tiers", function () {
  near(V.adjustmentPct(1, [0.05, 0.10, 0.20]), 0.05);
  near(V.adjustmentPct(2, [0.05, 0.10, 0.20]), 0.10);
  near(V.adjustmentPct(3, [0.05, 0.10, 0.20]), 0.20);
  near(V.adjustmentPct(-3, [0.05, 0.10, 0.20]), -0.20, "minus mirrors plus");
  near(V.adjustmentPct(0, [0.05, 0.10, 0.20]), 0);
  // Beyond the configured tiers, clamp rather than run off the end.
  near(V.adjustmentPct(9, [0.05, 0.10, 0.20]), 0.20);
});

test("an adjustment moves only the configured stats", function () {
  var line = adjust("Skater", 3);
  near(line[1], 120, "goals take the full +20%");
  near(line[2], 200, "hits are a role stat and must not move");
  near(line[0], 82, "games played never moves");
});

test("a minus adjustment lowers the same stats", function () {
  var line = adjust("Skater", -2);
  near(line[1], 90, "goals -10%");
  near(line[2], 200, "hits still untouched");
});

test("a boost always improves a player, whatever the stat's sign", function () {
  // Wins are scored positively and goals against negatively, so a boost has to
  // push them in opposite directions. Scaling both upward would make a boosted
  // goalie worse, which is the trap this guards.
  var line = adjust("Goalie", 3);
  near(line[3], 36, "wins +20%");
  near(line[4], 120, "goals against -20%");
  var worse = adjust("Goalie", -3);
  near(worse[3], 24, "wins -20%");
  near(worse[4], 180, "goals against +20%");
});

test("level zero leaves the line untouched", function () {
  var line = adjust("Skater", 0);
  near(line[1], 100);
  near(line[2], 200);
});

test("adjustments flow through scoring, VORP and rank", function () {
  var settings = {
    weights: { S1: 1 }, scoring: adjScoring, gpModel: "totals", teams: 1,
    slots: { C: 1, D: 0, G: 1, BN: 0 }, replacementMethod: "position",
    tierK: 1, adjust: adjConfig
  };
  var plain = V.compute(adjModel, settings);
  var skater = plain.rows.filter(function (r) { return r.name === "Skater"; })[0];
  near(skater.fp, 300, "100 goals + 200 hits");
  assert.strictEqual(skater.adj, 0);

  var boost = {};
  boost[skater.id] = 3;
  var raised = V.compute(adjModel, Object.assign({}, settings, { adjustments: boost }));
  var after = raised.rows.filter(function (r) { return r.name === "Skater"; })[0];
  near(after.fp, 320, "goals 100 -> 120, hits unchanged");
  assert.strictEqual(after.adj, 3);
  near(after.adjDelta, 20, "the adjustment reports what it was actually worth");
});

test("adjDelta captures the real points swing, not the tier percentage", function () {
  // A goalie moves both a reward and a penalty, so a 20% tier is worth more
  // than 20% of their total. The board shows this number in the tooltip
  // precisely so that gap is visible.
  var settings = {
    weights: { S1: 1 }, scoring: adjScoring, gpModel: "totals", teams: 1,
    slots: { C: 1, D: 0, G: 1, BN: 0 }, replacementMethod: "position",
    tierK: 1, adjust: adjConfig
  };
  var plain = V.compute(adjModel, settings);
  var goalie = plain.rows.filter(function (r) { return r.name === "Goalie"; })[0];
  near(goalie.fp, -120, "30 wins - 150 goals against");

  var boost = {};
  boost[goalie.id] = 3;
  var raised = V.compute(adjModel, Object.assign({}, settings, { adjustments: boost }));
  var after = raised.rows.filter(function (r) { return r.name === "Goalie"; })[0];
  near(after.fp, -84, "36 wins - 120 goals against");
  near(after.adjDelta, 36, "worth 36 points, well beyond 20% of the total");
});

test("last season is never adjusted", function () {
  // Manual moves are an opinion about next season; last season already happened.
  var data = withHistory();
  var model = V.createHistoryModel(data);
  var plain = V.computeHistory(model, histSettings);
  var boost = {};
  plain.rows.forEach(function (r) { boost[r.id] = 3; });
  var withBoost = V.computeHistory(model, Object.assign({}, histSettings, {
    adjustments: boost, adjust: adjConfig
  }));
  near(withBoost.rows[0].fp, plain.rows[0].fp,
    "history must ignore adjustments entirely");
  assert.strictEqual(withBoost.rows[0].adj, 0);
});

test("minGP drops players below the games threshold", function () {
  var m = V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }], meta: {},
    players: [
      { n: "full", t: "A", p: ["C"], s: { S1: [82, 40, 0] } },
      { n: "fringe", t: "A", p: ["C"], s: { S1: [9, 2, 0] } }
    ]
  });
  var out = V.compute(m, Object.assign({}, baseSettings, { minGP: 20 }));
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].name, "full");
});

test("zeroing a source's weight removes its opinion from the board", function () {
  var m = V.createModel({
    stats: ["GP", "G", "A"], counting_stats: ["G", "A"], rate_stats: [],
    sources: [{ id: "S1", name: "One" }, { id: "S2", name: "Two" }], meta: {},
    players: [{ n: "X", t: "A", p: ["C"], s: { S1: [82, 10, 0], S2: [82, 50, 0] } }]
  });
  var both = V.compute(m, Object.assign({}, baseSettings, { weights: { S1: 1, S2: 1 } }));
  var only = V.compute(m, Object.assign({}, baseSettings, { weights: { S1: 1, S2: 0 } }));
  near(both.rows[0].fp, 30, "average of 10 and 50");
  near(only.rows[0].fp, 10, "S2 silenced");
});

test("rosterSpotCount sums every slot type", function () {
  near(V.rosterSpotCount({ C: 2, LW: 2, RW: 2, W: 0, F: 0, D: 4, UTIL: 0, G: 2, BN: 4 }), 16);
});

console.log("\n" + passed + " passed" +
  (process.exitCode ? ", with failures" : ", 0 failed"));
