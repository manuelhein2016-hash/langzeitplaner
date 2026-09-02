// TIER 2 · THE E9 DEMONSTRATION — two people, one co-editable bar, and it staying boring.
// Stories 18.1 · 18.2 · 18.3 · 18.4 · 18.5 · 18.6 · Principles 9 and 10 · PO decision D7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS NEXT TO `coedit.dom.js` AND `conflict.dom.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Those two each own one seam and each build the fixture that seam needs. `coedit.dom.js` writes
// synthetic foreign entries straight into the projection — correct for a file about the POINTER
// MACHINE, and it means its entries have no folded `pub.*` registers, so no write of theirs
// could ever be authored. `conflict.dom.js` builds a real circle but is about ONE cell and one
// line of copy.
//
// E9's acceptance is neither. It is the whole arc, in order, on ONE entity:
//
//     Papa shares a bar and ticks „Familie darf bearbeiten"
//       → Mama drags it            (18.2 — and the write is REAL, into the family space)
//       → Mama cannot drag his other entries        (18.1 — the grant is per entry)
//       → both edit it at once     (18.5 — per-field LWW, attribution moves, one quiet line)
//       → Papa deletes it          (18.6 — it leaves Mama's board)
//       → Papa's ⌘Z restores it    (18.6 — as a NEW shared op)
//       → Mama's ⌘Z never touches it                (18.4)
//       → the admin unshares one of MAMA's entries  (18.3 — reverts, is not deleted)
//
// ⚠ THIS MAC IS MAMA. Every other file in the tree runs as the owner and receives; this one runs
// as the CO-EDITOR and as the MODERATED OWNER, because both of those are the roles E9 added and
// neither had ever been driven end to end. Papa is a genuine peer: his own HLC, his own device,
// his own attestation, his ops built with the real `makeOp` and delivered through the real
// `store.applyRemote` — the same call the transport makes.
//
// ⚠ THE WRITES ARE REAL AND ARE ASSERTED ON THE LOG, NOT ON THE PIXELS. `store._log.lines()` is
// the log itself. A demonstration that only checked the board would pass over an implementation
// that moved the bar locally and published nothing, which is precisely the failure 18.2 had
// before the integration: the flag granted a permission whose write was unsealable.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const popover = await importApp('popover.js');
const sharing = await importApp('family/sharing.js');
const conflict = await importApp('family/conflict.js');
const i18n = await importApp('i18n.js');
const { makeOp } = await importApp('core/ops.js');
const { createClock } = await importApp('core/stamp.js');
const { familyKey } = await importApp('core/entities.js');
const { parseAttestationBlob } = await importApp('core/authz.js');
const { adminUnshareOp, projectForFamily } = await importApp('core/project.js');
const { canonicalJSON } = await importApp('core/canon.js');
const { b64u } = await importApp('core/b64.js');

popover.useSharing(sharing);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE CIRCLE — Papa the admin and owner, MAMA (this Mac) the co-editor
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_9876543210mkjihgfedcba';
const PAPA = 'mem_PPPPPPPPPPPPPPPPPPPPPP';
const PAPA_DEV = 'dev_PPPPPPPPPPPPPPPPPPPPPP';
const PAPA_SHORT = 'PPPPPPPPPPPPPPPP';

const utf8 = (s) => new TextEncoder().encode(s);
const blobFor = (att) => `${b64u(utf8(canonicalJSON(att)))}.${b64u(utf8('signature'))}`;

store.useFamilySpace(SPACE);
const ME = store.diagnostics().identity.memberId;          // ← this Mac is MAMA
const MY = store.diagnostics().identity;

// THE TEST IS THE DOOR (`sharing-control.dom.js`'s phrase). `authz.js` still compares all six
// ADR 002 §2.3 fields against `parseAttestationBlob`, so a shim that lied would be caught: it
// cannot smuggle in an attestation the log does not carry.
store.setAttestOpen((_m, b) => parseAttestationBlob(b));

store.apply('attestMyDevice', {
  deviceShort: MY.deviceShort,
  blob: blobFor({
    memberId: ME, deviceId: MY.deviceId, deviceShort: MY.deviceShort,
    sigPubRaw: b64u(utf8('mamasig')), kexPubRaw: b64u(utf8('mamakex')), createdAt: '2026-08-25',
  }),
});
store.apply('setMyProfile', { displayName: 'Mama', colorRef: 'palette-3' });

