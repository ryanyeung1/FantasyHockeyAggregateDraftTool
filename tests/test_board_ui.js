/* End-to-end check of the built board: loads out/draft_board.html in a headless
 * DOM and drives the real UI -- search, filters, drafting, the settings drawer,
 * sorting and persistence.
 *
 * Needs jsdom, which is not a project dependency (nothing else here needs npm):
 *     npm install jsdom
 * Skips cleanly when it is absent, and requires `python build.py` to have run.
 *
 * Run with: node tests/test_board_ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BOARD = path.join(__dirname, '..', 'out', 'draft_board.html');
const SOURCES = path.join(__dirname, '..', 'sources');
if (!fs.existsSync(BOARD)) {
  console.log('SKIP: out/draft_board.html not found -- run `python build.py` first.');
  process.exit(0);
}

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (err) {
  console.log('SKIP: jsdom is not installed (npm install jsdom).');
  process.exit(0);
}

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
  if (!cond) fails++;
}

const errors = [];
const dom = new JSDOM(fs.readFileSync(BOARD, 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://local.test/'
});
dom.virtualConsole.on('jsdomError', e => errors.push(e.message));
const { window } = dom;
const doc = window.document;
const $ = s => doc.querySelector(s);
const $$ = s => Array.from(doc.querySelectorAll(s));
const click = (el, opts) => el.dispatchEvent(new window.MouseEvent('click',
  Object.assign({ bubbles: true }, opts || {})));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
// A browser sends click(detail 1), click(detail 2), then dblclick. Replaying
// that exact sequence is the only way to test the gesture honestly.
// The board holds its rebuild back for the double-click window (see
// draftAfterDoubleClickWindow in app.js). Re-applying a setting at its current
// value forces one synchronously, without changing any state.
const flush = () => { const el = $('#min-gp'); el.value = el.value; fire(el, 'input'); };
const dblclick = (el) => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 2 }));
  el.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
};

setTimeout(() => {
  console.log('\n--- initial render ---');
  check('no script errors', errors.length === 0, errors.join(' | '));
  const rows = $$('#rows tr[data-id]');
  check('board rendered rows', rows.length > 800, rows.length + ' rows');
  // Column positions by header text. Adding a column used to shift every
  // hardcoded index and quietly move assertions onto the wrong cell.
  const COL = (() => {
    const map = {};
    $$('#head th').forEach((th, i) => { map[th.textContent.replace(/[▲▼]/g, '').trim()] = i; });
    return map;
  })();
  const cellOf = (row, header) => row.children[COL[header]];

  check('header rendered', $$('#head th').length === 18,
        $$('#head th').length + ' columns');
  const headings = $$('#head th').map(t => t.textContent.replace(/[\u25bc\u25b2]/g, '').trim());
  check('source column is spelled out',
        headings.indexOf('Source') >= 0 && headings.indexOf('Src') < 0,
        headings.join(' | '));
  check('last-season rank column says what the number is',
        headings.indexOf('25-26 (VORP)') >= 0, headings.join(' | '));
  check('last-season points column is unchanged',
        headings.indexOf('25-26 FP') >= 0, headings.join(' | '));
  // The team count is an editable setting, so it must not be baked into the title.
  check('subtitle names the season', /2026-27/.test($('#subtitle').textContent),
        $('#subtitle').textContent);
  check('subtitle does not state a team count',
        !/team/i.test($('#subtitle').textContent), $('#subtitle').textContent);
  check('status filled', /806 players . 4 sources/.test($('#status').textContent),
        $('#status').textContent);

  const first = rows[0];
  const name1 = first.querySelector('.pname').textContent;
  check('top player is MacKinnon', name1 === 'Nathan MacKinnon', name1);
  check('VORP shown with sign', /^\+/.test(first.querySelector('.vorp').textContent),
        first.querySelector('.vorp').textContent);
  check('tier badge shown', /^C\d+$/.test(first.querySelector('.tier').textContent),
        first.querySelector('.tier').textContent);

  console.log('\n--- side rail ---');
  check('best-available populated', $$('#bestpos .bp-row').length >= 5,
        $$('#bestpos .bp-row').length + ' entries');
  check('roster shows 16 open slots', $$('#slots .slot').length === 16,
        $$('#slots .slot').length + ' slots');
  // The panel must name the RANK it used, not the slot count -- the slot count
  // is what made the Yahoo comparison confusing in the first place.
  var replText = $('#repl').textContent.replace(/\s+/g, ' ').trim();
  check('replacement panel names the depth actually used',
        /\d+(st|nd|rd|th) best C/.test(replText), replText.slice(0, 70));
  check('replacement panel no longer prints slot counts',
        !/rostered/.test(replText));

  console.log('\n--- search + filter ---');
  const search = $('#search');
  check('search hint explains what / does',
        /press \/ to jump here/.test(search.getAttribute('placeholder')),
        search.getAttribute('placeholder'));
  search.value = 'makar';
  fire(search, 'input');
  const found = $$('#rows tr[data-id]');
  check('search narrows the board', found.length === 1 && /Makar/.test(found[0].textContent),
        found.length + ' rows');
  search.value = '';
  fire(search, 'input');

  // Count goalies on the unfiltered board first, so this does not need updating
  // every time a source is added.
  const allRows = $$('#rows tr[data-id]');
  const expectedGoalies = allRows.filter(r => cellOf(r, 'Pos').textContent.trim() === 'G').length;
  click($$('.filters .chip').find(c => c.getAttribute('data-pos') === 'G'));
  const goalies = $$('#rows tr[data-id]');
  check('G filter shows every goalie and nothing else',
        goalies.length === expectedGoalies && expectedGoalies > 0 &&
        goalies.every(r => cellOf(r, 'Pos').textContent.trim() === 'G'),
        goalies.length + ' shown, ' + expectedGoalies + ' on the board');
  click($$('.filters .chip').find(c => c.getAttribute('data-pos') === 'ALL'));

  console.log('\n--- drafting ---');
  const before = $$('#rows tr[data-id]')[0].querySelector('.pname').textContent;
  const beforeRepl = $('#repl').textContent;
  click($$('#rows tr[data-id]')[0].querySelector('.tm'));
  // The row restyles instantly; the full rebuild is deliberately held back so
  // the row cannot vanish from under a double-click. The side panels therefore
  // catch up a moment later, or as soon as anything forces a full refresh.
  check('clicked player marked drafted immediately',
        $$('#rows tr[data-id]')[0].classList.contains('drafted'), before);
  check('side panels not yet rebuilt during the double-click window',
        $('#bestpos').textContent.includes(before));

  const target = $$('#rows tr[data-id]').find(r => !r.classList.contains('drafted'));
  const pick = target.querySelector('.pname').textContent;
  dblclick(target.querySelector('.tm'));
  check('double-click adds to my roster', $('#slots').textContent.includes(pick), pick);
  check('shift-click no longer rosters anyone', (function () {
    const other = $$('#rows tr[data-id]').find(r => !r.classList.contains('drafted'));
    const name = other.querySelector('.pname').textContent;
    click(other.querySelector('.tm'), { shiftKey: true });
    const rostered = $('#slots').textContent.includes(name);
    click($$('#rows tr[data-id]').find(
      r => r.querySelector('.pname').textContent === name).querySelector('.tm'));
    return !rostered;
  })(), 'plain click should only mark drafted');
  check('roster counter updated', /1 of 16 filled/.test($('#rosterbar').textContent),
        $('#rosterbar').textContent.trim());
  // The double-click forced a full refresh, so the panels are current again.
  check('best-available dropped the drafted player',
        !$('#bestpos').textContent.includes(before), before);
  check('replacement level moved', $('#repl').textContent !== beforeRepl);

  console.log('\n--- double-click gestures ---');
  // Taking a player back off your roster.
  const onRoster = $$('#rows tr[data-id]').find(r => r.classList.contains('mine'));
  const onRosterName = onRoster.querySelector('.pname').textContent;
  dblclick(onRoster.querySelector('.tm'));
  check('double-clicking a rostered player removes them',
        !$('#slots').textContent.includes(onRosterName), onRosterName);
  const backOff = $$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === onRosterName);
  check('and clears them from the board entirely',
        !backOff.classList.contains('drafted') && !backOff.classList.contains('mine'));

  // A player already drafted by someone else becomes yours in one gesture.
  const theirs = $$('#rows tr[data-id]').find(
    r => r.classList.contains('drafted') && !r.classList.contains('mine'));
  if (theirs) {
    const theirsName = theirs.querySelector('.pname').textContent;
    dblclick(theirs.querySelector('.tm'));
    check('double-click claims a player marked drafted',
          $('#slots').textContent.includes(theirsName), theirsName);
    dblclick($$('#rows tr[data-id]').find(
      r => r.querySelector('.pname').textContent === theirsName).querySelector('.tm'));
  }

  // The name cell expands the row; double-clicking it must not roster anyone.
  const nameTarget = $$('#rows tr[data-id]').find(r => !r.classList.contains('drafted'));
  const nameTargetName = nameTarget.querySelector('.pname').textContent;
  dblclick(nameTarget.querySelector('.pname'));
  check('double-clicking a name does not roster the player',
        !$('#slots').textContent.includes(nameTargetName), nameTargetName);
  if ($('#rows tr.detail')) {
    click($$('#rows tr[data-id]').find(
      r => r.querySelector('.pname').textContent === nameTargetName).querySelector('.pname'));
  }

  console.log('\n--- expand row ---');
  const expandTarget = $$('#rows tr[data-id]').find(r => !r.classList.contains('drafted'));

  // Clicking the name opens the source comparison while clicking anywhere else
  // on the row drafts the player, so the name needs to advertise itself as a
  // separate target.
  const chev = expandTarget.querySelector('.pexp');
  check('the name carries an expand chevron', !!chev,
        expandTarget.querySelector('.pname').parentNode.innerHTML);
  check('and says what clicking it does',
        /compare/i.test(expandTarget.querySelector('.pname').getAttribute('title') || ''),
        expandTarget.querySelector('.pname').getAttribute('title'));
  // `css` is declared further down; read the page again rather than shadow it.
  const pageCss = fs.readFileSync(BOARD, 'utf8');
  check('the chevron is hidden until the row is hovered',
        /\.pexp[^{]*\{[^}]*opacity:\s*0/.test(pageCss) &&
        /tr:hover \.pexp[^{]*\{[^}]*opacity:\s*1/.test(pageCss));

  // The chevron sits beside the name, so it has to share its click target --
  // otherwise clicking the affordance would draft the player instead.
  // Expanding re-renders, so hold the name and look the row up again after.
  const expandName = expandTarget.querySelector('.pname').textContent;
  const rowNamed = () => $$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === expandName);
  click(chev);
  check('clicking the chevron expands rather than drafting',
        !!$('#rows tr.detail') && !rowNamed().classList.contains('drafted'),
        expandName);
  check('and it flips to the open state',
        rowNamed().querySelector('.pexp').classList.contains('open'),
        rowNamed().querySelector('.pexp').outerHTML);
  click(rowNamed().querySelector('.pname'));
  check('clicking again closes it', !$('#rows tr.detail'));

  // Reopen for the checks below; expandTarget is detached by now.
  click(rowNamed().querySelector('.pname'));
  const detail = $('#rows tr.detail');
  check('detail row opens', !!detail);
  if (detail) {
    check('shows every source', /Datsyuk/.test(detail.textContent) &&
          /Apples/.test(detail.textContent) && /Daily Faceoff/.test(detail.textContent));
    check('shows the blended line', /Blended/.test(detail.textContent));
    // Projections only: the player's name and their schedule are already on
    // the row you clicked, so repeating them here is just noise above the
    // thing you opened the panel for.
    check('opens straight into the table, with no heading or schedule blurb',
          !detail.querySelector('h4') && !detail.querySelector('.schednote') &&
          detail.querySelector('.detail-wrap').firstElementChild.tagName === 'TABLE',
          detail.querySelector('.detail-wrap').firstElementChild.tagName);
  }

  console.log('\n--- settings drawer ---');
  click($('#open-settings'));
  check('drawer opens', !$('#drawer').hidden);
  check('one weight slider per source', $$('#weights input[type=range]').length === 4,
        $$('#weights input[type=range]').length + ' sliders');
  // Two sources project goalies now, so the 'weights are inert' notice must go.
  check('goalie-only notice is gone', $('#goalie-note').hidden);
  check('adjustment tier inputs rendered', $$('#adjust-tiers input').length === 3);
  check('scoring inputs rendered', $$('#scoring input').length === 26,
        $$('#scoring input').length + ' inputs');
  // Defence points is the one positional scoring term: it must move
  // defencemen by exactly their points and leave everyone else alone.
  const fpOf = (name) => {
    const r = $$('#rows tr[data-id]').find(
      x => x.querySelector('.pname').textContent === name);
    return r ? parseFloat(cellOf(r, 'FanPts').textContent) : null;
  };
  const dptInput = $('[data-scoring="DPT"]');
  check('the D-points category has an input', !!dptInput);
  check('labelled readably rather than as a raw key',
        dptInput.closest('.field').querySelector('label').textContent.trim() === 'D pts',
        dptInput.closest('.field').querySelector('label').textContent);
  check('and defaults to 0 so no existing board changes',
        parseFloat(dptInput.value) === 0, dptInput.value);
  const dptDBefore = fpOf('Cale Makar');
  const dptFBefore = fpOf('Nathan MacKinnon');
  dptInput.value = '1';
  fire(dptInput, 'input');
  check('setting it raises a defenceman', fpOf('Cale Makar') > dptDBefore,
        dptDBefore + ' -> ' + fpOf('Cale Makar'));
  check('and leaves a forward untouched', fpOf('Nathan MacKinnon') === dptFBefore,
        dptFBefore + ' -> ' + fpOf('Nathan MacKinnon'));
  dptInput.value = '0';
  fire(dptInput, 'input');
  check('and clearing it restores both', fpOf('Cale Makar') === dptDBefore &&
        fpOf('Nathan MacKinnon') === dptFBefore);

  // The second positional category: points per goalie start, which the board
  // keeps as their GP. Negative is a real setting, so check that direction too.
  const gsInput = $('[data-scoring="GS"]');
  check('the goalie-starts category has an input', !!gsInput);
  check('and defaults to 0', parseFloat(gsInput.value) === 0, gsInput.value);
  const gBefore = fpOf('Connor Hellebuyck');
  const sBefore = fpOf('Cale Makar');
  gsInput.value = '1';
  fire(gsInput, 'input');
  check('setting it raises a goalie', fpOf('Connor Hellebuyck') > gBefore,
        gBefore + ' -> ' + fpOf('Connor Hellebuyck'));
  check('and leaves a skater untouched', fpOf('Cale Makar') === sBefore,
        sBefore + ' -> ' + fpOf('Cale Makar'));
  gsInput.value = '-1';
  fire(gsInput, 'input');
  check('a negative value charges the goalie instead',
        fpOf('Connor Hellebuyck') < gBefore,
        gBefore + ' -> ' + fpOf('Connor Hellebuyck'));
  gsInput.value = '0';
  fire(gsInput, 'input');
  check('and clearing it restores both', fpOf('Connor Hellebuyck') === gBefore &&
        fpOf('Cale Makar') === sBefore);

  check('league inputs rendered', $$('#slots-cfg input').length === 10,
        $$('#slots-cfg input').length + ' inputs');

  const topBefore = $$('#rows tr[data-id]')[0].querySelector('.pname').textContent;
  const blk = $$('#scoring input').find(i => i.getAttribute('data-scoring') === 'BLK');
  blk.value = '25';
  fire(blk, 'input');
  const topAfter = $$('#rows tr[data-id]')[0].querySelector('.pname').textContent;
  check('changing scoring re-ranks the board', topBefore !== topAfter,
        topBefore + ' -> ' + topAfter);
  blk.value = '0.6';
  fire(blk, 'input');
  check('reverting scoring restores the board',
        $$('#rows tr[data-id]')[0].querySelector('.pname').textContent === topBefore);

  const slider = $$('#weights input[type=range]')[0];
  const fpBefore = cellOf($$('#rows tr[data-id]')[0], 'VORP').textContent;
  slider.value = '0';
  fire(slider, 'input');
  const fpAfter = cellOf($$('#rows tr[data-id]')[0], 'VORP').textContent;
  check('zeroing a source weight changes values', fpBefore !== fpAfter,
        fpBefore + ' -> ' + fpAfter);
  slider.value = '1';
  fire(slider, 'input');

  const gpSel = $('#gp-model');
  // Games-played source feeds only the rate_source_gp model (valuation.js
  // reads settings.gpSource nowhere else), so it must be absent otherwise.
  gpSel.value = 'rate_source_gp';
  fire(gpSel, 'change');
  check('GP-source row appears for rate_source_gp', !$('#gp-source-row').hidden);
  gpSel.value = 'totals';
  fire(gpSel, 'change');
  check('GP-source row hides for totals', $('#gp-source-row').hidden);
  gpSel.value = 'rate_blended_gp';
  fire(gpSel, 'change');
  check('GP-source row hides for blended GP too', $('#gp-source-row').hidden);

  // The hidden PROPERTY was always right; what was broken was the rendering.
  // .field is display:grid, which outranks the browser's own [hidden] rule, so
  // the row stayed on screen in every model. jsdom does not implement
  // !important in the cascade (it returns grid even for an isolated
  // [hidden]{display:none!important} vs .f{display:grid}), so this asserts the
  // guard is present in the stylesheet rather than trying to observe it.
  const css = fs.readFileSync(BOARD, 'utf8');
  check('a global [hidden] rule outranks any element display',
        /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css));

  // The native number spinner is three different widgets -- Chrome hides it
  // until hover, Firefox always draws it, Safari draws none -- so it is
  // suppressed and replaced with our own buttons. These checks cover the
  // replacement, since jsdom cannot observe the native one either way.
  // The input needs appearance:TEXTFIELD, not none -- none does not suppress
  // the spinner, and the unprefixed property overrides the -moz- line that
  // would have. That exact slip shipped a spinner once already.
  const numberRule = (css.match(
    /\.field input\[type="number"\]\s*\{[^}]*\}/) || [''])[0];
  check('the input asks for the textfield appearance, not none',
        /(^|[^-])appearance:\s*textfield/.test(numberRule) &&
        !/(^|[^-])appearance:\s*none/.test(numberRule),
        numberRule.replace(/\s+/g, ' ').slice(0, 110));
  check('and the WebKit spin button is hidden outright',
        /::-webkit-(inner|outer)-spin-button[^{]*\{[^}]*display:\s*none/.test(css));

  // Inputs come from ten different markup sites; the steppers are attached at
  // runtime precisely so an eleventh cannot be missed. Assert none were.
  const numbers = $$('input[type="number"]');
  const stepped = numbers.filter(i => i.parentNode.className === 'stepper');
  check('every number input gets a stepper',
        numbers.length > 30 && stepped.length === numbers.length,
        stepped.length + ' of ' + numbers.length);
  check('with a button on each side',
        stepped.every(i => i.parentNode.querySelector('[data-step="-1"]') &&
                           i.parentNode.querySelector('[data-step="1"]')));

  const stepBtn = (input, dir) =>
    input.parentNode.querySelector('[data-step="' + dir + '"]');

  // Stepping has to drive the board exactly as typing does -- the handlers are
  // delegated 'input' listeners, so the button only changes the value and
  // fires the event.
  const stepGoals = $('[data-scoring="G"]');
  const stepGoalsBefore = parseFloat(stepGoals.value);
  const vorpBefore = cellOf($$('#rows tr[data-id]')[0], 'VORP').textContent;
  click(stepBtn(stepGoals, 1));
  check('the plus button honours the step for that input',
        Math.abs(parseFloat(stepGoals.value) - (stepGoalsBefore + 0.05)) < 1e-9,
        stepGoalsBefore + ' -> ' + stepGoals.value);
  check('and the board re-ranks from it',
        cellOf($$('#rows tr[data-id]')[0], 'VORP').textContent !== vorpBefore);
  click(stepBtn(stepGoals, -1));
  check('the minus button puts it back',
        Math.abs(parseFloat(stepGoals.value) - stepGoalsBefore) < 1e-9, stepGoals.value);

  // A different input, a different step size -- proof stepUp/stepDown is
  // reading each input's own attributes rather than a hardcoded increment.
  const cSlot = $('[data-slot="C"]');
  const cBefore = parseInt(cSlot.value, 10);
  click(stepBtn(cSlot, 1));
  check('a roster slot steps by 1, not by the scoring step',
        parseInt(cSlot.value, 10) === cBefore + 1, cBefore + ' -> ' + cSlot.value);

  let guard = 0;
  while (parseFloat(cSlot.value) > 0 && guard++ < 30) click(stepBtn(cSlot, -1));
  check('the button disables at min rather than going negative',
        cSlot.value === '0' && stepBtn(cSlot, -1).disabled === true,
        cSlot.value + ', disabled=' + stepBtn(cSlot, -1).disabled);
  for (let i = 0; i < cBefore; i++) click(stepBtn(cSlot, 1));
  check('and steps back up once it is off the limit',
        parseInt(cSlot.value, 10) === cBefore, cSlot.value);

  // Driven by setting the value rather than 95 clicks at step 0.01: every
  // click recomputes the whole 806-player board, and this asserts the same
  // thing -- that the limit check runs on typed input as well as on a step.
  const tier1 = $('#adj-1');
  const tier1Before = tier1.value;
  tier1.value = '1';
  fire(tier1, 'input');
  check('a max attribute disables the plus button too',
        stepBtn(tier1, 1).disabled === true, tier1.value);
  tier1.value = tier1Before;
  fire(tier1, 'input');
  check('and re-enables it once back under the max',
        stepBtn(tier1, 1).disabled === false, tier1.value);

  const depthSel = $('#repl-depth');
  check('replacement depth selector exists', !!depthSel);
  const dBefore = $('#repl').textContent;
  depthSel.value = 'starters';
  fire(depthSel, 'change');
  const dAfter = $('#repl').textContent;
  check('starters-only changes the replacement depth', dBefore !== dAfter);
  // 12 teams x 4 D = 48 rostered, so replacement is the 49th -- the first
  // defenceman nobody has a starting spot for.
  check('starters-only reaches a shallower D',
        /49th best D/.test(dAfter), dAfter.replace(/\s+/g, ' ').trim().slice(0, 80));
  depthSel.value = 'roster';
  fire(depthSel, 'change');

  const eligSel = $('#eligibility');
  check('eligibility control is shown now that lists ship',
        !$('#eligibility-row').hidden);
  check('it offers exactly the two platforms', eligSel.options.length === 2,
        Array.prototype.map.call(eligSel.options, o => o.value).join(','));
  // The sources agree with Yahoo's ruling on all but three players, so a
  // neutral option would behave almost identically to it. It must not be there.
  check('with no neutral option',
        Array.prototype.every.call(eligSel.options, o => o.value !== ''));
  check('and defaults to Yahoo', eligSel.value === 'yahoo', eligSel.value);
  check('the options are just the platform names',
        Array.prototype.map.call(eligSel.options, o => o.textContent).join('|') ===
          'Yahoo|Fantrax',
        Array.prototype.map.call(eligSel.options, o => o.textContent).join('|'));
  check('with no "N differ" noise', eligSel.innerHTML.indexOf('differ') === -1);

  // Brady Tkachuk is C,LW on Yahoo and LW only on Fantrax, so switching must
  // change both the Pos cell and the position rank that follows from it.
  const tkachukRow = () => {
    const rows = $$('#rows tr[data-id]');
    for (const r of rows) {
      if (cellOf(r, 'Player').textContent.indexOf('Brady Tkachuk') !== -1) return r;
    }
    return null;
  };
  const posOf = () => { const r = tkachukRow(); return r && cellOf(r, 'Pos').textContent.trim(); };
  const yahooPos = posOf();
  eligSel.value = 'fantrax';
  fire(eligSel, 'change');
  const fantraxPos = posOf();
  check('Yahoo rules Brady Tkachuk C,LW', yahooPos === 'C,LW', yahooPos);
  check('Fantrax rules him LW only', fantraxPos === 'LW', fantraxPos);
  eligSel.value = 'yahoo';
  fire(eligSel, 'change');
  check('switching back restores the Yahoo ruling', posOf() === 'C,LW', posOf());

  const adpSel = $('#adp-source');
  check('ADP column selector exists', !!adpSel);
  check('it offers all three columns', adpSel.options.length === 3,
        Array.prototype.map.call(adpSel.options, o => o.value).join(','));
  check('and states the coverage of each', adpSel.innerHTML.indexOf('254 players') !== -1,
        adpSel.options[1] && adpSel.options[1].textContent);

  // MacKinnon is row 1 and the two platforms rank him differently -- Yahoo 2.4,
  // Fantrax 1.3 -- so the cell must actually change.
  const adpCell = () => $('#rows tr[data-id] td.adp').textContent.trim();
  adpSel.value = 'yahoo';
  fire(adpSel, 'change');
  const yahooAdp = adpCell();
  adpSel.value = 'fantrax';
  fire(adpSel, 'change');
  const fantraxAdp = adpCell();
  check('switching the ADP column changes the number', yahooAdp !== fantraxAdp,
        yahooAdp + ' -> ' + fantraxAdp);
  check('Yahoo reads 2.4 for the top player', yahooAdp === '2.4', yahooAdp);
  check('Fantrax reads 1.3 for the same player', fantraxAdp === '1.3', fantraxAdp);
  adpSel.value = 'average';
  fire(adpSel, 'change');

  console.log('\n--- drop-off column ---');
  // Start from a clean board: earlier sections drafted two players, and
  // clicking an already-drafted row would un-draft them.
  window.confirm = function () { return true; };
  click($('#clear-draft'));

  const withDrop = $$('#rows tr[data-id]').filter(function (r) {
    return cellOf(r, 'Next').textContent.trim() !== '';
  });
  check('drop-off column is populated', withDrop.length > 700,
        withDrop.length + ' rows have a value');

  // Taking the player immediately behind someone at their position must widen
  // the gap to whoever is next.
  const topRow = $$('#rows tr[data-id]')[0];
  const topPos = cellOf(topRow, 'Pos').textContent.trim();
  const dropBefore = parseFloat(cellOf(topRow, 'Next').textContent);
  const victim = $$('#rows tr[data-id]').slice(1).find(function (r) {
    return cellOf(r, 'Pos').textContent.trim() === topPos;
  });
  const victimName = victim.querySelector('.pname').textContent;
  check('the next player at that position is undrafted to begin with',
        !victim.classList.contains('drafted'), victimName);
  click(victim.querySelector('.tm'));
  flush();
  const dropAfter = parseFloat(cellOf($$('#rows tr[data-id]')[0], 'Next').textContent);
  check('drop-off grows when the next player at the position is taken',
        dropAfter > dropBefore,
        dropBefore + ' -> ' + dropAfter + ' (took ' + victimName + ')');
  click($('#clear-draft'));

  console.log('\n--- manual adjustments ---');
  const ADJ = COL['Adj'], FPCOL = COL['FanPts'];
  const adjRow = () => $$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === adjName);
  const adjName = $$('#rows tr[data-id]')[0].querySelector('.pname').textContent;
  const fpPlain = adjRow().children[FPCOL].textContent;
  check('Adj cell has minus, value and plus',
        adjRow().children[ADJ].querySelectorAll('.adjbtn').length === 2 &&
        adjRow().children[ADJ].querySelector('.adjval') !== null);
  check('minus is disabled only at the floor',
        adjRow().children[ADJ].querySelector('[data-step="-1"]').disabled === false);

  for (let i = 0; i < 3; i++) {
    click(adjRow().children[ADJ].querySelector('[data-step="1"]'));
  }
  check('three clicks reach +++',
        adjRow().children[ADJ].querySelector('.adjval').textContent.trim() === '+++',
        adjRow().children[ADJ].querySelector('.adjval').textContent.trim());
  check('plus is disabled at the ceiling',
        adjRow().children[ADJ].querySelector('[data-step="1"]').disabled === true);
  check('projection moved', adjRow().children[FPCOL].textContent !== fpPlain,
        fpPlain + ' -> ' + adjRow().children[FPCOL].textContent);
  check('tooltip reports the real points swing',
        /=\s+[+-][\d.]+ FanPts/.test(
          adjRow().children[ADJ].querySelector('.adjval').getAttribute('title')),
        adjRow().children[ADJ].querySelector('.adjval').getAttribute('title'));
  check('adjusting does not draft the player',
        !adjRow().classList.contains('drafted'));

  const storedAdj = JSON.parse(window.localStorage.getItem('drafttool:2026-27')).adjust;
  check('adjustment persisted', Object.keys(storedAdj).length === 1,
        JSON.stringify(storedAdj));
  check('adjustment stored under a player name, not a row index',
        Object.keys(storedAdj).every(k => isNaN(Number(k))), JSON.stringify(storedAdj));

  click($$('.filters .chip').find(c => c.getAttribute('data-pos') === 'ADJ'));
  check('Adj filter shows only adjusted players',
        $$('#rows tr[data-id]').length === 1, $$('#rows tr[data-id]').length + ' rows');
  click($$('.filters .chip').find(c => c.getAttribute('data-pos') === 'ALL'));

  console.log('\n--- schedule marks ---');
  const tmCell = (team) => {
    const r = $$('#rows tr[data-id]').find(
      x => cellOf(x, 'Tm').textContent.indexOf(team) === 0);
    return r && cellOf(r, 'Tm');
  };
  const wsh = tmCell('WSH');
  check('the team cell carries two schedule marks',
        wsh && wsh.querySelectorAll('.flag').length === 2,
        wsh && wsh.innerHTML);
  check('a strong schedule shows both favourable',
        wsh.textContent.replace(/[^\u25b2\u25bc]/g, '') === '\u25b2\u25b2',
        JSON.stringify(wsh.textContent));
  check('and the tooltip spells both out',
        /Off-nights: .*of 84.*Playoffs to Apr 4: .*games/.test(
          wsh.querySelector('.tmcode').getAttribute('title')),
        wsh.querySelector('.tmcode').getAttribute('title'));

  // Off-nights and the playoff weeks are close to independent, which is why
  // they are two marks and not one combined score. St Louis is the case: poor
  // all season, strong in the playoff weeks.
  const stl = tmCell('STL');
  check('a team can be poor on one measure and strong on the other',
        stl.textContent.indexOf('\u25bc') !== -1 &&
        stl.textContent.indexOf('\u25b2') !== -1,
        JSON.stringify(stl.textContent));

  // A middling team still reserves the slot, so the codes stay aligned.
  const neutral = $$('#rows tr[data-id]').map(r => cellOf(r, 'Tm'))
    .find(c => c.querySelectorAll('.flag').length === 2 &&
               !/[\u25b2\u25bc]/.test(c.querySelectorAll('.flag')[0].textContent));
  check('a middling rating reserves its slot but shows no glyph', !!neutral,
        neutral && JSON.stringify(neutral.textContent));

  // The window setting has to actually move the second mark, or it is
  // decoration: Boston is unfavourable to Apr 4 and favourable to Apr 11.
  const poMark = (team) => {
    const flags = tmCell(team).querySelectorAll('.flag');
    return flags[1].textContent;
  };
  const winSel = $('#playoff-window');
  check('the playoff-window setting exists', !!winSel && winSel.options.length === 2,
        winSel && winSel.options.length);
  check('and defaults to skipping the final week', winSel.value === 'skip', winSel.value);
  const bosBefore = poMark('BOS');
  winSel.value = 'full';
  fire(winSel, 'change');
  const bosAfter = poMark('BOS');
  check('switching the window flips a known team', bosBefore !== bosAfter,
        JSON.stringify(bosBefore) + ' -> ' + JSON.stringify(bosAfter));
  check('and the tooltip follows it',
        /to Apr 11/.test(tmCell('BOS').querySelector('.tmcode').getAttribute('title')));
  winSel.value = 'skip';
  fire(winSel, 'change');

  console.log('\n--- age column ---');
  const ageOf = name => {
    const r = $$('#rows tr[data-id]').find(
      x => x.querySelector('.pname').textContent === name);
    return r && cellOf(r, 'Age').querySelector('.age');
  };
  check('the Age column exists', COL['Age'] !== undefined, JSON.stringify(COL));

  // Colour must never be the only signal. Green/amber for the age bands were
  // indistinguishable to a red-green colourblind reader -- same hue channel,
  // and identical luminance -- so the hues changed AND every direction is
  // carried by a glyph as well.
  check('age bands use the colourblind-safe tokens, not good/warn',
        /--pre-prime:/.test(css) && /--post-prime:/.test(css) &&
        /\.age\.pre\s*\{[^}]*--pre-prime/.test(css) &&
        /\.age\.post\s*\{[^}]*--post-prime/.test(css));
  check('and no longer reference the old green/amber',
        !/\.age\.(pre|post)\s*\{[^}]*var\(--(good|warn)\)/.test(css));

  const glyphed = (sel) => $$('#rows tr[data-id]').map(r => r.querySelector(sel))
    .filter(Boolean).filter(sp => /[▲▼]/.test(sp.textContent));
  const counts = {
    adpSteal: glyphed('.adp.steal').length, adpReach: glyphed('.adp.reach').length,
    lastUp: glyphed('.last.up').length,     lastDown: glyphed('.last.down').length
  };
  const allOf = (sel) => $$('#rows tr[data-id]').map(r => r.querySelector(sel)).filter(Boolean).length;
  check('every flagged ADP row carries a glyph, not just a colour',
        counts.adpSteal === allOf('.adp.steal') && counts.adpReach === allOf('.adp.reach'),
        JSON.stringify(counts));
  check('and every flagged 25-26 row does too',
        counts.lastUp === allOf('.last.up') && counts.lastDown === allOf('.last.down'),
        JSON.stringify(counts));
  const plainAdp = $$('#rows tr[data-id]').map(r => r.querySelector('td.adp span'))
    .filter(sp => sp && !sp.classList.contains('steal') && !sp.classList.contains('reach'));
  const strays = plainAdp.filter(sp => /[▲▼]/.test(sp.textContent));
  check('while unflagged rows carry none',
        plainAdp.length > 100 && strays.length === 0,
        plainAdp.length + ' unflagged, ' + strays.length + ' with a stray glyph' +
        (strays[0] ? ': ' + JSON.stringify(strays[0].textContent) : ''));

  // The marker sits in a fixed-width slot so a right-aligned column does not
  // go ragged on the rows that happen to be flagged.
  check('the marker has a reserved slot on unflagged rows too',
        $$('#rows tr[data-id]')[0].querySelector('.adp .flag') !== null);
  check('and sits with the identity columns, not the numbers',
        COL['Age'] === COL['Pos'] + 1, 'Pos ' + COL['Pos'] + ', Age ' + COL['Age']);

  const mac = ageOf('Nathan MacKinnon');
  check('a prime player carries no marker',
        mac.textContent.trim() === '30' && !mac.classList.contains('pre') &&
        !mac.classList.contains('post'), mac.textContent);
  // The whole reason the ages are extracted rather than taken from a source:
  // DtZ has him a year older, which would read post-prime.
  check('and the extracted age wins over the projection source',
        mac.getAttribute('title').indexOf('prime') !== -1, mac.getAttribute('title'));

  const allAges = () => $$('#rows tr[data-id]')
    .map(r => cellOf(r, 'Age').querySelector('.age'));
  const kid = allAges().find(a => a && a.classList.contains('pre'));
  check('pre-prime players are marked up', kid.textContent.indexOf('▲') !== -1,
        kid.textContent);
  check('with a tooltip that says what it means',
        /Pre-prime .*break out/.test(kid.getAttribute('title')), kid.getAttribute('title'));

  const vet = allAges().find(a => a && a.classList.contains('post'));
  check('post-prime players are marked down', vet.textContent.indexOf('▼') !== -1,
        vet.textContent);
  check('with its own tooltip',
        /Post-prime .*decline/.test(vet.getAttribute('title')), vet.getAttribute('title'));

  // A workbook typo has Giroux as 19; the guard keeps the real age, so he must
  // not turn up in the breakout band at 39.
  const giroux = ageOf('Claude Giroux');
  check('an implausible extracted age is rejected, not shown',
        !giroux || giroux.classList.contains('post'),
        giroux && giroux.textContent);

  const bands = { pre: 0, post: 0, prime: 0, blank: 0 };
  allAges().forEach(a => {
    if (!a) bands.blank++;
    else if (a.classList.contains('pre')) bands.pre++;
    else if (a.classList.contains('post')) bands.post++;
    else bands.prime++;
  });
  check('all three bands are populated and few players lack an age',
        bands.pre > 50 && bands.prime > 50 && bands.post > 50 && bands.blank < 20,
        JSON.stringify(bands));

  click($$('#head th')[COL['Age']]);
  const firstAge = cellOf($$('#rows tr[data-id]')[0], 'Age').textContent.trim();
  check('sorting by age works', firstAge.length > 0 && !isNaN(parseInt(firstAge, 10)),
        firstAge);
  click($$('#head th')[COL['VORP']]);

  console.log('\n--- adj column alignment ---');
  // Cells in the flagged columns end with a fixed-width direction slot, so a
  // heading with ordinary padding sits right of its own numbers. Every column
  // that renders a trailing slot has to offset its header by the same width.
  const flaggedCols = ['ADP', 'Age', '25-26 (VORP)'];
  flaggedCols.forEach(name => {
    const th = $$('#head th')[COL[name]];
    check('the ' + name + ' header clears its direction slot',
          th.classList.contains('hasflag'), JSON.stringify(th.className));
  });
  check('and columns without a slot are not offset',
        !$$('#head th')[COL['25-26 FP']].classList.contains('hasflag') &&
        !$$('#head th')[COL['FanPts']].classList.contains('hasflag'));
  check('the offset matches the slot width in the stylesheet',
        /th\.hasflag[^{]*\{[^}]*padding-right/.test(pageCss) &&
        /\.flag[^{]*\{[^}]*margin-left/.test(pageCss));

  const adjTh = $$('#head th')[COL['Adj']];
  check('the Adj header is centred like its cells',
        adjTh.classList.contains('center'), JSON.stringify(adjTh.className));

  console.log('\n--- watch / do-not-draft marks ---');
  const markBtn = (row, kind) =>
    cellOf(row, 'Mark').querySelector('[data-mark=\'' + kind + '\']');
  const rowFor2 = (name) => $$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === name);

  const markTarget = $$('#rows tr[data-id]').find(r => !r.classList.contains('drafted'));
  const markName = markTarget.querySelector('.pname').textContent;
  check('every row has both mark toggles',
        !!markBtn(markTarget, 'watch') && !!markBtn(markTarget, 'avoid'));

  click(markBtn(markTarget, 'watch'));
  check('the watch toggle marks the row',
        rowFor2(markName).classList.contains('watch'),
        rowFor2(markName).className);
  // Marking must never draft: the cell sits inside a row whose click drafts.
  check('and does not draft the player',
        !rowFor2(markName).classList.contains('drafted'));

  click(markBtn(rowFor2(markName), 'avoid'));
  check('the two marks are mutually exclusive',
        rowFor2(markName).classList.contains('avoid') &&
        !rowFor2(markName).classList.contains('watch'),
        rowFor2(markName).className);
  click(markBtn(rowFor2(markName), 'avoid'));
  check('clicking an active mark clears it',
        !rowFor2(markName).classList.contains('avoid') &&
        !rowFor2(markName).classList.contains('watch'),
        rowFor2(markName).className);

  // The rule that would be wrong if avoid leaked into the valuation: Best
  // Available is your list, but replacement level and Next model the whole
  // league, and somebody else will still draft an avoided player.
  const bestListNames = () => $$('#bestpos .bp-name').map(n => n.textContent);
  const nextTipTitles = () => $$('#rows tr[data-id]').map(r => {
    const sp = r.querySelector('td.drop span');
    return sp ? (sp.getAttribute('title') || '') : '';
  });
  const avoidName = (nextTipTitles().find(t => t.indexOf('available: ') !== -1) || '')
    .split('available: ')[1];
  check('a player is named as somebody else Next to begin with', !!avoidName, avoidName);
  const replBeforeAvoid = $('#repl').textContent.trim();
  click(markBtn(rowFor2(avoidName), 'avoid'));
  check('an avoided player leaves Best Available',
        bestListNames().indexOf(avoidName) < 0, avoidName);
  check('the panel says why a name is missing',
        /do-not-draft/.test($('#bestpos').textContent));
  check('but is still somebody else Next',
        nextTipTitles().some(t => t.indexOf(avoidName) >= 0), avoidName);
  check('and replacement level is untouched',
        $('#repl').textContent.trim() === replBeforeAvoid);
  check('and the row stays on the board', !!rowFor2(avoidName));

  // Filters.
  click(markBtn(rowFor2(markName), 'watch'));
  const chipFor = (name) => $$('.filters .chip').find(
    c => c.getAttribute('data-pos') === name);
  click(chipFor('WATCH'));
  check('the Watch chip shows only watched players',
        $$('#rows tr[data-id]').length === 1 &&
        $$('#rows tr[data-id]')[0].querySelector('.pname').textContent === markName,
        $$('#rows tr[data-id]').length + ' rows');
  click(chipFor('AVOID'));
  check('the Avoid chip shows only avoided players',
        $$('#rows tr[data-id]').length === 1 &&
        $$('#rows tr[data-id]')[0].querySelector('.pname').textContent === avoidName,
        $$('#rows tr[data-id]').length + ' rows');
  click(chipFor('ALL'));

  // Marks are prep, not draft state.
  const storedMarks = JSON.parse(window.localStorage.getItem('drafttool:2026-27'));
  check('marks persist by name, not row index',
        Object.keys(storedMarks.marks).length === 2 &&
        Object.keys(storedMarks.marks).every(k => isNaN(Number(k))),
        JSON.stringify(storedMarks.marks));
  window.confirm = function () { return true; };
  click($('#clear-draft'));
  check('Clear draft leaves marks alone',
        !!rowFor2(markName).classList.contains('watch') &&
        !!rowFor2(avoidName).classList.contains('avoid'));
  click($('#clear-marks'));
  check('Clear marks removes them',
        !rowFor2(markName).classList.contains('watch') &&
        !rowFor2(avoidName).classList.contains('avoid'));
  check('and Best Available fills back up', !/do-not-draft/.test($('#bestpos').textContent));

  console.log('\n--- drafted filter ---');
  const chip = name => $$('.filters .chip').find(c => c.getAttribute('data-pos') === name);
  const draftedCount = () => $$('#rows tr[data-id]')
    .filter(r => r.classList.contains('drafted')).length;
  const allRowCount = $$('#rows tr[data-id]').length;

  // Nothing is drafted at this point in the suite, so draft a couple here and
  // undraft them afterwards rather than leaving state for later sections.
  const takenNames = $$('#rows tr[data-id]').slice(0, 2)
    .map(r => r.querySelector('.pname').textContent);
  takenNames.forEach(name => click($$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === name).querySelector('.tm')));
  const takenSoFar = draftedCount();
  check('two players are drafted for this section', takenSoFar === 2,
        takenSoFar + ' drafted');
  click(chip('DRAFTED'));
  check('the Drafted filter shows exactly the drafted players',
        $$('#rows tr[data-id]').length === takenSoFar,
        takenSoFar + ' expected, ' + $$('#rows tr[data-id]').length + ' shown');
  check('and every visible row is one of them',
        $$('#rows tr[data-id]').every(r => r.classList.contains('drafted')));

  // The case that would otherwise render an empty table: an explicit request
  // for the drafted players has to outrank a standing "hide them".
  $('#hide-drafted').checked = true;
  fire($('#hide-drafted'), 'change');
  check('it still works with Hide drafted on',
        $$('#rows tr[data-id]').length === takenSoFar,
        $$('#rows tr[data-id]').length + ' rows');
  check('while Hide drafted still hides them under All', (function () {
    click(chip('ALL'));
    const none = $$('#rows tr[data-id]').every(r => !r.classList.contains('drafted'));
    return none && $$('#rows tr[data-id]').length === allRowCount - takenSoFar;
  })(), $$('#rows tr[data-id]').length + ' rows');
  $('#hide-drafted').checked = false;
  fire($('#hide-drafted'), 'change');

  // Your own picks are drafted too, so Drafted is a superset of Mine.
  click(chip('MINE'));
  const mineCount = $$('#rows tr[data-id]').length;
  click(chip('DRAFTED'));
  check('Drafted includes your own roster', $$('#rows tr[data-id]').length >= mineCount,
        mineCount + ' mine, ' + $$('#rows tr[data-id]').length + ' drafted');
  click(chip('ALL'));
  check('All restores the whole board', $$('#rows tr[data-id]').length === allRowCount,
        $$('#rows tr[data-id]').length + ' of ' + allRowCount);

  takenNames.forEach(name => click($$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === name).querySelector('.tm')));
  check('the section leaves nothing drafted behind', draftedCount() === 0,
        draftedCount() + ' still drafted');

  for (let i = 0; i < 6; i++) {
    click(adjRow().children[ADJ].querySelector('[data-step="-1"]'));
  }
  check('six minus clicks reach the floor',
        adjRow().children[ADJ].querySelector('.adjval').textContent.trim() === '\u2212\u2212\u2212',
        adjRow().children[ADJ].querySelector('.adjval').textContent.trim());

  $('#open-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  window.confirm = function () { return true; };
  click($('#clear-adjust'));
  check('clearing restores the untouched projection',
        adjRow().children[FPCOL].textContent === fpPlain,
        adjRow().children[FPCOL].textContent + ' vs ' + fpPlain);
  check('no adjustments left',
        Object.keys(JSON.parse(window.localStorage.getItem('drafttool:2026-27')).adjust).length === 0);

  console.log('\n--- last season ---');
  const heads = $$('#head th').map(t => t.textContent.replace(/[\u25bc\u25b2]/g, '').trim());
  check('last-season columns present',
        heads.indexOf('25-26 (VORP)') >= 0 && heads.indexOf('25-26 FP') >= 0,
        heads.join(' '));

  const lastIdx = heads.indexOf('25-26 (VORP)');
  const lastFpIdx = heads.indexOf('25-26 FP');
  const boardRows = $$('#rows tr[data-id]');
  // The numeric columns carry a fixed-width direction marker, so read the
  // number without it rather than requiring the cell to be digits alone.
  const numOnly = (cell) => cell.textContent.replace(/[▲▼]/g, '').trim();
  const withLast = boardRows.filter(r => /^\d+$/.test(numOnly(r.children[lastIdx])));
  check('most players carry a last-season rank', withLast.length === 503,
        withLast.length + ' of ' + boardRows.length);
  const blanks = boardRows.filter(r => r.children[lastIdx].textContent.trim() === '\u2014');
  check('players with no season row show a dash', blanks.length === boardRows.length - 503,
        blanks.length + ' blank');

  // McDavid finished 1st last season under this scoring.
  const mcd = boardRows.find(r => /Connor McDavid/.test(r.textContent));
  check('McDavid shows last season rank 1', numOnly(mcd.children[lastIdx]) === '1',
        numOnly(mcd.children[lastIdx]));
  const tip = mcd.children[lastIdx].querySelector('span').getAttribute('title');
  check('tooltip carries points, games and team',
        /1st .* FP .* GP .* EDM/.test(tip), tip);
  check('last-season FP column is populated',
        parseFloat(mcd.children[lastFpIdx].textContent) > 500,
        mcd.children[lastFpIdx].textContent);

  // Matthews missed a chunk of last season, so the board should rank him far
  // above where he finished -- the case the column exists to surface.
  const matt = boardRows.find(r => /Auston Matthews/.test(r.textContent));
  check('a big riser is flagged', matt.children[lastIdx].querySelector('.up') !== null,
        matt.children[lastIdx].innerHTML);

  // Changing scoring must move last season too, not just the projections.
  $('#open-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const fpBeforeScoring = mcd.children[lastFpIdx].textContent;
  const goals = $$('#scoring input').find(i => i.getAttribute('data-scoring') === 'G');
  goals.value = '40';
  fire(goals, 'input');
  const mcd2 = $$('#rows tr[data-id]').find(r => /Connor McDavid/.test(r.textContent));
  check('last-season points follow a scoring change',
        mcd2.children[lastFpIdx].textContent !== fpBeforeScoring,
        fpBeforeScoring + ' -> ' + mcd2.children[lastFpIdx].textContent);
  goals.value = '4';
  fire(goals, 'input');

  // Drafting cannot change last season.
  const before25 = $$('#rows tr[data-id]')[0].children[lastIdx].textContent;
  click($$('#rows tr[data-id]')[3].querySelector('.tm'));
  check('drafting leaves last season alone',
        $$('#rows tr[data-id]')[0].children[lastIdx].textContent === before25);
  click($('#clear-draft'));

  console.log('\n--- sorting ---');
  const lastTh = $$('#head th').find(t => t.getAttribute('data-key') === 'lastRank');
  click(lastTh);
  const sorted = $$('#rows tr[data-id]');
  check('sorting by last season starts at rank 1',
        sorted[0].children[lastIdx].textContent.trim() === '1',
        sorted[0].children[lastIdx].textContent.trim());
  check('players with no season row sort last',
        sorted[sorted.length - 1].children[lastIdx].textContent.trim() === '\u2014');
  click($$('#head th').find(t => t.getAttribute('data-key') === 'vorp'));

  const adpTh = $$('#head th').find(t => t.getAttribute('data-key') === 'adp');
  click(adpTh);
  const adpRows = $$('#rows tr[data-id]');
  const firstAdp = cellOf(adpRows[0], 'ADP').textContent;
  check('sorting by ADP works', parseFloat(firstAdp) < 3, 'top ADP ' + firstAdp);
  click($$('#head th').find(t => t.getAttribute('data-key') === 'vorp'));

  console.log('\n--- persistence ---');
  click($$('#rows tr[data-id]')[0].querySelector('.tm'));
  dblclick($$('#rows tr[data-id]')[1].querySelector('.tm'));
  const stored = window.localStorage.getItem('drafttool:2026-27');
  check('state saved to localStorage', !!stored && !!JSON.parse(stored).drafted);
  check('drafted players persisted', Object.keys(JSON.parse(stored).drafted).length === 2,
        Object.keys(JSON.parse(stored).drafted).length + ' drafted');
  check('stored state is versioned', JSON.parse(stored).version >= 2,
        String(JSON.parse(stored).version));
  check('picks stored by name, not row index',
        Object.keys(JSON.parse(stored).drafted).every(k => isNaN(Number(k))),
        Object.keys(JSON.parse(stored).drafted).join(', '));
  check('my roster persisted', Object.keys(JSON.parse(stored).mine).length === 1);
  check('model settings persisted',
        JSON.parse(stored).settings.countBench === true);

  console.log('\n--- clear ---');
  click($('#clear-draft'));
  check('clearing empties the roster', /0 of 16 filled/.test($('#rosterbar').textContent),
        $('#rosterbar').textContent.trim());

  console.log('\n--- importing a projection file ---');
  const CSV = path.join(__dirname, '..', 'sources', '5v5-2027-players-projections.csv');
  const rowCount = () => $$('#rows tr[data-id]').length;
  const sliderCount = () => $$('#weights input[type=range]').length;

  function pickFile(name, body, type) {
    const file = new window.File([body], name, { type: type });
    const input = $('#import-source-file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  }

  $('#open-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const rowsBefore = rowCount();
  const slidersBefore = sliderCount();

  // Only .csv and .xlsx may be chosen at all.
  check('the picker only accepts csv and xlsx',
        $('#import-source-file').getAttribute('accept') === '.csv,.xlsx');
  pickFile('notes.txt', 'hello', 'text/plain');
  check('another file type is refused',
        /Only \.csv and \.xlsx/.test($('#status').textContent), $('#status').textContent);
  check('and the dialog stays shut', $('#import-modal').hidden);

  pickFile('5v5-2027-players-projections.csv', fs.readFileSync(CSV, 'utf8'), 'text/csv');
  setTimeout(function () {
    check('the review dialog opens', !$('#import-modal').hidden);
    check('the header row was detected', $('#import-header').value === '1',
          $('#import-header').value);
    check('every column gets a card', $$('.mapcol').length === 33,
          $$('.mapcol').length + ' cards');
    // This file now ships as the Daily Faceoff source, so every row matches.
    check('the match count is shown before committing',
          /643 players . 643 matched to the board . 0 new/.test($('#import-summary').textContent),
          $('#import-summary').textContent);

    // Only the genuinely ambiguous columns are flagged: the second PTS (fantasy
    // points, which does not equal goals + assists) and GS feeding GP.
    const flagged = $$('.mapcol-flag .mapcol-head').map(e => e.textContent.replace('?', '').trim());
    check('the ambiguous columns are flagged, and only those',
          flagged.length === 2 && flagged.indexOf('PTS') >= 0 && flagged.indexOf('GS') >= 0,
          flagged.join(' | '));

    // A flagged card's note used to ride on the sample line, which is
    // white-space:nowrap. That one unwrappable string set the card's minimum
    // width, the 1fr grid track could not shrink below it, and the whole
    // dialog spilled sideways past its 760px box. jsdom cannot measure that,
    // so pin the two things that prevent it.
    const flagCards = $$('.mapcol-flag');
    check('a flagged note sits on its own element, not on the sample line',
          flagCards.length > 0 && flagCards.every(c => !!c.querySelector('.mapcol-note')),
          flagCards.map(c => c.innerHTML.slice(0, 40)).join(' | '));
    check('so the sample survives on exactly the cards you need it',
          flagCards.every(c => c.querySelector('.mapcol-sample')
            .textContent.indexOf('·') === -1),
          flagCards.map(c => c.querySelector('.mapcol-sample').textContent).join(' | '));
    // overflow-wrap:anywhere drops the text's min-content width to a single
    // character; with it the flagged card collapsed to a one-character column
    // and the note ran vertically down it. break-word does not do this, and
    // these notes are prose with spaces, so neither is needed.
    check('the note wraps on words, not on every character',
          /\.mapcol-note\s*\{[^}]*white-space:\s*normal/.test(pageCss) &&
          !/\.mapcol-note\s*\{[^}]*overflow-wrap:\s*anywhere/.test(pageCss));
    // The card keeps the browser's default grid-item sizing: the spill is
    // fixed at source by moving the note off the nowrap line, so nothing here
    // should be overriding widths.
    // The real bug behind two rounds of wrong guesses: the dialog had used
    // class "flag" for an uncertain column since long before the board's
    // direction markers took the same name. A bare `.flag { width: 9px }`
    // then matched the card too and collapsed it to a 9px column with the
    // note running vertically down it.
    check('the uncertain card does not collide with the direction markers',
          flagCards.every(c => !c.matches('.flag')),
          flagCards.map(c => c.className).join(' | '));
    check('and the marker rule is scoped to table cells',
          /td \.flag\s*\{/.test(pageCss) && !/^\.flag\s*\{/m.test(pageCss));
    // Nothing in the import dialog should carry a bare marker class.
    check('no import-dialog element carries the marker class',
          $$('#import-modal .flag').length === 0,
          $$('#import-modal .flag').length + ' found');

    click($('#import-confirm'));
    setTimeout(function () {
      check('the dialog closes on import', $('#import-modal').hidden);
      check('re-importing a built-in source adds no one', rowCount() === rowsBefore,
            rowsBefore + ' -> ' + rowCount());
      check('a weight slider appears for it', sliderCount() === slidersBefore + 1);
      check('named after the file',
            $$('#weights .srcw-top b').pop().textContent === '5v5-2027-players-projections',
            $$('#weights .srcw-top b').pop().textContent);
      check('and it can be removed again',
            $$('#weights [data-remove-source^="IMP"]').length === 1);

      const stored = JSON.parse(window.localStorage.getItem('drafttool:2026-27'));
      check('the import is persisted', stored.imports.length === 1 &&
            stored.imports[0].rows.length === 643,
            JSON.stringify(stored.imports.length) + ' import(s)');

      // Drafting a player proves state survives the ids shifting underneath.
      const victim = $$('#rows tr[data-id]')[3];
      const victimName = victim.querySelector('.pname').textContent;
      victim.querySelector('.tm').dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, detail: 1 }));

      // A file carrying someone the board has never seen must add them.
      pickFile('extra.csv',
               'Player,Team,Pos,GP,G,A\nMade Upplayer,COL,C,82,40,40\n', 'text/csv');
      setTimeout(function () {
        click($('#import-confirm'));
        check('a genuinely new player is added', rowCount() === rowsBefore + 1,
              rowsBefore + ' -> ' + rowCount());
        check('and shows up when searched', (function () {
          $('#search').value = 'Made Upplayer';
          fire($('#search'), 'input');
          var found = $$('#rows tr[data-id]').length === 1;
          $('#search').value = '';
          fire($('#search'), 'input');
          return found;
        })());
        window.confirm = function () { return true; };
        // Each removal re-renders the panel, so re-query rather than iterating
        // a NodeList whose later entries are already detached.
        var guard = 0;
        while ($('#weights [data-remove-source^="IMP"]') && guard++ < 10) {
          click($('#weights [data-remove-source^="IMP"]'));
        }
        finishImport();
      }, 400);
      return;

      function finishImport() {
      window.confirm = function () { return true; };
      check('removing the imports restores the board', rowCount() === rowsBefore,
            rowCount() + ' rows');
      check('and their sliders go with them', sliderCount() === slidersBefore);
      const stillDrafted = $$('#rows tr[data-id]').filter(r => r.classList.contains('drafted'));
      check('a player drafted while the import was loaded stays drafted',
            stillDrafted.some(r => r.querySelector('.pname').textContent === victimName),
            victimName);
      click($('#clear-draft'));

      nearMissTests();
      }

      /* A name the source spells differently must not quietly become a second
       * row for a player already on the board. That failure is silent -- the
       * import reports success and the duplicate only surfaces later, halfway
       * through a draft -- so the dialog has to raise it before the commit. */
      function nearMissTests() {
      console.log('\n--- near-miss names in the import dialog ---');
      const beforeNear = rowCount();
      pickFile('nearmiss.csv',
               'Player,Team,Pos,GP,G,A\nMitchell Marner,VGK,RW,82,40,40\n',
               'text/csv');
      setTimeout(function () {
        /* The direction-marker collision cost two wrong diagnoses: a bare
         * `.flag { width: 9px }` silently matched the import dialog too. These
         * panel classes are generic enough to invite the same, so keep them
         * scoped rather than global. */
        check('the panel classes are scoped, not global',
              !/^\.arrow\s*\{/m.test(pageCss) && !/^\.merged\s*\{/m.test(pageCss) &&
              /\.unmatched-row \.arrow\s*\{/.test(pageCss));
        check('a near-miss name is surfaced before the commit',
              !$('#import-unmatched').hidden);
        check('named against the board player it resembles',
              /Mitchell Marner/.test($('#import-unmatched').textContent) &&
              /Mitch Marner/.test($('#import-unmatched').textContent),
              $('#import-unmatched').textContent.trim().slice(0, 90));
        // Nothing merges on its own -- the panel proposes, the user decides.
        check('and it still counts as new until merged',
              /1 players . 0 matched to the board . 1 new/
                .test($('#import-summary').textContent),
              $('#import-summary').textContent);

        click($('#import-unmatched [data-merge]'));
        check('merging folds it onto the existing player',
              /1 players . 1 matched to the board . 0 new/
                .test($('#import-summary').textContent),
              $('#import-summary').textContent);
        check('and the row shows as merged, with an undo',
              !!$('#import-unmatched .unmatched-row.merged') &&
              /Undo/.test($('#import-unmatched [data-merge]').textContent));

        click($('#import-unmatched [data-merge]'));
        check('undo puts it back',
              /1 players . 0 matched to the board . 1 new/
                .test($('#import-summary').textContent),
              $('#import-summary').textContent);

        click($('#merge-all'));
        check('merge all does the same in one click',
              /1 players . 1 matched to the board . 0 new/
                .test($('#import-summary').textContent),
              $('#import-summary').textContent);

        click($('#import-confirm'));
        check('so committing adds no duplicate row', rowCount() === beforeNear,
              beforeNear + ' -> ' + rowCount());
        check('and the merged row keeps the board spelling', (function () {
          $('#search').value = 'Marner';
          fire($('#search'), 'input');
          const names = $$('#rows tr[data-id] .pname').map(e => e.textContent);
          $('#search').value = '';
          fire($('#search'), 'input');
          return names.length === 1 && names[0] === 'Mitch Marner';
        })());

        window.confirm = function () { return true; };
        let guard = 0;
        while ($('#weights [data-remove-source^=\"IMP\"]') && guard++ < 10) {
          click($('#weights [data-remove-source^=\"IMP\"]'));
        }
        removalTests();
      }, 400);
      }
    }, 300);
  }, 400);

  function removalTests() {
  console.log('\n--- removing and restoring built-in sources ---');
  window.confirm = function () { return true; };

  const allRows = rowCount();
  const allSliders = sliderCount();
  const topName = () => $$('#rows tr[data-id]')[0].querySelector('.pname').textContent;
  const topFp = () => cellOf($$('#rows tr[data-id]')[0], 'FanPts').textContent;
  const beforeTop = topName();
  const beforeFp = topFp();

  // A built-in source now carries a remove link, same as an imported one.
  const builtinButton = $('#weights [data-remove-source="DtZ"]');
  check('built-in sources can be removed', !!builtinButton);
  click(builtinButton);
  check('removing one drops its slider', sliderCount() === allSliders - 1,
        allSliders + ' -> ' + sliderCount());
  check('and the players only it carried leave the board', rowCount() < allRows,
        allRows + ' -> ' + rowCount());
  check('an add-back link appears', !!$('#weights [data-restore-source="DtZ"]'));

  click($('#weights [data-restore-source="DtZ"]'));
  check('adding it back restores every row', rowCount() === allRows,
        rowCount() + ' rows');
  check('and its slider', sliderCount() === allSliders);
  check('and the board is numerically identical again',
        topName() === beforeTop && topFp() === beforeFp,
        topName() + ' ' + topFp());

  console.log('\n--- a board with no sources at all ---');
  // Removing the last source must leave a usable page, not a crash or a table
  // that silently claims 820 players it can no longer value.
  let guard = 0;
  while ($('#weights [data-remove-source]') && guard++ < 20) {
    click($('#weights [data-remove-source]'));
  }
  check('every source can be removed', sliderCount() === 0, sliderCount() + ' left');
  check('the board empties rather than erroring', rowCount() === 0, rowCount() + ' rows');
  check('and says so', /No projection sources/.test($('#status').textContent),
        $('#status').textContent);
  check('the settings panel explains how to recover',
        /No projection sources/.test($('#weights').textContent));
  check('still no script errors', errors.length === 0, errors.join('; '));

  // Interacting with an empty board must not throw either.
  $('#search').value = 'mack';
  fire($('#search'), 'input');
  $('#search').value = '';
  fire($('#search'), 'input');
  const gp = $('#gp-model');
  gp.value = 'totals';
  fire(gp, 'change');
  gp.value = 'rate_blended_gp';
  fire(gp, 'change');
  check('an empty board survives being driven', errors.length === 0, errors.join('; '));

  guard = 0;
  while ($('#weights [data-restore-source]') && guard++ < 20) {
    click($('#weights [data-restore-source]'));
  }
  check('every source comes back', sliderCount() === allSliders, sliderCount() + '');
  check('with the original board', rowCount() === allRows && topFp() === beforeFp,
        rowCount() + ' rows, top ' + topFp());

  roundTrip();
  }

  function roundTrip() {
  console.log('\n--- remove a source, re-import the same file ---');
  // The question this answers: is a source added through the UI worth the same
  // as the one the build baked in? Daily Faceoff is the CSV, so it goes through
  // the importer end to end.
  const snapshot = () => $$('#rows tr[data-id]').slice(0, 40).map(r => ({
    name: r.querySelector('.pname').textContent,
    fp: cellOf(r, 'FanPts').textContent,
    vorp: cellOf(r, 'VORP').textContent
  }));
  const baseline = snapshot();
  const baseRows = rowCount();
  const dfoWeight = $('#weights [data-weight="DFO"]').value;

  window.confirm = function () { return true; };
  click($('#weights [data-remove-source="DFO"]'));
  check('the baked-in source is gone', !$('#weights [data-weight="DFO"]'));

  pickFile('5v5-2027-players-projections.csv',
           fs.readFileSync(path.join(SOURCES, '5v5-2027-players-projections.csv'), 'utf8'),
           'text/csv');
  setTimeout(function () {
    $('#import-weight').value = dfoWeight;
    check('a totals CSV is not flagged as per-game', !$('#import-per-game').checked);
    click($('#import-confirm'));

    check('the re-imported board has the same number of players',
          rowCount() === baseRows, baseRows + ' -> ' + rowCount());
    const after = snapshot();
    const mismatch = baseline.filter((b, i) =>
      !after[i] || after[i].name !== b.name || after[i].fp !== b.fp ||
      after[i].vorp !== b.vorp);
    check('and identical names, FanPts and VORP down the top 40',
          mismatch.length === 0,
          mismatch.length ? JSON.stringify(mismatch[0]) + ' vs ' +
            JSON.stringify(after[baseline.indexOf(mismatch[0])]) : '');

    // Put it back the way the rest of the suite expects.
    window.confirm = function () { return true; };
    let g = 0;
    while ($('#weights [data-remove-source^="IMP"]') && g++ < 10) {
      click($('#weights [data-remove-source^="IMP"]'));
    }
    while ($('#weights [data-restore-source]') && g++ < 20) {
      click($('#weights [data-restore-source]'));
    }
    click($('#clear-draft'));
    importDone();
  }, 400);
  }

  function importDone() {
  console.log('\n--- restoring saved state ---');
  // A fresh board with localStorage already populated, which is the only way to
  // exercise load(). JSDOM's beforeParse hook runs before the page's scripts.
  const bootWith = (saved, then) => {
    const dom2 = new JSDOM(fs.readFileSync(BOARD, 'utf8'), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://local.test/',
      beforeParse(w) {
        if (saved) w.localStorage.setItem('drafttool:2026-27', JSON.stringify(saved));
      }
    });
    setTimeout(() => then(dom2.window, dom2.window.document), 900);
  };

  const rowsOf = (doc) => Array.from(doc.querySelectorAll('#rows tr[data-id]'));
  const rowFor = (doc, name) =>
    rowsOf(doc).find(r => r.querySelector('.pname').textContent === name);
  // These run against a second document, so the outer COL map does not apply.
  const cellIn = (doc, row, header) => {
    const heads = Array.from(doc.querySelectorAll('#head th'));
    const i = heads.findIndex(th => th.textContent.replace(/[▲▼]/g, '').trim() === header);
    return row.children[i];
  };

  // The property the old index-keyed storage got wrong: state must come back on
  // the NAMED players, whatever position they now occupy.
  bootWith({
    version: 2,
    drafted: { 'Cale Makar': true, 'Sidney Crosby': true },
    mine: { 'Cale Makar': true },
    adjust: { 'Moritz Seider': 3 },
    settings: { scoring: { G: 9 } }
  }, (w2, d2) => {
    check('saved picks restore onto the named players',
          rowFor(d2, 'Cale Makar').classList.contains('mine') &&
          rowFor(d2, 'Sidney Crosby').classList.contains('drafted'));
    check('a player saved as drafted only is not put on the roster',
          !rowFor(d2, 'Sidney Crosby').classList.contains('mine'));
    const adjCell = cellIn(d2, rowFor(d2, 'Moritz Seider'), 'Adj');
    check('saved adjustment restores onto the named player',
          adjCell.querySelector('.adjval').textContent.trim() === '+++',
          adjCell.querySelector('.adjval').textContent.trim());
    // The drawer renders its inputs on open, so it has to be opened first.
    d2.getElementById('open-settings').dispatchEvent(
      new w2.MouseEvent('click', { bubbles: true }));
    const goals = Array.from(d2.querySelectorAll('#scoring input'))
      .find(i => i.getAttribute('data-scoring') === 'G');
    check('saved settings restore', goals && goals.value === '9',
          goals ? goals.value : '(no input)');

    // A name the board no longer carries must be skipped and reported, not
    // quietly applied to whoever now sits in that slot.
    bootWith({
      version: 2,
      drafted: { 'Cale Makar': true, 'Someone Retired': true },
      mine: {}, adjust: {}
    }, (w3, d3) => {
      check('a name no longer on the board is skipped',
            rowFor(d3, 'Cale Makar').classList.contains('drafted'));
      check('and is reported rather than vanishing',
            /no longer on the board/.test(d3.getElementById('status').textContent),
            d3.getElementById('status').textContent);

      // Version 1 blobs were index-keyed. They were written against the build
      // that is still loaded, so their indexes are honoured, then rewritten.
      bootWith({ drafted: { 0: true }, mine: {}, adjust: {} }, (w4, d4) => {
        check('a legacy index-keyed blob still restores',
              rowsOf(d4).find(r => r.classList.contains('drafted')) !== undefined);
        // Force a save and confirm the entry is now name-keyed.
        rowsOf(d4)[5].querySelector('.tm').dispatchEvent(
          new w4.MouseEvent('click', { bubbles: true, detail: 1 }));
        const rewritten = JSON.parse(w4.localStorage.getItem('drafttool:2026-27'));
        check('and is rewritten by name on the next save',
              rewritten.version >= 2 &&
              Object.keys(rewritten.drafted).every(k => isNaN(Number(k))),
              JSON.stringify(rewritten.drafted));
        hostileSnapshot();
      });

      // A snapshot is a file someone can send you, so treat it as hostile
      // input. Numeric settings used to be written straight into an input's
      // value attribute, and a string could break out of it: this exact
      // payload produced a live <img onerror> and a <b id=BOOM> in the panel.
      function hostileSnapshot() {
        bootWith({
          version: 2, drafted: {}, mine: {}, adjust: {},
          settings: {
            scoring: { G: '"><img src=x onerror="window.__pwned=1">' },
            teams: '12"><b id=BOOM></b>',
            slots: { C: '2"><s id=BOOM2></s>' },
            tierK: 'not a number'
          }
        }, (w5, d5) => {
          d5.getElementById('open-settings').dispatchEvent(
            new w5.MouseEvent('click', { bubbles: true }));
          check('a hostile snapshot injects no markup into the settings panel',
                !d5.getElementById('BOOM') && !d5.getElementById('BOOM2') &&
                !/<img[^>]*onerror/i.test(d5.getElementById('scoring').innerHTML));
          check('and no injected handler ran', w5.__pwned === undefined);
          const g = d5.querySelector('[data-scoring="G"]');
          check('a non-numeric scoring value falls back to the default',
                g && !isNaN(parseFloat(g.getAttribute('value'))),
                g && g.getAttribute('value'));
          const teams = d5.querySelector('[data-teams]');
          check('and so does a non-numeric team count',
                teams && !isNaN(parseFloat(teams.getAttribute('value'))),
                teams && teams.getAttribute('value'));
          check('the board still renders rather than erroring',
                rowsOf(d5).length > 500, rowsOf(d5).length + ' rows');
          importedWeightSurvives();
        });
      }

      // An imported source's weight was saved but thrown away on load:
      // mergeSettings only copied keys already in the defaults, and an
      // import's id is not one of them, so every reload reset the slider to 0.
      function importedWeightSurvives() {
        bootWith({
          version: 2, drafted: {}, mine: {}, adjust: {}, marks: {}, removed: [],
          imports: [{ id: 'IMP1-ab', name: 'My Projections',
                      rows: [{ k: 'nathan mackinnon', n: 'Nathan MacKinnon',
                               t: 'COL', p: 'C', s: { GP: 82, G: 50, A: 60 } }] }],
          settings: { weights: { DtZ: 1, DFO: 1, AGN: 1, AGB: 1, 'IMP1-ab': 2 } }
        }, (w6, d6) => {
          d6.getElementById('open-settings').dispatchEvent(
            new w6.MouseEvent('click', { bubbles: true }));
          const sliders = Array.from(
            d6.querySelectorAll('#weights input[type=range]'));
          const imported = sliders.find(
            sl => sl.getAttribute('data-weight') === 'IMP1-ab');
          check('an imported source comes back with its saved weight',
                imported && imported.value === '2', imported && imported.value);
          check('and the built-in weights are unaffected',
                sliders.filter(sl => sl.getAttribute('data-weight') !== 'IMP1-ab')
                  .every(sl => sl.value === '1'),
                sliders.map(sl => sl.value).join(','));
          hostileImportedWeight();
        });
      }

      // Accepting weights for imported ids widened WHICH keys are read, not
      // what values are allowed through them -- the numeric coercion has to
      // still hold on the newly accepted key.
      function hostileImportedWeight() {
        bootWith({
          version: 2, drafted: {}, mine: {}, adjust: {}, marks: {}, removed: [],
          imports: [{ id: 'IMP1-ab', name: 'X',
                      rows: [{ k: 'nathan mackinnon', n: 'Nathan MacKinnon',
                               t: 'COL', p: 'C', s: { GP: 82, G: 50 } }] }],
          settings: { weights: { 'IMP1-ab': '"><img src=x onerror=window.__pwned=1>' } }
        }, (w7, d7) => {
          d7.getElementById('open-settings').dispatchEvent(
            new w7.MouseEvent('click', { bubbles: true }));
          const sl = Array.from(d7.querySelectorAll('#weights input[type=range]'))
            .find(x => x.getAttribute('data-weight') === 'IMP1-ab');
          check('a hostile weight on an imported id is still coerced',
                sl && !isNaN(parseFloat(sl.value)), sl && sl.value);
          check('and injects nothing into the weights panel',
                !/<img[^>]*onerror/i.test(d7.getElementById('weights').innerHTML) &&
                w7.__pwned === undefined);
          everySettingRoundTrips();
        });
      }

      // Two settings have now been silently dropped on load -- an imported
      // source's weight, and the playoff window -- because each restore list
      // has to name its keys and nothing checked that they all did. Save every
      // setting at a non-default value and read each control back, so the next
      // setting that forgets to register fails here instead of in a draft.
      function everySettingRoundTrips() {
        const want = {
          'scoring G':        ['[data-scoring="G"]',   'value', '9'],
          'scoring DPT':      ['[data-scoring="DPT"]', 'value', '1.5'],
          'scoring GS':       ['[data-scoring="GS"]',  'value', '-0.5'],
          'weights DtZ':      ['[data-weight="DtZ"]',  'value', '0.5'],
          'slots C':          ['[data-slot="C"]',      'value', '3'],
          teams:              ['[data-teams]',          'value', '14'],
          gpModel:            ['#gp-model',             'value', 'totals'],
          gpSource:           ['#gp-source',            'value', 'DFO'],
          adpSource:          ['#adp-source',           'value', 'yahoo'],
          eligibility:        ['#eligibility',          'value', 'fantrax'],
          playoffWindow:      ['#playoff-window',       'value', 'full'],
          replacementMethod:  ['#repl-method',          'value', 'position'],
          countBench:         ['#repl-depth',           'value', 'starters'],
          tierK:              ['#tier-k',               'value', '2.5'],
          minGP:              ['#min-gp',               'value', '20'],
          'adjust tier 1':    ['#adj-1',                'value', '0.11']
        };
        bootWith({
          version: 2, drafted: {}, mine: {}, adjust: {}, marks: {},
          imports: [], removed: [],
          settings: {
            scoring: { G: 9, DPT: 1.5, GS: -0.5 }, weights: { DtZ: 0.5 }, slots: { C: 3 },
            teams: 14, gpModel: 'totals', gpSource: 'DFO', adpSource: 'yahoo',
            eligibility: 'fantrax', playoffWindow: 'full',
            replacementMethod: 'position', countBench: false,
            tierK: 2.5, minGP: 20, adjust: { tiers: [0.11, 0.12, 0.13] }
          }
        }, (w8, d8) => {
          d8.getElementById('open-settings').dispatchEvent(
            new w8.MouseEvent('click', { bubbles: true }));
          const missed = Object.keys(want).filter(name => {
            const el = d8.querySelector(want[name][0]);
            return !el || String(el[want[name][1]]) !== want[name][2];
          });
          check('every setting survives a reload', missed.length === 0,
                missed.length ? 'dropped: ' + missed.join(', ') : 'all ' +
                  Object.keys(want).length + ' restored');
          finish();
        });
      }
    });
  });

  function finish() {
  console.log('\n--- deferred rebuild ---');
  // Nothing else forces a refresh here, so this proves the timer fires on its
  // own rather than the board relying on some later interaction.
  const solo = $$('#rows tr[data-id]').find(r => !r.classList.contains('drafted'));
  const soloName = solo.querySelector('.pname').textContent;
  click(solo.querySelector('.tm'));
  check('row greys out at once', $$('#rows tr[data-id]').find(
    r => r.querySelector('.pname').textContent === soloName).classList.contains('drafted'));
  check('panel still stale immediately after the click',
        $('#bestpos').textContent.includes(soloName));

  setTimeout(function () {
    check('panel catches up once the double-click window closes',
          !$('#bestpos').textContent.includes(soloName), soloName);

    console.log('\n--- final ---');
    check('still no script errors', errors.length === 0, errors.join(' | '));
    console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nall UI checks passed');
    process.exit(fails ? 1 : 0);
  }, 400);
  }
  }
}, 1200);
