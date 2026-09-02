// TIER 2 · THE LOST-EDIT NOTICE — deliverable 23 · story 18.5 · LZP-904.
// ADR 004 §8, §7, §4.1 · ADR 001 §4.0, §4.2b, §4.3, §5, §6 · ADR 002 §2.3, §7.4 · Principles 9, 10.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THIS FILE DRIVES A GENUINE RACE, NOT A RENDERED FIXTURE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `family-attribution.dom.js` and `belegt-render.dom.js` assign materialized arrays, for the
// reason they both state: at the time they were written no device in this tree could RECEIVE a
// foreign entry, so the materialized entry was the seam they owned. That is no longer true, and
// 18.5 is not a rendering story — it is a story about what happens when two people write the same
// cell. A fixture cannot fail the way this ticket can fail. So §0 below builds a real, fully
// authorised two-member circle inside the running app:
//
//   · a real Familienkreis (`store.useFamilySpace`), a real note created through `store.apply`,
//     a real Geteilt level and a real co-edit flag written through `store.txn` — so the family
//     publication is DERIVED by the store's own publisher, not hand-assembled;
//   · a real device attestation for BOTH members (ADR 002 §2.3), because `authz.js` stage 0b
//     rejects `unattestedDevice` and a fixture that skipped it would be testing nothing;
//   · Mama's ops built with the real `makeOp` on her own HLC, delivered through the real
//     `store.applyRemote` — the same call the transport makes.
//
// Every one of those was needed: the probe run that established this setup was refused three
// times in a row — `unattestedDevice`, then `notMember` for Mama, then `notMember` for ME,
// because ADR 001 §4.2b's per-space membership requires the entity's OWNER to be a member of the
// space too. The final arrival is `applied`, and `pub.text` genuinely changes hands.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE ASSERTIONS ARE ABOUT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   §1  the race itself, both languages, and 17.6's attribution moving with it (requirement 2)
//   §2  "the notice is the ONLY conflict UI in the product" — asserted as the ABSENCE of the
//       four things the addendum's design note rules out, on the real element
//   §3  it costs the board nothing: the rendered geometry is identical with the line on screen
//   §4  it dismisses itself
//   §5  ONLY THE LOSER — four silences, each a state change the fold accepts
//   §6  the copy contract, swept in both languages