/**
 * ONE clock lead for every peer — `conflict.dom.js`'s finding, restated because this file would
 * have hit it too. `applyRemote` calls `_clock.observe(op.ts)`, so my HLC is dragged up to the
 * greatest stamp it has ever seen. With two different leads the smaller peer could never win a
 * race, and §3's „both at once" would be decided by the fixture instead of by the fold.
 */
const PEER_LEAD_MS = 60_000;

function peer(member, dev, short) {
  let n = 0;
  const clock = createClock(short, () => Date.now() + PEER_LEAD_MS);
  const ctx = {
    act: member, dev, gid: 'D'.repeat(22), space: 'personal', familySpaceId: SPACE,
    mint: () => clock.tick(), newOpId: () => `${short.slice(0, 2)}${String(++n).padStart(20, '0')}`,
  };
  return {
    member,
    op: (kind, e, f) => makeOp(ctx, kind, e, f, {}),
    ctx: () => ({ ...ctx, gid: 'D'.repeat(22) }),
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

const papa = peer(PAPA, PAPA_DEV, PAPA_SHORT);
{
  // Papa joins AND takes the genesis admin seat — 18.3 needs a real admin chain, not a flag.
  const ops = [...papa.joinOps('Papa', 'palette-1'),
    papa.op('space.set', `space:${SPACE}`, { admin: PAPA, adminPrev: null, name: 'Familie' })];
  const r = store.applyRemote(ops);
  if (r.applied.length !== 3) throw new Error(`the circle did not form: ${JSON.stringify(r)}`);
}
if (store.familyAdmin().admin !== PAPA) throw new Error('precondition: Papa must hold the seat');

const nameOf = (id) => ({ [PAPA]: 'Papa', [ME]: 'Mama' }[id] ?? null);

// ── event helpers — `interaction.dom.js`'s, which characterize v1's gestures ─────────────────
const at = (node, dx = 6, dy = 4) => {
  const r = node.getBoundingClientRect();
  return { clientX: r.left + dx, clientY: r.top + dy };
};
const ptr = (type, node, pos, target = node) =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, isPrimary: true, ...pos,
  }));
function drag(from, to) {
  const a = at(from);
  const b = at(to);
  ptr('pointerdown', from, a);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: a.clientX, clientY: a.clientY + 10 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, ...b }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, ...b }));
}
const dayNode = (date) => $(`.board .day[data-date="${date}"]`);
const barNode = (id) => $(`.board .bar[data-bar-id="${CSS.escape(id)}"]`);
const noteNode = (id) => $(`.board .note[data-note-id="${CSS.escape(id)}"]`);

const opMark = () => store._log.lines().length;
const opsSince = (m) => store._log.lines().slice(m).map((l) => l.op);
const settle = () => new Promise((r) => setTimeout(r, 2));
const de = () => i18n.setLang('de');
const en = () => i18n.setLang('en');

let seq = 0;
const mkId = () => `e9de${String(++seq).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;

/**
 * PAPA'S BAR, published the way his Mac would publish it: through the REAL `projectForFamily`,
 * from a truth object his device holds and mine never sees. Nothing here is hand-assembled — if
 * the projection would not emit a field, this fixture cannot either.
 */
function papaPublishesBar(uuid, { level = 'geteilt', coEdit = true, label, from, to }) {
  const truth = {
    visibility: level, startDate: from, endDate: to, label, coEdit,
    categoryId: 'papas-kategorie', _alive: true, _born: null,
  };
  const patch = projectForFamily('fbar', truth, level, null);
  return papa.op('pub.set', familyKey('fbar', PAPA, uuid), { ...patch });
}

const fbarKey = (uuid) => familyKey('fbar', PAPA, uuid);
const barOnBoard = (key) => store.state.bars.find((b) => b.id === key);

/** Install the real 18.5 watcher, run, and ALWAYS stop it — a stray watcher cascades. */
async function withWatch(fn, opts = {}) {
  const w = conflict.installConflictNotice({ store, nameOf, me: () => ME, ...opts });
  try { return await fn(w); } finally { w.stop(); }
}
const notice = () => $('.lzp-conflict');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · 18.2 — MAMA DRAGS PAPA'S CO-EDITABLE BAR, AND THE WRITE IS REAL
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('1a · the invited bar is on my board, editable, and the fold grants the write', async () => {
  de();
  const uuid = mkId();
  const r = store.applyRemote([papaPublishesBar(uuid, {
    label: 'Herbstferien Nordsee', from: '2026-10-05', to: '2026-10-19',
  })]);
  assert.equal(r.refused.length, 0, `Papa's publication was refused: ${JSON.stringify(r.refused)}`);
  await settle();

  const key = fbarKey(uuid);
  const e = barOnBoard(key);
  assert.ok(e, '17.1: Papa\'s shared bar must be on my board');
  assert.equal(e.isForeign, true);
  assert.equal(e.label, 'Herbstferien Nordsee', 'Geteilt carries the text (16.3)');
  assert.equal(e.coEdit, true, '18.2: „Familie darf bearbeiten" arrived with it');

  // THE CAPABILITY, from the authenticated fold and not from the projection's `coEdit` flag.
  assert.equal(store.familyCoEditLevelOf(key), 'geteilt',
    'the fold must grant the write, or the gesture has nowhere to go');
  assert.ok(barNode(key), 'and it is rendered');
});

