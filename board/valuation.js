/* Valuation model for the fantasy hockey draft tool.
 *
 * This file is the single implementation of the math. The Python side only
 * reads spreadsheets; everything from blending sources through VORP happens
 * here, so weight and scoring changes re-rank the board with no rebuild and
 * there is never a second copy of the formulas to keep in sync.
 *
 * Loads in the browser as `window.Valuation` and in Node via require(), which
 * is how tests/test_valuation.js exercises it. Kept to ES2018 syntax because
 * the Node available here is v12.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Valuation = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var POSITIONS = ["C", "LW", "RW", "D", "G"];
  var POS_LABEL = { C: "C", LW: "L", RW: "R", D: "D", G: "G" };

  // Pseudo-source id for last season's actuals; must match export.py.
  var HISTORY_SOURCE = "ACT";
  var HISTORY_WEIGHTS = { ACT: 1 };

  /* ---------------------------------------------------------------- blending */

  /* Weighted mean over the sources that actually published a value.
   *
   * This is the rule the reference spreadsheet uses, and the important half is
   * the denominator: it sums the weights of contributing sources only. A source
   * that does not project a stat (Apples & Ginos publish no shorthanded points,
   * and no goalie stats at all) drops out of that stat's average instead of
   * pulling it toward zero.
   *
   * `pick` maps a source id to its value, returning null when absent.
   */
  function weightedMean(sourceIds, weights, pick) {
    var num = 0;
    var den = 0;
    for (var i = 0; i < sourceIds.length; i++) {
      var sid = sourceIds[i];
      var w = weights[sid];
      if (!w) continue;
      var v = pick(sid);
      if (v === null || v === undefined || isNaN(v)) continue;
      num += w * v;
      den += w;
    }
    return den > 0 ? num / den : null;
  }

  /* Blend one player's sources into a single projected stat line.
   *
   * gpModel:
   *   "totals"          - weighted mean of season totals, exactly as the
   *                       reference sheet does it.
   *   "rate_blended_gp" - blend per-game rates, then multiply by blended GP.
   *   "rate_source_gp"  - same, but games played comes only from `gpSource`.
   *
   * The rate modes exist because sources disagree about what games played even
   * means. Apples & Ginos assign nearly everyone a full 84-game season, so
   * averaging raw totals quietly imports "no one gets hurt" into the board.
   * Blending rates and applying a games estimate separately keeps their opinion
   * about production without their opinion about availability.
   */
  function blendPlayer(player, model, settings) {
    var stats = model.stats;
    var idx = model.statIndex;
    var weights = settings.weights;
    var sourceIds = model.sourceIds;
    var isCounting = model.isCounting;
    var gpModel = settings.gpModel || "totals";
    var gpi = idx.GP;

    var valueOf = function (sid, i) {
      var line = player.s[sid];
      if (!line) return null;
      var v = line[i];
      return v === null || v === undefined ? null : v;
    };

    // Games played is never rate-scaled -- it is the scale.
    var gpSources = sourceIds;
    if (gpModel === "rate_source_gp" && settings.gpSource) {
      var only = [settings.gpSource];
      // Fall back to every source when the preferred one has no line for this
      // player, otherwise A&G-only skaters would come out with no games at all.
      if (valueOf(settings.gpSource, gpi) !== null) gpSources = only;
    }
    var gpWeights = weights;
    if (gpSources !== sourceIds) {
      gpWeights = {};
      gpWeights[settings.gpSource] = 1;
    }
    var gp = gpi === undefined ? null : weightedMean(gpSources, gpWeights, function (sid) {
      return valueOf(sid, gpi);
    });

    var out = new Array(stats.length);
    for (var i = 0; i < stats.length; i++) {
      var stat = stats[i];
      if (i === gpi) {
        out[i] = gp;
        continue;
      }
      if (gpModel === "totals" || !isCounting[stat] || !gp) {
        out[i] = weightedMean(sourceIds, weights, (function (col) {
          return function (sid) { return valueOf(sid, col); };
        })(i));
        continue;
      }
      // Rate mode: average the per-game rates, then re-apply the games estimate.
      var rate = weightedMean(sourceIds, weights, (function (col) {
        return function (sid) {
          var v = valueOf(sid, col);
          if (v === null) return null;
          var sgp = valueOf(sid, gpi);
          if (!sgp) return null;
          return v / sgp;
        };
      })(i));
      out[i] = rate === null ? null : rate * gp;
    }
    return out;
  }

  /* -------------------------------------------------------- manual adjustment */

  /* Percentage for an adjustment level, -3..+3.
   *
   * Level 1/2/3 map to the three configured tiers, so +++ is the largest move.
   */
  function adjustmentPct(level, tiers) {
    var steps = tiers || [0.05, 0.10, 0.20];
    var size = Math.min(Math.abs(level || 0), steps.length);
    if (!size) return 0;
    return (level < 0 ? -1 : 1) * steps[size - 1];
  }

  /* Nudge a blended line up or down by a subjective amount.
   *
   * Only the configured stats move. That is the Yahoo sheet's rule and it is a
   * real modelling choice: a boost says "I think this player scores more than
   * the projections do", and hits, blocks, PIM and faceoffs are role stats that
   * do not rise with better finishing. It means a physical defenceman gains
   * less from +++ than a pure scorer does -- which is the intended behaviour,
   * not an oversight.
   *
   * The direction is taken from the scoring value, so a boost always makes a
   * player better: goals go up, and a goalie's losses and goals against go
   * DOWN. Scaling every listed stat upward would otherwise make boosted goalies
   * worse, since two of their four stats are penalties.
   */
  function applyAdjustment(line, model, level, settings) {
    if (!level) return line;
    var config = settings.adjust || {};
    var pct = adjustmentPct(level, config.tiers);
    if (!pct) return line;

    var isGoalie = settings.isGoalie;
    var names = isGoalie ? config.goalieStats : config.skaterStats;
    if (!names || !names.length) return line;

    var scoring = settings.scoring || {};
    var out = line.slice();
    for (var i = 0; i < names.length; i++) {
      var index = model.statIndex[names[i]];
      if (index === undefined) continue;
      var value = out[index];
      if (value === null || value === undefined) continue;
      // A stat you are penalised for improves by getting smaller.
      var direction = (scoring[names[i]] || 0) < 0 ? -1 : 1;
      out[index] = value * (1 + pct * direction);
    }
    return out;
  }

  /* ----------------------------------------------------------------- scoring */

  /* posSet carries the positional scoring terms -- the categories that depend
     on what a player is, not just what they do:

       DPT  extra on every point a DEFENCEMAN scores, on top of goals/assists
       GS   points per game a GOALIE starts, which is their GP on the board

     Neither is a stat any source publishes; both are absent from model.stats
     on purpose, which is also what keeps the loop below from counting them.
     Negative values are meaningful for either -- some leagues charge per
     start. */
  function fantasyPoints(line, model, scoring, posSet) {
    posSet = posSet || {};
    var total = 0;
    var stats = model.stats;
    for (var i = 0; i < stats.length; i++) {
      var pts = scoring[stats[i]];
      if (!pts) continue;
      var v = line[i];
      if (v === null || v === undefined) continue;
      total += v * pts;
    }
    if (posSet.D && scoring.DPT) {
      var points = statValue(line, model, 'PTS');
      if (points === null) {
        // An imported file may map goals and assists without a points column.
        // Awarding nothing there would look like the setting was ignored.
        var g = statValue(line, model, 'G');
        if (g !== null) points = g + (statValue(line, model, 'A') || 0);
      }
      if (points !== null) total += points * scoring.DPT;
    }
    if (posSet.G && scoring.GS) {
      // The board keeps a goalie's starts in GP: Daily Faceoff publishes a GS
      // column and it is mapped straight onto GP, and every goalie has one, so
      // no fallback is needed here.
      var starts = statValue(line, model, 'GP');
      if (starts !== null) total += starts * scoring.GS;
    }
    return total;
  }

  function statValue(line, model, stat) {
    var i = model.statIndex[stat];
    if (i === undefined) return null;
    var v = line[i];
    return (v === null || v === undefined) ? null : v;
  }

  /* ------------------------------------------------------- replacement level */

  /* League-wide starting slots per position, with flex spots distributed.
   *
   * Dedicated slots count where they are named; flexible ones are spread over
   * the positions that can fill them: W across the two wings, F across all
   * three forward spots, UTIL two-thirds forward / one-third defence, and the
   * bench two-thirds forward, one-sixth each to defence and goal.
   *
   * Those fractions decide replacement level, which decides the whole board, so
   * they live here in the open rather than buried in a formula. For a standard
   * 2C/2LW/2RW/4D/2G/4BN league they reproduce the reference sheet's numbers
   * exactly (2.889 per forward spot, 4.667 D, 2.667 G per team), while still
   * behaving sensibly for lopsided rosters the reference sheet would mis-split.
   */
  function positionalSlots(slots, teams, countBench) {
    var s = function (k) { return slots[k] || 0; };
    var bench = countBench === false ? 0 : s("BN");
    var wing = s("W") / 2;
    var forward = s("F") / 3;
    var utilForward = s("UTIL") * (2 / 3) / 3;
    var benchForward = bench * (2 / 3) / 3;

    var perForward = forward + utilForward + benchForward;
    return {
      C: (s("C") + perForward) * teams,
      LW: (s("LW") + wing + perForward) * teams,
      RW: (s("RW") + wing + perForward) * teams,
      D: (s("D") + s("UTIL") * (1 / 3) + bench * (1 / 6)) * teams,
      G: (s("G") + bench * (1 / 6)) * teams
    };
  }

  /* The (n+1)-th best player at a position, as both a points value and the rank
   * it came from. The rank is what the board displays -- "replacement at C is
   * the 57th-best centre" explains a number far better than the number does.
   */
  function nthBestAt(pool, position, n) {
    var eligible = [];
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].posSet[position]) eligible.push(pool[i].fp);
    }
    if (!eligible.length) return { fp: 0, rank: 0 };
    eligible.sort(function (a, b) { return b - a; });
    var index = Math.min(Math.max(Math.round(n), 0), eligible.length - 1);
    return { fp: eligible[index], rank: index + 1 };
  }

  function splitLevels(picked) {
    var level = {};
    var depth = {};
    for (var i = 0; i < POSITIONS.length; i++) {
      var p = POSITIONS[i];
      level[p] = picked[p].fp;
      depth[p] = picked[p].rank;
    }
    return { level: level, depth: depth };
  }

  /* Position-based replacement: the first player past the league's starting
   * slots at that position. */
  function replacementByPosition(pool, slots, teams, countBench) {
    var counts = positionalSlots(slots, teams, countBench);
    var picked = {};
    for (var i = 0; i < POSITIONS.length; i++) {
      var p = POSITIONS[i];
      picked[p] = nthBestAt(pool, p, counts[p]);
    }
    return splitLevels(picked);
  }

  /* Which roster group a player will realistically occupy.
   *
   * Defence is the scarcer, more constrained slot in a standard lineup, so a
   * player eligible at both D and forward is assumed to be rostered at D. That
   * is an approximation; it only matters for the handful of dual-eligible
   * players, and only for how fast each pool's remaining demand drains.
   */
  function groupOf(player) {
    if (player.posSet.G) return "G";
    if (player.posSet.D) return "D";
    return "F";
  }

  /* Draft-based replacement: measure how deep each pool is actually drained.
   *
   * Slot counts alone understate forward scarcity. A league with 2C/2LW/2RW
   * plus flex and bench spots rosters ~104 forwards, and because most of them
   * are eligible at more than one forward position, far more than 35 centres
   * come off the board. Counting who is really taken is what separates this
   * from the naive slot math.
   *
   * So: take the forwards that the league's forward spots will actually absorb,
   * ranked by projected points, count how many are eligible at each forward
   * position, and set replacement level immediately past that count. Defence
   * and goal have no equivalent cross-drain -- nothing else competes for those
   * spots -- so they use their slot counts directly.
   *
   * Ranking that slice by points rather than by VORP is deliberate. An earlier
   * version ranked it by VORP, which is circular: a shallow forward replacement
   * suppresses forward VORP, which lets defencemen fill the slice, which pushes
   * the forward replacement shallower still. It converged on a board that was
   * mostly defencemen and goalies.
   *
   * `consumed` is how many spots each roster group has already absorbed, and it
   * is subtracted from demand. Replacement level means "the marginal rostered
   * player at this position", so demand has to be the spots still *unfilled*.
   *
   * Do not be tempted to hold demand at the full league count to make the live
   * view move more. That was tried, on the reasoning that shrinking demand
   * "did nothing": under an efficient draft, removing the top k players at a
   * position while asking for the (n-k)th best of the remainder lands on the
   * same player as the nth best of the original, so the number is unchanged.
   * But that invariance is the correct answer, not a bug -- if the draft
   * follows projected value, the marginal rostered player was determined before
   * the draft began and nothing has been learned. Holding demand fixed breaks
   * two cases badly: a position drafted past its slot count keeps reporting
   * healthy replacement instead of collapsing to best-available (leftover
   * goalies scoring +93 VORP when nobody needs a goalie), and spots burned on
   * weak players are ignored entirely.
   *
   * The live signal a drafter actually wants -- "how much worse is this
   * position if I wait?" -- is the drop-off to the next available player, which
   * `compute` reports separately as `dropoff`. That is a different quantity
   * from replacement level, and conflating the two is what caused the mistake.
   */
  function replacementByDraft(pool, slots, teams, consumed, countBench) {
    consumed = consumed || {};
    var counts = positionalSlots(slots, teams, countBench);

    var forwardSlots = Math.max(
      Math.round(counts.C + counts.LW + counts.RW) - (consumed.F || 0), 0
    );
    var defenceSlots = Math.max(Math.round(counts.D) - (consumed.D || 0), 0);
    var goalieSlots = Math.max(Math.round(counts.G) - (consumed.G || 0), 0);

    var forwards = [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      if (p.posSet.C || p.posSet.LW || p.posSet.RW) forwards.push(p);
    }
    forwards.sort(function (a, b) { return b.fp - a.fp; });
    var taken = forwards.slice(0, forwardSlots);

    var eligible = { C: 0, LW: 0, RW: 0 };
    for (var j = 0; j < taken.length; j++) {
      if (taken[j].posSet.C) eligible.C++;
      if (taken[j].posSet.LW) eligible.LW++;
      if (taken[j].posSet.RW) eligible.RW++;
    }

    return splitLevels({
      C: nthBestAt(pool, "C", eligible.C),
      LW: nthBestAt(pool, "LW", eligible.LW),
      RW: nthBestAt(pool, "RW", eligible.RW),
      D: nthBestAt(pool, "D", defenceSlots),
      G: nthBestAt(pool, "G", goalieSlots)
    });
  }

  function bestVorp(player, replacement) {
    var best = null;
    for (var i = 0; i < POSITIONS.length; i++) {
      var pos = POSITIONS[i];
      if (!player.posSet[pos]) continue;
      var v = player.fp - replacement[pos];
      if (best === null || v > best) best = v;
    }
    return best === null ? player.fp : best;
  }

  function bestPosition(player, replacement) {
    var best = null;
    var bestPos = null;
    for (var i = 0; i < POSITIONS.length; i++) {
      var pos = POSITIONS[i];
      if (!player.posSet[pos]) continue;
      var v = player.fp - replacement[pos];
      if (best === null || v > best) {
        best = v;
        bestPos = pos;
      }
    }
    return bestPos;
  }

  /* ------------------------------------------------------------------- tiers */

  /* Cut a ranked list where the drop to the next player is unusually large.
   *
   * Tiers answer the only question that matters when you are on the clock: is
   * there another player like this one if I wait? A gap more than k standard
   * deviations above the average gap says no.
   */
  /* Cut a ranked list into tiers wherever the drop to the next player is
   * unusually large.
   *
   * `window` limits the gaps used to calibrate the threshold to the draftable
   * part of the list -- roughly the players who will actually come off the
   * board at this position. Calibrating over the whole pool does not work:
   * there are 236 centres and 255 defencemen, nearly all of them replacement
   * level with near-zero gaps, and including them drags the mean down until the
   * top of the board is chopped into two-player slivers while 178 centres share
   * a single tier. The players you draft should set the scale.
   *
   * There is deliberately no minimum tier size. A tier of one is a real
   * statement -- MacKinnon stands alone, and Kucherov is 39 points clear of the
   * next right wing. An earlier version enforced a minimum of two and, because
   * the counter reset after each cut, silently swallowed 14 genuine cliffs
   * inside the top 40 of each position and put several boundaries one row late.
   */
  function assignTiers(ranked, k, window) {
    if (ranked.length < 2) {
      for (var z = 0; z < ranked.length; z++) ranked[z].tier = 1;
      return;
    }
    var gaps = [];
    for (var i = 1; i < ranked.length; i++) {
      gaps.push(ranked[i - 1].vorp - ranked[i].vorp);
    }

    var size = Math.max(2, Math.min(window || gaps.length, gaps.length));
    var sample = gaps.slice(0, size);

    /* Median and MAD rather than mean and standard deviation.
     *
     * Gaps between consecutive players are heavily right-skewed -- across the
     * top 57 centres the mean is 5.0 but the median is 3.5 and the standard
     * deviation 7.2, because a handful of enormous gaps at the very top set the
     * scale. `mean + 1sd` then lands at 12.2, which only four gaps in the whole
     * draftable range clear, leaving ranks 6 through 57 as one undifferentiated
     * block. The median and MAD ignore those outliers, so the threshold
     * describes a typical gap instead of being dragged out by the extremes.
     *
     * MAD is scaled by 1.4826, the constant that makes it match the standard
     * deviation for normally distributed data, so `k` still reads as roughly
     * "how many deviations above a normal gap".
     */
    var sorted = sample.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    var deviations = sorted.map(function (v) { return Math.abs(v - median); })
                           .sort(function (a, b) { return a - b; });
    var scale = 1.4826 * deviations[Math.floor(deviations.length / 2)];
    if (!scale) {
      // Degenerate spread (most gaps identical): fall back to the median itself
      // so the threshold stays above a typical gap rather than collapsing to it.
      scale = median || 1;
    }
    var threshold = median + k * scale;

    var tier = 1;
    ranked[0].tier = 1;
    for (var j = 1; j < ranked.length; j++) {
      if (gaps[j - 1] > threshold) tier++;
      ranked[j].tier = tier;
    }
  }

  /* ------------------------------------------------------------------- model */

  /* Pre-chew the exported payload into the shape the hot path wants.
   * Built once; `compute` runs on every settings keystroke. */
  function createModel(data) {
    var statIndex = {};
    for (var i = 0; i < data.stats.length; i++) statIndex[data.stats[i]] = i;

    var isCounting = {};
    for (var c = 0; c < data.counting_stats.length; c++) {
      isCounting[data.counting_stats[c]] = true;
    }

    /* One entry per eligibility ruling. "" is what the projection sources say;
       a platform id is that platform's own list, which only exists for players
       it actually rules differently. Precomputed here because compute() runs on
       every keystroke and would otherwise rebuild these sets 820 times a go. */
    function variant(list) {
      var set = {};
      for (var j = 0; j < list.length; j++) set[list[j]] = true;
      return { pos: list, posSet: set, posLabel: list.join(",") };
    }

    var players = data.players.map(function (p, i) {
      var variants = { "": variant(p.p) };
      if (p.pe) {
        for (var prov in p.pe) {
          if (Object.prototype.hasOwnProperty.call(p.pe, prov)) {
            variants[prov] = variant(p.pe[prov]);
          }
        }
      }
      var posSet = variants[""].posSet;
      return {
        id: i,
        name: p.n,
        team: p.t,
        pos: p.p,
        posSet: posSet,
        posLabel: p.p.join(","),
        posVariants: variants,
        age: p.age === undefined ? null : p.age,
        adp: p.adp || null,   // {provider: pick}; resolved in compute()
        s: p.s,
        sourceCount: Object.keys(p.s).length
      };
    });

    return {
      stats: data.stats,
      statIndex: statIndex,
      isCounting: isCounting,
      sources: data.sources,
      sourceIds: data.sources.map(function (s) { return s.id; }),
      players: players,
      meta: data.meta
    };
  }

  /* Build a model over last season's actual results.
   *
   * The history block is shaped like the board's own player list with a single
   * pseudo-source, so it goes through createModel unchanged and can then be run
   * through compute() with the user's real scoring and roster. That is the
   * whole point: last season's rank comes out VORP-based and position-adjusted
   * exactly like the board's, so the two numbers are directly comparable.
   * Ranking last season by raw points instead would drop the best goalie to
   * 65th overall and make every goalie look like a huge riser.
   */
  function createHistoryModel(data) {
    if (!data.history || !data.history.players || !data.history.players.length) {
      return null;
    }
    var model = createModel({
      stats: data.stats,
      counting_stats: data.counting_stats,
      rate_stats: data.rate_stats,
      sources: [{ id: HISTORY_SOURCE, name: data.history.label || "last season" }],
      players: data.history.players,
      meta: {}
    });
    model.season = data.history.season;
    model.label = data.history.label;
    return model;
  }

  /* Rank last season under the current settings.
   *
   * Only the settings that can change a valuation are honoured; draft state is
   * deliberately ignored, because who has been picked this year cannot alter
   * what happened last year.
   */
  function computeHistory(historyModel, settings) {
    if (!historyModel) return null;
    return compute(historyModel, {
      scoring: settings.scoring,
      weights: HISTORY_WEIGHTS,
      slots: settings.slots,
      teams: settings.teams,
      // Actual season totals: there is nothing to rate-adjust, and with one
      // source a rate model is an identity anyway.
      gpModel: "totals",
      replacementMethod: settings.replacementMethod,
      countBench: settings.countBench,
      tierK: settings.tierK,
      minGP: 0,
      drafted: {},
      dynamic: false
      // No `adjustments`, deliberately. Manual +/- moves are an opinion about
      // what a player will do next season; last season already happened.
    });
  }

  function rosterSpotCount(slots) {
    var total = 0;
    for (var key in slots) {
      if (Object.prototype.hasOwnProperty.call(slots, key)) total += slots[key] || 0;
    }
    return total;
  }

  /* Run the whole pipeline: blend -> score -> replacement -> VORP -> rank.
   *
   * `settings.drafted` (a set of player ids) drives the live view: those players
   * leave the pool and the roster spots they consumed leave the demand count.
   * Expect replacement level to sit still while the draft follows the board --
   * see replacementByDraft for why that is correct -- and to move when picks
   * deviate. The signal that tracks a run in progress is `dropoff`, below.
   */
  /* Which ADP column to show. Providers cover different depths -- Yahoo ranks
     254 players and Fantrax 439 -- so a player ranked by one and not the other
     is normal and reads as blank rather than as a missing player. */
  function adpFor(player, provider) {
    var table = player.adp;
    if (!table) return null;
    if (provider && table[provider] !== undefined) return table[provider];
    return null;
  }

  /* Which position ruling to value a player under. Falls back to the sources'
     own reading, which is also the only entry present for the great majority
     of players -- a platform list only overrides where it disagrees. */
  function eligibilityFor(player, provider) {
    if (provider && player.posVariants[provider]) return player.posVariants[provider];
    return player.posVariants[""];
  }

  function compute(model, settings) {
    var scoring = settings.scoring;
    var teams = settings.teams;
    var slots = settings.slots;
    var gpi = model.statIndex.GP;
    var minGP = settings.minGP || 0;

    var adjustments = settings.adjustments || {};
    var rows = [];
    for (var i = 0; i < model.players.length; i++) {
      var player = model.players[i];
      var elig = eligibilityFor(player, settings.eligibility);
      var line = blendPlayer(player, model, settings);
      var gp = gpi === undefined ? null : line[gpi];
      if (minGP && (!gp || gp < minGP)) continue;

      // Your own opinion, applied to the blend before it is scored -- so it
      // flows through fantasy points, VORP, tiers and the drop-off together.
      var level = adjustments[player.id] || 0;
      var adjDelta = 0;
      if (level) {
        var before = fantasyPoints(line, model, scoring, elig.posSet);
        line = applyAdjustment(line, model, level, {
          adjust: settings.adjust,
          scoring: scoring,
          isGoalie: !!elig.posSet.G
        });
        // What the adjustment was actually worth, in points. A tier percentage
        // does not translate to the same points swing for everyone: a goalie
        // moves all four of their stats and two of those are penalties, so a
        // 5% tier can be worth 9% of their total. Reporting the real number
        // keeps that visible instead of surprising.
        adjDelta = fantasyPoints(line, model, scoring, elig.posSet) - before;
      }

      var fp = fantasyPoints(line, model, scoring, elig.posSet);
      rows.push({
        id: player.id,
        name: player.name,
        team: player.team,
        pos: elig.pos,
        posSet: elig.posSet,
        posLabel: elig.posLabel,
        age: player.age,
        adp: adpFor(player, settings.adpSource),
        sourceCount: player.sourceCount,
        line: line,
        adj: level,
        adjDelta: adjDelta,
        gp: gp,
        fp: fp,
        fpg: gp ? fp / gp : 0
      });
    }

    var drafted = settings.drafted || {};
    var countBench = settings.countBench !== false;
    var draftedCount = 0;
    var consumed = { F: 0, D: 0, G: 0 };
    for (var d = 0; d < rows.length; d++) {
      if (!drafted[rows[d].id]) continue;
      draftedCount++;
      consumed[groupOf(rows[d])]++;
    }

    // The live view prices every player against the pool still on the board and
    // the roster spots still unfilled -- both have to shrink together.
    var available = rows.filter(function (r) { return !drafted[r.id]; });
    var pool = settings.dynamic ? available : rows;
    var spots = Math.max(teams * rosterSpotCount(slots) - draftedCount, 1);

    var picked = settings.replacementMethod === "position"
      ? replacementByPosition(pool, slots, teams, countBench)
      : replacementByDraft(pool, slots, teams,
          settings.dynamic ? consumed : null, countBench);
    var replacement = picked.level;

    // Positional ranks come from the full board so a player's "C7" label does
    // not shuffle every time somebody else is drafted.
    var posRank = {};
    for (var p = 0; p < POSITIONS.length; p++) {
      var pos = POSITIONS[p];
      var eligible = rows.filter(function (r) { return r.posSet[pos]; });
      eligible.sort(function (a, b) { return b.fp - a.fp; });
      var map = {};
      for (var e = 0; e < eligible.length; e++) map[eligible[e].id] = e + 1;
      posRank[pos] = map;
    }

    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      row.vorp = bestVorp(row, replacement);
      row.bestPos = bestPosition(row, replacement);
      var labels = [];
      for (var q = 0; q < POSITIONS.length; q++) {
        var pp = POSITIONS[q];
        if (row.posSet[pp]) labels.push(POS_LABEL[pp] + posRank[pp][row.id]);
      }
      row.prnk = labels.join(" ");
    }

    rows.sort(function (a, b) { return b.vorp - a.vorp; });
    for (var n = 0; n < rows.length; n++) rows[n].rank = n + 1;

    /* Drop-off: how far this player is above the next one still available at
     * the same position.
     *
     * This is the question replacement level cannot answer -- "if I pass here,
     * what do I actually lose?" Replacement level is a season-long baseline and
     * correctly holds still through an orderly draft; the drop-off moves on
     * every pick, and spikes exactly when a position is about to fall off a
     * cliff. A drafted player's drop-off is measured from where they were, so
     * the column stays readable after they come off the board.
     */
    for (var bp = 0; bp < POSITIONS.length; bp++) {
      var dpos = POSITIONS[bp];
      var stillThere = [];
      for (var a = 0; a < rows.length; a++) {
        if (rows[a].posSet[dpos] && !drafted[rows[a].id]) stillThere.push(rows[a]);
      }
      stillThere.sort(function (x, y) { return y.fp - x.fp; });
      for (var b = 0; b < rows.length; b++) {
        var who = rows[b];
        if (who.bestPos !== dpos) continue;
        // First still-available player scoring strictly less, by binary search
        // over the descending list -- this runs on every settings keystroke.
        var lo = 0;
        var hi = stillThere.length;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (stillThere[mid].fp < who.fp) hi = mid; else lo = mid + 1;
        }
        var next = lo < stillThere.length ? stillThere[lo] : null;
        who.dropoff = next ? who.fp - next.fp : 0;
        who.nextUp = next ? next.name : "";
      }
    }

    // Tier within the position a player is actually most valuable at, so a
    // multi-position player is tiered where you would really slot them. The
    // replacement depth doubles as the draftable range used to calibrate the
    // gap threshold -- past it, players are by definition interchangeable.
    var tierK = settings.tierK === undefined ? 1.0 : settings.tierK;
    for (var t = 0; t < POSITIONS.length; t++) {
      var tpos = POSITIONS[t];
      var group = rows.filter(function (x) { return x.bestPos === tpos; });
      group.sort(function (a, b) { return b.vorp - a.vorp; });
      assignTiers(group, tierK, picked.depth[tpos]);
    }

    return {
      rows: rows,
      replacement: replacement,
      replacementDepth: picked.depth,
      spots: spots,
      draftedCount: draftedCount,
      consumed: consumed,
      slotsByPosition: positionalSlots(slots, teams, countBench)
    };
  }

  return {
    POSITIONS: POSITIONS,
    POS_LABEL: POS_LABEL,
    weightedMean: weightedMean,
    blendPlayer: blendPlayer,
    adjustmentPct: adjustmentPct,
    applyAdjustment: applyAdjustment,
    fantasyPoints: fantasyPoints,
    positionalSlots: positionalSlots,
    replacementByPosition: replacementByPosition,
    replacementByDraft: replacementByDraft,
    bestVorp: bestVorp,
    groupOf: groupOf,
    nthBestAt: nthBestAt,
    assignTiers: assignTiers,
    rosterSpotCount: rosterSpotCount,
    createModel: createModel,
    createHistoryModel: createHistoryModel,
    computeHistory: computeHistory,
    HISTORY_SOURCE: HISTORY_SOURCE,
    compute: compute
  };
});