const { store } = await importApp('store.js');
const conflict = await importApp('family/conflict.js');
const sharing = await importApp('family/sharing.js');
const i18n = await importApp('i18n.js');
const { makeOp } = await importApp('core/ops.js');
const { createClock } = await importApp('core/stamp.js');
const { familyKey } = await importApp('core/entities.js');
const { parseAttestationBlob } = await importApp('core/authz.js');
const { canonicalJSON } = await importApp('core/canon.js');
const { b64u } = await importApp('core/b64.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · a real two-member circle
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_0123456789abcdefghijkm';
const MAMA = 'mem_MMMMMMMMMMMMMMMMMMMMMM';
const MAMA_DEV = 'dev_MMMMMMMMMMMMMMMMMMMMMM';
const MAMA_SHORT = 'HHHHHHHHHHHHHHHH';
const OMA = 'mem_NNNNNNNNNNNNNNNNNNNNNN';
const OMA_DEV = 'dev_NNNNNNNNNNNNNNNNNNNNNN';
const OMA_SHORT = 'JJJJJJJJJJJJJJJJ';
/**
 * ONE DAY ROW PER NOTE, and it is not tidiness.
 *
 * Every note in this file lives on `2026-09-15` in the first draft, and from the fourth test on
 * the board stopped rendering them: v1's capacity slice and „+n" overflow (stories 2.4, 3.8,
 * `layout.js:209`) had taken over, `anchorFor` found nothing, and the notice correctly declined
 * to appear — a green module failing a red suite for the right reason. The dates are spread so
 * the thing under test is the race and not the lane cap, which `e8-density-*.dom.js` owns.
 */
let day = 2;
const nextDate = () => `2026-09-${String((day = day + 1)).padStart(2, '0')}`;

const utf8 = (s) => new TextEncoder().encode(s);
const blobFor = (att) => `${b64u(utf8(canonicalJSON(att)))}.${b64u(utf8('signature'))}`;

store.useFamilySpace(SPACE);
const ME = store.diagnostics().identity.memberId;
const MY_DEV = store.diagnostics().identity;

// THE TEST IS THE DOOR, exactly as `sharing-control.dom.js` puts it. In the product this verifier
// is `family/engine.js:buildAttestOpen`, which checks each blob against its member's recovery
// signing key; here the blobs are hand-signed, so the shim answers with the blob's own parse.
// `authz.js` still compares all six ADR 002 §2.3 fields against `parseAttestationBlob`, so a shim
// that lied would be caught — it cannot smuggle in an attestation the log does not carry.
store.setAttestOpen((_m, b) => parseAttestationBlob(b));

const MY_BLOB = blobFor({
  memberId: ME, deviceId: MY_DEV.deviceId, deviceShort: MY_DEV.deviceShort,
  sigPubRaw: b64u(utf8('mysig')), kexPubRaw: b64u(utf8('mykex')), createdAt: '2026-08-25',
});
store.apply('attestMyDevice', { deviceShort: MY_DEV.deviceShort, blob: MY_BLOB });
store.apply('setMyProfile', { displayName: 'Papa', colorRef: 'palette-1' });

/**
 * How far ahead of this Mac the peers' wall clocks run.
 *
 * ⚠ IT IS ONE NUMBER FOR EVERY PEER, AND THAT IS LOAD-BEARING. `applyRemote` calls
 * `_clock.observe(op.ts)` on every arrival, so an HLC is dragged up to the greatest stamp it has
 * ever seen and then STAYS there while real time catches up. Give Mama +4 s and Oma +5 s and the
 * circle's own join ops push MY clock to +5 s — after which every op I author outranks anything
 * Mama can mint at +4 s, and she can never win a race. Measured: her `pub.set` landed 933 ms
 * BEHIND a note I had created after it, and the fold correctly kept mine.
 *
 * With ONE lead the arithmetic is right for the right reason: my clock freezes at
 * `t_join + LEAD` and only counters move, while each peer op is stamped `t_now + LEAD` with
 * `t_now > t_join`. So a peer op minted after my edit is genuinely newer — which is what
 * "near-simultaneously, and hers landed second" means — and my own later edit still beats hers,
 * because observing her stamp lifts me to her millisecond and my counter goes one further (§5b).
 */
const PEER_LEAD_MS = 60_000;

/** A peer: her own HLC, her own device, her own op ids. Nothing here is mine. */
function peer(member, dev, short) {
  let n = 0;
  const clock = createClock(short, () => Date.now() + PEER_LEAD_MS);
  const ctx = {
    act: member, dev, gid: 'C'.repeat(22), space: 'personal', familySpaceId: SPACE,
    mint: () => clock.tick(), newOpId: () => `${short.slice(0, 2)}${String(++n).padStart(20, '0')}`,
  };
  return {
    member,
    op: (kind, e, f) => makeOp(ctx, kind, e, f, {}),
    /** The two ops that make her a real, attested member of this circle. */
    joinOps(name, color) {
      const att = blobFor({
        memberId: member, deviceId: dev, deviceShort: short,
        sigPubRaw: b64u(utf8(`sig${short}`)), kexPubRaw: b64u(utf8(`kex${short}`)),
        createdAt: '2026-08-25',
      });
      return [
        makeOp(ctx, 'member.set', `member:${member}`, { [`dev.${short}`]: att }, {}),
        makeOp(ctx, 'member.set', `member:${member}`, { displayName: name, colorRef: color }, {}),
      ];
    },
  };
}

const mama = peer(MAMA, MAMA_DEV, MAMA_SHORT);
const oma = peer(OMA, OMA_DEV, OMA_SHORT);
{
  const r = store.applyRemote([...mama.joinOps('Mama', 'palette-3'), ...oma.joinOps('Oma', 'palette-5')]);
  if (r.applied.length !== 4) throw new Error(`the circle did not form: ${JSON.stringify(r)}`);
}

/** 17.6's roster port — the same one `sharing.js:attributionLine` takes. */
const nameOf = (id) => ({ [MAMA]: 'Mama', [OMA]: 'Oma', [ME]: 'Papa' }[id] ?? null);

let seq = 0;
const mkId = () => `cf${String(++seq).padStart(6, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;

/** A real, shared, co-editable note of MINE. Returns its uuid. */
async function coEditableNote(text = 'Zahnarzt 9 Uhr', date = nextDate()) {
  const id = mkId();
  store.apply('createNoteInline', {
    id, date, text, categoryId: store.state.categories[0].id, visibility: 'geteilt',
  });
  store.txn('seed-coedit', (tx) => { tx.note(id).set({ coEdit: true }); });
  await settle();
  return id;
}

const fkeyOf = (uuid, owner = ME) => familyKey('fnote', owner, uuid);
const noteOnBoard = (uuid) => store.state.notes.find((n) => n.id === uuid);
const notice = () => $('.lzp-conflict');
const noticeText = () => (notice() ? notice().textContent : null);

/**
 * Install the real watcher, run the body, and ALWAYS stop it.
 *
 * A watcher is a live `store.subscribe`, so one left behind by a red row goes on evaluating for
 * the rest of the file and puts a line on somebody else's screen. That is a cascade — the first
 * failure invents four more — and it cost this file one debugging round before the `finally`
 * existed. The injected `now` is what lets §5e close ADR 004 §8's 30-second window without
 * waiting half a minute.
 */
async function withWatch(fn, { now = () => Date.now(), schedule, unschedule } = {}) {
  const w = conflict.installConflictNotice({ store, nameOf, me: () => ME, now, schedule, unschedule });
  try { return await fn(w); } finally { w.stop(); }
}

const de = () => i18n.setLang('de');
const en = () => i18n.setLang('en');

/**
 * Let the store's publish microtask run.
 *
 * ADR 001 §0.9 forbids an `await` above `emit()`, so `store.js` mints the family publication of a
 * local edit in a `queueMicrotask` AFTER the emit. In the product that microtask has run long
 * before a peer's op arrives over the network. In a synchronous test body it has NOT — and the
 * consequence is not cosmetic: `applyRemote` calls `_clock.observe(op.ts)`, which drags my HLC up
 * to the peer's stamp, so the still-pending publication is then minted NEWER than her write and
 * my own projection wins a race I was supposed to lose. Measured, not guessed: without this the
 * register kept `Zahnarzt 9 Uhr` at my device short with a counter above hers.
 */
const settle = () => new Promise((r) => setTimeout(r, 2));

/** Drive one race end to end and return the watcher, so a test can inspect and stop it. */
function race(uuid, from, text, w) {
  const op = from.op('pub.set', fkeyOf(uuid), { 'pub.text': text });
  const r = store.applyRemote([op]);
  if (!r.applied.includes(op.id)) throw new Error(`the peer's op was refused: ${JSON.stringify(r.refused)}`);
  return w;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · the race
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('1a · DE — my in-flight edit loses, and I get one quiet line naming the winner', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    // MY EDIT, through the real mutation. It enters the outbox, and the watcher harvests it on the
    // emit that mutation causes — which is the whole in-flight mechanism, unfaked.
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    assert.equal(w.ledger.size(), 1, 'my edit is in flight');

    race(uuid, mama, 'Zahnarzt 10 Uhr', w);

    assert.ok(notice(), 'the loser is told');
    assert.equal(noticeText(), 'Mama hat das gerade auch geändert — die neuere Änderung gilt.');
    // …and the fold really did move, which is what the line is about.
    assert.equal(noteOnBoard(uuid).text, 'Zahnarzt 10 Uhr', 'later wins, per field');
    assert.equal(w.ledger.size(), 0, 'the row is retired, so the line cannot fire twice');
  });
});

