/* Draft board UI.
 *
 * All valuation lives in valuation.js; this file only handles state, rendering
 * and input. Any settings change re-runs the whole model and repaints, which is
 * fast enough at a few hundred players that there is no reason to complicate it
 * with incremental updates.
 */
(function () {
  "use strict";

  var DATA = window.DRAFT_DATA;
  var V = window.Valuation;
  var I = window.Importer;

  // The board as it currently stands: the built-in sources plus anything
  // imported through the UI. Rebuilt whenever the import list changes.
  var BOARD = DATA;
  var model = V.createModel(BOARD);
  var historyModel = V.createHistoryModel(DATA);
  var HISTORY_LABEL = (DATA.history && DATA.history.label) || "";
  var SCHEDULE = DATA.schedule || null;
  var AGE_BANDS = DATA.age_bands || {};
  var AGE_PRE = AGE_BANDS.pre_prime_max === undefined ? 24 : AGE_BANDS.pre_prime_max;
  var AGE_POST = AGE_BANDS.post_prime_min === undefined ? 31 : AGE_BANDS.post_prime_min;

  var STORE_KEY = "drafttool:" + (DATA.meta.season || "season");
  var POS = V.POSITIONS;

  /* ------------------------------------------------------------------ state */

  var MAX_ADJ = 3;

  var state = {
    settings: null,     // scoring / weights / model options
    drafted: {},        // id -> true    (off the board, anyone's pick)
    mine: {},           // id -> true    (subset of drafted: my roster)
    adjust: {},         // id -> -3..+3  (your own read on a player)
    marks: {},          // id -> "watch" | "avoid"  (prep notes, not draft state)
    imports: [],        // sources added through the UI, not the build
    removed: [],        // ids of built-in sources the user has taken off the board
    filter: "ALL",
    query: "",
    sortKey: "vorp",
    sortDir: -1,
    dynamic: true,
    hideDrafted: false,
    expanded: null,
    result: null
  };

  function defaultSettings() {
    var cfg = DATA.config;
    return {
      scoring: shallow(cfg.scoring),
      weights: shallow(cfg.source_weights),
      slots: shallow(cfg.league.slots),
      teams: cfg.league.teams,
      gpModel: cfg.model.gp_model,
      gpSource: cfg.model.gp_source,
      adpSource: cfg.model.adp_source || "average",
      eligibility: cfg.model.eligibility || "",
      playoffWindow: cfg.model.playoff_window || "skip",
      replacementMethod: cfg.model.replacement_method,
      countBench: cfg.model.count_bench !== false,
      tierK: cfg.model.tier_k,
      minGP: cfg.model.min_gp || 0,
      adjust: {
        tiers: (cfg.adjust && cfg.adjust.tiers) || [0.05, 0.10, 0.20],
        skaterStats: (cfg.adjust && cfg.adjust.skater_stats) || [],
        goalieStats: (cfg.adjust && cfg.adjust.goalie_stats) || []
      }
    };
  }

  function shallow(obj) {
    var out = {};
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }

  /* ---------------------------------------------------------------- imports */

  /* Resolve a display name to the board's join key.
   *
   * Uses the alias table the build shipped, so a file imported here matches
   * names exactly the way `python build.py` matches its own sources. Without
   * this an import would silently miss every player the alias table covers.
   */
  /* Apply the build's name-collision rules: same name, different player, told
     apart by position. Without this an imported file merges them again. */
  function disambiguated(name, posText) {
    var rules = DATA.disambiguate || [];
    var positions = parsePositions(posText);
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].name !== name) continue;
      if (positions.indexOf(rules[i].pos) >= 0) return rules[i].as;
    }
    return name;
  }

  function resolveName(name, posText) {
    var aliases = DATA.aliases || {};
    var key = I.normalizeName(disambiguated(name, posText));
    var seen = {};
    while (aliases[key] && !seen[key]) {
      seen[key] = 1;
      key = aliases[key];
    }
    return key;
  }

  resolveName.rename = disambiguated;

  function normalizeTeam(value) {
    var text = String(value || "").trim();
    if (!text) return "";
    var nick = (DATA.team_nicknames || {})[text.toLowerCase()];
    return nick || text.toUpperCase();
  }

  /* Fold the imports into the payload the model is built from.
   *
   * Players already on the board gain another source line; players only the
   * import knows about are appended. Appending shifts row ids, which is safe
   * because saved state is keyed by player name.
   */
  function rebuildBoard() {
    var dropped = {};
    (state.removed || []).forEach(function (id) { dropped[id] = 1; });
    var anyDropped = Object.keys(dropped).length > 0;

    if (!state.imports.length && !anyDropped) {
      BOARD = DATA;
      model = V.createModel(BOARD);
      return;
    }

    var statKeys = DATA.stats;
    var players = DATA.players.map(function (p) {
      var copy = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) copy[k] = p[k];
      copy.s = {};
      for (var sid in p.s) {
        if (!Object.prototype.hasOwnProperty.call(p.s, sid)) continue;
        if (dropped[sid]) continue;
        copy.s[sid] = p.s[sid];
      }
      return copy;
    });

    var byKey = {};
    players.forEach(function (p) { if (!(p.k in byKey)) byKey[p.k] = p; });

    var sources = DATA.sources.filter(function (s) { return !dropped[s.id]; });
    state.imports.forEach(function (imported) {
      var covered = {};
      var goalies = false;
      var count = 0;

      imported.rows.forEach(function (row) {
        var line = statKeys.map(function (stat) {
          var value = row.s[stat];
          if (value === undefined || value === null) return null;
          covered[stat] = 1;
          return value;
        });

        var player = byKey[row.k];
        if (!player) {
          player = {
            n: row.n,
            t: normalizeTeam(row.t),
            p: parsePositions(row.p),
            k: row.k,
            s: {}
          };
          players.push(player);
          byKey[row.k] = player;
        }
        player.s[imported.id] = line;
        count++;
        if (player.p.indexOf("G") >= 0) goalies = true;
      });

      sources.push({
        id: imported.id,
        name: imported.name,
        players: count,
        stats: Object.keys(covered),
        has_goalies: goalies,
        imported: true
      });
    });

    if (anyDropped) {
      players = players.filter(function (p) {
        for (var sid in p.s) {
          if (Object.prototype.hasOwnProperty.call(p.s, sid)) return true;
        }
        return false;
      });
    }

    BOARD = {
      meta: DATA.meta,
      stats: DATA.stats,
      counting_stats: DATA.counting_stats,
      rate_stats: DATA.rate_stats,
      sources: sources,
      players: players,
      config: DATA.config,
      history: DATA.history
    };
    model = V.createModel(BOARD);
  }

  /* Split a source's position string, falling back to centre.
   *
   * A player with no position cannot be valued against any replacement level,
   * so an unreadable position becomes C rather than dropping the player.
   */
  function parsePositions(raw) {
    var text = String(raw || "").toUpperCase().replace(/[^A-Z,/]/g, "");
    var out = [];
    text.split(/[,/]/).forEach(function (part) {
      var code = { C: "C", LW: "LW", L: "LW", RW: "RW", R: "RW",
                   D: "D", G: "G" }[part.trim()];
      if (part.trim() === "F") { ["C", "LW", "RW"].forEach(function (p) {
        if (out.indexOf(p) < 0) out.push(p);
      }); return; }
      if (part.trim() === "W") { ["LW", "RW"].forEach(function (p) {
        if (out.indexOf(p) < 0) out.push(p);
      }); return; }
      if (code && out.indexOf(code) < 0) out.push(code);
    });
    return out.length ? out : ["C"];
  }

  /* ------------------------------------------------- import review dialog */

  // Everything the dialog is currently looking at, between opening a file and
  // pressing Import.
  var pending = null;

  var TARGETS = [
    ["", "— ignore —"], ["name", "Player name"], ["team", "Team"],
    ["pos", "Position"]
  ];

  function inflateRaw(bytes) {
    // The browser's own decompression, so no zip library has to be bundled
    // into a file that must work offline.
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot open .xlsx files. Save the sheet as " +
                      "CSV and import that instead.");
    }
    var stream = new Response(bytes).body
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).arrayBuffer().then(function (buffer) {
      return new Uint8Array(buffer);
    });
  }

  function importError(message) {
    var box = document.getElementById("import-error");
    box.textContent = message;
    box.hidden = !message;
  }

  function openImport(file) {
    var name = file.name || "";
    var isCsv = /\.csv$/i.test(name);
    var isXlsx = /\.xlsx$/i.test(name);
    if (!isCsv && !isXlsx) {
      setStatus("Only .csv and .xlsx files can be imported");
      return;
    }

    pending = {
      perGame: false,
      perGameTouched: false,
      label: name.replace(/\.[^.]+$/, ""),
      workbook: null,
      sheet: null,
      rows: [],
      columns: [],
      headerRow: 0
    };
    importError("");

    var reader = new FileReader();
    reader.onerror = function () { setStatus("Could not read that file"); };
    reader.onload = function () {
      try {
        if (isCsv) {
          pending.rows = I.parseDelimited(String(reader.result)).rows;
          showImport();
        } else {
          I.readXlsx(reader.result, { inflateRaw: inflateRaw }).then(function (wb) {
            pending.workbook = wb;
            // Land on the first sheet that actually looks like projections
            // rather than a read-me: DtZ opens with 31 tabs.
            return pickSheet(wb, bestSheet(wb));
          }).then(showImport).catch(function (err) {
            showImport();
            importError(err.message || String(err));
          });
        }
      } catch (err) {
        setStatus(err.message || "Could not read that file");
      }
    };
    if (isCsv) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }

  function bestSheet(workbook) {
    // Prefer a tab whose name mentions projections; otherwise the first.
    for (var i = 0; i < workbook.sheets.length; i++) {
      if (/project|skater|forward|player|goalie/i.test(workbook.sheets[i])) return i;
    }
    return 0;
  }

  function pickSheet(workbook, index) {
    return workbook.readSheet(index).then(function (rows) {
      pending.sheet = index;
      pending.rows = rows;
    });
  }

  /* Re-run detection over whatever rows are loaded and paint the dialog. */
  function showImport(keepHeader) {
    var modal = document.getElementById("import-modal");
    modal.hidden = false;

    if (!keepHeader) {
      pending.headerRow = I.detectHeaderRow(pending.rows);
    }
    var header = pending.rows[pending.headerRow] || [];
    var body = pending.rows.slice(pending.headerRow + 1);
    pending.columns = I.autoMap(header, body);
    // Re-detected whenever the mapping changes, unless the user has said
    // otherwise -- once they touch the box, their answer stands.
    if (!pending.perGameTouched) {
      pending.perGame = I.looksPerGame(body, pending.columns);
    }
    document.getElementById("import-per-game").checked = !!pending.perGame;

    document.getElementById("import-name").value =
      document.getElementById("import-name").value || pending.label;
    document.getElementById("import-header").value = pending.headerRow + 1;

    var sheetRow = document.getElementById("import-sheet-row");
    if (pending.workbook) {
      sheetRow.hidden = false;
      var select = document.getElementById("import-sheet");
      select.innerHTML = pending.workbook.sheets.map(function (name, i) {
        return '<option value="' + i + '"' +
          (i === pending.sheet ? " selected" : "") + ">" + esc(name) + "</option>";
      }).join("");
    } else {
      sheetRow.hidden = true;
    }

    renderMapping();
    addSteppers(document.getElementById("import-modal"));
  }

  function renderMapping() {
    var options = TARGETS.concat(DATA.stats.map(function (stat) {
      return [stat, stat];
    }));

    var html = pending.columns.map(function (col) {
      var chosen = col.field || "";
      var selects = options.map(function (opt) {
        return '<option value="' + esc(opt[0]) + '"' +
          (opt[0] === chosen ? " selected" : "") + ">" + esc(opt[1]) + "</option>";
      }).join("");
      // The note gets its own line rather than riding on the sample. The
      // sample is what tells two identically-named columns apart, so losing it
      // to an ellipsis on exactly the cards flagged for review is backwards --
      // and a long unwrappable line here is what forced the card wider than
      // its grid track and pushed the whole dialog sideways.
      var note = col.note || (col.duplicate ? "second column for this stat" : "");
      return '<div class="mapcol' + (col.uncertain ? " mapcol-flag" : "") + '">' +
        '<div class="mapcol-head">' + esc(col.header || "(no heading)") +
        (col.uncertain ? ' <span class="mapcol-q">?</span>' : "") + "</div>" +
        '<div class="mapcol-sample">' + esc(col.sample || "—") + "</div>" +
        (note ? '<div class="mapcol-note">' + esc(note) + "</div>" : "") +
        '<select data-col="' + col.index + '">' + selects + "</select></div>";
    }).join("");

    document.getElementById("import-columns").innerHTML = html;
    updateImportSummary();
  }

  /* Tell the user how many rows will actually land before they commit. */
  function updateImportSummary() {
    var box = document.getElementById("import-summary");
    var body = pending.rows.slice(pending.headerRow + 1);
    var built;
    try {
      built = I.buildSource(body, pending.columns, DATA.stats, resolveName,
                            { perGame: pending.perGame,
                              countingStats: DATA.counting_stats });
    } catch (err) {
      box.textContent = err.message;
      pending.built = null;
      return;
    }
    var onBoard = {};
    BOARD.players.forEach(function (p) { onBoard[p.k] = 1; });
    var matched = built.filter(function (p) { return onBoard[p.key]; }).length;
    var stats = {};
    pending.columns.forEach(function (c) {
      if (c.field && TARGETS.every(function (t) { return t[0] !== c.field; })) {
        stats[c.field] = 1;
      }
    });

    pending.built = built;
    box.textContent = built.length + " players · " + matched +
      " matched to the board · " + (built.length - matched) + " new · " +
      Object.keys(stats).length + " stats mapped";
  }

  function closeImport() {
    document.getElementById("import-modal").hidden = true;
    document.getElementById("import-name").value = "";
    document.getElementById("import-columns").innerHTML = "";
    pending = null;
  }

  function commitImport() {
    if (!pending || !pending.built || !pending.built.length) {
      importError("Nothing to import — check that a column is mapped to the " +
                  "player name.");
      return;
    }
    var name = document.getElementById("import-name").value.trim() ||
               pending.label || "Imported";
    var weight = parseFloat(document.getElementById("import-weight").value);
    if (isNaN(weight)) weight = 1;

    var id = "IMP" + (state.imports.length + 1) + "-" +
             Math.random().toString(36).slice(2, 6);

    state.imports.push({
      id: id,
      name: name,
      rows: pending.built.map(function (p) {
        return { k: p.key, n: p.name, t: p.team, p: p.pos, s: p.stats };
      })
    });
    state.settings.weights[id] = weight;

    var count = pending.built.length;
    closeImport();
    rememberNames();          // while the old ids are still meaningful
    rebuildBoard();
    // Ids moved if the import added players, so re-resolve saved state by name.
    remapStateByName();
    refresh();
    renderSettings();
    setStatus("Imported " + name + " · " + count + " players");
  }

  /* Imports can append players, which renumbers every row. State is held by id
   * in memory, so translate it through names whenever the board changes. */
  function remapStateByName() {
    var saved = {
      drafted: toNamesFrom(state.drafted),
      mine: toNamesFrom(state.mine),
      adjust: toNamesFrom(state.adjust),
      marks: toNamesFrom(state.marks)
    };
    state.drafted = fromNames(saved.drafted, null);
    state.mine = fromNames(saved.mine, null);
    state.adjust = fromNames(saved.adjust, null);
    state.marks = fromNames(saved.marks, null);
  }

  // Snapshot taken against the model as it was before the rebuild.
  var previousNames = null;
  function toNamesFrom(map) {
    var out = {};
    (previousNames || []).forEach(function (name, id) {
      if (map[id]) out[name] = map[id];
    });
    return out;
  }

  function rememberNames() {
    previousNames = model.players.map(function (p) { return p.name; });
  }

  /* Take a source off the board entirely.
   *
   * Different from setting its weight to 0: a zero weight still leaves the
   * player on the board, so someone only that source projects sits there with
   * no numbers behind them. Removing drops those players too.
   *
   * An imported source is discarded; a built-in one is only hidden, since the
   * payload still holds it and it can be restored without re-importing a file.
   */
  function removeSource(id) {
    var imported = state.imports.filter(function (s) { return s.id === id; })[0];
    var builtin = DATA.sources.filter(function (s) { return s.id === id; })[0];
    var found = imported || builtin;
    if (!found) return;

    var message = imported
      ? 'Remove the imported source "' + found.name + '"?'
      : 'Remove "' + found.name + '" from the board? You can add it back from ' +
        "Settings without re-importing anything.";
    if (!confirm(message)) return;

    rememberNames();
    if (imported) {
      state.imports = state.imports.filter(function (s) { return s.id !== id; });
    } else {
      if (state.removed.indexOf(id) < 0) state.removed.push(id);
    }
    delete state.settings.weights[id];
    rebuildBoard();
    remapStateByName();
    refresh();
    renderSettings();
    // With nothing left, "Removed Daily Faceoff" is the less useful of the two
    // things that are true, and it would sit over the message that says what
    // to do next.
    setStatus(model.sources.length ? "Removed " + found.name : defaultStatus());
  }

  function restoreSource(id) {
    var builtin = DATA.sources.filter(function (s) { return s.id === id; })[0];
    if (!builtin) return;
    rememberNames();
    state.removed = state.removed.filter(function (x) { return x !== id; });
    // Back at the weight it shipped with, not at zero -- restoring a source
    // and seeing nothing change would look like the button did nothing.
    if (state.settings.weights[id] === undefined) {
      var shipped = DATA.config.source_weights[id];
      state.settings.weights[id] = shipped === undefined ? 1 : shipped;
    }
    rebuildBoard();
    remapStateByName();
    refresh();
    renderSettings();
    setStatus("Added " + builtin.name + " back");
  }

  /* ------------------------------------------------------------ persistence */

  // Bumped when the stored shape changes. Version 1 keyed players by their row
  // index; see load() for why that had to go.
  var STORE_VERSION = 2;

  function idByName() {
    var map = {};
    for (var i = 0; i < model.players.length; i++) {
      map[model.players[i].name.toLowerCase()] = model.players[i].id;
    }
    return map;
  }

  /* Player state travels by name, never by row index.
   *
   * A player's id is their position in the exported player list, and that
   * position comes from the order sources are merged in. Editing a projection
   * file and rebuilding shifts every index after the change -- dropping one
   * player near the top of a source moves 766 of 817 of them. Indexes stored
   * against the old build then land on whoever moved into that slot, so a
   * roster silently reappears against different players. Names survive.
   */
  function toNames(map) {
    var out = {};
    for (var i = 0; i < model.players.length; i++) {
      var value = map[model.players[i].id];
      if (value) out[model.players[i].name] = value;
    }
    return out;
  }

  function fromNames(map, missing) {
    var byName = idByName();
    var out = {};
    for (var name in map) {
      if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
      var id = byName[String(name).toLowerCase()];
      if (id === undefined) {
        if (missing) missing.push(name);
        continue;
      }
      out[id] = map[name];
    }
    return out;
  }

  /* Layer a saved settings object over the current defaults.
   *
   * Merging rather than replacing means a rebuild that adds a source or a stat
   * still picks up its new default instead of being overridden by a stale copy
   * that never heard of it.
   */
  /* A snapshot is a file someone can send you, so nothing in it is trusted.
     Every numeric setting is coerced and rejected if it is not a finite
     number: a string here would otherwise reach the settings panel and be
     written straight into an input's value attribute. Keys are already safe --
     only names present in the defaults are copied. */
  function numberOr(value, fallback) {
    var n = typeof value === "number" ? value : parseFloat(value);
    return (typeof n === "number" && isFinite(n)) ? n : fallback;
  }

  function mergeSettings(saved) {
    var base = defaultSettings();
    if (!saved) return base;

    // defaultSettings() only knows the built-in sources, and the loop below
    // copies saved values for keys that already exist. An imported source's id
    // ("IMP1-ab") is not one of them, so without seeding it here its weight is
    // dropped on every reload and the slider silently returns to 0. load()
    // restores state.imports and rebuilds the model before calling this, so
    // model.sources already includes them. Seeded at 0, not 1: an import with
    // no saved weight keeps today's behaviour rather than quietly gaining a
    // say in a draft that is already under way.
    ((model && model.sources) || []).forEach(function (source) {
      if (base.weights[source.id] === undefined) base.weights[source.id] = 0;
    });

    ["scoring", "weights", "slots"].forEach(function (group) {
      if (!saved[group]) return;
      for (var k in base[group]) {
        if (saved[group][k] !== undefined) {
          base[group][k] = numberOr(saved[group][k], base[group][k]);
        }
      }
    });
    ["teams", "tierK", "minGP"].forEach(function (k) {
      if (saved[k] !== undefined) base[k] = numberOr(saved[k], base[k]);
    });
    // Free-text settings are only ever compared against known ids, never
    // written into markup, but keep them to strings so nothing else can be
    // smuggled through as an object.
    ["gpModel", "gpSource", "adpSource", "eligibility", "playoffWindow",
     "replacementMethod"].forEach(function (k) {
      if (saved[k] !== undefined) base[k] = String(saved[k]);
    });
    if (saved.countBench !== undefined) base.countBench = !!saved.countBench;
    if (saved.adjust && Object.prototype.toString.call(saved.adjust.tiers) === "[object Array]") {
      base.adjust.tiers = saved.adjust.tiers.slice(0, 3).map(function (t, i) {
        return numberOr(t, base.adjust.tiers[i]);
      });
    }
    return base;
  }

  /* Persistence is best-effort: a browser with site data blocked should still
   * give a working board, just one that forgets between refreshes. */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: STORE_VERSION,
        settings: state.settings,
        drafted: toNames(state.drafted),
        mine: toNames(state.mine),
        adjust: toNames(state.adjust),
        marks: toNames(state.marks),
        imports: state.imports,
        removed: state.removed,
        dynamic: state.dynamic,
        hideDrafted: state.hideDrafted
      }));
    } catch (e) { /* private window, quota, or storage disabled */ }
  }

  // Names in a saved blob that no longer exist on the board, reported once the
  // board has rendered rather than disappearing without a word.
  var droppedOnLoad = [];

  function load() {
    state.settings = defaultSettings();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);

      // Imports come back before anything else: they change which players are
      // on the board, and every id below is an index into that list.
      state.imports = Array.isArray(saved.imports) ? saved.imports : [];
      // Only ids the payload still carries: a saved removal for a source that
      // has since been renamed or dropped from the build is meaningless.
      state.removed = (Array.isArray(saved.removed) ? saved.removed : [])
        .filter(function (id) {
          return DATA.sources.some(function (s) { return s.id === id; });
        });
      rebuildBoard();

      state.settings = mergeSettings(saved.settings);

      if (saved.version >= 2) {
        state.drafted = fromNames(saved.drafted || {}, droppedOnLoad);
        state.mine = fromNames(saved.mine || {}, null);
        state.adjust = fromNames(saved.adjust || {}, droppedOnLoad);
        state.marks = fromNames(saved.marks || {}, droppedOnLoad);
      } else {
        // Version 1 keyed players by row index. Those indexes are still valid
        // for the build that wrote them, and nothing has been rebuilt in
        // between or this entry would not be here -- so take them as they are.
        // The next save() rewrites the entry by name.
        state.drafted = saved.drafted || {};
        state.mine = saved.mine || {};
        state.adjust = saved.adjust || {};
      }

      if (saved.dynamic !== undefined) state.dynamic = saved.dynamic;
      if (saved.hideDrafted !== undefined) state.hideDrafted = saved.hideDrafted;
    } catch (e) { /* fall back to defaults */ }
  }

  /* ------------------------------------------------------------- formatting */

  function fmt(value, places) {
    if (value === null || value === undefined || isNaN(value)) return "";
    return value.toFixed(places === undefined ? 1 : places);
  }

  function signed(value) {
    if (value === null || value === undefined || isNaN(value)) return "";
    return (value > 0 ? "+" : "") + value.toFixed(1);
  }

  /* ---------------------------------------------------------------- steppers */

  /* Our own -/+ buttons on every number input.
   *
   * The native spinner is unusable as a shared control: Chrome fades it out
   * until you hover, Firefox draws it always, and Safari renders none at all.
   * Three behaviours for one widget is not something CSS can reconcile, so the
   * native one is hidden and these take over.
   *
   * Applied at runtime rather than in markup because the inputs come from ten
   * different places -- seven in the template, three generated loops -- and
   * the eleventh would inevitably be missed. Idempotent, so it is safe to
   * re-run after any render.
   */
  function addSteppers(root) {
    var inputs = (root || document).querySelectorAll('.field input[type="number"]');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      if (input.parentNode && input.parentNode.className === "stepper") continue;

      var wrap = document.createElement("div");
      wrap.className = "stepper";
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(makeStepButton(-1));
      wrap.appendChild(input);
      wrap.appendChild(makeStepButton(1));
      syncStepButtons(input);
    }
  }

  function makeStepButton(direction) {
    var button = document.createElement("button");
    button.className = "stepbtn";
    button.type = "button";
    // Not a tab stop: the input itself is already keyboard-steppable with the
    // arrow keys, so these would only add noise for anyone tabbing through.
    button.tabIndex = -1;
    button.setAttribute("data-step", direction);
    button.textContent = direction < 0 ? "−" : "+";
    return button;
  }

  function stepInput(input, direction) {
    try {
      if (input.value === "") input.value = input.getAttribute("min") || "0";
      // stepUp/stepDown honour min, max and step, which differ per input --
      // 0.05 for a scoring value, 1 for a roster slot, 0.1 for tier-k.
      if (direction < 0) input.stepDown();
      else input.stepUp();
    } catch (err) {
      // Thrown when the current value is not a valid number for this input.
      var min = parseFloat(input.getAttribute("min"));
      input.value = isNaN(min) ? "0" : String(min);
    }
    syncStepButtons(input);
    // The settings and import handlers are delegated "input" listeners, so
    // this is all it takes for the board to react exactly as if you typed.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function syncStepButtons(input) {
    var wrap = input.parentNode;
    if (!wrap || wrap.className !== "stepper") return;
    var value = parseFloat(input.value);
    var min = parseFloat(input.getAttribute("min"));
    var max = parseFloat(input.getAttribute("max"));
    var buttons = wrap.querySelectorAll(".stepbtn");
    for (var i = 0; i < buttons.length; i++) {
      var down = buttons[i].getAttribute("data-step") === "-1";
      var atLimit = isNaN(value) ? false
        : (down ? (!isNaN(min) && value <= min) : (!isNaN(max) && value >= max));
      buttons[i].disabled = atLimit;
    }
  }

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* Round from the overall board rank, so ADP and our rank are comparable in
   * the unit that actually matters at the table. */
  function roundOf(rank) {
    return Math.ceil(rank / state.settings.teams);
  }

  function pickLabel(rank) {
    var teams = state.settings.teams;
    var round = Math.ceil(rank / teams);
    var pick = rank - (round - 1) * teams;
    return round + "-" + (pick < 10 ? "0" : "") + pick;
  }

  /* ------------------------------------------------------------- computation */

  /* Last season's ranking, cached.
   *
   * It depends only on scoring and roster shape -- never on draft state -- so
   * marking players drafted must not pay for recomputing it. The cache key is
   * the settings that can actually move it.
   */
  var historyCache = { key: null, byIndex: null };

  function historyFor(settings) {
    if (!historyModel) return null;
    var key = JSON.stringify([settings.scoring, settings.slots, settings.teams,
                              settings.replacementMethod, settings.countBench]);
    if (historyCache.key === key) return historyCache.byIndex;

    var result = V.computeHistory(historyModel, settings);
    var byIndex = {};
    for (var i = 0; i < result.rows.length; i++) {
      var row = result.rows[i];
      byIndex[row.id] = { rank: row.rank, fp: row.fp, gp: row.gp, team: row.team };
    }
    historyCache.key = key;
    historyCache.byIndex = byIndex;
    return byIndex;
  }

  function recompute() {
    var settings = shallow(state.settings);
    settings.drafted = state.drafted;
    settings.dynamic = state.dynamic;
    settings.adjustments = state.adjust;
    state.result = V.compute(model, settings);

    var history = historyFor(state.settings);
    if (!history) return;
    var players = BOARD.players;
    for (var i = 0; i < state.result.rows.length; i++) {
      var row = state.result.rows[i];
      var index = players[row.id].h;
      row.last = index === undefined ? null : history[index] || null;
      // Flattened so the generic column sorter can read them.
      row.lastRank = row.last ? row.last.rank : null;
      row.lastFp = row.last ? row.last.fp : null;
    }
  }

  function visibleRows() {
    var rows = state.result.rows;
    var query = state.query.trim().toLowerCase();
    var filter = state.filter;

    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      // Asking for the drafted players outranks a standing "hide them", which
      // would otherwise leave the filter showing an empty table.
      if (state.hideDrafted && state.drafted[row.id] &&
          filter !== "DRAFTED") continue;
      if (filter !== "ALL") {
        if (filter === "F") {
          if (!(row.posSet.C || row.posSet.LW || row.posSet.RW)) continue;
        } else if (filter === "MINE") {
          if (!state.mine[row.id]) continue;
        } else if (filter === "ADJ") {
          if (!state.adjust[row.id]) continue;
        } else if (filter === "DRAFTED") {
          if (!state.drafted[row.id]) continue;
        } else if (filter === "WATCH") {
          if (state.marks[row.id] !== "watch") continue;
        } else if (filter === "AVOID") {
          if (state.marks[row.id] !== "avoid") continue;
        } else if (!row.posSet[filter]) continue;
      }
      if (query && row.name.toLowerCase().indexOf(query) === -1 &&
          row.team.toLowerCase().indexOf(query) === -1) continue;
      out.push(row);
    }

    var key = state.sortKey;
    var dir = state.sortDir;
    out.sort(function (a, b) {
      var x = a[key];
      var y = b[key];
      if (key === "name" || key === "team" || key === "posLabel" || key === "prnk") {
        x = String(x); y = String(y);
        return x < y ? -dir : (x > y ? dir : 0);
      }
      // Players with no ADP sort last regardless of direction -- an unlisted
      // player is not "the earliest pick in the draft".
      if (x === null || x === undefined || isNaN(x)) return 1;
      if (y === null || y === undefined || isNaN(y)) return -1;
      return (x - y) * dir;
    });
    return out;
  }

  /* ---------------------------------------------------------------- columns */

  var COLUMNS = [
    { key: "rank", label: "#", cls: "num", get: function (r) { return r.rank; } },
    { key: "adp", flagged: true, label: "ADP", cls: "num adp", render: adpCell },
    { key: "name", label: "Player", cls: "left", render: nameCell },
    { key: "team", label: "Tm", cls: "left tm", render: teamCell,
      title: "Team, with two schedule marks: the first is off-nights across the " +
             "season (games on a quiet night are ones you actually get to " +
             "start), the second is the fantasy playoff weeks. They are close " +
             "to independent — a team can be good at one and poor at the " +
             "other — so they are shown separately rather than combined." },
    { key: "posLabel", label: "Pos", cls: "left pos", get: function (r) { return r.posLabel; } },
    { key: "age", flagged: true, label: "Age", cls: "num age", render: ageCell,
      title: "Age, with a marker for the two ends of the curve: ▲ pre-prime " +
             "(" + AGE_PRE + " and under, chance to break out), ▼ post-prime (" +
             AGE_POST + " and over, chance to decline). It is a rule of thumb " +
             "about age alone — the projections already price a player, and " +
             "nothing here changes their value." },
    { key: "tier", label: "Tier", cls: "", render: tierCell },
    { key: "adj", label: "Adj", cls: "adjcell", render: adjCell,
      title: "Your own read on a player. Each step moves their projected " +
             "scoring by a set percentage — goals, assists, points, shots, " +
             "power play and +/- for skaters; wins, losses, saves and goals " +
             "against for goalies. Hits, blocks, PIM and faceoffs are left " +
             "alone, since a scoring opinion should not change a player's role." },
    { key: "mark", label: "Mark", cls: "markcell", render: markCell,
      title: "Your own shortlist. ★ keeps an eye on a player, ⊘ takes them off " +
             "your list entirely — an avoided player drops out of Best " +
             "Available, but still counts everywhere the board models what the " +
             "rest of the league will do, because someone else will draft them." },
    { key: "vorp", label: "VORP", cls: "vorp", render: vorpCell },
    { key: "dropoff", label: "Next", cls: "num drop", render: dropCell },
    { key: "fp", label: "FanPts", cls: "num", get: function (r) { return fmt(r.fp); } },
    { key: "fpg", label: "FP/GP", cls: "num", get: function (r) { return fmt(r.fpg, 2); } },
    { key: "gp", label: "GP", cls: "num", get: function (r) { return fmt(r.gp, 0); } },
    { key: "prnk", label: "PRnk", cls: "prnk", get: function (r) { return r.prnk; } },
    { key: "lastRank", flagged: true, label: HISTORY_LABEL + " (VORP)", cls: "num last", render: lastRankCell,
      title: "Last season's actual results, scored with your settings and ranked " +
             "by VORP the same way as this board — so 12 means he would have been " +
             "the 12th most valuable player last season. History only: never " +
             "blended into the projections. Blank means no row in the season " +
             "file, usually a rookie.",
      omit: !historyModel },
    { key: "lastFp", label: HISTORY_LABEL + " FP", cls: "num", render: lastFpCell,
      title: "Fantasy points actually scored last season under your current scoring.",
      omit: !historyModel },
    { key: "sourceCount", label: "Source", cls: "", render: sourceCell,
      title: "Which projection sources have a line for this player. A dim dot " +
             "means that source does not cover them." }
  ].filter(function (col) { return !col.omit; });

  /* Clicking a name opens the per-source comparison, but clicking anywhere
     else on the row drafts the player -- two different actions on one row, so
     the name needs to say it is its own target. The chevron appears on row
     hover rather than sitting on all 806 rows at rest, and stays on once the
     row is open, where it reports state rather than invites a click. */
  function nameCell(row) {
    var open = state.expanded === row.id;
    return '<span class="pname" title="Click to compare every source’s ' +
      'projection for this player">' + esc(row.name) + "</span>" +
      '<span class="pexp' + (open ? " open" : "") + '">' +
      (open ? "▾" : "▸") + "</span>";
  }

  /* Two toggles rather than a cycling cell, matching the Adj column beside it.
     Clicking an active mark clears it; the two are mutually exclusive. */
  function markCell(row) {
    var mark = state.marks[row.id] || "";
    return markButton(row, "watch", "★", mark) +
           markButton(row, "avoid", "⊘", mark);
  }

  function markButton(row, kind, glyph, current) {
    var on = current === kind;
    var label = kind === "watch"
      ? (on ? "On your watch list — click to remove" : "Keep an eye on this player")
      : (on ? "Marked do-not-draft — click to remove" : "Never draft this player");
    return '<button class="markbtn ' + kind + (on ? " on" : "") +
      '" data-mark="' + kind + '" tabindex="-1" title="' + esc(label) + '">' +
      glyph + "</button>";
  }

  function toggleMark(id, kind) {
    if (state.marks[id] === kind) delete state.marks[id];
    else state.marks[id] = kind;
    save();
    refresh();
  }

  function adjLabel(level) {
    if (!level) return "";
    return new Array(Math.abs(level) + 1).join(level > 0 ? "+" : "−");
  }

  /* Your manual read on a player: minus, the current tier, plus.
   *
   * Two explicit buttons rather than a click-to-cycle cell, so reaching a minus
   * tier is one click and nothing collides with click-to-draft on the row.
   */
  function adjCell(row) {
    var level = row.adj || 0;
    var pct = V.adjustmentPct(level, state.settings.adjust.tiers);
    var cls = level > 0 ? " up" : (level < 0 ? " down" : "");
    // Show what it is actually worth in points, not just the tier percentage --
    // the two differ, most of all for goalies.
    var title = level
      ? adjLabel(level) + "  " + (pct > 0 ? "+" : "") + Math.round(pct * 100) +
        "% on projected scoring  =  " + signed(row.adjDelta) + " FanPts"
      : "No adjustment";
    return '<button class="adjbtn" data-step="-1" tabindex="-1"' +
      (level <= -MAX_ADJ ? " disabled" : "") + ">−</button>" +
      '<span class="adjval' + cls + '" title="' + esc(title) + '">' +
      (adjLabel(level) || "·") + "</span>" +
      '<button class="adjbtn" data-step="1" tabindex="-1"' +
      (level >= MAX_ADJ ? " disabled" : "") + ">+</button>";
  }

  function vorpCell(row) {
    return '<span class="vorp' + (row.vorp < 0 ? " neg" : "") + '">' +
      signed(row.vorp) + "</span>";
  }

  /* How far this player is above the next one still available at their
   * position -- the cost of waiting. A big number is a cliff: take them now or
   * take a real step down. Highlighted once the gap is worth a whole tier. */
  function dropCell(row) {
    if (!row.dropoff) return "";
    var big = row.dropoff >= 20;
    return '<span class="drop' + (big ? " big" : "") + '" title="next ' +
      esc(row.bestPos) + " available: " + esc(row.nextUp) + '">' +
      fmt(row.dropoff) + "</span>";
  }

  function tierCell(row) {
    var tier = row.tier || 1;
    var cls = tier <= 3 ? " t" + tier : "";
    return '<span class="tier' + cls + '">' + (row.bestPos || "") + tier + "</span>";
  }

  /* ADP against our own rank, expressed in rounds. Anything the room is letting
   * fall two-plus rounds past where we have them is the pick worth noticing. */
  function adpCell(row) {
    if (row.adp === null) return "";
    var diff = roundOf(row.adp) - roundOf(row.rank);
    // Green/red is near-universal in fantasy tools so the hues stay, but they
    // are the hardest pair to tell apart and were the only signal here.
    var cls = diff >= 2 ? " steal" : (diff <= -2 ? " reach" : "");
    return '<span class="adp' + cls + '" title="ADP ' + fmt(row.adp) +
      " • our board " + pickLabel(row.rank) + '">' + fmt(row.adp) +
      flag(diff >= 2 ? 1 : (diff <= -2 ? -1 : 0)) + "</span>";
  }

  /* Where a player finished last season, against where the board has them now.
   *
   * The gap is the point of the column: a big rise means the projections expect
   * something last season did not show, and a big fall usually means age,
   * a role change, or a healthy season regressing. Games played sits in the
   * tooltip because injury explains most of the large drops.
   */
  /* Age plus a pre/post-prime marker. Blank when no source gives an age --
     11 of the players on the board, all fringe. */
  /* A fixed-width direction marker. Always emitted so the numbers in a
     right-aligned column keep their alignment whether or not a row is
     flagged; 1 is the favourable direction, -1 the unfavourable one. */
  function flag(direction) {
    var glyph = direction > 0 ? "▲" : (direction < 0 ? "▼" : "");
    return '<span class="flag">' + glyph + "</span>";
  }

  /* Team code plus two schedule marks: off-nights, then the playoff weeks.
     Indicator only -- neither touches the blend or VORP. */
  function teamCell(row) {
    var team = SCHEDULE && SCHEDULE.teams ? SCHEDULE.teams[row.team] : null;
    if (!team) return esc(row.team) + flag(0) + flag(0);

    // Not "window" -- that shadows the global inside this function.
    var windowId = state.settings.playoffWindow;
    var po = team.po && team.po[windowId] ? team.po[windowId] : null;
    var poTier = po ? po.tier : 0;

    var bits = [];
    if (team.off !== null && team.off !== undefined) {
      bits.push("Off-nights: " + fmt(team.off, 0) + " of " + fmt(team.games, 0) +
        (team.offPct ? " (" + Math.round(team.offPct * 100) + "%)" : "") +
        (team.offRank ? ", " + ordinal(team.offRank) + " of " + SCHEDULE.count : ""));
    }
    if (po) {
      bits.push("Playoffs " + windowLabel(windowId, true) + ": " + fmt(po.games, 0) +
        " games, " + fmt(po.off, 0) + " on off-nights" +
        (po.rank ? ", " + ordinal(po.rank) + " of " + SCHEDULE.count : ""));
    }
    return '<span class="tmcode" title="' + esc(bits.join(" · ")) + '">' +
      esc(row.team) + "</span>" + flag(team.offTier || 0) + flag(poTier);
  }

  function windowLabel(id, brief) {
    var windows = (SCHEDULE && SCHEDULE.windows) || [];
    for (var i = 0; i < windows.length; i++) {
      if (windows[i].id !== id) continue;
      return (brief && windows[i].short) || windows[i].name;
    }
    return id;
  }

  function ageCell(row) {
    if (row.age === null || row.age === undefined) return "";
    var age = Math.round(row.age);
    if (age <= AGE_PRE) {
      return '<span class="age pre" title="Pre-prime (' + AGE_PRE +
        ' and under) — chance to break out">' + age + flag(1) + "</span>";
    }
    if (age >= AGE_POST) {
      return '<span class="age post" title="Post-prime (' + AGE_POST +
        ' and over) — chance to decline">' + age + flag(-1) + "</span>";
    }
    return '<span class="age" title="In their prime (' + (AGE_PRE + 1) +
      "–" + (AGE_POST - 1) + ')">' + age + flag(0) + "</span>";
  }

  function lastRankCell(row) {
    if (!row.last) return '<span class="last none" title="No row in the ' +
      esc(HISTORY_LABEL) + ' file">—</span>';
    var delta = roundOf(row.last.rank) - roundOf(row.rank);
    var cls = delta >= 2 ? " up" : (delta <= -2 ? " down" : "");
    var title = ordinal(row.last.rank) + " · " + fmt(row.last.fp) + " FP · " +
      fmt(row.last.gp, 0) + " GP · " + row.last.team;
    return '<span class="last' + cls + '" title="' + esc(title) + '">' +
      row.last.rank + flag(delta >= 2 ? 1 : (delta <= -2 ? -1 : 0)) +
      "</span>";
  }

  function lastFpCell(row) {
    return row.last ? fmt(row.last.fp) : "";
  }

  function sourceCell(row) {
    var html = "";
    for (var i = 0; i < model.sources.length; i++) {
      var sid = model.sources[i].id;
      var on = row.line && model.players[row.id].s[sid];
      html += '<span class="srcdot' + (on ? " on" : "") + '" title="' +
        esc(model.sources[i].name) + (on ? "" : " (no projection)") + '"></span>';
    }
    return html;
  }

  /* --------------------------------------------------------------- rendering */

  var tbody = document.getElementById("rows");
  var thead = document.getElementById("head");

  function renderHead() {
    var html = "";
    for (var i = 0; i < COLUMNS.length; i++) {
      var col = COLUMNS[i];
      var sorted = state.sortKey === col.key;
      var classes = [];
      if (col.cls.indexOf("left") >= 0) classes.push("left");
      else if (col.cls.indexOf("adjcell") >= 0 ||
               col.cls.indexOf("markcell") >= 0) classes.push("center");
      // Cells in these columns end with a fixed-width direction slot, so the
      // heading has to clear the same width or it sits right of the numbers.
      if (col.flagged) classes.push("hasflag");
      if (sorted) classes.push("sorted");
      html += '<th data-key="' + col.key + '" class="' +
        classes.join(" ") + '"' +
        (col.title ? ' title="' + esc(col.title) + '"' : "") + ">" +
        esc(col.label) +
        (sorted ? '<span class="dir">' + (state.sortDir < 0 ? "▼" : "▲") + "</span>" : "") +
        "</th>";
    }
    thead.innerHTML = html;
  }

  function renderRows() {
    var rows = visibleRows();
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="' + COLUMNS.length +
        '" class="empty-state">No players match.</td></tr>';
      return;
    }

    var html = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cls = [];
      if (state.drafted[row.id]) cls.push("drafted");
      if (state.mine[row.id]) cls.push("mine");
      // The Mark column sits well to the right, so the row carries an edge too.
      if (state.marks[row.id]) cls.push(state.marks[row.id]);
      html.push('<tr data-id="' + row.id + '" class="' + cls.join(" ") + '">');
      for (var c = 0; c < COLUMNS.length; c++) {
        var col = COLUMNS[c];
        var content = col.render ? col.render(row) : esc(col.get(row));
        html.push('<td class="' + col.cls + '">' + content + "</td>");
      }
      html.push("</tr>");
      if (state.expanded === row.id) html.push(detailRow(row));
    }
    tbody.innerHTML = html.join("");
  }

  /* Per-source breakdown: where sources disagree is information, and a blended
   * number alone hides it. A player two sources love and one has never heard of
   * is a different bet from one all three agree on. */
  function detailRow(row) {
    var stats = model.stats;
    var player = model.players[row.id];
    var shown = [];
    for (var i = 0; i < stats.length; i++) {
      var used = state.settings.scoring[stats[i]] || stats[i] === "GP";
      var anySource = false;
      for (var s = 0; s < model.sources.length; s++) {
        var line = player.s[model.sources[s].id];
        if (line && line[i] !== null && line[i] !== undefined) { anySource = true; break; }
      }
      if (used && anySource) shown.push(i);
    }

    var html = '<tr class="detail"><td colspan="' + COLUMNS.length + '"><div class="detail-wrap">' +
      '<table class="srccmp"><tr><td class="slabel"></td>';
    for (var h = 0; h < shown.length; h++) {
      html += "<th>" + esc(stats[shown[h]]) + "</th>";
    }
    html += "</tr>";

    for (var m = 0; m < model.sources.length; m++) {
      var src = model.sources[m];
      var line2 = player.s[src.id];
      var weight = state.settings.weights[src.id];
      html += '<tr><td class="slabel">' + esc(src.name) +
        (weight ? " ×" + weight : " (off)") + "</td>";
      for (var k = 0; k < shown.length; k++) {
        var value = line2 ? line2[shown[k]] : null;
        html += value === null || value === undefined
          ? '<td class="absent">–</td>'
          : "<td>" + fmt(value, stats[shown[k]] === "GP" ? 0 : 1) + "</td>";
      }
      html += "</tr>";
    }

    html += '<tr class="blendrow"><td class="slabel">Blended</td>';
    for (var b = 0; b < shown.length; b++) {
      var blended = row.line[shown[b]];
      html += "<td>" + (blended === null ? "–" :
        fmt(blended, stats[shown[b]] === "GP" ? 0 : 1)) + "</td>";
    }
    html += "</tr></table></div></td></tr>";
    return html;
  }

  /* ---------------------------------------------------------------- side rail */

  function renderSide() {
    renderBestAvailable();
    renderRoster();
    renderReplacement();
  }

  function renderBestAvailable() {
    var groups = { C: [], LW: [], RW: [], D: [], G: [] };
    var rows = state.result.rows;
    var avoided = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (state.drafted[row.id]) continue;
      // "Who should I take" has to respect your own list. Replacement level and
      // the Next column deliberately do NOT -- they model what the whole league
      // does, and someone else will still draft this player.
      if (state.marks[row.id] === "avoid") { avoided++; continue; }
      for (var p = 0; p < POS.length; p++) {
        if (row.posSet[POS[p]] && groups[POS[p]].length < 3) groups[POS[p]].push(row);
      }
    }

    var html = "";
    for (var g = 0; g < POS.length; g++) {
      var pos = POS[g];
      var list = groups[pos];
      if (!list.length) {
        html += '<div class="bp-row empty"><span class="bp-pos">' + pos +
          '</span><span class="bp-name">—</span><span class="bp-v"></span></div>';
        continue;
      }
      for (var j = 0; j < list.length; j++) {
        html += '<div class="bp-row" data-id="' + list[j].id + '">' +
          '<span class="bp-pos">' + (j === 0 ? pos : "") + "</span>" +
          '<span class="bp-name">' + esc(list[j].name) + "</span>" +
          '<span class="bp-v">' + signed(list[j].vorp) + "</span></div>";
      }
    }
    if (avoided) {
      // Say so, or a missing name reads as a bug rather than your own decision.
      html += '<div class="bp-note">' + avoided + " player" +
        (avoided === 1 ? "" : "s") + " hidden by your do-not-draft marks</div>";
    }
    document.getElementById("bestpos").innerHTML = html;
  }

  /* Fill my roster greedily by VORP into the tightest slot a player fits, so
   * the "needs" list reflects what is actually still open. */
  function renderRoster() {
    var slots = state.settings.slots;
    var order = ["C", "LW", "RW", "W", "F", "D", "UTIL", "G", "BN"];
    var eligibility = {
      C: ["C"], LW: ["LW"], RW: ["RW"], W: ["LW", "RW"],
      F: ["C", "LW", "RW"], D: ["D"], UTIL: ["C", "LW", "RW", "D"], G: ["G"],
      BN: POS
    };

    var picks = state.result.rows.filter(function (r) { return state.mine[r.id]; });
    picks.sort(function (a, b) { return b.vorp - a.vorp; });

    var open = [];
    for (var o = 0; o < order.length; o++) {
      for (var n = 0; n < (slots[order[o]] || 0); n++) open.push({ type: order[o], player: null });
    }

    for (var p = 0; p < picks.length; p++) {
      var placed = false;
      for (var s = 0; s < open.length && !placed; s++) {
        if (open[s].player) continue;
        var allowed = eligibility[open[s].type] || [];
        for (var e = 0; e < allowed.length; e++) {
          if (picks[p].posSet[allowed[e]]) { open[s].player = picks[p]; placed = true; break; }
        }
      }
      if (!placed) open.push({ type: "XTRA", player: picks[p] });
    }

    var html = "";
    for (var i = 0; i < open.length; i++) {
      var slot = open[i];
      html += '<div class="slot' + (slot.player ? "" : " open") + '"' +
        (slot.player ? ' data-id="' + slot.player.id + '"' : "") + '>' +
        '<span class="s-pos">' + slot.type + "</span>" +
        '<span class="s-name">' + (slot.player ? esc(slot.player.name) : "open") +
        "</span></div>";
    }
    document.getElementById("slots").innerHTML = html;

    var total = 0;
    for (var t = 0; t < open.length; t++) if (open[t].player) total++;
    document.getElementById("rosterbar").textContent =
      total + " of " + V.rosterSpotCount(slots) + " filled · " +
      state.result.draftedCount + " players off the board";
  }

  /* Show the rank the replacement level came from, not the slot count.
   *
   * "C 336.5, the 57th best centre" explains the number; the slot count does
   * not, and printing it here actively misleads -- in draft mode the depth used
   * is far past the slot count because multi-position players drain the pool.
   * This panel is where a disagreement with any other ranking tool gets
   * diagnosed, so it has to state what the model actually did.
   */
  function renderReplacement() {
    var repl = state.result.replacement;
    var depth = state.result.replacementDepth;
    var html = "";
    for (var i = 0; i < POS.length; i++) {
      var pos = POS[i];
      html += "<div>" + pos + " <b>" + fmt(repl[pos]) + "</b> " +
        '<span style="color:var(--dim)">' + ordinal(depth[pos]) + " best " + pos +
        "</span></div>";
    }
    document.getElementById("repl").innerHTML = html;
  }

  function ordinal(n) {
    if (!n) return "—";
    var rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + "th";
    return n + (["th", "st", "nd", "rd"][n % 10] || "th");
  }

  /* ---------------------------------------------------------------- settings */

  /* Scoring keys are stat codes and read fine as-is, apart from the ones that
     are not stats at all. [display name, explanation]. */
  var SCORING_LABELS = {
    DPT: ["D pts", "Defence points: an extra award on every point a defenceman " +
                   "scores, on top of the goals and assists values above. " +
                   "Forwards and goalies are unaffected."],
    GS: ["GS", "Goalie starts: points for every game a goalie starts, which is " +
               "their GP on the board. Skaters are unaffected. Set it negative " +
               "if your league charges per start rather than paying for one."]
  };

  function renderSettings() {
    var settings = state.settings;

    var weights = "";
    for (var i = 0; i < model.sources.length; i++) {
      var src = model.sources[i];
      var weight = settings.weights[src.id] === undefined ? 0 : settings.weights[src.id];
      weights += '<div class="srcw">' +
        '<div class="srcw-top"><b>' + esc(src.name) + "</b>" +
        '<span class="w" id="w-label-' + esc(src.id) + '">' +
        numberOr(weight, 0).toFixed(1) + "</span></div>" +
        '<input type="range" min="0" max="3" step="0.1" value="' + numberOr(weight, 0) +
        '" data-weight="' + esc(src.id) + '">' +
        '<div class="cov">' + src.players + " players · " + src.stats.length +
        " stats · " + (src.has_goalies ? "skaters + goalies" : "skaters only") +
        ' <button class="linkbtn" data-remove-source="' + esc(src.id) +
        '">remove</button>' +
        "</div></div>";
    }
    // Built-in sources currently off the board, so removing one is never a
    // dead end that can only be undone by finding the original file again.
    var off = (state.removed || []).map(function (id) {
      return DATA.sources.filter(function (s) { return s.id === id; })[0];
    }).filter(Boolean);
    if (off.length) {
      weights += '<div class="srcw off"><div class="cov">Removed: ' +
        off.map(function (src) {
          return esc(src.name) + ' <button class="linkbtn" data-restore-source="' +
            esc(src.id) + '">add back</button>';
        }).join(" · ") + "</div></div>";
    }
    if (!model.sources.length) {
      weights = '<div class="srcw off"><div class="cov">No projection sources. ' +
        "Import a file, or add one back, to build a board.</div></div>" + weights;
    }
    document.getElementById("weights").innerHTML = weights;

    // Say plainly when a weight cannot do anything, rather than letting someone
    // spend the draft tuning a slider that is wired to nothing.
    var goalieSources = model.sources.filter(function (s) { return s.has_goalies; });
    var note = document.getElementById("goalie-note");
    if (goalieSources.length === 1) {
      note.innerHTML = "Only <b>" + esc(goalieSources[0].name) +
        "</b> projects goalies, so goalie values come from it alone — the other " +
        "weights have no effect on goalies until you add a second goalie source.";
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    var scoring = "";
    for (var stat in settings.scoring) {
      if (!Object.prototype.hasOwnProperty.call(settings.scoring, stat)) continue;
      var label = SCORING_LABELS[stat];
      scoring += '<div class="field"><label' +
        (label ? ' title="' + esc(label[1]) + '"' : "") + ">" +
        esc(label ? label[0] : stat) + "</label>" +
        '<input type="number" step="0.05" data-scoring="' + esc(stat) + '" value="' +
        esc(settings.scoring[stat]) + '"></div>';
    }
    document.getElementById("scoring").innerHTML = scoring;

    var slots = "";
    slots += '<div class="field"><label>Teams</label>' +
      '<input type="number" min="2" step="1" data-teams value="' +
      esc(settings.teams) + '"></div>';
    for (var slot in settings.slots) {
      if (!Object.prototype.hasOwnProperty.call(settings.slots, slot)) continue;
      slots += '<div class="field"><label>' + esc(slot) + "</label>" +
        '<input type="number" min="0" step="1" data-slot="' + esc(slot) + '" value="' +
        esc(settings.slots[slot]) + '"></div>';
    }
    document.getElementById("slots-cfg").innerHTML = slots;
    // Scoring and slot inputs are rebuilt from scratch here, so their steppers
    // have to be reattached.
    addSteppers(document.getElementById("drawer"));

    for (var t = 0; t < 3; t++) {
      var input = document.getElementById("adj-" + (t + 1));
      if (input) input.value = settings.adjust.tiers[t];
    }

    setSelect("gp-model", settings.gpModel);
    setSelect("gp-source", settings.gpSource);
    setSelect("adp-source", settings.adpSource);
    setSelect("eligibility", settings.eligibility);
    setSelect("playoff-window", settings.playoffWindow);
    setSelect("repl-method", settings.replacementMethod);
    setSelect("repl-depth", settings.countBench ? "roster" : "starters");
    document.getElementById("tier-k").value = settings.tierK;
    document.getElementById("min-gp").value = settings.minGP;
    document.getElementById("gp-source-row").hidden = settings.gpModel !== "rate_source_gp";
  }

  function setSelect(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  function buildPlayoffWindowOptions() {
    var row = document.getElementById("playoff-window-row");
    var windows = (SCHEDULE && SCHEDULE.windows) || [];
    if (!row) return;
    // No schedule pack in the build means no marks and nothing to choose.
    row.hidden = !windows.length;
    if (!windows.length) return;
    var html = "";
    for (var i = 0; i < windows.length; i++) {
      html += '<option value="' + esc(windows[i].id) + '">' +
        esc(windows[i].name) + "</option>";
    }
    document.getElementById("playoff-window").innerHTML = html;
  }

  function buildEligibilityOptions() {
    var providers = DATA.eligibility_providers || [];
    var row = document.getElementById("eligibility-row");
    if (!row) return;
    // No platform lists installed means there is nothing to choose between.
    row.hidden = !providers.length;
    if (!providers.length) return;
    // No neutral "projection sources" entry: the sources agree with Yahoo's
    // ruling on all but three players, so it would be a third option that
    // behaves almost identically to Yahoo. See DESIGN.md, "Position eligibility".
    var html = "";
    for (var i = 0; i < providers.length; i++) {
      html += '<option value="' + esc(providers[i].id) + '">' +
        esc(providers[i].name) + "</option>";
    }
    document.getElementById("eligibility").innerHTML = html;
  }

  function buildAdpSourceOptions() {
    var select = document.getElementById("adp-source");
    if (!select) return;
    var providers = DATA.adp_providers || [];
    if (!providers.length) {
      document.getElementById("adp-source").parentNode.hidden = true;
      return;
    }
    var html = "";
    for (var i = 0; i < providers.length; i++) {
      // The count is the point: it is how you tell that a blank ADP means
      // "this column does not rank him", not "we lost the number".
      html += '<option value="' + esc(providers[i].id) + '">' +
        esc(providers[i].name) + " • " + providers[i].players +
        " players</option>";
    }
    select.innerHTML = html;
  }

  function buildGpSourceOptions() {
    var select = document.getElementById("gp-source");
    var html = "";
    for (var i = 0; i < model.sources.length; i++) {
      html += '<option value="' + esc(model.sources[i].id) + '">' +
        esc(model.sources[i].name) + "</option>";
    }
    select.innerHTML = html;
  }

  /* ------------------------------------------------------------------ export */

  function exportCsv() {
    var last = HISTORY_LABEL || "LastYr";
    var header = ["Rank", "Player", "Team", "Pos", "Adj", "Mark", "Tier", "VORP", "Next",
                  "FanPts", "FP/GP", "GP", "PosRank", "ADP",
                  last + " Rank", last + " FP", last + " GP",
                  "Drafted", "MyTeam"];
    var lines = [header.join(",")];
    var rows = state.result.rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        r.rank, '"' + r.name.replace(/"/g, '""') + '"', r.team, '"' + r.posLabel + '"',
        r.adj || 0,
        state.marks[r.id] || "",
        (r.bestPos || "") + (r.tier || ""), r.vorp.toFixed(2),
        (r.dropoff || 0).toFixed(2), r.fp.toFixed(2),
        r.fpg.toFixed(3), r.gp === null ? "" : r.gp.toFixed(1), '"' + r.prnk + '"',
        r.adp === null ? "" : r.adp,
        r.last ? r.last.rank : "",
        r.last ? r.last.fp.toFixed(2) : "",
        r.last && r.last.gp !== null ? r.last.gp.toFixed(0) : "",
        state.drafted[r.id] ? "Y" : "", state.mine[r.id] ? "Y" : ""
      ].join(","));
    }
    download("rankings.csv", lines.join("\n"), "text/csv");
  }

  /* A complete snapshot: picks, your roster, adjustments and every setting.
   *
   * The browser already saves all of this on its own, so this file is not how
   * your work survives a reload or a rebuild. It is for carrying a setup to
   * another machine or browser, and for keeping a backup before you go
   * experimenting with scoring.
   */
  function exportDraft() {
    var payload = {
      version: STORE_VERSION,
      season: DATA.meta.season,
      settings: state.settings,
      drafted: [],
      mine: [],
      adjust: toNames(state.adjust),
      marks: toNames(state.marks)
    };
    var rows = state.result.rows;
    for (var i = 0; i < rows.length; i++) {
      if (state.drafted[rows[i].id]) payload.drafted.push(rows[i].name);
      if (state.mine[rows[i].id]) payload.mine.push(rows[i].name);
    }
    download("draft-snapshot.json", JSON.stringify(payload, null, 2),
             "application/json");
  }

  function importDraft(text) {
    var payload = JSON.parse(text);
    var byName = idByName();
    var missing = [];

    if (payload.settings) state.settings = mergeSettings(payload.settings);

    state.drafted = {};
    state.mine = {};
    state.adjust = {};
    state.marks = fromNames(payload.marks || {}, missing);

    (payload.drafted || []).forEach(function (name) {
      var id = byName[String(name).toLowerCase()];
      if (id === undefined) { missing.push(name); return; }
      state.drafted[id] = true;
    });
    (payload.mine || []).forEach(function (name) {
      var id = byName[String(name).toLowerCase()];
      if (id === undefined) return;   // already counted by the drafted pass
      state.mine[id] = true;
      state.drafted[id] = true;
    });

    var levels = fromNames(payload.adjust || {}, missing);
    for (var id in levels) {
      if (!Object.prototype.hasOwnProperty.call(levels, id)) continue;
      var level = parseInt(levels[id], 10);
      if (level) state.adjust[id] = Math.max(-MAX_ADJ, Math.min(MAX_ADJ, level));
    }

    refresh();
    // Owns its own status message: a warning about dropped names must not be
    // overwritten a moment later by a cheerful "restored".
    if (missing.length) reportDropped(missing, "that snapshot");
    else setStatus("Snapshot restored");
  }

  /* Say so when saved names no longer match the board -- a player dropped from
   * the projections should not disappear from your roster without a word. */
  function reportDropped(names, source) {
    setStatus(names.length + " name(s) in " + source +
              " are no longer on the board: " + names.slice(0, 3).join(", ") +
              (names.length > 3 ? "…" : ""));
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* ------------------------------------------------------------------ events */

  var statusTimer = null;
  function setStatus(text) {
    var el = document.getElementById("status");
    el.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { el.textContent = defaultStatus(); }, 4000);
  }

  function defaultStatus() {
    if (!model.sources.length) {
      return "No projection sources — import one from Settings to build a board";
    }
    var n = state.result ? state.result.rows.length : 0;
    return n + " players · " + model.sources.length +
      (model.sources.length === 1 ? " source" : " sources");
  }

  function refresh() {
    recompute();
    renderHead();
    renderRows();
    renderSide();
    document.getElementById("status").textContent = defaultStatus();
    save();
  }

  /* Move a player's adjustment one tier, clamped, and re-rank.
   *
   * Preserves the row under the cursor where it can: the board reorders on
   * every step, so without scroll restoration a click sends the player you are
   * working on somewhere off screen.
   */
  function adjustBy(id, step) {
    var next = Math.max(-MAX_ADJ, Math.min(MAX_ADJ, (state.adjust[id] || 0) + step));
    if (next) {
      state.adjust[id] = next;
    } else {
      delete state.adjust[id];
    }
    var scroll = document.querySelector("main").scrollTop;
    refresh();
    document.querySelector("main").scrollTop = scroll;
  }

  /* A double-click arrives as click, click, dblclick -- and the first click has
   * already flipped the drafted flag by the time dblclick runs. For a player
   * who was on your roster it also cleared `mine`, so the state alone can no
   * longer distinguish "was on my roster" from "was never drafted".
   *
   * So the first click of every pair records what the row looked like
   * beforehand, and the double-click handler works from that snapshot rather
   * than toggling from the already-mutated state.
   *
   * The alternative -- debouncing single clicks a couple of hundred
   * milliseconds to see whether a second one follows -- was rejected. Marking
   * players drafted is the most frequent thing you do during a live draft, and
   * that delay would be felt on every pick.
   */
  var beforeClick = { id: null, drafted: false, mine: false };
  var pendingRefresh = null;

  function rememberBeforeClick(id) {
    beforeClick = {
      id: id,
      drafted: !!state.drafted[id],
      mine: !!state.mine[id]
    };
  }

  /* Mark a player drafted on a single click, but hold the full re-render.
   *
   * A rebuild of the table would detach the row from under the pointer before
   * the second click of a double-click lands. With "hide drafted" on that is
   * actively dangerous: the row disappears, the list shifts up, and the second
   * click hits whoever slid into its place. So the state changes immediately,
   * the clicked row's own styling is updated in place for instant feedback, and
   * the expensive rebuild waits out the double-click window -- or is cancelled
   * by the double-click that follows.
   *
   * Rapid entry benefits too: five picks logged in a second cost one rebuild.
   */
  function draftAfterDoubleClickWindow(id) {
    rememberBeforeClick(id);
    if (state.drafted[id]) {
      delete state.drafted[id];
      delete state.mine[id];
    } else {
      state.drafted[id] = true;
    }
    styleRow(id);
    save();
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(function () {
      pendingRefresh = null;
      refresh();
    }, 260);
  }

  function cancelPendingRefresh() {
    if (pendingRefresh) {
      clearTimeout(pendingRefresh);
      pendingRefresh = null;
    }
  }

  /* Repaint one row's drafted/mine styling without touching the rest. */
  function styleRow(id) {
    var tr = tbody.querySelector('tr[data-id="' + id + '"]');
    if (!tr) return;
    tr.classList.toggle("drafted", !!state.drafted[id]);
    tr.classList.toggle("mine", !!state.mine[id]);
  }

  /* Put a player on your roster, or take them off if they were already on it. */
  function assignToRoster(id) {
    cancelPendingRefresh();
    var wasMine = beforeClick.id === id ? beforeClick.mine : !!state.mine[id];
    if (wasMine) {
      delete state.mine[id];
      delete state.drafted[id];
    } else {
      state.mine[id] = true;
      state.drafted[id] = true;
    }
    refresh();
  }

  function toggleDrafted(id, mineToo) {
    if (mineToo) {
      if (state.mine[id]) {
        delete state.mine[id];
        delete state.drafted[id];
      } else {
        state.mine[id] = true;
        state.drafted[id] = true;
      }
    } else if (state.drafted[id]) {
      delete state.drafted[id];
      delete state.mine[id];
    } else {
      state.drafted[id] = true;
    }
    refresh();
  }

  function bind() {
    document.getElementById("search").addEventListener("input", function (e) {
      state.query = e.target.value;
      renderRows();
    });

    document.querySelector(".filters").addEventListener("click", function (e) {
      var chip = e.target.closest(".chip");
      if (!chip) return;
      state.filter = chip.getAttribute("data-pos");
      document.querySelectorAll(".filters .chip").forEach(function (c) {
        c.classList.toggle("on", c === chip);
      });
      renderRows();
    });

    thead.addEventListener("click", function (e) {
      var th = e.target.closest("th");
      if (!th) return;
      var key = th.getAttribute("data-key");
      if (state.sortKey === key) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = key;
        // Ranks and ADP read best ascending; every other column descending.
        state.sortDir = (key === "rank" || key === "adp" || key === "prnk" ||
                         key === "lastRank" || key === "name" || key === "team" ||
                         key === "posLabel") ? 1 : -1;
      }
      renderHead();
      renderRows();
    });

    tbody.addEventListener("click", function (e) {
      var tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      var id = parseInt(tr.getAttribute("data-id"), 10);

      var button = e.target.closest(".adjbtn");
      if (button) {
        // Must not fall through to the row handler, which drafts the player.
        e.stopPropagation();
        adjustBy(id, parseInt(button.getAttribute("data-step"), 10));
        return;
      }
      var markBtn = e.target.closest("[data-mark]");
      if (markBtn) {
        toggleMark(id, markBtn.getAttribute("data-mark"));
        return;
      }
      // Anywhere else in the cell is dead space, not a draft click.
      if (e.target.closest(".markcell")) return;
      if (e.target.closest(".adjcell")) return;

      if (e.target.closest(".pname, .pexp")) {
        state.expanded = state.expanded === id ? null : id;
        renderRows();
        return;
      }

      // Second click of a double-click: the dblclick handler owns that gesture.
      if (e.detail > 1) return;
      draftAfterDoubleClickWindow(id);
    });

    tbody.addEventListener("dblclick", function (e) {
      var tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      if (e.target.closest(".adjcell") || e.target.closest(".pname")) return;
      assignToRoster(parseInt(tr.getAttribute("data-id"), 10));
    });

    document.getElementById("bestpos").addEventListener("click", function (e) {
      var row = e.target.closest(".bp-row[data-id]");
      if (!row || e.detail > 1) return;
      draftAfterDoubleClickWindow(parseInt(row.getAttribute("data-id"), 10));
    });

    document.getElementById("bestpos").addEventListener("dblclick", function (e) {
      var row = e.target.closest(".bp-row[data-id]");
      if (row) assignToRoster(parseInt(row.getAttribute("data-id"), 10));
    });

    document.getElementById("slots").addEventListener("click", function (e) {
      var slot = e.target.closest(".slot[data-id]");
      if (slot) toggleDrafted(parseInt(slot.getAttribute("data-id"), 10), true);
    });

    document.getElementById("dynamic").addEventListener("change", function (e) {
      state.dynamic = e.target.checked;
      refresh();
    });

    document.getElementById("hide-drafted").addEventListener("change", function (e) {
      state.hideDrafted = e.target.checked;
      renderRows();
    });

    document.getElementById("open-settings").addEventListener("click", function () {
      renderSettings();
      document.getElementById("drawer").hidden = false;
    });

    document.getElementById("close-settings").addEventListener("click", function () {
      document.getElementById("drawer").hidden = true;
    });

    var drawer = document.getElementById("drawer");

    document.addEventListener("click", function (e) {
      var button = e.target.closest && e.target.closest(".stepbtn");
      if (!button || button.disabled) return;
      var input = button.parentNode.querySelector('input[type="number"]');
      if (input) stepInput(input, parseInt(button.getAttribute("data-step"), 10));
    });

    document.addEventListener("input", function (e) {
      if (e.target.type === "number") syncStepButtons(e.target);
    });

    drawer.addEventListener("input", function (e) {
      var target = e.target;
      var settings = state.settings;

      if (target.hasAttribute("data-weight")) {
        var sid = target.getAttribute("data-weight");
        settings.weights[sid] = parseFloat(target.value);
        document.getElementById("w-label-" + sid).textContent =
          settings.weights[sid].toFixed(1);
      } else if (target.hasAttribute("data-scoring")) {
        settings.scoring[target.getAttribute("data-scoring")] =
          parseFloat(target.value) || 0;
      } else if (target.hasAttribute("data-slot")) {
        settings.slots[target.getAttribute("data-slot")] =
          Math.max(0, parseInt(target.value, 10) || 0);
      } else if (target.hasAttribute("data-teams")) {
        settings.teams = Math.max(2, parseInt(target.value, 10) || 2);
      } else if (target.id === "tier-k") {
        settings.tierK = parseFloat(target.value) || 0;
      } else if (target.id === "min-gp") {
        settings.minGP = Math.max(0, parseFloat(target.value) || 0);
      } else if (/^adj-[123]$/.test(target.id)) {
        var tier = parseInt(target.id.slice(4), 10) - 1;
        settings.adjust.tiers[tier] = Math.max(0, parseFloat(target.value) || 0);
      } else {
        return;
      }
      refresh();
    });

    drawer.addEventListener("change", function (e) {
      var settings = state.settings;
      if (e.target.id === "gp-model") {
        settings.gpModel = e.target.value;
        document.getElementById("gp-source-row").hidden =
          settings.gpModel !== "rate_source_gp";
      } else if (e.target.id === "gp-source") {
        settings.gpSource = e.target.value;
      } else if (e.target.id === "adp-source") {
        settings.adpSource = e.target.value;
      } else if (e.target.id === "eligibility") {
        settings.eligibility = e.target.value;
      } else if (e.target.id === "playoff-window") {
        settings.playoffWindow = e.target.value;
      } else if (e.target.id === "repl-method") {
        settings.replacementMethod = e.target.value;
      } else if (e.target.id === "repl-depth") {
        settings.countBench = e.target.value === "roster";
      } else {
        return;
      }
      refresh();
    });

    document.getElementById("reset-settings").addEventListener("click", function () {
      state.settings = defaultSettings();
      renderSettings();
      refresh();
      setStatus("Settings reset to the shipped defaults");
    });

    document.getElementById("clear-draft").addEventListener("click", function () {
      if (!confirm("Clear all drafted players and your roster?")) return;
      state.drafted = {};
      state.mine = {};
      refresh();
      setStatus("Draft cleared");
    });

    document.getElementById("clear-marks").addEventListener("click", function () {
      var count = Object.keys(state.marks).length;
      if (!count) { setStatus("No marks to clear"); return; }
      if (!confirm("Clear your marks on " + count + " player(s)?")) return;
      state.marks = {};
      refresh();
      setStatus("Marks cleared");
    });

    document.getElementById("clear-adjust").addEventListener("click", function () {
      var count = Object.keys(state.adjust).length;
      if (!count) { setStatus("No adjustments to clear"); return; }
      if (!confirm("Clear your adjustments on " + count + " player(s)?")) return;
      state.adjust = {};
      refresh();
      setStatus("Adjustments cleared");
    });

    document.getElementById("import-source").addEventListener("click", function () {
      document.getElementById("import-source-file").click();
    });

    document.getElementById("import-source-file").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) openImport(file);
    });

    document.getElementById("weights").addEventListener("click", function (e) {
      var button = e.target.closest("[data-remove-source]");
      if (button) { removeSource(button.getAttribute("data-remove-source")); return; }
      var restore = e.target.closest("[data-restore-source]");
      if (restore) restoreSource(restore.getAttribute("data-restore-source"));
    });

    var importModal = document.getElementById("import-modal");

    importModal.addEventListener("change", function (e) {
      if (!pending) return;
      if (e.target.id === "import-sheet") {
        pickSheet(pending.workbook, parseInt(e.target.value, 10))
          .then(function () { showImport(); })
          .catch(function (err) { importError(err.message || String(err)); });
        return;
      }
      if (e.target.hasAttribute("data-col")) {
        var index = parseInt(e.target.getAttribute("data-col"), 10);
        pending.columns.forEach(function (col) {
          if (col.index !== index) return;
          col.field = e.target.value || null;
          col.uncertain = false;
          col.note = "";
        });
        updateImportSummary();
      }
      if (e.target.id === "import-per-game") {
        pending.perGame = e.target.checked;
        pending.perGameTouched = true;
        updateImportSummary();
      }
    });

    importModal.addEventListener("input", function (e) {
      if (!pending) return;
      if (e.target.id === "import-header") {
        var row = Math.max(1, parseInt(e.target.value, 10) || 1) - 1;
        if (row < pending.rows.length) {
          pending.headerRow = row;
          showImport(true);
        }
      }
    });

    document.getElementById("import-confirm").addEventListener("click", commitImport);
    document.getElementById("import-cancel").addEventListener("click", closeImport);
    document.getElementById("import-cancel-2").addEventListener("click", closeImport);

    document.getElementById("export-csv").addEventListener("click", exportCsv);
    document.getElementById("export-draft").addEventListener("click", exportDraft);

    document.getElementById("import-draft").addEventListener("click", function () {
      document.getElementById("import-file").click();
    });

    document.getElementById("import-file").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          importDraft(reader.result);
        } catch (err) {
          setStatus("Could not read that file");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (!document.getElementById("import-modal").hidden) { closeImport(); return; }
        document.getElementById("drawer").hidden = true;
        return;
      }
      // "/" jumps to search, the one shortcut worth muscle memory mid-draft.
      if (e.key === "/" && document.activeElement.id !== "search") {
        e.preventDefault();
        document.getElementById("search").focus();
        document.getElementById("search").select();
      }
    });
  }

  /* -------------------------------------------------------------------- init */

  load();
  buildGpSourceOptions();
  buildAdpSourceOptions();
  buildEligibilityOptions();
  buildPlayoffWindowOptions();
  addSteppers();
  document.getElementById("dynamic").checked = state.dynamic;
  document.getElementById("hide-drafted").checked = state.hideDrafted;
  // No team count here -- it is an editable setting, so a title that states it
  // goes stale the moment you change it.
  document.getElementById("subtitle").textContent =
    DATA.meta.season + " · points league";
  bind();
  refresh();
  if (droppedOnLoad.length) reportDropped(droppedOnLoad, "your saved state");
})();
