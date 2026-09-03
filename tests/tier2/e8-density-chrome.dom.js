// TIER 2 · E8 DENSITY ADVERSARY — §D · THE HORIZONTAL BUDGET OF THE 40 px ROW
//
// A3 („the legend becomes two sections") · 17.3 (a visibility toggle per member)
// · finding R14 („the legend does not fit eight members") and `membersui.js`'s
// answer to it · DESIGN-DECISIONS open question 4: „Minimum 900 × 640."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT `family-members.dom.js` MEASURED, AND THE ONE THING IT DID NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// That suite measures the family SECTION in isolation (186 px at eight members)
// and proves the collapse mechanism by shrinking the legend host to 60 px. Both
// are right. Neither is the product's question, which is:
//
//     at v1's OWN minimum window — 900 px — does the whole 40 px row still hold
//     the Heute button, two layer toggles, four German category names,
//     „bearbeiten", eight member chips, the find field, ⎙ and ⚙?
//
// `.legend` is `flex:1; min-width:0; overflow:hidden`. It does not wrap and it
// does not scroll: what does not fit is GONE, with no ellipsis and no cue. So
// the question has a yes/no answer and it is measurable.
//
// The window is emulated by constraining `body`, which is what `.app`'s width
// resolves against — the same mechanism a real resize uses.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp,
// diag, skip.
// ─────────────────────────────────────────────────────────────────────────────

const members = await importApp('family/membersui.js');
const i18n = await importApp('i18n.js');
const { store } = await importApp('store.js');
const { renderLegend } = await importApp('legend.js');

const px = (n) => Math.round(n * 10) / 10;
const B22 = 'ABCDEFGHJKMNPQRSTUVWXY';
const memId = (n) => `mem_${B22.slice(0, 21)}${String(n)}`;

function regs(rows) {
  const m = new Map();
  for (const r of rows) {
    const cells = new Map();
    if ('displayName' in r) cells.set('displayName', { value: r.displayName, stamp: 'S' });
    if ('colorRef' in r) cells.set('colorRef', { value: r.colorRef, stamp: 'S' });
    cells.set('_alive', { value: true, stamp: 'S' });
    m.set(`member:${r.id}`, cells);
  }
  return m;
}
const ME = memId(0);
const EIGHT = [
  { id: ME, displayName: 'Manuel', colorRef: 'blau' },
  { id: memId(1), displayName: 'Mama', colorRef: 'magenta' },
  { id: memId(2), displayName: 'Papa', colorRef: 'gruen' },
  { id: memId(3), displayName: 'Oma', colorRef: 'orange' },
  { id: memId(4), displayName: 'Opa', colorRef: 'violett' },
  { id: memId(5), displayName: 'Lena', colorRef: 'tuerkis' },
  { id: memId(6), displayName: 'Jonas', colorRef: 'rot' },
  { id: memId(7), displayName: 'Ümit', colorRef: 'gold' },
];
const TWO = EIGHT.slice(0, 2);

// THE MOUNT GOES THROUGH `legend.js`'s SEAM, which is how the shipped app draws this row.
//
// It used to call `members.renderFamilyLegend()` directly, which appends the family half to
// whatever category half happened to be on the row already — i.e. to a category half fitted at
// some earlier width. Every question in this file is about the WHOLE row at ONE width, so the
// row has to be the one `renderLegend()` produces: `legend: true` installs the seam
// (`family/mount.js` does the same on a real launch) and the explicit render draws both halves
// together at the width under test.
function mount(rows) {
  const map = regs(rows);
  members.initMembersUI({
    port: { me: () => ME, adminId: () => ME, registers: () => map, keysPending: () => false, setProfile: async () => {} },
    legendHost: '.legend',
    legend: true,
  });
  renderLegend();
}
function unmount() {
  members.initMembersUI();
  renderLegend();
  document.querySelectorAll('.scrim').forEach((n) => n.remove());
}

function verdict(label, rows) {
  const bad = rows.filter((r) => !r.ok);
  diag(`${label}: ${rows.length - bad.length}/${rows.length} cells hold`);
  for (const r of bad) diag('  x ' + r.id + ' — ' + r.why);
  assert.equal(bad.length, 0, bad.length ? label + ': ' + bad.map((r) => r.id).join(', ') : '');
}

