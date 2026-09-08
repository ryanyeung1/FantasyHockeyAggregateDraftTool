/* Headless ranking, used by build.py to write out/rankings.csv and to print the
 * --verify comparison.
 *
 * It exists so the offline CSV comes out of the same valuation.js the board
 * runs, rather than a second Python implementation that could quietly drift.
 *
 *   node board/rank_cli.js <data.json> csv    > rankings.csv
 *   node board/rank_cli.js <data.json> top 25
 */
"use strict";

var fs = require("fs");
var path = require("path");
var V = require(path.join(__dirname, "valuation.js"));

var dataPath = process.argv[2];
var mode = process.argv[3] || "csv";
var limit = parseInt(process.argv[4], 10) || 25;

var data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
var model = V.createModel(data);
var cfg = data.config;

// Last season's finish under the same scoring, joined by the index the build
// stored on each player.
var historyModel = V.createHistoryModel(data);
var lastByIndex = {};
if (historyModel) {
  V.computeHistory(historyModel, {
    scoring: cfg.scoring, slots: cfg.league.slots, teams: cfg.league.teams,
    replacementMethod: cfg.model.replacement_method,
    countBench: cfg.model.count_bench !== false, tierK: cfg.model.tier_k
  }).rows.forEach(function (r) {
    lastByIndex[r.id] = { rank: r.rank, fp: r.fp, gp: r.gp };
  });
}
function lastFor(row) {
  var index = data.players[row.id].h;
  return index === undefined ? null : (lastByIndex[index] || null);
}

var result = V.compute(model, {
  scoring: cfg.scoring,
  weights: cfg.source_weights,
  slots: cfg.league.slots,
  teams: cfg.league.teams,
  gpModel: cfg.model.gp_model,
  gpSource: cfg.model.gp_source,
  replacementMethod: cfg.model.replacement_method,
  tierK: cfg.model.tier_k,
  minGP: cfg.model.min_gp || 0,
  drafted: {},
  dynamic: false
});

function num(value, places) {
  return value === null || value === undefined || isNaN(value)
    ? "" : value.toFixed(places);
}

if (mode === "csv") {
  var label = (data.history && data.history.label) || "LastYr";
  var out = ["Rank,Player,Team,Pos,Tier,VORP,Next,FanPts,FP/GP,GP,PosRank,ADP," +
             label + " Rank," + label + " FP," + label + " GP,Sources"];
  result.rows.forEach(function (r) {
    var last = lastFor(r);
    out.push([
      r.rank,
      '"' + r.name.replace(/"/g, '""') + '"',
      r.team,
      '"' + r.posLabel + '"',
      (r.bestPos || "") + (r.tier || ""),
      num(r.vorp, 2), num(r.dropoff, 2), num(r.fp, 2), num(r.fpg, 3), num(r.gp, 1),
      '"' + r.prnk + '"',
      r.adp === null ? "" : r.adp,
      last ? last.rank : "", last ? num(last.fp, 2) : "", last ? num(last.gp, 0) : "",
      r.sourceCount
    ].join(","));
  });
  process.stdout.write(out.join("\n") + "\n");
} else if (mode === "top") {
  var pad = function (s, n, right) {
    s = String(s);
    if (s.length > n) s = s.slice(0, n);
    var fill = new Array(n - s.length + 1).join(" ");
    return right ? fill + s : s + fill;
  };
  var hlabel = (data.history && data.history.label) || "";
  var lines = [
    pad("#", 4) + pad("Player", 24) + pad("Tm", 5) + pad("Pos", 9) +
    pad("FanPts", 9, true) + pad("VORP", 9, true) + "  " + pad("PRnk", 10) +
    pad("Tier", 6) + pad("ADP", 7, true) + pad(hlabel, 8, true)
  ];
  lines.push(new Array(92).join("-"));
  result.rows.slice(0, limit).forEach(function (r) {
    var last = lastFor(r);
    lines.push(
      pad(r.rank, 4) + pad(r.name, 24) + pad(r.team, 5) + pad(r.posLabel, 9) +
      pad(num(r.fp, 1), 9, true) + pad(num(r.vorp, 1), 9, true) + "  " +
      pad(r.prnk, 10) + pad((r.bestPos || "") + (r.tier || ""), 6) +
      pad(r.adp === null ? "-" : r.adp, 7, true) +
      pad(last ? last.rank : "-", 8, true)
    );
  });
  lines.push("");
  lines.push("Replacement level:  " + V.POSITIONS.map(function (p) {
    return p + " " + num(result.replacement[p], 1);
  }).join("   "));
  process.stdout.write(lines.join("\n") + "\n");
} else if (mode === "json") {
  process.stdout.write(JSON.stringify(result.rows.map(function (r) {
    return {
      rank: r.rank, name: r.name, team: r.team, pos: r.posLabel,
      fp: r.fp, vorp: r.vorp, prnk: r.prnk, gp: r.gp, adp: r.adp
    };
  })));
} else {
  process.stderr.write("unknown mode: " + mode + "\n");
  process.exit(2);
}