test('1b · Mama DRAGS it — the bar moves, and one real family op is authored', async () => {
  de();
  const uuid = mkId();
  store.applyRemote([papaPublishesBar(uuid, {
    label: 'Sommerferien', from: '2026-11-02', to: '2026-11-16',
  })]);
  await settle();
  const key = fbarKey(uuid);
  const node = barNode(key);
  assert.ok(node, 'precondition: it is on the board');

  const mark = opMark();
  drag(node, dayNode('2026-11-05'));
  await settle();

  // ── THE BOARD ──────────────────────────────────────────────────────────────
  const after = barOnBoard(key);
  assert.notEqual(after.startDate, '2026-11-02', '18.2: the invited bar did not move');
  assert.equal(document.body.classList.contains('is-dragging'), false, 'the board is wedged');
  assert.equal($$('.drag-ghost').length, 0, 'a ghost was left floating');

  // ── THE LOG — what actually leaves this Mac ────────────────────────────────
  const ops = opsSince(mark);
  assert.equal(ops.length, 1, `a co-edit must be ONE op, got ${JSON.stringify(ops.map((o) => [o.k, o.e]))}`);
  const [op] = ops;
  assert.equal(op.k, 'pub.set', 'it is a family publication, not a truth write');
  assert.equal(op.e, key, 'addressed to PAPA\'s entity — ownership is structural (ADR 001 §4.4)');
  assert.equal(op.act, ME, 'and authored by me, which is what stage 3b judges');
  assert.equal(op.space, SPACE);
  assert.deepEqual(Object.keys(op.f).sort(), ['pub.endDate', 'pub.startDate'],
    'only the two co-editable fields — no governing field, no label I did not touch');

  // ⚠ NO TRUTH REGISTER. The entry is not mine; there is nothing of mine to move.
  assert.equal(store.registers().has(`bar:${uuid}`), false,
    'a co-edit minted a TRUTH register for somebody else\'s entity');
  // ⚠ AND NOTHING HALTED. This is the failure the integration existed to remove: before it,
  // `sealOp` refused the write and `redactionHalt` stopped ALL family sync from this Mac.
  assert.equal(store.redactionHalt, null, 'family publication halted — barrier 4 refused the write');
  assert.equal(store.familyOutbox().some((l) => l.op.id === op.id), true,
    'and the op really is queued for the family');
});

test('1c · 18.1 — Mama cannot drag any of Papa\'s OTHER entries', async () => {
  de();
  // The same owner, the same space, the same member colour. The ONLY difference is the flag.
  const plain = mkId();
  const belegt = mkId();
  store.applyRemote([
    papaPublishesBar(plain, { coEdit: false, label: 'Dienstreise', from: '2026-10-26', to: '2026-10-30' }),
    papaPublishesBar(belegt, { level: 'belegt', coEdit: false, label: 'Geheim', from: '2026-11-23', to: '2026-11-27' }),
  ]);
  await settle();

  for (const [why, uuid, startedAt] of [['no co-edit flag', plain, '2026-10-26'], ['Belegt', belegt, '2026-11-23']]) {
    const key = fbarKey(uuid);
    const node = barNode(key);
    assert.ok(node, `precondition: the ${why} bar is rendered`);
    assert.equal(store.familyCoEditLevelOf(key), null, `${why}: the fold must not grant it`);

    const mark = opMark();
    drag(node, dayNode('2026-12-01'));
    await settle();

    assert.equal(barOnBoard(key).startDate, startedAt, `${why}: it moved — 18.1 is the default`);
    assert.deepEqual(opsSince(mark), [], `${why}: it authored an op`);
    assert.equal(document.body.classList.contains('is-dragging'), false, `${why}: the board is wedged`);
  }
  assert.equal(store.redactionHalt, null);
});

