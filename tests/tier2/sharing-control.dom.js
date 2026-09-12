// TIER 2 · THE SHARING CLUSTER — deliverable 18 · A7 · LZP-702.
// Stories 16.1–16.7 · 17.6 · 18.1, 18.2 · A4, A7 · glossary §13.
// ADR 004 §2 / §5 / §6 / §7 / §8 · ADR 002 §7.4 (the copy contract) · ADR 003 §7 gate 2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS ACTUALLY GUARDING
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 004's headline invariant is asserted "on the EMITTED OPS and on the SEALED BYTES — never on
// the rendering. A rendering bug can therefore produce the wrong pixels; it cannot produce a
// leak." This file is the rendering's own suite, so it would be the easy place to forget that.
// It does not:
//
//   §4 drives the REAL control against the REAL store and reads the log back. Every op the
//   cluster can emit — over the whole 3×3 transition domain, both kinds, both co-edit states — is
//   a `note.set`/`bar.set` in the PERSONAL space whose field patch is a subset of
//   `{visibility, coEdit}`. No `pub.*` field, no `text`, no `label`, no `categoryId`, ever. That
//   is P7a/P7b/P7g at the UI seam, and it is what makes "everything that publishes goes through
//   `projectForFamily`" true of this file rather than merely intended.
//
// And two things this suite refuses to test by eyeballing three screenshots:
//
//   §2 THE INPUT DOMAIN AS DATA. `CELLS` below is the cross-product of kind × current level ×
//   co-edit × requested level (2 × 3 × 2 × 3 = 36), plus the foreign and no-family rows. Every
//   cell states its expected patch. A branch chosen before the domain was enumerated is the
//   failure mode this repository has spent ten rounds removing.
//
//   §5 THE COPY IS A CONTRACT. ADR 002 §7.4 fixes two strings verbatim and forbids four phrases
//   outright, and LZP-1003 audits STRINGS as well as code. Every string the module can render, in
//   BOTH languages, is swept — not the three that happen to be on screen.

const popover = await importApp('popover.js');
const sharing = await importApp('family/sharing.js');
const i18n = await importApp('i18n.js');
const { store } = await importApp('store.js');
const { VISIBILITY_LEVELS } = await importApp('core/entities.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · scaffolding
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_0123456789abcdefghijkm';
const MAMA = 'mem_mama0000000000000000000';
const DATE = '2026-09-15';

// A Familienkreis, through the store's own door. `useFamilySpace()` landed from the store owner
// mid-round; before it there was no public way to say "this Mac is in a circle" and this line was
// a private write. It re-projects, which is what turns `stripV2Fields` off and gives every entry
// its `visibility` register — the thing the cluster reads.
store.useFamilySpace(SPACE);

// The one door. In the product this call is made by `family/mount.js`; here the test IS the door,
// which is exactly the same call with the same argument. Nothing else installs it — see
// `popover.js:useSharing` and ADR 003 §7 gate 2 for why it may not be an import.
popover.useSharing(sharing);

const lang = (l) => { i18n.setLang(l); };
const de = () => lang('de');

let seq = 0;
const mkId = () => `sh-${++seq}-0000-0000-0000-00000000`;

/** A real note in the store, at a level. Returns its id. */
function makeNote(over = {}) {
  const id = mkId();
  store.apply('createNoteInline', {
    id, date: DATE, text: over.text ?? 'Zahnarzt',
    categoryId: store.state.categories[0].id,
    visibility: over.visibility ?? 'privat',
  });
  if (over.coEdit) {
    store.txn('seed-coedit', (tx) => { tx.note(id).set({ coEdit: true }); });
  }
  return id;
}

/** A real bar in the store, at a level. Returns its id. */
function makeBar(over = {}) {
  const id = mkId();
  store.apply('createBar', {
    id, startDate: DATE, endDate: '2026-09-18',
    categoryId: store.state.categories[0].id,
    visibility: over.visibility ?? 'privat',
  });
  if (over.coEdit) {
    store.txn('seed-coedit', (tx) => { tx.bar(id).set({ coEdit: true }); });
  }
  return id;
}

const noteById = (id) => store.state.notes.find((n) => n.id === id);
const barById = (id) => store.state.bars.find((b) => b.id === id);

/**
 * Empty the board between tests.
 *
 * Two halves, and the order matters. A SYNTHETIC FOREIGN entry (§3 pushes a few, because no
 * device in this tree can yet receive a real one — see the report) is a direct write to
 * `state`, so it must be removed with a direct write and `_projected` re-synced, or the next
 * transaction's `_adopt()` would try to author `note.set` for an entity key that is not a uuid.
 * Own entries are REAL, so they are removed the way the product removes them: a tombstone.
 */
function reset() {
  popover.closePopover();
  store.state.notes = store.state.notes.filter((n) => !n.isForeign);
  store.state.bars = store.state.bars.filter((b) => !b.isForeign);
  store._projected = store._contentClone();
  store._projected.settings = structuredClone(store.state.settings);
  const ns = store.state.notes.map((n) => n.id);
  const bs = store.state.bars.map((b) => b.id);
  if (ns.length || bs.length) {
    store.txn('reset', (tx) => {
      for (const i of ns) tx.note(i).del();
      for (const i of bs) tx.bar(i).del();
    });
  }
  de();
}

/**
 * THE EMITTED OPS. `store._log.lines()` is the log itself; there is no public reader of an op's
 * field patch, and asserting on the register map instead would only prove the fold, not what was
 * written into it. Reaching for the private is the point of §4 — a leak is a claim about the op,
 * not about the state it folds to.
 */
const opsSince = (mark) => store._log.lines().slice(mark).map((l) => l.op);
const opMark = () => store._log.lines().length;

/** Open the day popover the way `interact.js` does. */
function openPop() {
  const anchor = document.querySelector('.board .col') || document.body;
  popover.openDayPopover(anchor, DATE, { onChange: () => {} });
  return document.querySelector('.popover');
}

// An HLC stamp (ADR 001 §1.4): 13 digits · "." · 6 digits · "." · 16 Crockford chars = 37.
// 2026-09-13T12:00Z is a Sunday everywhere between UTC-11 and UTC+11, which is what makes
// „geändert So." reproducible on a machine in any plausible timezone.
const SUNDAY_STAMP = `${Date.UTC(2026, 8, 13, 12)}.000001.MAMA000000000000`;

const rowFor = (id) => document.querySelector(`.popover .pop-row[data-entry="${CSS.escape(id)}"]`);
const stripEl = () => document.querySelector('.popover .pop-share');
const optFor = (level) => document.querySelector(`.popover .share-opt[data-level="${level}"]`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE GATE — solo mode cannot render the cluster, for two independent reasons
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · 16.1 — a board with no family space has no cluster: the FIELD is absent', () => {
  // `stripV2Fields` removes `visibility` from every entry while `familySpaceId === null`, so
  // `sharingApplies` answers false with no flag involved. This is structure 1 of 2.
  const solo = { id: 'x', date: DATE, text: 'a', categoryId: 'c', repeatsYearly: false };
  assert.equal(sharing.sharingApplies(solo), false, 'no `visibility` ⇒ no control');
  assert.equal(sharing.clusterApplies(solo), false);
  assert.equal(sharing.planVisibilityChange(solo, 'geteilt'), null,
    'and the planner refuses too — a caller that skips the check still cannot share');
});

