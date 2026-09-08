/* Reading a projection file the user picks in the browser.
 *
 * Everything here is pure: text or bytes in, rows and a column mapping out. No
 * DOM, so tests/test_importer.js can run it under Node against the real source
 * files rather than fixtures invented to pass.
 *
 * Kept to ES2018 syntax because the Node available here is v12.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Importer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ names */

  var SUFFIXES = /\b(jr|sr|ii|iii|iv)\b/g;

  /* Port of drafttool/names.py::normalize.
   *
   * Both sides must agree exactly or an imported file silently fails to join,
   * so the payload also ships each player's key and a test asserts this
   * function reproduces every one of them.
   */
  function normalizeName(value) {
    if (value === null || value === undefined) return "";
    var text = String(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")   // drop combining accents
      .replace(/[^\x00-\x7f]/g, "")      // and anything still non-ASCII
      .toLowerCase()
      .replace(/[.'`]/g, "")
      .replace(/-/g, " ")
      .replace(SUFFIXES, "");
    return text.replace(/\s+/g, " ").trim();
  }

  /* ------------------------------------------------------------------ values */

  // Sites write "no value" in a dozen ways; an em dash is the one this project
  // first tripped over (7,274 of them in a single file).
  var BLANKS = { "": 1, "-": 1, "--": 1, "–": 1, "—": 1, "n/a": 1,
                 "na": 1, "null": 1, "none": 1, ".": 1 };

  function toNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return isFinite(value) ? value : null;
    var text = String(value).trim();
    if (BLANKS[text.toLowerCase()]) return null;
    // Spreadsheets prefix values with an apostrophe to force text, and numbers
    // arrive with thousands separators, percent signs and stray currency.
    text = text.replace(/^'/, "").replace(/,/g, "").replace(/[$%]/g, "").trim();
    if (!text) return null;
    // Time on ice as mm:ss.
    var clock = /^(\d+):([0-5]?\d)(?:\.\d+)?$/.exec(text);
    if (clock) return parseInt(clock[1], 10) + parseInt(clock[2], 10) / 60;
    var n = Number(text);
    return isFinite(n) ? n : null;
  }

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    return !!BLANKS[String(value).trim().toLowerCase()];
  }

  /* --------------------------------------------------------------- delimited */

  /* Sniff the delimiter from the first few lines.
   *
   * Counting only characters outside quotes matters: a European export using
   * semicolons still has commas inside quoted team names, and a name like
   * "Smith, Jr." would otherwise win the vote for comma.
   */
  function sniffDelimiter(text) {
    var candidates = [",", "\t", ";", "|"];
    var sample = text.slice(0, 8000);
    var best = ",";
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var count = 0;
      var quoted = false;
      for (var j = 0; j < sample.length; j++) {
        var ch = sample[j];
        if (ch === '"') quoted = !quoted;
        else if (!quoted && ch === candidates[i]) count++;
      }
      if (count > bestScore) {
        bestScore = count;
        best = candidates[i];
      }
    }
    return bestScore > 0 ? best : ",";
  }

  /* RFC4180 with the usual real-world tolerances: BOM, CRLF or LF, doubled
   * quotes inside quoted fields, and a trailing newline. */
  function parseDelimited(text, delimiter) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var sep = delimiter || sniffDelimiter(text);

    var rows = [];
    var row = [];
    var field = "";
    var quoted = false;
    var i = 0;

    while (i < text.length) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }
      if (ch === '"') { quoted = true; i++; continue; }
      if (ch === sep) { row.push(field); field = ""; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i++;
        continue;
      }
      field += ch;
      i++;
    }
    row.push(field);
    rows.push(row);

    // Drop trailing blank lines without disturbing genuinely empty inner rows.
    while (rows.length && rows[rows.length - 1].every(function (c) { return c === ""; })) {
      rows.pop();
    }
    return { rows: rows, delimiter: sep };
  }

  /* -------------------------------------------------------------------- xlsx */

  function xmlUnescape(text) {
    return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
               .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
               .replace(/&#(\d+);/g, function (_, code) {
                 return String.fromCharCode(parseInt(code, 10));
               })
               .replace(/&amp;/g, "&");
  }

  function columnIndex(ref) {
    // "BC12" -> 54. Cells are addressed, not positional, so a sparse row has to
    // be placed by its reference or every value after a gap shifts left.
    var n = 0;
    for (var i = 0; i < ref.length; i++) {
      var code = ref.charCodeAt(i);
      if (code < 65 || code > 90) break;
      n = n * 26 + (code - 64);
    }
    return n - 1;
  }

  /* Minimal zip reader: walk the central directory and return the entries.
   *
   * `inflateRaw(bytes)` may return a Uint8Array or a Promise of one, which is
   * how the same code serves the browser's DecompressionStream and Node's
   * zlib.inflateRawSync.
   */
  function unzip(buffer, inflateRaw) {
    var view = new DataView(buffer);
    var bytes = new Uint8Array(buffer);

    // End of central directory: scan back for its signature.
    var eocd = -1;
    for (var i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");

    var count = view.getUint16(eocd + 10, true);
    var offset = view.getUint32(eocd + 16, true);

    var entries = [];
    for (var e = 0; e < count; e++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      var method = view.getUint16(offset + 10, true);
      var compressedSize = view.getUint32(offset + 20, true);
      var nameLength = view.getUint16(offset + 28, true);
      var extraLength = view.getUint16(offset + 30, true);
      var commentLength = view.getUint16(offset + 32, true);
      var localOffset = view.getUint32(offset + 42, true);
      var name = "";
      for (var n = 0; n < nameLength; n++) {
        name += String.fromCharCode(bytes[offset + 46 + n]);
      }
      entries.push({ name: name, method: method, size: compressedSize,
                     localOffset: localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    function read(entry) {
      // The local header repeats the name and extra fields with its own lengths.
      var localNameLength = view.getUint16(entry.localOffset + 26, true);
      var localExtraLength = view.getUint16(entry.localOffset + 28, true);
      var start = entry.localOffset + 30 + localNameLength + localExtraLength;
      var raw = bytes.subarray(start, start + entry.size);
      if (entry.method === 0) return raw;          // stored
      return inflateRaw(raw);
    }

    return { entries: entries, read: read };
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    return require("util").TextDecoder ?
      new (require("util").TextDecoder)("utf-8").decode(bytes) : String(bytes);
  }

  /* List an xlsx workbook's sheets, in the order the workbook declares them.
   *
   * Sheet order is not file order: workbook.xml gives names and relationship
   * ids, and the rels file maps those to the worksheet parts. Assuming
   * sheet1.xml is the first tab is wrong often enough to matter.
   */
  function xlsxSheets(zip, texts) {
    var workbook = texts["xl/workbook.xml"] || "";
    var rels = texts["xl/_rels/workbook.xml.rels"] || "";

    var target = {};
    var relRe = /<Relationship\b[^>]*>/g;
    var rel;
    while ((rel = relRe.exec(rels))) {
      var id = /Id="([^"]+)"/.exec(rel[0]);
      var path = /Target="([^"]+)"/.exec(rel[0]);
      if (id && path) {
        var clean = path[1].replace(/^\/?xl\//, "").replace(/^\//, "");
        target[id[1]] = "xl/" + clean;
      }
    }

    var sheets = [];
    var sheetRe = /<sheet\b[^>]*\/?>/g;
    var match;
    while ((match = sheetRe.exec(workbook))) {
      var name = /name="([^"]*)"/.exec(match[0]);
      var rid = /r:id="([^"]+)"/.exec(match[0]);
      if (!name) continue;
      var part = rid ? target[rid[1]] : null;
      sheets.push({
        name: xmlUnescape(name[1]),
        part: part || ("xl/worksheets/sheet" + (sheets.length + 1) + ".xml")
      });
    }
    return sheets;
  }

  function sharedStrings(text) {
    if (!text) return [];
    var out = [];
    var siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    var si;
    while ((si = siRe.exec(text))) {
      // A string may be split across runs; concatenate every <t>.
      var parts = si[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
      out.push(parts.map(function (p) {
        return xmlUnescape(p.replace(/<t\b[^>]*>/, "").replace(/<\/t>$/, ""));
      }).join(""));
    }
    return out;
  }

  /* Walk <tag ...> ... </tag> pairs, tolerating the self-closing form.
   *
   * Written as an explicit scan rather than one regex on purpose. The obvious
   * pattern -- <c\b([^>]*)(?:\/>|>(.*?)<\/c>) -- is subtly wrong: for a
   * self-closing <c r="E1" s="195"/> the attribute group happily takes the
   * trailing slash, the \/> branch then fails, and the element instead matches
   * through to the *next* </c>, eating the following cell. In Yahoo's sheet
   * that silently swallowed the TEAM column and shifted everything after it.
   */
  function eachElement(text, tag, visit) {
    var open = new RegExp("<" + tag + "\\b([^>]*)>", "g");
    var close = "</" + tag + ">";
    var match;
    while ((match = open.exec(text))) {
      var attrs = match[1] || "";
      if (attrs.charAt(attrs.length - 1) === "/") {
        visit(attrs.slice(0, -1), "");          // self-closing: no content
        continue;
      }
      var end = text.indexOf(close, open.lastIndex);
      if (end < 0) { visit(attrs, ""); break; }
      visit(attrs, text.slice(open.lastIndex, end));
      open.lastIndex = end + close.length;
    }
  }

  function sheetRows(text, strings) {
    var rows = [];
    eachElement(text, "row", function (rowAttrs, body) {
      var cells = [];
      eachElement(body, "c", function (attrs, inner) {
        var ref = /r="([A-Z]+)\d+"/.exec(attrs);
        var index = ref ? columnIndex(ref[1]) : cells.length;
        var type = /t="([^"]+)"/.exec(attrs);
        var value = null;

        if (type && type[1] === "inlineStr") {
          var is = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
          value = is ? xmlUnescape(is[1]) : "";
        } else {
          // Take <v>, never <f>: a formula cell carries both, and the cached
          // <v> is the value the sheet actually shows.
          var v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          if (v) {
            var raw = xmlUnescape(v[1]);
            value = (type && type[1] === "s") ? (strings[Number(raw)] || "") : raw;
          }
        }
        while (cells.length < index) cells.push("");
        cells[index] = value === null ? "" : value;
      });
      rows.push(cells);
    });
    return rows;
  }

  /* Read a workbook. Returns a promise so the browser's async decompression and
   * Node's synchronous zlib can share one code path. */
  function readXlsx(buffer, options) {
    var inflateRaw = (options || {}).inflateRaw;
    if (!inflateRaw) throw new Error("readXlsx needs an inflateRaw function");
    var zip = unzip(buffer, inflateRaw);

    var wanted = ["xl/workbook.xml", "xl/_rels/workbook.xml.rels",
                  "xl/sharedStrings.xml"];
    var byName = {};
    zip.entries.forEach(function (entry) { byName[entry.name] = entry; });

    var pending = wanted.filter(function (n) { return byName[n]; })
                        .map(function (n) {
                          return Promise.resolve(zip.read(byName[n]))
                            .then(function (b) { return [n, decodeUtf8(b)]; });
                        });

    return Promise.all(pending).then(function (pairs) {
      var texts = {};
      pairs.forEach(function (p) { texts[p[0]] = p[1]; });
      var strings = sharedStrings(texts["xl/sharedStrings.xml"]);
      var sheets = xlsxSheets(zip, texts).filter(function (s) {
        return byName[s.part];
      });

      return {
        sheets: sheets.map(function (s) { return s.name; }),
        readSheet: function (nameOrIndex) {
          var sheet = typeof nameOrIndex === "number"
            ? sheets[nameOrIndex]
            : sheets.filter(function (s) { return s.name === nameOrIndex; })[0];
          if (!sheet) throw new Error("no such sheet: " + nameOrIndex);
          return Promise.resolve(zip.read(byName[sheet.part])).then(function (b) {
            return sheetRows(decodeUtf8(b), strings);
          });
        }
      };
    });
  }

  /* -------------------------------------------------------------- mapping */

  /* Header spellings seen in the wild, per target field.
   *
   * Compared after normalizeHeader, which keeps + - / % because they carry the
   * meaning in "+/-", "T/O" and "SV%".
   */
  var SYNONYMS = {
    name: ["player", "name", "players", "skater", "goalie", "full name",
           "player name", "playername"],
    team: ["team", "tm", "club", "teams", "nhl team"],
    pos: ["pos", "position", "positions", "y! pos", "yahoo pos", "elig",
          "eligibility", "eligible", "pos(s)"],

    GP: ["gp", "games", "games played", "gms", "gamesplayed"],
    G: ["g", "goals", "goal", "gls"],
    A: ["a", "assists", "ast", "asst", "assist", "apples"],
    PTS: ["pts", "points", "p", "pt"],
    SOG: ["sog", "shots", "sh", "shots on goal", "shots on net", "shot", "s"],
    PPG: ["ppg", "pp goals", "pp g", "powerplay goals", "power play goals",
          "pp goal"],
    PPP: ["ppp", "pp points", "pp pts", "powerplay points", "power play points",
          "pp p", "pp point"],
    SHG: ["shg", "sh goals", "sh g", "shorthanded goals", "short handed goals"],
    SHP: ["shp", "sh points", "sh pts", "sh p", "shorthanded points",
          "short handed points"],
    BLK: ["blk", "blocks", "blocked shots", "bs", "blk shots", "blocked"],
    HIT: ["hit", "hits", "hts", "hitting"],
    PM: ["+/-", "+-", "plus minus", "plusminus", "pm", "plus/minus"],
    PIM: ["pim", "penalty minutes", "pen min", "pims", "pen"],
    GWG: ["gwg", "game winning goals", "gw goals", "gw"],
    FOW: ["fow", "faceoff wins", "fo wins", "fo w", "faceoffs won", "fw"],
    FOL: ["fol", "faceoff losses", "fo losses", "fo l", "faceoffs lost", "fl"],
    ATOI: ["atoi", "toi/gp", "avg toi", "average toi", "time on ice", "toi",
           "min/gp", "ice time", "total toi", "toi/g"],

    W: ["w", "wins", "win"],
    L: ["l", "losses", "loss", "lost"],
    OTL: ["otl", "t/o", "ot", "ot losses", "otl+t", "ties", "ol", "otll"],
    SO: ["so", "shutouts", "sho", "shut outs", "shutout"],
    SV: ["sv", "saves", "save", "svs"],
    SA: ["sa", "shots against", "shots faced", "sog against", "shots ag"],
    GA: ["ga", "goals against", "goals ag"],
    "SV%": ["sv%", "save %", "sv pct", "save percentage", "svpct", "sv pctg",
            "save pct"],
    GAA: ["gaa", "goals against average", "gaa avg", "avg ga"]
  };

  /* Headers that mean the right thing but only when nothing better is present.
   * Goalie sheets record games as starts, and mapping that to GP alongside a
   * real GP column is safe because several columns may feed one stat. */
  var WEAK = { GP: ["gs", "games started", "starts"] };

  function normalizeHeader(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/^'/, "")
      .toLowerCase()
      .replace(/[^a-z0-9+\-/%\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  var HEADER_LOOKUP = (function () {
    var map = {};
    Object.keys(SYNONYMS).forEach(function (field) {
      SYNONYMS[field].forEach(function (word) {
        if (!(word in map)) map[word] = field;
      });
    });
    return map;
  })();

  var WEAK_LOOKUP = (function () {
    var map = {};
    Object.keys(WEAK).forEach(function (field) {
      WEAK[field].forEach(function (word) { map[word] = field; });
    });
    return map;
  })();

  /* Headings that genuinely could be two things, and so are worth a look.
   *
   * Deliberately short. "G", "A", "W" and "L" are unambiguous in a hockey
   * projection file, and flagging them buried the two columns that actually
   * needed attention under four that did not. "S" really can be shots or saves,
   * "P" points or penalty minutes, "SH" shorthanded or shots, "OT" overtime
   * losses or overtime games. */
  var AMBIGUOUS = { s: 1, p: 1, sh: 1, ot: 1 };

  function fieldFor(header) {
    var key = normalizeHeader(header);
    if (!key) return null;
    return HEADER_LOOKUP[key] || WEAK_LOOKUP[key] || null;
  }

  /* Which row holds the column headings.
   *
   * Files put banners above the data -- Apples & Ginos spends six rows on
   * instructions and settings before the real header on row 7 -- so the header
   * is found by looking for the row that recognises the most columns, not by
   * assuming row 1.
   */
  function detectHeaderRow(rows, limit) {
    var scanned = Math.min(rows.length, limit || 15);
    var best = 0;
    var bestScore = 0;
    for (var r = 0; r < scanned; r++) {
      var seen = {};
      var score = 0;
      var hasName = false;
      for (var c = 0; c < rows[r].length; c++) {
        var field = fieldFor(rows[r][c]);
        if (!field) continue;
        if (field === "name") hasName = true;
        // Count distinct fields, so a row of twenty identical labels does not
        // outscore a genuine header.
        if (!seen[field]) { seen[field] = 1; score++; }
      }
      if (hasName) score += 3;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  /* Does a candidate points column track goals + assists?
   *
   * The supplied CSV has two columns both headed PTS: one is fantasy points
   * (1047.5) and one is hockey points (126). Nothing in the header separates
   * them, but only the second equals G + A.
   */
  function looksLikePoints(rows, column, goalCol, assistCol) {
    if (goalCol === undefined || assistCol === undefined) return false;
    var checked = 0;
    var agree = 0;
    for (var i = 0; i < rows.length && checked < 40; i++) {
      var value = toNumber(rows[i][column]);
      var goals = toNumber(rows[i][goalCol]);
      var assists = toNumber(rows[i][assistCol]);
      if (value === null || goals === null || assists === null) continue;
      checked++;
      var expected = goals + assists;
      if (Math.abs(value - expected) <= Math.max(1, expected * 0.02)) agree++;
    }
    return checked >= 5 && agree / checked > 0.8;
  }

  /* Guess a target for every column.
   *
   * Returns one entry per column: its heading, a sample value, the guess, and
   * whether that guess is worth a second look. Several columns may target the
   * same stat -- Yahoo heads both its skater and goalie games columns "GP" --
   * and buildSource takes the first non-empty of them per player.
   */
  function autoMap(header, dataRows) {
    var columns = [];
    var byField = {};

    for (var c = 0; c < header.length; c++) {
      var raw = header[c] === undefined ? "" : String(header[c]).trim();
      var field = fieldFor(raw);
      var uncertain = false;
      var key = normalizeHeader(raw);

      if (field && AMBIGUOUS[key]) uncertain = true;
      if (WEAK_LOOKUP[key] && !HEADER_LOOKUP[key]) uncertain = true;

      var sample = "";
      for (var r = 0; r < dataRows.length && r < 30; r++) {
        if (!isBlank(dataRows[r][c])) { sample = String(dataRows[r][c]).trim(); break; }
      }

      // A second column feeding an already-claimed stat still works -- first
      // non-empty wins -- but it is worth a look, because it is as likely to be
      // a derived copy (Apples & Ginos repeat every stat weighted) as it is a
      // genuine skater/goalie split.
      if (field && field in byField) {
        uncertain = true;
      }

      columns.push({ index: c, header: raw, sample: sample,
                     field: field, uncertain: uncertain,
                     duplicate: !!(field && field in byField) });
      if (field && !(field in byField)) byField[field] = c;
    }

    // Points needs the arithmetic check, and only once G and A are known.
    columns.forEach(function (col) {
      if (col.field !== "PTS") return;
      if (looksLikePoints(dataRows, col.index, byField.G, byField.A)) {
        col.uncertain = false;
      } else {
        col.field = null;
        col.uncertain = true;
        col.note = "does not match goals + assists";
      }
    });

    // A name column is required; fall back to the first mostly-text column.
    if (!columns.some(function (col) { return col.field === "name"; })) {
      var guess = firstTextColumn(columns, dataRows);
      if (guess >= 0) {
        columns[guess].field = "name";
        columns[guess].uncertain = true;
      }
    }
    return columns;
  }

  function firstTextColumn(columns, dataRows) {
    for (var c = 0; c < columns.length; c++) {
      var text = 0;
      var seen = 0;
      for (var r = 0; r < dataRows.length && r < 30; r++) {
        var value = dataRows[r][c];
        if (isBlank(value)) continue;
        seen++;
        if (toNumber(value) === null && /[a-z]/i.test(String(value))) text++;
      }
      if (seen >= 5 && text / seen > 0.8) return c;
    }
    return -1;
  }

  /* Turn mapped rows into per-player stat lines.
   *
   * `resolve(name)` returns the board's join key for a display name, applying
   * the same alias table Python uses. Rows whose name resolves to nothing on
   * the board are still returned -- the caller decides whether to add them.
   */
  /* Does this sheet hold per-game rates rather than season totals?
   *
   * Some projection sheets publish rates -- 0.55 goals a game, not 45.7 --
   * and importing one as totals would value that whole source at about a
   * hundredth of what it is worth. The signal is not subtle: across the real
   * workbooks the largest goal figure is 45+ on a totals sheet and under 0.6
   * on a rate sheet, so a ceiling test separates them with two orders of
   * magnitude to spare. The caller still shows the answer as a toggle, because
   * a silent guess about the meaning of every number is not something to hide.
   */
  var PER_GAME_CEILING = { G: 3, PTS: 5, A: 4, SOG: 10, W: 2, SV: 5 };

  function looksPerGame(dataRows, columns) {
    var index = {};
    columns.forEach(function (col) {
      if (col.field && index[col.field] === undefined) index[col.field] = col.index;
    });
    if (index.GP === undefined) return false;

    var maxGp = 0;
    var maxima = {};
    for (var r = 0; r < dataRows.length; r++) {
      var gp = toNumber(dataRows[r][index.GP]);
      if (gp === null || gp < 10) continue;
      if (gp > maxGp) maxGp = gp;
      for (var stat in PER_GAME_CEILING) {
        if (index[stat] === undefined) continue;
        var v = toNumber(dataRows[r][index[stat]]);
        if (v !== null && (maxima[stat] === undefined || v > maxima[stat])) {
          maxima[stat] = v;
        }
      }
    }
    // Without a full season behind it, "per game" is not a claim worth making.
    if (maxGp < 10) return false;

    var judged = 0;
    for (var key in maxima) {
      judged++;
      if (maxima[key] >= PER_GAME_CEILING[key]) return false;
    }
    return judged > 0;
  }

  /* options: { perGame: bool, countingStats: [...] } -- when perGame is set,
     counting stats are multiplied back up by GP and rate stats are left alone,
     the same split drafttool/sources.py applies to the same sheet. */
  function buildSource(dataRows, columns, statKeys, resolve, options) {
    options = options || {};
    var perGame = !!options.perGame;
    var counting = {};
    (options.countingStats || []).forEach(function (k) { counting[k] = 1; });
    var nameCol = -1;
    var teamCol = -1;
    var posCol = -1;
    var statCols = {};

    columns.forEach(function (col) {
      if (!col.field) return;
      if (col.field === "name") { if (nameCol < 0) nameCol = col.index; return; }
      if (col.field === "team") { if (teamCol < 0) teamCol = col.index; return; }
      if (col.field === "pos") { if (posCol < 0) posCol = col.index; return; }
      if (!statCols[col.field]) statCols[col.field] = [];
      statCols[col.field].push(col.index);
    });

    if (nameCol < 0) throw new Error("no column is mapped to the player name");

    var players = [];
    var seen = {};
    for (var r = 0; r < dataRows.length; r++) {
      var row = dataRows[r];
      var display = row[nameCol] === undefined ? "" : String(row[nameCol]).trim();
      if (!display || isBlank(display)) continue;

      var stats = {};
      var any = false;
      for (var i = 0; i < statKeys.length; i++) {
        var stat = statKeys[i];
        var sources = statCols[stat];
        if (!sources) continue;
        for (var s = 0; s < sources.length; s++) {
          // First column with a value wins, which is how one stat can be fed by
          // a skater column and a goalie column in the same sheet.
          var value = toNumber(row[sources[s]]);
          if (value !== null) { stats[stat] = value; any = true; break; }
        }
      }
      if (!any) continue;

      if (perGame) {
        var games = stats.GP;
        if (games === undefined || games === null) continue;
        for (var scaled in stats) {
          if (counting[scaled]) stats[scaled] = stats[scaled] * games;
        }
      }

      var posText = posCol >= 0 ? String(row[posCol] || "").trim() : "";
      // resolve() may rewrite the name -- two players can share one, and only
      // the position separates them. It returns the key; resolveDisplay gives
      // the name that went with it.
      var key = resolve ? resolve(display, posText) : normalizeName(display);
      if (resolve && resolve.rename) display = resolve.rename(display, posText);
      if (seen[key]) continue;          // keep the first row for a player
      seen[key] = 1;

      players.push({
        key: key,
        name: display,
        team: teamCol >= 0 ? String(row[teamCol] || "").trim() : "",
        pos: posText,
        stats: stats
      });
    }
    return players;
  }

  return {
    normalizeName: normalizeName,
    normalizeHeader: normalizeHeader,
    toNumber: toNumber,
    isBlank: isBlank,
    sniffDelimiter: sniffDelimiter,
    parseDelimited: parseDelimited,
    readXlsx: readXlsx,
    detectHeaderRow: detectHeaderRow,
    autoMap: autoMap,
    buildSource: buildSource,
    looksPerGame: looksPerGame,
    fieldFor: fieldFor,
    SYNONYMS: SYNONYMS,
    _columnIndex: columnIndex,
    _sheetRows: sheetRows,
    _looksLikePoints: looksLikePoints
  };
});