test('1d · and 18.1\'s second verb — ⌫ never deletes a co-editable entry either', async () => {
  de();
  const uuid = mkId();
  store.applyRemote([papaPublishesBar(uuid, {
    label: 'Skifreizeit', from: '2027-05-03', to: '2027-05-07',
  })]);
  await settle();
  const key = fbarKey(uuid);
  // `pub.alive` is a GOVERNING register — stage 3a folds it from the owner alone — so a
  // co-editor's deletion is an op every honest device rejects. Refusing it here is what keeps
  // my board and everyone else's the same board.
  interact.clearSelection();
  const node = barNode(key);
  ptr('pointerdown', node, at(node));
  ptr('pointerup', node, at(node), window);
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...at(node) }));

  const mark = opMark();
  assert.equal(interact.deleteSelected(), false, '18.1: ⌫ must decline on somebody else\'s entry');
  assert.deepEqual(opsSince(mark), [], 'and author nothing');
  assert.ok(barOnBoard(key), 'and the bar is still there');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · 18.5 — BOTH AT ONCE. Per-field LWW, attribution moves, only the loser is told.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The race, driven the way it happens: I edit, my write is in flight, and Papa's newer write for
 * the SAME field arrives before mine is acknowledged. Nothing about the ordering is faked — his
 * op is stamped on his own HLC, `PEER_LEAD_MS` ahead of mine, and the fold decides.
 */
async function raceOnTheBar(lang) {
  lang();
  const uuid = mkId();
  store.applyRemote([papaPublishesBar(uuid, {
    label: 'Familienurlaub', from: '2026-12-07', to: '2026-12-21',
  })]);
  await settle();
  const key = fbarKey(uuid);

  return withWatch(async () => {
    // MY edit — a real drag, so the op enters the outbox through the product's own path.
    drag(barNode(key), dayNode('2026-12-09'));
    await settle();
    const mine = barOnBoard(key).startDate;
    assert.notEqual(mine, '2026-12-07', 'precondition: my drag landed');

    // PAPA'S, on the same field, newer. `pub.endDate` is deliberately NOT touched, so §2b can
    // show that per-field LWW keeps my other half.
    const his = store.applyRemote([papa.op('pub.set', key, { 'pub.startDate': '2026-12-14' })]);
    assert.equal(his.applied.length, 1, `Papa's op was refused: ${JSON.stringify(his.refused)}`);
    await settle();
    return { key, uuid };
  });
}

test('2a · DE — the later change wins the field, and I get ONE quiet line naming Papa', async () => {
  const { key } = await withWatch(async () => {
    de();
    const uuid = mkId();
    store.applyRemote([papaPublishesBar(uuid, {
      label: 'Familienurlaub', from: '2026-12-07', to: '2026-12-21',
    })]);
    await settle();
    const k = fbarKey(uuid);
    drag(barNode(k), dayNode('2026-12-09'));
    await settle();
    // A MOVE drags both endpoints (the duration is preserved), so MY write covered `pub.startDate`
    // AND `pub.endDate`. Papa's covers only the start. That is what makes this a per-field race
    // rather than a whole-entity one, and it is why the end date is read AFTER my drag: asserting
    // the ORIGINAL end date here would be asserting that my own gesture did nothing.
    const myEnd = barOnBoard(k).endDate;
    assert.notEqual(myEnd, '2026-12-21', 'precondition: my drag moved both endpoints');
    store.applyRemote([papa.op('pub.set', k, { 'pub.startDate': '2026-12-14' })]);
    await settle();
    await waitFor(() => notice() !== null, 2000);

    // ── requirement 1 · PER-FIELD LWW, and it is the fold's answer, not the notice's ─────────
    assert.equal(barOnBoard(k).startDate, '2026-12-14',
      'the later change must win the field it names');
    assert.equal(barOnBoard(k).endDate, myEnd,
      'PER-FIELD: MY end date must survive, because Papa never wrote that cell. A whole-entity '
      + 'LWW would have taken it with the start date, and the bar would have changed length');

    // ── requirement 2 · ATTRIBUTION MOVES (17.6) ─────────────────────────────────────────────
    assert.equal(barOnBoard(k).updatedBy, PAPA, '17.6: attribution must follow the winning write');

    // ── requirement 3 · ONE QUIET LINE, and it names WHO, never WHAT ─────────────────────────
    const line = notice();
    assert.ok(line, '18.5: the loser must be told');
    assert.match(line.textContent, /Papa/, 'it names the person');
    assert.match(line.textContent, /auch geändert/, 'and says we both did it');
    for (const forbidden of ['Konflikt', 'überschrieben', 'verworfen', '2026-12', 'startDate', 'Familienurlaub']) {
      assert.equal(line.textContent.includes(forbidden), false,
        `17.6 / Principle 10: the line must not say "${forbidden}" — who, never what`);
    }
    assert.equal($$('.lzp-conflict').length, 1, 'exactly one line');
    return { key: k };
  });
  assert.ok(key);
});

