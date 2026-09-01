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

function mount(rows) {
  const map = regs(rows);
  members.initMembersUI({
    port: { me: () => ME, adminId: () => ME, registers: () => map, keysPending: () => false, setProfile: async () => {} },
    legendHost: '.legend',
  });
  members.renderFamilyLegend();
}
function unmount() {
  members.initMembersUI();
  members.renderFamilyLegend();
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
  return {
    toolbarH: px(tbr.height),
    toolbarW: px(tbr.width),
    legendW: px(lr.width),
    legendNeeds: px(lg.scrollWidth),
    overflowPx: px(lg.scrollWidth - lg.clientWidth),
    categories: cats.length,
    categoriesClipped: cats.filter(clipped).length,
    editClipped: edit ? clipped(edit) : null,
    famSection: !!sec,
    famCollapsed: chips ? getComputedStyle(chips).display === 'none' : null,
    chipsShown: chips && getComputedStyle(chips).display !== 'none' ? chips.children.length : 0,
    openerClipped: more ? clipped(more) : null,
    searchW: px(($('.search-box') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
  };
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
  diag('   width   toolbar  legend  legend needs  overflow  cats clipped  „bearbeiten" clipped  chips shown  collapsed  „· n" clipped');
  for (const [w, r] of Object.entries(at)) {
    diag(`   ${String(w).padStart(5)}${String(r.toolbarH).padStart(9)}${String(r.legendW).padStart(8)}`
      + `${String(r.legendNeeds).padStart(14)}${String(r.overflowPx).padStart(10)}`
      + `${String(r.categoriesClipped + '/' + r.categories).padStart(14)}`
      + `${String(r.editClipped).padStart(22)}${String(r.chipsShown).padStart(13)}`
      + `${String(r.famCollapsed).padStart(11)}${String(r.openerClipped).padStart(15)}`);
  }

  const two = atWidth(900, () => { mount(TWO); return toolbarSurvey(); });
  diag(`   at 900 px with TWO members (addendum §9's „excellent at 2"): chips shown ${two.chipsShown}, collapsed ${two.famCollapsed}, cats clipped ${two.categoriesClipped}/${two.categories}, „· n" clipped ${two.openerClipped}`);

  const min = at[900];
  const rows = [];
  rows.push({ id: 'principle-1/toolbar-is-still-40px', ok: min.toolbarH === 40, why: `the toolbar is ${min.toolbarH} px at 900 px wide` });
  rows.push({ id: 'A3/both-sections-are-present-at-900px', ok: min.famSection, why: 'no family section at v1\'s minimum window' });
  // ⚠ 17.3's toggle is a CONTROL. A collapsed section still opens the popover;
  // a CLIPPED one is gone, with no ellipsis, no scroll and no cue.
  rows.push({ id: '17.3/the-toggle-is-reachable-at-900px', ok: min.openerClipped === false,
    why: 'the family section\'s only affordance at 900 px is clipped by `.legend { overflow: hidden }` — 17.3 has no entry point on the minimum window' });
  rows.push({ id: '4.3/categories-keep-their-names-at-900px', ok: min.categoriesClipped === 0,
    why: `${min.categoriesClipped} of ${min.categories} category names are cut off at 900 px` });
  rows.push({ id: '4.4/„bearbeiten"-is-reachable-at-900px', ok: min.editClipped === false,
    why: 'the category manager\'s only entry point is clipped at 900 px' });
  verdict('§D1 · the 900 px floor', rows);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// §D2 · THE COLLAPSE IS DECIDED ONCE, AT RENDER TIME
//
// `applyOverflow` runs inside `renderFamilyLegend` and nowhere else. There is no
// `resize` listener and no `ResizeObserver` in `src/js/` except `popover.js`'s
// „close on resize". So the decision „do the chips fit?" is taken against
// whatever width the window had when the legend was last drawn — and 13.1 says
// the window remembers its size, which means it is also a window the user drags.
// ═════════════════════════════════════════════════════════════════════════════

test('§D2 · shrinking the window does not re-decide the collapse, so the legend clips silently', async () => {
  i18n.setLang('de');
  const wide = atWidth(1440, () => { mount(EIGHT); return toolbarSurvey(); });

  // Now the user drags the window narrower. Nothing re-renders the legend.
  const shrunk = atWidth(900, () => toolbarSurvey());
  // …and this is what the SAME width looks like when something does re-render it.
  const rerendered = atWidth(900, () => { members.renderFamilyLegend(); return toolbarSurvey(); });

  diag(`drawn at 1440 → chips shown ${wide.chipsShown}, collapsed ${wide.famCollapsed}, legend overflow ${wide.overflowPx} px`);
  diag(`dragged to 900, NO re-render → chips shown ${shrunk.chipsShown}, collapsed ${shrunk.famCollapsed}, legend overflow ${shrunk.overflowPx} px, cats clipped ${shrunk.categoriesClipped}/${shrunk.categories}, „· n" clipped ${shrunk.openerClipped}`);
  diag(`the same 900 px WITH a re-render → chips shown ${rerendered.chipsShown}, collapsed ${rerendered.famCollapsed}, legend overflow ${rerendered.overflowPx} px, „· n" clipped ${rerendered.openerClipped}`);
  diag('   `applyOverflow` is called only from `renderFamilyLegend`. `grep -rn "resize\\|ResizeObserver" src/js/` finds one hit, in popover.js.');

  verdict('§D2 · the collapse and the window', [
    { id: 'R14/the-collapse-follows-the-window', ok: shrunk.famCollapsed === rerendered.famCollapsed && shrunk.openerClipped === rerendered.openerClipped,
      why: `after a drag to 900 px the row is in the state it would have had at 1440 (collapsed ${shrunk.famCollapsed}, opener clipped ${shrunk.openerClipped}); a re-render at the same width gives collapsed ${rerendered.famCollapsed}, opener clipped ${rerendered.openerClipped}` },
  ]);
  unmount();
});

// ═════════════════════════════════════════════════════════════════════════════
// §D3 · WHOSE SECTION YIELDS WHEN THE ROW IS FULL
//
// `applyOverflow` asks one question — „does the HOST overflow?" — and answers it
// by collapsing the FAMILY chips, whatever the cause of the overflow. A user who
// adds categories (4.4, unbounded by design) therefore loses the family section
// to make room for categories, and the family section is the half that carries a
// privacy control (17.3). This measures where the line actually falls.
// ═════════════════════════════════════════════════════════════════════════════

test('§D3 · added categories collapse the FAMILY half, not the half that grew', () => {
  i18n.setLang('de');
  const before = store.state.categories;
  const extra = ['Ehrenamt', 'Fortbildung', 'Sport', 'Verein'].map((name, i) => ({
    id: `cat_extra_${i}`, name, nameEn: name, paletteRef: ['tuerkis', 'rot', 'gold', 'marine'][i], visible: true,
  }));
  try {
    const rows = [];
    for (const n of [0, 2, 4]) {
      store.state.categories = before.concat(extra.slice(0, n));
      renderLegend();
      const r = atWidth(1280, () => { mount(EIGHT); return toolbarSurvey(); });
      rows.push({ n: before.length + n, r });
      diag(`   ${before.length + n} categories at 1280 px → legend needs ${r.legendNeeds} px of ${r.legendW} px `
        + `· cats clipped ${r.categoriesClipped}/${r.categories} · family chips shown ${r.chipsShown} · collapsed ${r.famCollapsed} · „· n" clipped ${r.openerClipped}`);
    }
    const grew = rows[rows.length - 1].r;
    verdict('§D3 · which half yields', [
      { id: 'A3/the-family-half-survives-added-categories', ok: grew.chipsShown > 0,
        why: `with ${rows[rows.length - 1].n} categories the family half is collapsed to its opener; the categories are what grew and the family is what yielded` },
      { id: '17.3/the-toggle-survives', ok: grew.openerClipped === false,
        why: 'the family section\'s opener is clipped once the user has added categories' },
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
  ]);
});