/** Emulate a window width by constraining `body`, which is what `.app` sizes against. */
function atWidth(w, fn) {
  const before = document.body.style.cssText;
  document.body.style.width = `${w}px`;
  document.body.style.maxWidth = `${w}px`;
  void document.body.offsetWidth;
  try { return fn(); } finally { document.body.style.cssText = before; void document.body.offsetWidth; }
}

/** What the 40 px row is actually holding, and what has fallen off the end of it. */
function toolbarSurvey() {
  const tb = $('.toolbar');
  const lg = $('.legend');
  const tbr = tb.getBoundingClientRect();
  const lr = lg.getBoundingClientRect();
  const clipped = (n) => {
    const r = n.getBoundingClientRect();
    return r.width === 0 || r.right > lr.right + 0.5 || r.left < lr.left - 0.5;
  };
  const cats = $$('.legend-item', lg);
  const sec = document.getElementById(members.FAMILY_LEGEND_ID);
  const chips = sec ? sec.querySelector('.legend-fam-chips') : null;
  const more = sec ? sec.querySelector('.legend-fam-more') : null;
  const edit = $('.legend-edit', lg);
  // The category half's own „+n" (2.4's idiom, applied to the legend by `legend.js#moreChip`).
  // `catsBehindMore` is what it CLAIMS to be holding; `catsTotal` is what the board actually has.
  // The two together are the „nothing vanishes uncounted" ledger.
  const bucket = lg.querySelector('.legend-more');
  return {
    toolbarH: px(tbr.height),
    toolbarW: px(tbr.width),
    legendW: px(lr.width),
    legendNeeds: px(lg.scrollWidth),
    overflowPx: px(lg.scrollWidth - lg.clientWidth),
    categories: cats.length,
    categoriesClipped: cats.filter(clipped).length,
    catsBehindMore: bucket ? Number(bucket.dataset.count) : 0,
    catsTotal: store.state.categories.length,
    moreClipped: bucket ? clipped(bucket) : null,
    editClipped: edit ? clipped(edit) : null,
    famSection: !!sec,
    famCollapsed: chips ? getComputedStyle(chips).display === 'none' : null,
    chipsShown: chips && getComputedStyle(chips).display !== 'none' ? chips.children.length : 0,
    openerClipped: more ? clipped(more) : null,
    searchW: px(($('.search-box') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
  };
}

/** Every category is either NAMED on the row or COUNTED behind „+n" — 2.4's own ledger. */
const uncounted = (r) => r.catsTotal - r.categories - r.catsBehindMore;

/**
 * §D2 needs the width to STAY narrow while the fit re-decides, because the re-decision is a
 * `ResizeObserver` and an observer answers after the frame, not inside the call that resized it.
 * `atWidth` restores in a `finally`, so it can only ever see the row as it was BEFORE the
 * observer ran — which is the state the finding was about and no longer the state that ships.
 */
//
// `sleep`, not `requestAnimationFrame`: a `--test` run never shows a window (`main.swift`:
// „A headless run (--test / --smoke) never shows a window"), and an off-screen WKWebView does not
// run the animation-frame callbacks — a probe in this harness reports `rAF fired: false` and
// `RO after a body resize: 2`. The ResizeObserver the fix uses is delivered; a frame is not.
const settle = () => sleep(80);
async function dragTo(w) {
  document.body.style.width = `${w}px`;
  document.body.style.maxWidth = `${w}px`;
  void document.body.offsetWidth;
  await settle();
}

// ═════════════════════════════════════════════════════════════════════════════
// §D1 · v1's OWN MINIMUM WINDOW — 900 px, German, four categories, eight members
// ═════════════════════════════════════════════════════════════════════════════

test('§D1 · the two-section legend at 900 × 640, the window v1 declares as its floor', () => {
  i18n.setLang('de');
  renderLegend();
  const catNames = store.state.categories.map((c) => c.name).join(', ');
  diag(`categories on this board: ${store.state.categories.length} — ${catNames}`);

  const at = {};
  for (const w of [1440, 1280, 1100, 1000, 900]) {
    at[w] = atWidth(w, () => { mount(EIGHT); return toolbarSurvey(); });
  }
  diag('   width   toolbar  legend  legend needs  overflow  cats named  behind „+n"  cats clipped  „bearbeiten" clipped  chips shown  collapsed  „· n" clipped');
  for (const [w, r] of Object.entries(at)) {
    diag(`   ${String(w).padStart(5)}${String(r.toolbarH).padStart(9)}${String(r.legendW).padStart(8)}`
      + `${String(r.legendNeeds).padStart(14)}${String(r.overflowPx).padStart(10)}`
      + `${String(r.categories).padStart(12)}${String(r.catsBehindMore).padStart(13)}`
      + `${String(r.categoriesClipped).padStart(14)}`
      + `${String(r.editClipped).padStart(22)}${String(r.chipsShown).padStart(13)}`
      + `${String(r.famCollapsed).padStart(11)}${String(r.openerClipped).padStart(15)}`);
  }

  const two = atWidth(900, () => { mount(TWO); return toolbarSurvey(); });
  diag(`   at 900 px with TWO members (addendum §9's „excellent at 2"): chips shown ${two.chipsShown}, collapsed ${two.famCollapsed}, cats named ${two.categories} + ${two.catsBehindMore} behind „+n", cats clipped ${two.categoriesClipped}, „· n" clipped ${two.openerClipped}`);

  const min = at[900];
  const rows = [];
  rows.push({ id: 'principle-1/toolbar-is-still-40px', ok: min.toolbarH === 40, why: `the toolbar is ${min.toolbarH} px at 900 px wide` });
  rows.push({ id: 'A3/both-sections-are-present-at-900px', ok: min.famSection, why: 'no family section at v1\'s minimum window' });
  // ⚠ 17.3's toggle is a CONTROL. A collapsed section still opens the popover;
  // a CLIPPED one is gone, with no ellipsis, no scroll and no cue. The row is unchanged from the
  // one that reported the defect — it is the ROW that changed: `legend.js#fitRow` now fits the
  // category half first, so the family half's opener is inside the box at v1's own floor.
  rows.push({ id: '17.3/the-toggle-is-reachable-at-900px', ok: min.openerClipped === false,
    why: 'the family section\'s only affordance at 900 px is clipped by `.legend { overflow: hidden }` — 17.3 has no entry point on the minimum window' });
  rows.push({ id: '4.3/categories-keep-their-names-at-900px', ok: min.categoriesClipped === 0,
    why: `${min.categoriesClipped} of ${min.categories} category names are cut off at 900 px` });
  rows.push({ id: '4.4/„bearbeiten"-is-reachable-at-900px', ok: min.editClipped === false,
    why: 'the category manager\'s only entry point is clipped at 900 px' });
  // ── THE ROWS THE FIX ADDS, because „it fits" is worthless if it fits by dropping things ──────
  //
  // 2.4's ledger: a category is either NAMED on the row or COUNTED behind „+n". A fit that
  // silently rendered three of four categories and no chip would satisfy every row above.
  rows.push({ id: '2.4/nothing-vanishes-uncounted-at-900px', ok: uncounted(min) === 0,
    why: `${min.catsTotal} categories on the board, ${min.categories} named on the row, ${min.catsBehindMore} counted by „+n" — ${uncounted(min)} unaccounted for` });
  rows.push({ id: '2.4/the-„+n"-is-itself-reachable', ok: min.moreClipped !== true,
    why: 'the disclosure that holds the overflowed categories is itself clipped, which just moves the silence one node along' });
  // The floor holds at every width, not only at 900 — a fit that yielded the whole category half
  // to eight member chips would pass at 900 and be wrong everywhere.
  for (const [w, r] of Object.entries(at)) {
    rows.push({ id: `2.4/nothing-vanishes-uncounted@${w}`, ok: uncounted(r) === 0,
      why: `at ${w} px: ${r.catsTotal} categories, ${r.categories} named, ${r.catsBehindMore} counted` });
    rows.push({ id: `17.3/the-toggle-is-reachable@${w}`, ok: r.openerClipped === false,
      why: `at ${w} px the family opener is clipped` });
  }
  verdict('§D1 · the 900 px floor', rows);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// §D2 · THE FIT FOLLOWS THE WINDOW — IN BOTH DIRECTIONS
//
// THE FINDING: `applyOverflow` ran inside `renderFamilyLegend` and nowhere else,
// and `grep -rn "resize\|ResizeObserver" src/js/` found one hit, in popover.js.
// So „does this row fit?" was answered against whatever width the window had
// when the legend was last DRAWN — and 13.1 says the window remembers its size,
// which means it is also a window the user drags. Dragging it narrower clipped
// the row with no ellipsis and no cue; dragging it wider left the disclosure up
// with 500 px of room going spare.
//
// THE FIX: `legend.js#watchLegendWidth` observes the legend's own box. The row
// below is the same question it always asked — is the dragged row the row this
// width deserves? — and it now also asks the two things a correct answer must
// carry: nothing is clipped after the drag, and the chips come BACK when the
// window does. A re-decision that only ever subtracts is not a re-decision.
// ═════════════════════════════════════════════════════════════════════════════

test('§D2 · dragging the window re-decides the fit, so nothing clips and nothing stays collapsed', async () => {
  i18n.setLang('de');
  const before = document.body.style.cssText;
  try {
    await dragTo(1440);
    mount(EIGHT);
    const wide = toolbarSurvey();

    // The user drags the window narrower. NOTHING in this test re-renders the legend — whatever
    // the row does next, the observer did.
    await dragTo(900);
    const shrunk = toolbarSurvey();
    // …and this is what the SAME width looks like when something does re-render it. The two must
    // agree, or the drag left the row in a state no render would ever produce.
    renderLegend();
    const rerendered = toolbarSurvey();
    // Back out again — the fit has to give the chips back, not just take them away.
    await dragTo(1440);
    const grown = toolbarSurvey();

    diag(`drawn at 1440 → chips ${wide.chipsShown}, collapsed ${wide.famCollapsed}, named ${wide.categories} + ${wide.catsBehindMore} behind „+n", overflow ${wide.overflowPx} px`);
    diag(`dragged to 900, no re-render → chips ${shrunk.chipsShown}, collapsed ${shrunk.famCollapsed}, named ${shrunk.categories} + ${shrunk.catsBehindMore} behind „+n", overflow ${shrunk.overflowPx} px, cats clipped ${shrunk.categoriesClipped}, „· n" clipped ${shrunk.openerClipped}`);
    diag(`the same 900 px WITH a re-render → chips ${rerendered.chipsShown}, collapsed ${rerendered.famCollapsed}, named ${rerendered.categories} + ${rerendered.catsBehindMore}, „· n" clipped ${rerendered.openerClipped}`);
    diag(`dragged back to 1440 → chips ${grown.chipsShown}, collapsed ${grown.famCollapsed}, named ${grown.categories} + ${grown.catsBehindMore}, overflow ${grown.overflowPx} px`);

    verdict('§D2 · the fit and the window', [
      { id: 'R14/the-collapse-follows-the-window', ok: shrunk.famCollapsed === rerendered.famCollapsed && shrunk.openerClipped === rerendered.openerClipped && shrunk.categories === rerendered.categories,
        why: `the dragged row (collapsed ${shrunk.famCollapsed}, opener clipped ${shrunk.openerClipped}, ${shrunk.categories} named) is not the row a re-render at the same width gives (collapsed ${rerendered.famCollapsed}, opener clipped ${rerendered.openerClipped}, ${rerendered.categories} named)` },
      { id: '3.6/the-drag-clips-nothing', ok: shrunk.openerClipped === false && shrunk.categoriesClipped === 0 && shrunk.moreClipped !== true,
        why: `after the drag: opener clipped ${shrunk.openerClipped}, ${shrunk.categoriesClipped} category names clipped, „+n" clipped ${shrunk.moreClipped}` },
      { id: '2.4/the-drag-counts-what-it-drops', ok: uncounted(shrunk) === 0,
        why: `${uncounted(shrunk)} of ${shrunk.catsTotal} categories are neither named on the dragged row nor counted behind „+n"` },
      { id: 'R14/the-chips-come-back-when-the-window-does', ok: grown.chipsShown === wide.chipsShown && grown.categories === wide.categories && grown.catsBehindMore === 0,
        why: `back at 1440 the row shows ${grown.chipsShown} chips and ${grown.categories} named categories (${grown.catsBehindMore} still behind „+n"); at the same width before the drag it showed ${wide.chipsShown} and ${wide.categories}` },
    ]);
  } finally {
    document.body.style.cssText = before;
    void document.body.offsetWidth;
    await settle();
    unmount();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// §D3 · WHOSE SECTION YIELDS WHEN THE ROW IS FULL
//
// THE FINDING: `applyOverflow` asked one question — „does the HOST overflow?" —
// and answered it by collapsing the FAMILY chips, whatever the cause of the
// overflow. A user who added categories (4.4, unbounded by design) therefore
// lost the family section to make room for the half that had just grown, and the
// family section is the half that carries a privacy control (17.3).
//
// THE FIX: `legend.js#fitRow` fits the category half FIRST, against the family
// half's measured natural width, and the categories that no longer fit go behind
// 2.4's „+n" instead of pushing anything off the end. `applyOverflow` is
// untouched — it now gets asked a question whose answer is the right one.
//
// THE ROW BELOW IS THE SAME CLAIM, PLUS THE ONE THAT MAKES IT MEAN SOMETHING:
// the family half must not merely be non-empty after the growth, it must be
// EXACTLY WHAT IT WAS BEFORE IT. „The half that grew is the half that yields" is
// an equality, and an equality is what is asserted.
// ═════════════════════════════════════════════════════════════════════════════

test('§D3 · added categories yield to „+n"; the family half is untouched by their growth', () => {
  i18n.setLang('de');
  const before = store.state.categories;
  const extra = ['Ehrenamt', 'Fortbildung', 'Sport', 'Verein'].map((name, i) => ({
    id: `cat_extra_${i}`, name, nameEn: name, paletteRef: ['tuerkis', 'rot', 'gold', 'marine'][i], visible: true,
  }));
  try {
    const rows = [];
    for (const n of [0, 2, 4]) {
      store.state.categories = before.concat(extra.slice(0, n));
      const r = atWidth(1280, () => { mount(EIGHT); return toolbarSurvey(); });
      rows.push({ n: before.length + n, r });
      diag(`   ${before.length + n} categories at 1280 px → legend needs ${r.legendNeeds} px of ${r.legendW} px `
        + `· named ${r.categories} + ${r.catsBehindMore} behind „+n" · cats clipped ${r.categoriesClipped} · family chips shown ${r.chipsShown} · collapsed ${r.famCollapsed} · „· n" clipped ${r.openerClipped}`);
    }
    const start = rows[0].r;
    const grew = rows[rows.length - 1].r;
    verdict('§D3 · which half yields', [
      { id: 'A3/the-family-half-survives-added-categories', ok: grew.chipsShown > 0,
        why: `with ${rows[rows.length - 1].n} categories the family half is collapsed to its opener; the categories are what grew and the family is what yielded` },
      { id: 'A3/the-family-half-is-UNCHANGED-by-added-categories', ok: grew.chipsShown === start.chipsShown && grew.famCollapsed === start.famCollapsed,
        why: `at ${start.catsTotal} categories the family half showed ${start.chipsShown} chips (collapsed ${start.famCollapsed}); at ${grew.catsTotal} it shows ${grew.chipsShown} (collapsed ${grew.famCollapsed}) — the growth was paid for out of the wrong half` },
      { id: '17.3/the-toggle-survives', ok: grew.openerClipped === false,
        why: 'the family section\'s opener is clipped once the user has added categories' },
      { id: '2.4/the-half-that-grew-discloses-what-it-drops', ok: rows.every((x) => uncounted(x.r) === 0),
        why: rows.map((x) => `${x.n} cats → ${x.r.categories} named + ${x.r.catsBehindMore} counted (${uncounted(x.r)} lost)`).join(' · ') },
      { id: '4.3/the-categories-that-yielded-are-not-clipped', ok: rows.every((x) => x.r.categoriesClipped === 0 && x.r.moreClipped !== true),
        why: 'a category name was cut off rather than disclosed — „+n" exists so that never happens' },
    ]);
  } finally {
    store.state.categories = before;
    renderLegend();
    unmount();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// §D4 · THE ENGLISH ROW — 13.7 says both languages, and English is not shorter
// ═════════════════════════════════════════════════════════════════════════════

test('§D4 · the 900 px row in both languages', () => {
  const out = {};
  for (const lang of ['de', 'en']) {
    i18n.setLang(lang);
    renderLegend();
    out[lang] = atWidth(900, () => { mount(EIGHT); return toolbarSurvey(); });
    diag(`   ${lang} at 900 px → legend needs ${out[lang].legendNeeds} px of ${out[lang].legendW} px (overflow ${out[lang].overflowPx}) `
      + `· cats clipped ${out[lang].categoriesClipped}/${out[lang].categories} · chips ${out[lang].chipsShown} · „· n" clipped ${out[lang].openerClipped}`);
  }
  i18n.setLang('de');
  renderLegend();
  unmount();
  verdict('§D4 · 13.7 both languages', [
    { id: '13.7/english-fits-too', ok: out.en.openerClipped === false && out.en.categoriesClipped === 0,
      why: `the English row at 900 px clips ${out.en.categoriesClipped} category names and ${out.en.openerClipped ? 'the family opener' : 'nothing else'}` },
    { id: '13.7/english-counts-what-it-drops', ok: uncounted(out.en) === 0 && uncounted(out.de) === 0,
      why: `de loses ${uncounted(out.de)}, en loses ${uncounted(out.en)} categories to neither the row nor „+n"` },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// §D5 · THE WHOLE PRODUCT, NOT ONE SAMPLE POINT
//
// The legend now carries two populations that grow independently: up to ~10
// categories (4.5's palette is the only cap) and up to 8 members
// (`MAX_LIVE_MEMBERS`). §D1–§D3 each pick one point in that grid. A fit that is
// right at three points and wrong at the fortieth is not a fit, so this sweeps
// the product — 10 × 4 category/member counts, at v1's floor and at a laptop
// width, in German — and asserts the three invariants at every cell:
//
//   17.3 · the family opener is inside the box (a privacy control is reachable)
//   2.4  · every category is named on the row or counted behind „+n"
//   4.3  · nothing is clipped: what does not fit is disclosed
// ═════════════════════════════════════════════════════════════════════════════

test('§D5 · the fit holds across 1–10 categories × 2–8 members, at 900 and at 1280', () => {
  i18n.setLang('de');
  const base = store.state.categories;
  const pool = ['Ehrenamt', 'Fortbildung', 'Sportverein', 'Musikschule', 'Kirchengemeinde', 'Renovierung']
    .map((name, i) => ({ id: `cat_sweep_${i}`, name, nameEn: name,
      paletteRef: ['tuerkis', 'rot', 'gold', 'marine', 'violett', 'gruen'][i], visible: true }));
  const bad = [];
  let cells = 0;
  try {
    for (const w of [900, 1280]) {
      for (let nc = 1; nc <= 10; nc++) {
        store.state.categories = base.concat(pool).slice(0, nc);
        for (const nm of [2, 4, 6, 8]) {
          const r = atWidth(w, () => { mount(EIGHT.slice(0, nm)); return toolbarSurvey(); });
          cells += 1;
          const at = `${w}px · ${nc} cats · ${nm} members`;
          if (r.openerClipped !== false) bad.push(`${at}: the „· n" opener is clipped (17.3)`);
          if (uncounted(r) !== 0) bad.push(`${at}: ${uncounted(r)} categories neither named nor counted (2.4)`);
          if (r.categoriesClipped !== 0) bad.push(`${at}: ${r.categoriesClipped} category names clipped (4.3)`);
          if (r.moreClipped === true) bad.push(`${at}: the „+n" disclosure is itself clipped (2.4)`);
          if (r.editClipped !== false) bad.push(`${at}: „bearbeiten" is clipped (4.4)`);
          if (r.toolbarH !== 40) bad.push(`${at}: the toolbar is ${r.toolbarH} px (principle 1)`);
        }
      }
    }
  } finally {
    store.state.categories = base;
    renderLegend();
    unmount();
  }
  diag(`   swept ${cells} cells of the category × member product at two widths`);
  for (const b of bad.slice(0, 12)) diag('   x ' + b);
  verdict('§D5 · the whole product', [
    { id: 'A3+17.3+2.4/the-fit-holds-everywhere', ok: bad.length === 0,
      why: `${bad.length} of ${cells} cells break an invariant` },
  ]);
});