test('2b · EN — the same race, the same single line, in English', async () => {
  await withWatch(async () => {
    en();
    const uuid = mkId();
    store.applyRemote([papaPublishesBar(uuid, {
      label: 'Family holiday', from: '2027-01-04', to: '2027-01-18',
    })]);
    await settle();
    const k = fbarKey(uuid);
    drag(barNode(k), dayNode('2027-01-06'));
    await settle();
    store.applyRemote([papa.op('pub.set', k, { 'pub.startDate': '2027-01-11' })]);
    await settle();
    await waitFor(() => notice() !== null, 2000);

    const line = notice();
    assert.ok(line, 'the English half must exist too (13.7)');
    assert.match(line.textContent, /Papa/);
    assert.match(line.textContent, /changed this too/, 'the English sentence');
    assert.equal(/[äöüßÄÖÜ]|geändert|Konflikt/.test(line.textContent), false,
      '13.7: no German may leak into the English line');
  });
  de();
});

test('2c · Principle 10 — the notice is the ONLY conflict UI, and it presses nothing', async () => {
  await withWatch(async () => {
    de();
    const uuid = mkId();
    store.applyRemote([papaPublishesBar(uuid, {
      label: 'Wochenende', from: '2027-02-01', to: '2027-02-03',
    })]);
    await settle();
    const k = fbarKey(uuid);
    drag(barNode(k), dayNode('2027-02-02'));
    await settle();
    store.applyRemote([papa.op('pub.set', k, { 'pub.startDate': '2027-02-05' })]);
    await settle();
    await waitFor(() => notice() !== null, 2000);

    const line = notice();
    // The addendum's design note: "one line, inline, dismisses itself". Asserted as ABSENCE.
    assert.equal(line.children.length, 0, 'it has child elements — it is becoming a widget');
    assert.equal(line.querySelectorAll('button, a, input, select, textarea').length, 0,
      'Principle 10: nothing to press. A conflict is not a decision the user has to make');
    assert.equal(getComputedStyle(line).pointerEvents, 'none', 'it cannot even be clicked');
    assert.equal(line.getAttribute('role'), 'status', 'polite, never an alert');
    assert.equal(line.getAttribute('aria-live'), 'polite');
    assert.equal(document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]').length, 0,
      'a modal appeared — 18.5 says inline');
    assert.equal(line.textContent.split('\n').filter((s) => s.trim()).length, 1, 'ONE line');

    // ── Principle 10, the whole of it: the board is not a messenger ───────────────────────
    const doc = document.body.textContent;
    for (const word of ['Kommentar', 'comment', 'Antwort', 'reply', 'gelesen', 'read receipt',
      'online', 'tippt', 'typing', 'Reaktion', 'reaction', 'Chat', 'Nachricht']) {
      assert.equal(doc.includes(word), false,
        `Principle 10: the board must never grow a "${word}" surface`);
    }
  });
});