test('1b · EN — the same race, the same one line', async () => {
  en();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Dentist 9am' });
    await settle();
    race(uuid, mama, 'Dentist 10am', w);
    assert.equal(noticeText(), 'Mama changed this too just now — the newer change stands.');

    de();
  });
});

test('1c · requirement 2 — attribution updates (17.6), and it is not this module that moved it', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    const before = sharing.attributionLine(noteOnBoard(uuid), { nameOf, lang: 'de' });
    assert.equal(before, null, 'while the entry is only mine there is nothing to attribute');

    race(uuid, mama, 'Zahnarzt 10 Uhr', w);

    const entry = noteOnBoard(uuid);
    assert.equal(entry.updatedBy, MAMA, 'the winning register carries the winner');
    const after = sharing.attributionLine(entry, { nameOf, lang: 'de' });
    assert.match(after, /^zuletzt geändert von Mama/, '17.6 now reads as changed by the winner');
  });
});

test('1d · the notice is ONE line, and only ever one of it', async () => {
  de();
  await withWatch(async (w) => {
    const a = await coEditableNote('A');
    const b = await coEditableNote('B');
    store.apply('editNoteInline', { id: a, text: 'A2' });
    store.apply('editNoteInline', { id: b, text: 'B2' });
    await settle();
    race(a, mama, 'A3', w);
    race(b, oma, 'B3', w);
    assert.equal($$('.lzp-conflict').length, 1, 'a second race REPLACES the line, never stacks');
    assert.equal(noticeText(), 'Oma hat das gerade auch geändert — die neuere Änderung gilt.');
    assert.ok(!noticeText().includes('\n'), 'one line');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · "the notice is the ONLY conflict UI in the product" — asserted as absence
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('2a · no dialog, no merge view, no history pane, no badge — on the real element', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    const n = notice();
    assert.ok(n, 'precondition: the line is up');

    // The four things the addendum's design note rules out.
    assert.equal($$('dialog').length, 0, 'no dialog anywhere in the document');
    assert.equal(n.querySelectorAll('button, a, input, select, textarea, [role="button"]').length, 0,
      'no control — Principle 10: the board is not a messenger, so this may not become a conversation');
    assert.equal(n.children.length, 0, 'one text node; a merge view would need children');
    assert.equal(getComputedStyle(n).pointerEvents, 'none', 'it is not even clickable');
    // Not an alert: `alert`/`assertive` is a screen-reader modal, which is the dialog by another door.
    assert.equal(n.getAttribute('role'), 'status');
    assert.equal(n.getAttribute('aria-live'), 'polite');
    // No badge and no counter survives it: once it goes, the document holds nothing about the race.
    w.stop();
    assert.equal($$('.lzp-conflict').length, 0, 'stopping removes it and leaves no mark');
  });
});

test('2b · it never says the word — „Konflikt" is nowhere in the product\'s rendered text', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    const body = document.body.textContent;
    for (const word of ['Konflikt', 'conflict', 'überschrieben', 'overwritten']) {
      assert.ok(!body.includes(word), `the board says "${word}"`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · zero pixel cost — the board is the feature, and a rare event may not cost it a row
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('3a · the notice displaces nothing: every day row is where it was', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    const geom = () => $$('#board .col').map((c) => {
      const r = c.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    }).join('|');
    const before = geom();
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    const n = notice();
    assert.ok(n, 'precondition: the line is up');
    assert.equal(geom(), before, 'the board did not move by a single pixel');
    assert.equal(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, true,
      'and it introduced no horizontal overflow of its own');
    // THE STRUCTURAL HALF, and it is the one that catches the tempting implementation. Appending
    // the line INTO the day row costs the board a row — v1's principle 1 is that density is the
    // feature — and it does not necessarily move a column rect, so the geometry check alone lets
    // it through. It is not in the board at all, and it is laid out over the page.
    assert.ok(!$('#board').contains(n), 'the line is not a child of the board');
    assert.equal(getComputedStyle(n).position, 'fixed', 'it is laid out over the board, never in it');
  });
});

test('3b · it is anchored to the entry, inside the board — not a banner', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    const n = notice().getBoundingClientRect();
    const anchor = $(`#board [data-note-id="${CSS.escape(uuid)}"]`).getBoundingClientRect();
    const wrap = $('#board-wrap').getBoundingClientRect();
    assert.ok(Math.abs(n.top - anchor.bottom) < 60, `the line sits at the entry (Δ ${Math.round(n.top - anchor.bottom)}px)`);
    assert.ok(n.left >= wrap.left - 1 && n.right <= wrap.right + 1, 'and stays inside the board area');
    assert.ok(n.width <= 320, `one line, not a banner (${Math.round(n.width)}px)`);
  });
});