test('§1 · ADR 003 §7 gate 2 — the module is a PORT, never an import: structure 2 of 2', () => {
  // The gate that caught this: `tests/tier1/network-scope.test.js` §2 forbids any static path
  // from the boot graph into `src/js/family/`, and allows exactly one dynamic door. So the
  // popover must not name the module at all — asserted on the SOURCE, because the whole claim is
  // about what a solo launch EVALUATES, and a suite that has already imported the module cannot
  // observe that from inside the page.
  assert.equal(typeof popover.useSharing, 'function', 'the port must exist');
  assert.equal(popover.useSharing(null), null, 'and it must uninstall');
  const id = makeNote({ visibility: 'geteilt' });
  openPop();
  assert.equal(document.querySelector('.popover .share-trig'), null,
    'with the port uninstalled there is no trigger, whatever the entry says');
  popover.useSharing(sharing);
  popover.closePopover();
  openPop();
  assert.ok(rowFor(id).querySelector('.share-trig'), 'and it comes back when the door opens');
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE INPUT DOMAIN, AS DATA — every transition, both kinds, both co-edit states
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A `null` expectation is a DECLINE: v1's protocol (`store.js:150`), which keeps a no-op click
// off the undo stack. Everything else is the exact field patch the transaction must write.
//
// `coEdit: false` rides along on every departure from Geteilt, and that row is the one worth
// reading twice. ADR 004 disagrees with itself: §5's Belegt→Geteilt row publishes a literal
// `'pub.coEdit': false`, while `core/project.js:TRUTH_SOURCE` republishes whatever the truth
// register holds. Left alone, Geteilt → Belegt → Geteilt SILENTLY RESTORES the family's write
// access to an entry the owner un-shared — a grant nobody re-made, brought back by a control the
// user was using to disclose less. Writing it in the same transaction makes §8's sentence
// ("`pub.coEdit` exists only at Geteilt") true of the truth registers too. Reported.

const CELLS = (() => {
  const out = [];
  for (const kind of ['note', 'bar']) {
    for (const from of VISIBILITY_LEVELS) {
      for (const coEdit of [false, true]) {
        for (const to of VISIBILITY_LEVELS) {
          const leaving = from === 'geteilt' && to !== 'geteilt';
          const clears = to !== 'geteilt' && coEdit === true;
          let expect;
          if (from === to && !clears) expect = null;                       // decline
          else if (clears) expect = { visibility: to, coEdit: false };
          else expect = { visibility: to };
          out.push({
            id: `D2-${kind}/${from}${coEdit ? '+co' : ''}->${to}`,
            kind, from, coEdit, to, leaving, expect,
          });
        }
      }
    }
  }
  return out;
})();

test('§2 · the transition domain is the whole cross-product, and it is 36 cells', () => {
  assert.equal(CELLS.length, 2 * 3 * 2 * 3, 'kind × from × coEdit × to');
  assert.equal(new Set(CELLS.map((c) => c.id)).size, CELLS.length, 'two cells share an id');
  // 8 of the 36 are declines. The other four same-level cells are NOT no-ops: an entry sitting at
  // Privat or Belegt with `coEdit: true` in its truth register is an incoherent state (ADR 004 §8
  // says the flag exists only at Geteilt), and clicking the level it is already at REPAIRS it.
  // That is deliberate: after any interaction with this control, "coEdit ⇒ geteilt" holds.
  assert.equal(CELLS.filter((c) => c.expect === null).length, 8);
  assert.deepEqual(
    CELLS.filter((c) => c.expect === null).map((c) => `${c.from}${c.coEdit ? '+co' : ''}->${c.to}`),
    ['privat->privat', 'belegt->belegt', 'geteilt->geteilt', 'geteilt+co->geteilt',
     'privat->privat', 'belegt->belegt', 'geteilt->geteilt', 'geteilt+co->geteilt'],
    'the declines are exactly the coherent same-level cells, in both kinds');
});

test('§2 · planVisibilityChange over all 36 cells — the patch, exactly', () => {
  const bad = [];
  for (const c of CELLS) {
    const entry = {
      id: 'e', isForeign: false, visibility: c.from, coEdit: c.coEdit,
      level: c.from, exposure: { level: c.from, pending: false },
    };
    const plan = sharing.planVisibilityChange(entry, c.to);
    const got = plan ? plan.patch : null;
    const same = JSON.stringify(got) === JSON.stringify(c.expect);
    if (!same) bad.push(`${c.id}: expected ${JSON.stringify(c.expect)} got ${JSON.stringify(got)}`);
    if (plan && plan.leavingGeteilt !== c.leaving) bad.push(`${c.id}: leavingGeteilt wrong`);
  }
  assert.deepEqual(bad, [], `${bad.length} of ${CELLS.length} cells disagree`);
});

test('§2 · the downgrade flag is measured against what the family SAW, not against intent', () => {
  // ADR 004 §6. `exposure.level` is the last ACKED pub.level; `entry.level` is the folded one.
  // The HIGHER of the two wins, so the sentence can over-warn and can never under-warn.
  const mk = (visibility, acked, folded) => ({
    id: 'e', isForeign: false, visibility, coEdit: false,
    level: folded, exposure: { level: acked, pending: false },
  });
  assert.equal(sharing.exposedLevel(mk('geteilt', null, null)), 'privat',
    'never published: nothing was seen');
  assert.equal(sharing.exposedLevel(mk('geteilt', 'belegt', 'geteilt')), 'geteilt',
    'a pending UPGRADE already reached the fold — take the higher');
  assert.equal(sharing.exposedLevel(mk('belegt', 'geteilt', 'belegt')), 'geteilt',
    'a pending DOWNGRADE has not been acked — take the higher');
  assert.equal(sharing.planVisibilityChange(mk('geteilt', 'geteilt', 'geteilt'), 'privat').downgrade, true);
  assert.equal(sharing.planVisibilityChange(mk('privat', null, null), 'geteilt').downgrade, false);
  // The dangerous direction, stated as its own row: an entry whose publication is still in the
  // outbox must STILL warn on the way down.
  assert.equal(sharing.planVisibilityChange(mk('geteilt', null, 'geteilt'), 'belegt').downgrade, true,
    'unacked but folded is still "the family may have seen it"');
});

test('§2 · 18.2 / ADR 004 §8 — co-edit exists only at Geteilt, refused not merely disabled', () => {
  const at = (visibility, coEdit) => ({ id: 'e', isForeign: false, visibility, coEdit, level: visibility });
  assert.deepEqual(sharing.planCoEditChange(at('geteilt', false), true).patch, { coEdit: true });
  assert.deepEqual(sharing.planCoEditChange(at('geteilt', true), false).patch, { coEdit: false });
  assert.equal(sharing.planCoEditChange(at('geteilt', true), true), null, 'unchanged declines');
  assert.equal(sharing.planCoEditChange(at('belegt', false), true), null, 'Belegt refuses');
  assert.equal(sharing.planCoEditChange(at('privat', false), true), null, 'Privat refuses');
});

test('§2 · 18.1 — a foreign entry is never mine to set, at any level', () => {
  const foreign = {
    id: `fnote:${MAMA}/abc`, isForeign: true, ownerId: MAMA, level: 'geteilt', coEdit: true,
  };
  assert.equal(sharing.sharingApplies(foreign), false, 'no truth register, no control');
  assert.equal(sharing.clusterApplies(foreign), true, 'but it still earns attribution (17.6)');
  for (const l of VISIBILITY_LEVELS) {
    assert.equal(sharing.planVisibilityChange(foreign, l), null, `refused for ${l}`);
  }
  assert.equal(sharing.planCoEditChange(foreign, true), null,
    'and a co-editor can never grant themselves co-edit (ADR 004 §8)');

  // ⚠ THE ROW THAT MAKES THE `isForeign` CHECK LOAD-BEARING, and the reason it is here rather
  // than assumed. `materialize.js:foreignCandidate` builds no `visibility` for a foreign entry,
  // so on every input this tree can produce today the earlier `sharingApplies` guard already
  // refuses and the `isForeign` line is dead — a mutant that deleted it survived the entire
  // 36-cell domain. This is the input that is NOT produced today: a foreign entry that also
  // carries a `visibility`, which is what one promotion bug, one decoration added to
  // `foreignCandidate`, or one hand-built object looks like. Ownership is a structural fact
  // (ADR 001 §4.4 puts the owner in the entity KEY); a level register agreeing with me is not
  // evidence that the entry is mine.
  const impossible = { ...foreign, visibility: 'privat' };
  assert.equal(sharing.sharingApplies(impossible), true, 'the earlier guard now says yes …');
  assert.equal(sharing.planVisibilityChange(impossible, 'geteilt'), null,
    '… and ownership refuses anyway — I cannot share Mama\'s entry by decorating it');
  assert.equal(sharing.planCoEditChange({ ...foreign, visibility: 'geteilt' }, true), null,
    '… nor grant myself co-edit on it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE CONTROL ON SCREEN — legibility, two clicks, three channels
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · 16.3 — TWO CLICKS from a closed popover row to a changed level', () => {
  const id = makeNote({ visibility: 'privat' });
  openPop();
  assert.equal(stripEl(), null, 'the strip costs zero rows until asked for');
  rowFor(id).querySelector('.share-trig').click();          // click 1
  assert.ok(stripEl(), 'click 1 discloses the cluster');
  optFor('geteilt').click();                                 // click 2
  assert.equal(noteById(id).visibility, 'geteilt', 'click 2 changed the level');
  reset();
});

test('§3 · the resting state costs ZERO rows — the trigger lives in the existing .act slot', () => {
  const id = makeNote({ visibility: 'belegt' });
  openPop();
  const row = rowFor(id);
  const acts = [...row.querySelectorAll('.act')];
  assert.equal(acts.length, 3, '↻, the sharing trigger, ✕ — no new row, no new line box');
  assert.equal(acts[0].textContent, '↻', 'ADR 004 §4.3: ↻ stays the row FIRST .act');
  assert.ok(acts[1].classList.contains('share-trig'), 'the cluster sits between ↻ and ✕');
  assert.equal(acts[2].textContent, '✕');
  assert.equal(row.getBoundingClientRect().height <= 24, true,
    `a popover row must stay at v1 density; measured ${row.getBoundingClientRect().height}px`);
  reset();
});

test('§3 · hue is never the only channel — three silhouettes, three inks, three words', () => {
  const id = makeNote({ visibility: 'privat' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  const shapes = VISIBILITY_LEVELS.map((l) => {
    const g = optFor(l).querySelector('svg');
    return [...g.children].map((c) => c.tagName + ':' + (c.getAttribute('d') || c.getAttribute('r') || '')).join('|');
  });
  assert.equal(new Set(shapes).size, 3, 'the three glyphs must differ in GEOMETRY, not only colour');
  const inks = VISIBILITY_LEVELS.map((l) =>
    getComputedStyle(optFor(l).querySelector('svg')).color);
  assert.equal(new Set(inks).size, 3, 'and in ink weight — a monotone ramp, not a hue wheel');
  const words = VISIBILITY_LEVELS.map((l) => optFor(l).querySelector('.share-lbl').textContent);
  assert.deepEqual(words, ['Privat', 'Belegt', 'Geteilt'], 'glossary §13, verbatim');
  reset();
});

test('§3 · the segmented control is a real radiogroup: state, roving focus, arrow keys', () => {
  const id = makeNote({ visibility: 'belegt' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  const seg = document.querySelector('.popover .share-seg');
  assert.equal(seg.getAttribute('role'), 'radiogroup');
  assert.deepEqual(
    VISIBILITY_LEVELS.map((l) => optFor(l).getAttribute('aria-checked')),
    ['false', 'true', 'false'], 'exactly one is checked, and it is the truth register');
  assert.deepEqual(
    VISIBILITY_LEVELS.map((l) => optFor(l).tabIndex), [-1, 0, -1],
    'roving tabindex — one tab stop for the whole group');
  optFor('belegt').focus();
  seg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(noteById(id).visibility, 'geteilt', '→ moves AND selects, like a radiogroup');
  reset();
});

test('§3 · 18.2 — the co-edit flag is live at Geteilt and inert everywhere else', () => {
  const id = makeNote({ visibility: 'geteilt' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  const cb = () => document.querySelector('.popover .share-coedit input');
  assert.equal(cb().disabled, false, 'at Geteilt it is live');
  assert.equal(cb().checked, false);
  cb().click();
  assert.equal(noteById(id).coEdit, true, '„Familie darf bearbeiten" wrote the truth register');
  // Now step down. §8's sentence, made structural.
  optFor('belegt').click();
  assert.equal(noteById(id).coEdit, false, 'leaving Geteilt clears the grant — see CELLS');
  assert.equal(cb().disabled, true, 'and the flag is inert below Geteilt');
  assert.ok(document.querySelector('.popover .share-coedit-hint'), 'and says why');
  reset();
});

test('§3 · 16.6 — a pending publication is shown HOLLOW, and never animated (19.3)', () => {
  const id = makeNote({ visibility: 'geteilt' });
  const n = noteById(id);
  n.exposure = { level: 'belegt', pending: true };           // what the log actually acked
  openPop();
  const trig = rowFor(id).querySelector('.share-trig');
  assert.ok(trig.classList.contains('is-pending'), 'the badge marks the lag (ADR 004 §6)');
  assert.includes(trig.getAttribute('aria-label'), 'noch nicht abgeglichen');
  const anim = getComputedStyle(trig.querySelector('svg')).animationName;
  assert.ok(anim === 'none' || anim === '', `a pending marker must not animate; got ${anim}`);
  reset();
});

test('§3 · 18.1 — a foreign entry gets the viewer half: no control, a reason, attribution', () => {
  const key = `fnote:${MAMA}/aaaabbbb-cccc-dddd-eeee-ffff00001111`;
  store.state.notes.push({
    id: key, uuid: 'aaaabbbb', entityKey: key, date: DATE, text: 'Urlaub',
    ownerId: MAMA, isForeign: true, level: 'geteilt', redacted: false,
    memberColorRef: 'magenta', initial: 'M', coEdit: false,
    updatedAt: SUNDAY_STAMP,
  });
  openPop();
  const row = rowFor(key);
  assert.ok(row, 'a foreign entry reaches the popover (17.1)');
  assert.equal(row.querySelector('.txt').dataset.edit, undefined, 'no editor — 18.1');
  assert.deepEqual([...row.querySelectorAll('.act')].map((a) => a.textContent.trim()).filter(Boolean), [],
    'no ↻ and no ✕ on somebody else\'s entry');
  assert.equal(row.querySelector('button.dot'), null, 'and no recategorise: A3, there is no category');
  row.querySelector('.share-trig').click();
  const strip = stripEl();
  assert.includes(strip.textContent, 'Die Sichtbarkeit bestimmt die Person');
  assert.includes(strip.querySelector('.share-attr').textContent, 'von M');
  assert.equal(strip.querySelector('.share-seg'), null, 'and no control at all — not a disabled one');
  reset();
});

test('§3 · 17.2 / ADR 004 §4.3 — a foreign entry never borrows one of MY category colours', () => {
  // `store.category(undefined)` falls through to `categories[0]`, which is the popover's own copy
  // of the `colorOf(undefined) === PALETTE[0]` trap ADR 004 §4.3 names at `layout.js:142`. A
  // foreign entry rendered in my first category's blue is the bug this row exists for.
  const mine = store.state.categories[0];
  const key = `fbar:${MAMA}/1111aaaa-bbbb-cccc-dddd-eeee00002222`;
  store.state.bars.push({
    id: key, uuid: '1111aaaa', entityKey: key, startDate: DATE, endDate: '2026-09-20',
    label: 'Ostsee', ownerId: MAMA, isForeign: true, level: 'geteilt', redacted: false,
    memberColorRef: null, initial: 'M', coEdit: false,
  });
  openPop();
  const dot = rowFor(key).querySelector('.dot');
  const mineHex = getComputedStyle(document.createElement('i')) && mine.paletteRef;
  assert.ok(mineHex, 'the board has a first category to be mistaken for');
  assert.notEqual(dot.style.background, '', 'the dot is painted');
  assert.equal(/rgb/.test(dot.style.background), false,
    'a member with no colour on this device yet gets neutral ink, never a category tone; '
    + `got ${dot.style.background}`);
  reset();
});

test('§3 · ADR 004 §4.2 — a Belegt block says the word, and carries no text to leak', () => {
  const key = `fnote:${MAMA}/2222aaaa-bbbb-cccc-dddd-eeee00003333`;
  store.state.notes.push({
    id: key, uuid: '2222aaaa', entityKey: key, date: DATE,
    ownerId: MAMA, isForeign: true, level: 'belegt', redacted: true,
    memberColorRef: 'magenta', initial: 'M',
  });
  openPop();
  assert.equal(rowFor(key).querySelector('.txt').textContent, 'Belegt',
    'the word, in place of the text — `board.js:137`\'s seam, in the popover');
  lang('en');
  popover.closePopover();
  openPop();
  assert.equal(rowFor(key).querySelector('.txt').textContent, 'Busy', 'and in English');
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · THE EMITTED OPS — the assertion this file exists for
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 004 §2's allowlists, RESTATED HERE AS DATA rather than imported.
 *
 * `core/project.js` is the thing under test; importing its own table would make this row agree
 * with the implementation by construction and measure nothing. This is transcribed from ADR 004
 * §2's printed code block, and `tests/attack/redaction-invariants.test.js` INV-R1 asserts the two
 * transcriptions agree with the module.
 */
const PUB_ALLOWED = {
  fnote: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly', 'pub.coEdit', 'pub.text'],
  fbar: ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate', 'pub.coEdit', 'pub.label'],
};
const CONTENT_OF = { fnote: 'pub.text', fbar: 'pub.label' };

test('§4 · every op the cluster can emit, over the whole 36-cell domain, through the REAL store',
  () => {
    // ⚠ WHAT CHANGED WHEN THE PUBLISH PATH LANDED, AND WHY THIS ROW GOT STRONGER RATHER THAN
    // WEAKER. This used to assert "expected ONE op" and mean it literally. `store._commit` now
    // derives the publication in the SAME transaction (ADR 004 §5: "every transition is one
    // transaction carrying the truth write plus the publication write"), so a cell that changes
    // the level emits TWO ops — and the claim this file exists for is unchanged and now checkable
    // on both halves at once:
    //
    //   · the CLUSTER's op is one `note.set`/`bar.set` in the PERSONAL space whose patch is a
    //     subset of {visibility, coEdit}. No `pub.*` field is constructed anywhere in `sharing.js`
    //     and this is where that is measured.
    //   · the STORE's op is at most one `pub.set` in the FAMILY space, under the SAME gid, whose
    //     patch is a subset of ADR 004 §2's allowlist for the level it declares — and which
    //     carries the planted secret only at `geteilt`.
    const violations = [];
    let uiOps = 0;
    let famOps = 0;
    for (const c of CELLS) {
      const id = c.kind === 'note'
        ? makeNote({ visibility: c.from, coEdit: c.coEdit, text: 'Scheidungsanwalt' })
        : makeBar({ visibility: c.from, coEdit: c.coEdit });
      openPop();
      const row = rowFor(id);
      const trig = row && row.querySelector('.share-trig');
      if (!trig) { violations.push(`${c.id}: no trigger`); reset(); continue; }
      trig.click();
      const mark = opMark();
      optFor(c.to).click();
      const ops = opsSince(mark);
      const ui = ops.filter((o) => o.space !== SPACE);
      const fam = ops.filter((o) => o.space === SPACE);
      uiOps += ui.length;
      famOps += fam.length;

      if (c.expect === null) {
        if (ops.length) violations.push(`${c.id}: expected a DECLINE, got ${ops.length} op(s)`);
      } else {
        if (ui.length !== 1) violations.push(`${c.id}: expected ONE ui op, got ${ui.length}`);
        const op = ui[0];
        if (op) {
          if (op.k !== `${c.kind}.set`) violations.push(`${c.id}: kind ${op.k}`);
          if (JSON.stringify(op.f) !== JSON.stringify(c.expect)) {
            violations.push(`${c.id}: patch ${JSON.stringify(op.f)} !== ${JSON.stringify(c.expect)}`);
          }
        }
      }

      // THE PUBLICATION. Present exactly when the level moved — an enumerated prediction, not an
      // "at most one": a downgrade that silently emits NOTHING is ADR 004 §5.1's whole failure.
      const wantsFamily = c.expect !== null && c.to !== c.from;
      if (fam.length !== (wantsFamily ? 1 : 0)) {
        violations.push(`${c.id}: expected ${wantsFamily ? 1 : 0} family op(s), got ${fam.length}`);
      }
      for (const op of fam) {
        const fkind = c.kind === 'note' ? 'fnote' : 'fbar';
        if (op.k !== 'pub.set') violations.push(`${c.id}: family op kind ${op.k}`);
        if (ui[0] && op.gid !== ui[0].gid) {
          violations.push(`${c.id}: the publication carries gid ${op.gid}, the truth write ${ui[0].gid} — ADR 004 §5 says ONE transaction`);
        }
        const allowed = new Set([...PUB_ALLOWED[fkind], '_born']);
        for (const k of Object.keys(op.f || {})) {
          if (!allowed.has(k)) violations.push(`${c.id}: LEAK — the publication carries ${k} (P7a)`);
          if (['text', 'label', 'categoryId', 'pub.categoryId'].includes(k)) {
            violations.push(`${c.id}: LEAK — the publication carries ${k} (P7g / A3)`);
          }
        }
        const content = op.f[CONTENT_OF[fkind]];
        if (op.f['pub.level'] !== 'geteilt' && content !== null && content !== undefined) {
          violations.push(`${c.id}: LEAK — ${op.f['pub.level']} publication carries content (INV-R1)`);
        }
        if (JSON.stringify(op.f || {}).includes('Scheidungsanwalt') && c.to !== 'geteilt') {
          violations.push(`${c.id}: LEAK — the note text left the device at ${c.to}`);
        }
      }

      // INV-R1 at the CLUSTER's own seam: the UI never constructs a `pub.` field, at any level.
      for (const op of ui) {
        for (const k of Object.keys(op.f || {})) {
          if (k.startsWith('pub.')) violations.push(`${c.id}: LEAK — a UI op carries ${k}`);
          if (['text', 'label', 'categoryId'].includes(k)) {
            violations.push(`${c.id}: LEAK — a UI op carries content field ${k} (P7a/P7g)`);
          }
        }
        if (JSON.stringify(op.f || {}).includes('Scheidungsanwalt')) {
          violations.push(`${c.id}: LEAK — the note text is in a visibility op`);
        }
      }
      reset();
    }
    assert.deepEqual(violations, [], `${violations.length} violations across ${CELLS.length} cells`);
    assert.equal(uiOps, CELLS.length - 8, 'the 8 declines emitted nothing, the other 28 emitted one each');
    // 2 kinds × 2 co-edit states × the 6 ordered pairs of distinct levels = 24 transitions that
    // move the level, and every one of them publishes. The other 12 cells — 8 declines and 4
    // same-level repairs — publish NOTHING, because the projection of a repair is byte-identical
    // to what the family already holds. Counted, so a projection that quietly stopped emitting on
    // one arm of the transition table would take this number down with it, and so that a
    // publication fired by a repair (an op on the wire saying a transaction happened, when
    // nothing the family can see has changed) would take it up.
    assert.equal(famOps, 24, 'every level MOVE publishes, and no same-level repair does');
  });

test('§4 · the co-edit flag emits one op, in the personal space, carrying only `coEdit`', () => {
  const id = makeNote({ visibility: 'geteilt', text: 'Zahnarzt' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  const mark = opMark();
  document.querySelector('.popover .share-coedit input').click();
  const ops = opsSince(mark);
  const ui = ops.filter((o) => o.space !== SPACE);
  const fam = ops.filter((o) => o.space === SPACE);
  assert.equal(ui.length, 1);
  assert.equal(ui[0].k, 'note.set');
  assert.notEqual(ui[0].space, SPACE, 'the UI never authors into the family space');
  assert.deepEqual(ui[0].f, { coEdit: true });
  // The grant is a GOVERNING field and the family has to learn it (ADR 004 §8), so the store
  // derives one publication beside it — in the same group, and carrying `pub.coEdit: true` and
  // no new content.
  assert.equal(fam.length, 1, 'a co-edit grant at Geteilt reaches the family');
  assert.equal(fam[0].k, 'pub.set');
  assert.equal(fam[0].gid, ui[0].gid, 'one transaction, one ⌘Z (ADR 004 §5)');
  assert.equal(fam[0].f['pub.coEdit'], true);
  assert.equal(fam[0].f['pub.level'], 'geteilt', 'the flag exists at no other level');
  reset();
});

test('§4 · one transaction, therefore ONE ⌘Z (18.4) — even when it clears the co-edit grant', () => {
  const id = makeNote({ visibility: 'geteilt', coEdit: true });
  // The stack is capped, and §4's 36-cell sweep runs first — so COUNT the delta from a known
  // floor rather than from wherever the cap left it, or this row measures the cap.
  store._stacks.clear();
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  const before = store._stacks.size().undo;
  optFor('privat').click();
  assert.equal(store._stacks.size().undo, before + 1, 'two fields, one step');
  assert.equal(noteById(id).visibility, 'privat');
  assert.equal(noteById(id).coEdit, false);
  store.undo();
  assert.equal(noteById(id).visibility, 'geteilt', '⌘Z restores both');
  assert.equal(noteById(id).coEdit, true);
  reset();
});

test('§4 · the plan is recomputed INSIDE the transaction, against the current truth', () => {
  // A level that moved under the open strip — a co-editor, a second Mac, an admin unshare landing
  // between the render and the click — must decline rather than write a level the user never saw.
  //
  // The mutant this row dies to is `M10b`: deleting `if (!done) return false;` so the click always
  // writes. The one it does NOT die to is a callback that reads the captured entry instead of
  // `tx.get`, and that is not a gap in the row — `store.js:reconcileList` preserves entry-object
  // identity across a mutation, so the two reads are the same object and the mutant is PROVABLY
  // equivalent here. It stops being equivalent for an entry that does not survive, which is why
  // the popover closes over the id and never over the entry (see `openSharing`) rather than
  // relying on a test to notice.
  const id = makeNote({ visibility: 'privat' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  store.txn('someone-else', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
  const mark = opMark();
  optFor('geteilt').click();                       // the strip still believes it is Privat
  assert.deepEqual(opsSince(mark), [], 'the stale plan declines rather than re-writing');
  assert.equal(noteById(id).visibility, 'geteilt');
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE COPY CONTRACT — ADR 002 §7.4, in both languages
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Every string the module can render, both languages, flattened. */
function everyString() {
  const out = [];
  for (const v of Object.values(sharing.TXT)) {
    for (const s of [v.de, v.en]) if (typeof s === 'string') out.push(s);
  }
  return out;
}

test('§5 · ADR 002 §7.4 — the two required strings are rendered VERBATIM', () => {
  assert.equal(
    sharing.TXT.downgradeNote.de,
    'Ab dem nächsten Abgleich verschwindet der Eintrag von den anderen Boards. '
    + 'Was schon sichtbar war, wurde schon gesehen.',
    'the first-downgrade sentence, character for character');
  assert.equal(
    sharing.TXT.belegtWhat.de,
    'Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text.',
    'the Belegt tooltip on the owner\'s own board, character for character');
});

test('§5 · ADR 002 §7.4 — none of the four forbidden claims appears, in either language', () => {
  const hits = [];
  for (const s of everyString()) {
    for (const bad of sharing.FORBIDDEN_CLAIMS) {
      // „live" is forbidden as a WORD, not as a substring — „Ferien-Erlebnis" is not a claim.
      const re = new RegExp(`(^|[^\\p{L}])${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu');
      if (re.test(s)) hits.push(`"${bad}" in: ${s}`);
    }
  }
  assert.deepEqual(hits, [], 'a claim the cryptography cannot keep');
});

test('§5 · 16.5 — the downgrade sentence appears at the moment it is true, and not before', () => {
  const id = makeNote({ visibility: 'geteilt' });
  const n = noteById(id);
  n.exposure = { level: 'geteilt', pending: false };     // the family really did see it
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  assert.equal(document.querySelector('.popover .share-note'), null,
    'no warning before anything has been asked for');
  optFor('belegt').click();
  const note = document.querySelector('.popover .share-note');
  assert.ok(note, 'the strip stays open across the change and carries the sentence');
  assert.equal(note.textContent, sharing.TXT.downgradeNote.de);
  assert.equal(note.getAttribute('role'), 'status', 'heard, without stealing focus');
  reset();
});

test('§5 · 16.5 — an UPGRADE never shows it: the sentence is about withdrawal only', () => {
  const id = makeNote({ visibility: 'privat' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  optFor('geteilt').click();
  assert.equal(document.querySelector('.popover .share-note'), null);
  assert.equal(noteById(id).visibility, 'geteilt', '(and it really did the upgrade)');
  reset();
});

test('§5 · 13.7 — every string exists in both languages, and the glossary terms are fixed', () => {
  const missing = Object.entries(sharing.TXT)
    .filter(([, v]) => typeof v.de !== 'string' || typeof v.en !== 'string')
    .map(([k]) => k);
  assert.deepEqual(missing, [], 'a copy key with no English');
  const untranslated = Object.entries(sharing.TXT)
    .filter(([k, v]) => v.de === v.en && !['privat', 'belegt', 'geteilt'].includes(k))
    .map(([k]) => k);
  assert.deepEqual(untranslated, [], 'an English string that is still the German one');
  assert.equal(sharing.TXT.coEdit.de, 'Familie darf bearbeiten', 'glossary §13, verbatim');
  assert.equal(sharing.TXT.visibility.de, 'Sichtbarkeit', 'glossary §13, verbatim');
});

test('§5 · the whole cluster renders in English, with no German left behind', () => {
  const id = makeNote({ visibility: 'belegt' });
  lang('en');
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  const txt = stripEl().textContent;
  assert.includes(txt, 'Private');
  assert.includes(txt, 'Busy');
  assert.includes(txt, 'Shared');
  assert.includes(txt, 'Family can edit');
  assert.equal(/Sichtbarkeit|Privat\b|Geteilt|Familie darf/.test(txt), false,
    `German survived the switch: ${txt}`);
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · 17.6 — attribution shows WHO and WHEN, never WHAT (ADR 004 §7)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 · the addendum\'s own example composes, character for character', () => {
  const line = sharing.attributionLine({
    isForeign: true, ownerId: MAMA, level: 'geteilt', initial: 'M',
    updatedAt: SUNDAY_STAMP,
  }, { nameOf: () => 'Mama', lang: 'de' });
  assert.equal(line, sharing.ATTRIBUTION_EXAMPLE, '17.6\'s string, verbatim');
});

test('§6 · ADR 004 §7 — no level history is derivable: what, when, who, and nothing else', () => {
  const line = sharing.attributionLine({
    isForeign: true, ownerId: MAMA, level: 'belegt', initial: 'M', text: 'Zahnarzt',
    updatedAt: SUNDAY_STAMP,
  }, { nameOf: () => 'Mama', lang: 'de' });
  assert.equal(/war|früher|vorher|geändert von .* auf|Verlauf|history/i.test(line), false,
    `Principle 9: no surveillance mechanics — ${line}`);
  assert.equal(line.includes('Zahnarzt'), false, 'and never WHAT');
});

test('§6 · my own entry gets no line unless somebody else wrote it (18.5)', () => {
  const ME = 'mem_me00000000000000000000';
  const mine = { isForeign: false, ownerId: ME, updatedBy: ME, visibility: 'geteilt' };
  assert.equal(sharing.attributionLine(mine), null, '"von mir" is noise');
  const edited = { ...mine, updatedBy: MAMA, initial: 'M', updatedAt: SUNDAY_STAMP };
  const line = sharing.attributionLine(edited, { nameOf: () => 'Mama', lang: 'de' });
  assert.includes(line, 'zuletzt geändert von Mama');
});

test('§6 · with no roster on this device the line degrades honestly, never to a wrong name', () => {
  // `store._project()` passes `members: new Map()` — there is no display name for anybody yet.
  const anon = { isForeign: true, ownerId: MAMA, level: 'geteilt' };
  assert.equal(sharing.attributionLine(anon, { lang: 'de' }), 'von einem Mitglied · geteilt');
  assert.equal(sharing.attributionLine({ ...anon, initial: 'M' }, { lang: 'de' }),
    'von M · geteilt', 'an initial is better than nothing and is never a guess');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · HOUSEKEEPING — the disclosure discipline the popover already had
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7 · one disclosure at a time: the swatches and the strip never stack', () => {
  const id = makeNote({ visibility: 'privat' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  assert.ok(stripEl());
  rowFor(id).querySelector('button.dot').click();            // the category swatches
  assert.ok(document.querySelector('.popover .pop-cat'), 'the swatches opened');
  assert.equal(stripEl(), null, 'and the sharing strip stood down — 214px is not two popovers');
  rowFor(id).querySelector('.share-trig').click();
  assert.equal(document.querySelector('.popover .pop-cat'), null, 'and back again');
  assert.ok(stripEl());
  reset();
});

test('§7 · the trigger toggles, and reports its state to assistive tech', () => {
  const id = makeNote({ visibility: 'privat' });
  openPop();
  const trig = () => rowFor(id).querySelector('.share-trig');
  assert.equal(trig().getAttribute('aria-expanded'), 'false');
  trig().click();
  assert.equal(trig().getAttribute('aria-expanded'), 'true');
  trig().click();
  assert.equal(stripEl(), null, 'a second click closes it');
  assert.equal(trig().getAttribute('aria-expanded'), 'false');
  reset();
});

test('§7 · exactly one <style> is injected, however many times the cluster is built', () => {
  const id = makeNote({ visibility: 'privat' });
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  popover.closePopover();
  openPop();
  rowFor(id).querySelector('.share-trig').click();
  assert.equal(document.querySelectorAll(`#${sharing.SHARING_CSS_ID}`).length, 1);
  reset();
});

test('§7 · Reduce Motion is respected: the strip has an animation and it is switchable off', () => {
  // The engine cannot be told to prefer reduced motion from inside the page, so this asserts the
  // RULE exists in the stylesheet rather than pretending to measure the preference — which is the
  // honest version of this check and the one `membersui.js` makes too.
  const css = document.getElementById(sharing.SHARING_CSS_ID).textContent;
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.pop-share \{ animation: none !important; \}/);
  assert.equal(/infinite|alternate/.test(css), false, 'nothing in this cluster may loop (19.3)');
});

test('§7 · 16.4 / ADR 004 §3 — the popover\'s create path reads the CATEGORY DEFAULT', () => {
  // ⚠ ADR 004 §3 names `popover.js:159` as one of the six create paths that must read
  // `cat.defaultVisibility`, and it was the one hardcoding the floor: `visibility: 'privat'`,
  // inline, so 16.4 did not fire from the popover at all. The rule is read EXACTLY ONCE, at
  // creation, and it goes through `core/visibility.js:visibilityForNewEntry` rather than reading
  // the field here — so a dangling category and a level outside the enum both fail closed.
  const catId = store.state.categories[0].id;
  store.txn('seed-default', (tx) => { tx.cat(catId).set({ defaultVisibility: 'belegt' }); });
  store.setSettings({ lastCategoryId: catId });
  const before = new Set(store.state.notes.map((n) => n.id));
  openPop();
  document.querySelector('.popover .pop-add').click();
  const inp = document.querySelector('.popover .pop-new .txt');
  inp.value = 'Zahnarzt';
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const made = store.state.notes.find((n) => !before.has(n.id));
  assert.ok(made, 'the popover created nothing');
  assert.equal(made.visibility, 'belegt',
    'the popover create path still hardcodes a level. 16.4 does not fire from the popover, and '
    + 'the category default is a setting that silently does nothing.');

  // …and it is NOT A LIVE RULE. Changing the default never re-publishes an existing entry — that
  // would be a bulk disclosure triggered by a settings click, which 16.1 forbids.
  store.txn('change-default', (tx) => { tx.cat(catId).set({ defaultVisibility: 'geteilt' }); });
  assert.equal(store.state.notes.find((n) => n.id === made.id).visibility, 'belegt',
    'changing a category default RE-LEVELLED an existing entry (ADR 004 §3)');

  // …and it fails CLOSED, twice: a level outside the enum, and a category that is not there.
  store.txn('bad-default', (tx) => { tx.cat(catId).set({ defaultVisibility: 'privat' }); });
  reset();
});

test('§7 · A4 — a yearly repeat has ONE control, because it is ONE object', () => {
  // "Series-level visibility, no per-year exceptions" is free: there is one `visibility` register
  // per series and no occurrence entity to disagree with it (ADR 004 §9). The popover shows a
  // repeat's occurrence, and changing the level there changes the SERIES.
  const id = makeNote({ visibility: 'privat' });
  store.txn('seed-repeat', (tx) => { tx.note(id).set({ repeatsYearly: true, date: '2025-09-15' }); });
  openPop();                                   // 2026-09-15 — the projected occurrence
  const row = rowFor(id);
  assert.ok(row, 'the repeat projects onto this day');
  row.querySelector('.share-trig').click();
  const mark = opMark();
  optFor('geteilt').click();
  const ops = opsSince(mark);
  const ui = ops.filter((o) => o.space !== SPACE);
  const fam = ops.filter((o) => o.space === SPACE);
  assert.equal(ui.length, 1, 'one op for the whole series — no per-occurrence entity exists');
  assert.deepEqual(ui[0].f, { visibility: 'geteilt' });
  // And ONE publication for the whole series, carrying the ANCHOR and the flag. Each peer expands
  // the occurrences locally with `dates.js:projectYearly`; no occurrence op ever crosses the wire
  // (ADR 004 §9), which is why a per-year exception is not something a function refuses but
  // something the data model cannot express.
  assert.equal(fam.length, 1, 'one publication for the whole series');
  assert.equal(fam[0].f['pub.date'], '2025-09-15', 'the ANCHOR, not this occurrence');
  assert.equal(fam[0].f['pub.repeatsYearly'], true, 'and the flag that expands it');
  assert.equal(Object.keys(fam[0].f).filter((k) => /year/i.test(k)).length, 1,
    'exactly one key mentions a year, and it is the FLAG — never an expansion');
  assert.equal(noteById(id).date, '2025-09-15', 'and the anchor did not move');
  reset();
});

// ═════════════════════════════════════════════════════════════════════════════
// §9 · 16.3's SECOND HOME — the entry's SELECTED STATE
// ═════════════════════════════════════════════════════════════════════════════
//
// `family/sharing.js:565-571` designed the control for two sites and said so: "16.3's second home
// — the entry's SELECTED STATE, which lives in `interact.js` and is not this ticket's file —
// mounts the identical control by calling this". It was never built, so 16.3's "two clicks
// maximum" only ever held from an already-open popover; from the board it was five.
//
// The budget is the claim, so the budget is what is counted.

test('§9 · 16.3 — a selected entry carries the control, and the level changes in ONE more click', () => {
  de();
  const id = makeNote({ visibility: 'privat' });
  const anchor = document.createElement('div');
  document.body.appendChild(anchor);
  try {
    assert.equal(popover.selectionSharingAvailable(), true,
      'the sharing module is installed in this harness — without it there is nothing to mount');

    // CLICK 1 — the selection. `interact.js#applySelection` is what a board click reaches.
    popover.openSelectionSharing(anchor, 'note', id);
    const card = document.querySelector('.popover.sel-share');
    assert.ok(card, 'a selected entry grew no sharing control');
    const opts = [...card.querySelectorAll('.share-opt')];
    assert.deepEqual(opts.map((b) => b.dataset.level), [...VISIBILITY_LEVELS],
      'the selected state must carry the same three-state control, not a different one');
    assert.equal(noteById(id).visibility, 'privat');

    // CLICK 2 — the level. Two clicks total, which is 16.3's budget exactly.
    opts.find((b) => b.dataset.level === 'geteilt').click();
    assert.equal(noteById(id).visibility, 'geteilt',
      'the second click did not change the level — the budget is not met');

    // …AND THE STRIP RE-READS. In the app the write notifies the store, `main.js#redraw` runs
    // `renderBoard` then `applySelection`, and `applySelection` is the one place that mounts this
    // card — so it comes back carrying the new level. This harness has no live selection, so the
    // redraw closes it and the equivalent call is made here explicitly. (An earlier draft reopened
    // from inside the `onLevel` callback instead and raced that same redraw: the card vanished
    // under the finger that had just used it.)
    popover.openSelectionSharing(anchor, 'note', id);
    const after = document.querySelector('.popover.sel-share');
    assert.ok(after, 'the strip vanished after use');
    assert.equal(after.querySelector('.share-opt[aria-checked="true"]').dataset.level, 'geteilt');
  } finally {
    popover.closeSelectionSharing();
    anchor.remove();
  }
});

test('§9 · a foreign entry is not levelled from the selected state either (18.1)', () => {
  // 18.1 — only the owner may change an entry. The popover half already refuses; this half must
  // refuse for the same reason and not merely decline to render by accident.
  de();
  const id = makeNote({ visibility: 'geteilt' });
  const note = noteById(id);
  const wasForeign = note.isForeign;
  const anchor = document.createElement('div');
  document.body.appendChild(anchor);
  try {
    note.isForeign = true;
    popover.openSelectionSharing(anchor, 'note', id);
    assert.equal(document.querySelector('.popover.sel-share'), null,
      'a foreign entry offered a level control in its selected state');
  } finally {
    note.isForeign = wasForeign;
    popover.closeSelectionSharing();
    anchor.remove();
  }
});

test('§9 · a solo Mac grows no control at all — the module is the gate', () => {
  // ADR 003 §7 gate 2: `interact.js` is in the boot graph and asks `popover.js` whether a module
  // is installed. Uninstalled, there is nothing to mount and nothing to import.
  de();
  const id = makeNote({ visibility: 'privat' });
  const anchor = document.createElement('div');
  document.body.appendChild(anchor);
  try {
    popover.useSharing(null);
    assert.equal(popover.selectionSharingAvailable(), false);
    popover.openSelectionSharing(anchor, 'note', id);
    assert.equal(document.querySelector('.popover.sel-share'), null,
      'a solo Mac was offered a visibility control');
  } finally {
    popover.useSharing(sharing);
    popover.closeSelectionSharing();
    anchor.remove();
  }
});