test('2d · ONLY the loser — the WINNER of the same race is told nothing', async () => {
  // The structural half: the ledger's only input is MY OWN outbox. Here Papa's write arrives
  // FIRST and mine lands after it, so mine wins — and there must be no line at all.
  await withWatch(async () => {
    de();
    const uuid = mkId();
    store.applyRemote([papaPublishesBar(uuid, {
      label: 'Elternabend', from: '2027-03-01', to: '2027-03-02',
    })]);
    await settle();
    const k = fbarKey(uuid);

    store.applyRemote([papa.op('pub.set', k, { 'pub.startDate': '2027-03-03' })]);
    await settle();
    drag(barNode(k), dayNode('2027-03-08'));       // mine, and it is newer
    await settle();
    await sleep(120);

    assert.notEqual(barOnBoard(k).startDate, '2027-03-03', 'precondition: my write won');
    assert.equal(notice(), null, '18.5: the WINNER must not be told anything');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · 18.6 — PAPA DELETES IT, AND HIS ⌘Z RESTORES IT AS A NEW SHARED OP
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('3a · Papa\'s deletion propagates: the bar leaves MY board', async () => {
  de();
  const uuid = mkId();
  store.applyRemote([papaPublishesBar(uuid, {
    label: 'Abgesagt', from: '2027-04-05', to: '2027-04-09',
  })]);
  await settle();
  const key = fbarKey(uuid);
  assert.ok(barOnBoard(key), 'precondition: it is on my board');

  store.applyRemote([papa.op('pub.set', key, { 'pub.alive': false })]);
  await settle();

  assert.equal(barOnBoard(key), undefined, '18.6: deletions propagate to all boards');
  assert.equal(barNode(key), null, 'and it is off the pixels too');
});

test('3b · his ⌘Z restores it as a NEW shared op — and my board gets it back', async () => {
  de();
  const uuid = mkId();
  store.applyRemote([papaPublishesBar(uuid, {
    label: 'Doch wieder da', from: '2027-04-19', to: '2027-04-23',
  })]);
  await settle();
  const key = fbarKey(uuid);
  store.applyRemote([papa.op('pub.set', key, { 'pub.alive': false })]);
  await settle();
  assert.equal(barOnBoard(key), undefined, 'precondition: it is gone');

  // 18.6: "my undo of my own deletion restores the entry as a NEW SHARED OPERATION". On the
  // wire that is exactly what it looks like — another `pub.set`, at a newer stamp, from him.
  const restore = papa.op('pub.set', key, { 'pub.alive': true });
  const r = store.applyRemote([restore]);
  assert.equal(r.applied.length, 1, `the restore was refused: ${JSON.stringify(r.refused)}`);
  await settle();

  assert.ok(barOnBoard(key), '18.6: even destructive acts stay reversible for their author');
  assert.equal(barOnBoard(key).label, 'Doch wieder da', 'and it comes back whole');
});

test('3c · 18.4 — MY ⌘Z never touches his entry, in either direction', async () => {
  de();
  const uuid = mkId();
  store.applyRemote([papaPublishesBar(uuid, {
    label: 'Nicht meins', from: '2027-06-07', to: '2027-06-11',
  })]);
  await settle();
  const key = fbarKey(uuid);

  // A remote arrival must not have put anything on my stack. `store.js:applyRemote` — "rule U2 /
  // story 18.4: touches NEITHER stack and never clears redo".
  const depth = store.undoStack.length;
  const redo = store.redoStack.length;
  store.applyRemote([papa.op('pub.set', key, { 'pub.startDate': '2027-06-09' })]);
  await settle();
  assert.equal(store.undoStack.length, depth, '18.4: a peer\'s change entered MY undo stack');
  assert.equal(store.redoStack.length, redo, 'and it cleared my redo');

  // And an undo of something else of mine must not disturb his entry.
  const mineId = mkId();
  store.apply('createNoteInline', {
    id: mineId, date: '2027-06-21', text: 'Meins', categoryId: store.state.categories[0].id,
  });
  await settle();
  const before = { ...barOnBoard(key) };
  store.undo();
  await settle();
  assert.equal(store.state.notes.some((n) => n.id === mineId), false, 'precondition: my undo worked');
  assert.equal(barOnBoard(key).startDate, before.startDate,
    '18.4: my ⌘Z moved somebody else\'s entry');
  assert.equal(barOnBoard(key).label, before.label);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · 18.3 — THE ADMIN UNSHARES ONE OF MAMA'S ENTRIES
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SECRET = 'Scheidungsanwalt 14:30';

test('4a · it reverts to owner-private ON MY MACHINE, and is NOT deleted', async () => {
  de();
  const uuid = mkId();
  store.apply('createNoteInline', {
    id: uuid, date: '2026-12-24', text: 'Bescherung 18:00',
    categoryId: store.state.categories[0].id,
  });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  await settle();
  const fkey = familyKey('fnote', ME, uuid);
  assert.equal(store.registers().get(fkey).get('pub.level').value, 'geteilt',
    'precondition: it really is shared');

  // PAPA, the admin, moderates it. Built by the shipped `adminUnshareOp` — arity 2, and there is
  // no parameter through which content could enter.
  const mod = adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid });
  const r = store.applyRemote([mod]);
  assert.equal(r.refused.length, 0, `the moderation was refused: ${JSON.stringify(r.refused)}`);
  await settle();

  // ── IT REVERTS ─────────────────────────────────────────────────────────────
  assert.equal(store.registers().get(fkey).get('pub.level').value, 'privat',
    '18.3: the family must no longer hold it');
  assert.equal(store.registers().get(`note:${uuid}`).get('visibility').value, 'privat',
    'ADR 004 §5: the owner\'s own visibility must follow, or her next keystroke re-publishes it');

  // ── IT IS NEVER DELETED ────────────────────────────────────────────────────
  const still = store.state.notes.find((n) => n.id === uuid);
  assert.ok(still, '18.3: moderation is non-destructive — the entry stays on the owner\'s board');
  assert.equal(still.text, 'Bescherung 18:00', 'in full, and unchanged');
  assert.equal(still.visibility, 'privat', 'now owner-private');
  assert.ok(noteNode(uuid), 'and still rendered');

  // ── AND IT NOTIFIES NOBODY (Principle 9 / ADR 004 §7) ──────────────────────
  assert.equal(notice(), null, 'a moderation must never surface as a lost-edit notice');
  const doc = document.body.textContent;
  for (const w of ['entfernt', 'Verwalter hat', 'moderiert', 'removed by']) {
    assert.equal(doc.includes(w), false, `Principle 9: no „X made an entry private" notice ("${w}")`);
  }
});

test('4b · the owner\'s NEXT edit does not silently undo the moderation', async () => {
  // Without ADR 004 §5's follow-up this is where 18.3 quietly failed: `derivePublication` reads
  // the level from `visibility` and `lastPublished` from the folded `pub.level`, so after a
  // moderation those disagree and the very next keystroke re-publishes the whole Geteilt patch.
  de();
  const uuid = mkId();
  store.apply('createNoteInline', {
    id: uuid, date: '2026-12-27', text: 'Konzert', categoryId: store.state.categories[0].id,
  });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  await settle();
  const fkey = familyKey('fnote', ME, uuid);

  store.applyRemote([adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid })]);
  await settle();
  assert.equal(store.registers().get(fkey).get('pub.level').value, 'privat', 'precondition');

  store.apply('editNoteInline', { id: uuid, text: 'Konzert — verschoben' });
  await settle();

  assert.equal(store.registers().get(fkey).get('pub.level').value, 'privat',
    'the owner\'s next keystroke re-shared a moderated entry');
  assert.equal(store.registers().get(fkey).get('pub.text').value, null,
    'and it put the text back on the wire');
});

test('4c · the admin never reads what was never shared — ZERO family bytes for a Privat entry', () => {
  // 18.3's third clause, and 16.1's structural guarantee behind it. A Privat entry produces NO
  // family op at all — not a redacted one, not an empty one. So there is nothing for an admin to
  // moderate and nothing for a relay to hold. Asserted on the LOG, which is what reaches the wire.
  de();
  const uuid = mkId();
  const mark = opMark();
  store.apply('createNoteInline', {
    id: uuid, date: '2026-12-30', text: SECRET, categoryId: store.state.categories[0].id,
  });

  const family = opsSince(mark).filter((o) => o.space === SPACE);
  assert.deepEqual(family, [], '16.1: a Privat entry must emit ZERO family ops');

  // …and no register anywhere in the family half carries the string.
  let leaked = null;
  for (const [key, cells] of store.registers()) {
    if (!key.startsWith('fnote:') && !key.startsWith('fbar:')) continue;
    for (const [f, cell] of cells) {
      if (typeof cell?.value === 'string' && cell.value.includes(SECRET)) leaked = `${key}.${f}`;
    }
  }
  assert.equal(leaked, null, `a Privat entry's text reached a family register at ${leaked}`);

  // The whole family outbox — every byte this Mac would hand the relay — is free of it.
  const outbound = JSON.stringify(store.familyOutbox().map((l) => l.op));
  assert.equal(outbound.includes(SECRET), false, 'the Privat text is in the family outbox');
});

test('4d · the moderation op itself carries no content — a withdrawal, not a message', async () => {
  de();
  const uuid = mkId();
  store.apply('createNoteInline', {
    id: uuid, date: '2026-11-11', text: 'Nur für die Familie',
    categoryId: store.state.categories[0].id,
  });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  await settle();

  const mod = adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid });
  // Every field is either the literal `privat` or an explicit `null` (ADR 004 §5.1, INV-R4).
  assert.equal(mod.f['pub.level'], 'privat');
  for (const [f, v] of Object.entries(mod.f)) {
    if (f === 'pub.level') continue;
    assert.equal(v, null, `the retraction carries a value at ${f} — it must only withdraw`);
  }
  assert.equal(JSON.stringify(mod).includes('Nur für die Familie'), false,
    '18.3: the admin\'s op must not carry the text it is withdrawing');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE STANDING RESULT — the redaction boundary is where E9 could have broken it
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ⚠ THE PREDICATE IS „NEVER SHARED", NOT „PRIVAT NOW" — and the difference is a real one that
// this row got wrong on its first run. §4 moderates an entry that WAS legitimately Geteilt, so
// its text is in the family half by design and stays there; `UNSHARE_COPY.honesty` says so out
// loud („Was schon sichtbar war, wurde schon gesehen"). A sweep over „everything privat now"
// would therefore flag a correct product, which is the worst kind of leak test: one that has to
// be argued down. So the oracle is a SET THIS FILE CONTROLS — strings written into entries that
// were created Privat and never shared at all.
const NEVER_SHARED = [];

test('5a-seed · entries that are created Privat and never shared, for the sweep below', () => {
  de();
  for (const [text, date] of [
    ['Scheidungsanwalt 14:30', '2027-07-06'],
    ['Bewerbungsgespräch 11:00', '2027-07-13'],
    ['Therapie', '2027-07-20'],
  ]) {
    const id = mkId();
    store.apply('createNoteInline', {
      id, date, text, categoryId: store.state.categories[0].id,
    });
    NEVER_SHARED.push(text);
    assert.equal(store.state.notes.find((n) => n.id === id).visibility, 'privat',
      '16.1: creating an entry never shares it (Principle 8)');
  }
  assert.equal(NEVER_SHARED.length, 3);
});

test('5a · after the whole arc, not one NEVER-SHARED byte is anywhere in the family half', () => {
  // E9 added WRITE paths into the family space — a co-editor's `pub.set` and an admin's
  // retraction — which is exactly where a leak would appear. This sweeps the finished state
  // across all three places a byte could hide.
  assert.ok(NEVER_SHARED.length > 0, 'non-vacuity: there ARE private entries to leak');

  const familyOps = store._log.lines().map((l) => l.op).filter((o) => o.space === SPACE);
  assert.ok(familyOps.length > 10, `non-vacuity: the family half is populated (${familyOps.length} ops)`);
  const onTheWire = JSON.stringify(familyOps);

  let inRegisters = '';
  for (const [key, cells] of store.registers()) {
    if (!key.startsWith('fnote:') && !key.startsWith('fbar:')) continue;
    for (const [, cell] of cells) {
      if (typeof cell?.value === 'string') inRegisters += `\u0000${cell.value}`;
    }
  }
  const inOutbox = JSON.stringify(store.familyOutbox().map((l) => l.op));

  for (const text of NEVER_SHARED) {
    assert.equal(onTheWire.includes(text), false,
      `a never-shared entry reached a family OP: ${JSON.stringify(text)}`);
    assert.equal(inRegisters.includes(text), false,
      `a never-shared entry reached a family REGISTER: ${JSON.stringify(text)}`);
    assert.equal(inOutbox.includes(text), false,
      `a never-shared entry is in the family OUTBOX: ${JSON.stringify(text)}`);
  }
  assert.equal(store.redactionHalt, null, 'and publication never halted');
});

test('5b · every co-edit this file authored wrote ONLY co-editable fields', () => {
  // D7's fold, checked against what this Mac actually emitted: a co-editor can never have
  // written a governing field, because `projectCoEditPatch` has no door for one.
  const mine = store._log.lines().map((l) => l.op)
    .filter((o) => o.k === 'pub.set' && o.act === ME
      && (o.e.startsWith(`fbar:${PAPA}/`) || o.e.startsWith(`fnote:${PAPA}/`)));
  assert.ok(mine.length >= 3, `non-vacuity: this file authored co-edits, got ${mine.length}`);
  for (const o of mine) {
    for (const f of Object.keys(o.f)) {
      assert.equal(['pub.level', 'pub.coEdit', 'pub.alive', '_born'].includes(f), false,
        `a co-editor wrote the governing field ${f} on ${o.e}`);
    }
  }
});