test('3c · no anchor, no notice — an inline notice with nothing to be inline to is a banner', async () => {
  de();
  // AN ENTRY OUTSIDE THE ROLLING TWELVE MONTHS. The first draft deleted the entry's node instead,
  // which proved nothing: `applyRemote` emits, `board.js` rebuilds the whole DOM, and the node was
  // back before `evaluate()` looked for it. A date the board does not cover is the honest version
  // of "the entry is not on screen", and it is the common one — the user scrolls.
  const uuid = await coEditableNote('Weit weg', '2028-03-11');
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Weit weg' });
    await settle();
    assert.equal($(`#board [data-note-id="${CSS.escape(uuid)}"]`), null, 'precondition: off the board');
    race(uuid, mama, 'Weit weg, geändert', w);
    assert.equal(notice(), null, 'silence, and not a floating banner');
    assert.equal(w.ledger.size(), 0, 'the row is retired all the same — silent, not pending');
  });
});

test('3d · a board-wrap with no size is not "scrolled away" — the window is the fallback', async () => {
  de();
  // FOUND IN A REAL BROWSER, not here. `.board-wrap` is `flex: 1; min-height: 0`, so in a tab the
  // browser has never given a height it measures 0 × 0 — and the first version of `placeNotice`
  // read that as "the entry is outside the board's viewport" and refused every notice. The anchor
  // had a perfectly good rect the whole time. `display: none` reproduces the same degenerate rect.
  const uuid = await coEditableNote();
  const wrap = $('#board-wrap');
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    const anchorRect = $(`#board [data-note-id="${CSS.escape(uuid)}"]`).getBoundingClientRect();
    assert.ok(anchorRect.height > 0, 'precondition: the entry itself has a real rect');
    // Zero-sized, but NOT `display: none`: the entry has to keep a real rect while the wrap loses
    // its own. That is the shape the real browser produced, and it is the shape the bug needs —
    // with `display: none` the anchor's rect collapses too and every bounds test passes trivially.
    const before = wrap.getAttribute('style');
    wrap.style.cssText = 'flex:none;width:0;height:0;overflow:visible';
    try {
      assert.equal(wrap.getBoundingClientRect().width, 0, 'precondition: the wrap has no size');
      assert.ok($(`#board [data-note-id="${CSS.escape(uuid)}"]`).getBoundingClientRect().height > 0,
        'precondition: and the entry still does');
      race(uuid, mama, 'Zahnarzt 10 Uhr', w);
      assert.ok(notice(), 'the line still appears; a zero-size wrap is no answer, not a refusal');
    } finally {
      if (before === null) wrap.removeAttribute('style'); else wrap.setAttribute('style', before);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · it dismisses itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('4a · one line, six seconds, gone — with no click anywhere', async () => {
  de();
  const uuid = await coEditableNote();
  // A fake scheduler, so the six seconds are asserted rather than waited for.
  const jobs = [];
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    assert.ok(notice(), 'precondition: the line is up');
    assert.equal(jobs.length, 1, 'exactly one timer — nothing loops, nothing polls');
    assert.equal(jobs[0].ms, conflict.NOTICE_MS);
    jobs[0].fn();                                     // the six seconds elapse
    assert.ok(notice().classList.contains('is-going'), 'it fades rather than blinking out');
    jobs[1].fn();                                     // the fade completes
    assert.equal(notice(), null, 'and it is gone, with nothing left behind');
  }, {
    schedule: (fn, ms) => { jobs.push({ fn, ms }); return jobs.length; },
    unschedule: () => {},
  });
});

test('4b · a board redraw under the line repositions it instead of killing it', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    assert.ok(notice(), 'precondition');
    // `board.js` rebuilds the whole DOM on every emit, so the anchor node this line was placed
    // against is replaced. A cached anchor would have a zero rect and the line would vanish.
    store.emit('sync');
    assert.ok(notice(), 'the line survives an unrelated redraw');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · ONLY THE LOSER — five silences
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('5a · a third party is told nothing — the winner and every bystander see no line', async () => {
  de();
  // I am the bystander here: Mama edits an entry I never touched. My ledger has no row for that
  // cell, so `displacedBy` is never asked and there is nothing to construct a notice from.
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    assert.equal(w.ledger.size(), 0, 'nothing of mine was in flight');
    assert.equal(notice(), null, 'a notice here would be a surveillance mechanic (Principle 9)');
    assert.equal(noteOnBoard(uuid).text, 'Zahnarzt 10 Uhr', 'the board still converges, quietly');
  });
});

test('5b · the WINNER is told nothing — my newer edit beats hers in silence', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    // Her write first, mine second and newer. I win; there is nothing to say to anybody.
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 8 Uhr' });
    await settle();
    assert.equal(noteOnBoard(uuid).text, 'Zahnarzt 8 Uhr');
    assert.equal(notice(), null);
  });
});

test('5c · 18.3 — an ADMIN UNSHARE produces no line. ADR 004 §7 forbids that message by name', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    // The shape of an unshare: `pub.level: 'privat'` with every content field nulled, one op.
    // (`store.familyAdmin()` is not resolvable in this fixture, so it is refused at stage 3a — the
    // assertion below therefore holds for BOTH the admitted and the refused reading, which is what
    // makes it a safe row: no path exists on which this becomes a notice.)
    store.applyRemote([mama.op('pub.set', fkeyOf(uuid), { 'pub.level': 'privat', 'pub.text': null })]);
    assert.equal(notice(), null, 'moderation is not a lost edit, and is never announced');
    assert.equal(noteOnBoard(uuid).text, 'Zahnarzt 9 Uhr', '18.3: never deleted, and my board stays right');
  });
});

test('5d · 18.6 — a remote deletion produces no line; the answer to a deletion is ⌘Z', async () => {
  de();
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    store.applyRemote([mama.op('pub.set', fkeyOf(uuid), { 'pub.alive': false })]);
    assert.equal(notice(), null);
    assert.equal(w.ledger.size(), 1, 'my content edit is still in flight; nothing displaced it');
  });
});

test('5e · an edit older than 30 s is not in flight — history is 17.6\'s job, not a notice', async () => {
  de();
  let t = 1_000_000;
  const uuid = await coEditableNote();
  await withWatch(async (w) => {
    store.apply('editNoteInline', { id: uuid, text: 'Zahnarzt 9 Uhr' });
    await settle();
    assert.equal(w.ledger.size(), 1);
    t += conflict.IN_FLIGHT_MS;                     // ADR 004 §8's window closes
    race(uuid, mama, 'Zahnarzt 10 Uhr', w);
    assert.equal(notice(), null, 'past the window the change is history, and history is attribution');
    assert.equal(noteOnBoard(uuid).text, 'Zahnarzt 10 Uhr', 'the fold moved regardless');
  }, { now: () => t });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · the copy contract, both languages
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('6a · every string the module can render, in both languages, against both lists', async () => {
  const strings = [];
  for (const lang of ['de', 'en']) {
    for (const pair of Object.values(conflict.TXT)) strings.push(pair[lang]);
    strings.push(conflict.lostLine('Mama', lang));
    strings.push(conflict.lostLine(conflict.nameOf(MAMA, () => null, lang), lang));
  }
  assert.ok(strings.length >= 8, `only ${strings.length} strings — the sweep stopped working`);
  for (const s of strings) {
    for (const c of sharing.FORBIDDEN_CLAIMS) {
      assert.ok(!s.toLowerCase().includes(c.toLowerCase()), `ADR 002 §7.4 forbids "${c}": ${s}`);
    }
    for (const d of conflict.FORBIDDEN_DRAMA) {
      assert.ok(!s.toLowerCase().includes(d.toLowerCase()), `"${d}" makes it an event: ${s}`);
    }
  }
  de();
});
