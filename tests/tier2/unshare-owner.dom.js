// TIER 2 · F-SHELL-3 / residual R-1 — WHAT THE OWNER'S MAC DOES WITH A MODERATION **AFTER SHE
// HAS QUIT AND REOPENED THE APP**.
// Story 18.3 · ADR 001 §4.1 (the admin chain), §4.3 stage 3a · ADR 004 §5, §5.1 · ADR 006 (the
// spine) · `core/authz.js:foldAuthorized` · `store.js#_absorbedAttestOps` · `shell-macos/
// main.swift#runTestFile`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS BESIDE `unshare-ui.dom.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `unshare-ui.dom.js` §5 and §6 already drive a real store, a real remote admin and the real
// `adminUnshareOp`, and they assert the whole of 18.3 on the owner's own board — "it reverts to
// owner-private, it is never deleted" — and they are GREEN in this same WebKit engine. The
// shipped app fails that promise in every measured run of `scripts/shell-family-e2e.mjs`
// (`unshare-owner (B)`, tier-2 row §10: 10 of 10 before the last pass, and again at HEAD
// `78016e8`). ONE thing separates the two:
//
//     **`unshare-ui.dom.js` never reboots the store. The shipped app is nothing but reboots** —
//     the driver is 26 launches, and the owner quits between sharing her entry and the admin
//     moderating it, because that is what a person does with a laptop.
//
// So this file is that file's §5 with `await store.init()` in the middle. Everything else is
// held constant on purpose.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MECHANISM — and it is NOT in `family/sharing.js`, which is where R-1 assigns it
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `core/authz.js:1404` (stage 3a) admits an admin's `pub.set` on an entity he does not own only
// if `adminAtKey(spaceKey(op.space), op.ts)` names him. That query reads the chain stage 1 built
// — and stage 1 builds it **from `space.set{admin, adminPrev}` OPS in the fold's input, never
// from registers** (`authz.js:1234-1255`).
//
// A checkpoint ABSORBS ops. After one reboot the owner's `_log.ops()` no longer contains the
// genesis link (§3 measures it), while her `space:<id>` register still carries `admin` and
// `store.familyAdmin()` (a register read, `store.js#familyAdmin`) answers correctly. The chain the FOLD
// can see is empty, `adminAtKey` returns `null`, and the retraction is REJECTED `notOwner` at
// `authz.js:1405`. A rejection is final: the op never becomes a line, so it is re-refused on
// every later launch — the single `notOwner` in the acceptance run's refusal ledger.
//
// This is `F-SHELL-1(b)` one register over. `store.js#_absorbedAttestOps` rebuilds the absorbed
// `member.set{dev.*}` ops from their register cells for precisely this reason; nothing rebuilds
// the absorbed `space.set{admin}` link. §4 proves that is the whole of it, in this file, with no
// change to `src/`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — READ BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   §1  NON-VACUITY   no reboot → it reverts, whole. This engine can do 18.3.
//   §2  ✅ CLOSED      one reboot → the retraction lands, the entry reverts, her text survives.
//   §3  ✅ CLOSED      the mechanism, both halves: the LOG is still emptied of `space.set` lines
//                     by the checkpoint (non-vacuity), and the reconstruction refills the FOLD
//                     with exactly one genesis link, so `adminAtKey` answers the admin.
//   §4  the constructive proof: ONE reconstructed link admits the very same op — and the store's
//                     own `_absorbedChainOps()` is that op, field for field.
//   §5  ✅ CLOSED      it was NEVER a delete — her entry, text and tombstone were always intact;
//                     the reversion now lands too.
//   §6  Principle 9 survives it: nothing on her screen names the admin, before or after.
//   §7  the flush the `--test` runner used not to call. `shell-macos/main.swift#runTestFile`
//                     now awaits `window.__lzpFlush` before `exit()`, with the same 2 s watchdog
//                     `applicationShouldTerminate` uses. This row owns the half a PAGE can see —
//                     the flush exists and writes `board.json`; the half a page cannot see (that
//                     the shell calls it) is `tests/tier1/headless-shell.test.js`.
//
// THE REPAIR, AND WHERE IT WENT (landed this pass). `store.js` has an `_absorbedChainOps()`
// beside `_absorbedAttestOps()` — same shape, same discipline, spread into the same three fold
// inputs (`_refoldAuthorized`, `applyRemote`, `unparkAttested`) — rebuilding ONE `space.set{admin,
// adminPrev:null}` op per family space out of the `space:<id>` → `admin` cell, with `dev` read
// back out of `devOf(cell.stamp)` and the author's own member record. §4 builds that op here and
// asserts the store's copy equals it.
//
// RESIDUAL, NOT CLOSED: only a GENESIS-shaped link is rebuilt (`cell.author === cell.value`). A
// circle whose admin seat has been TRANSFERRED still breaks after compaction. No shipped circle
// transfers the seat.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// MUTANTS — one run each, scratch copy of `src/`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-1  `authz.js:1405` — `const who = adminAtKey(spaceKey(op.space), op.ts) ?? op.act;`
//        i.e. let a missing chain mean "whoever asked". MEASURED, in a scratch copy: **§2, §4 and
//        §5 die and §1, §3, §6, §7 stand** — and §4 dies because a NON-ADMIN's retraction lands
//        too, which is why the shortcut is a mutant and not a fix. `unshare-ui.dom.js` and
//        `e9-attack-moderation.test.js` are UNMOVED under it: neither reboots, so the link is
//        still a line and the `??` never fires. That gap is what this file exists to close.
//   M-2  §4's reconstruction with this Mac's own device instead of the one the stamp names.
//        MEASURED, in a scratch copy: **§4 dies ALONE, 6 of 7 still green.** Stage 0b
//        (`authz.js:1223`) refuses the rebuilt LINK `unattestedDevice`, the chain stays empty,
//        and §4 dies with the very `notOwner` it set out to remove — which is why the repair
//        reads `devOf(cell.stamp)` back out of the author's own member record.
//   CONTROL, with `src/` untouched: every row below is green, and so is `unshare-ui.dom.js`
//   (26/26) — which is the file this one is a reboot of.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const { store } = await importApp('store.js');
const { makeOp } = await importApp('core/ops.js');
const { createClock, devOf } = await importApp('core/stamp.js');
const { familyKey } = await importApp('core/entities.js');
const { adminUnshareOp } = await importApp('core/project.js');
const { foldAuthorized, REJECT_REASONS, parseAttestationBlob } = await importApp('core/authz.js');
const { canonicalJSON } = await importApp('core/canon.js');
const { b64u } = await importApp('core/b64.js');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · one circle, in this page: me (the OWNER) and Papa (the admin), through the real ops
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SPACE = 'fsp_abcdefghijklmnopqrstuv';
const PAPA = `mem_${'P'.repeat(22)}`;
const PAPA_DEV = `dev_${'P'.repeat(22)}`;
const PAPA_SHORT = 'PAPAPAPAPAPAPAPA';

const utf8 = (s) => new TextEncoder().encode(s);
const blobFor = (att) => `${b64u(utf8(canonicalJSON(att)))}.${b64u(utf8('signature'))}`;

store.useFamilySpace(SPACE);
const ME = store.diagnostics().identity.memberId;
const MY = store.diagnostics().identity;

store.setAttestOpen((_m, b) => parseAttestationBlob(b));
store.apply('attestMyDevice', {
  deviceShort: MY.deviceShort,
  blob: blobFor({
    memberId: ME, deviceId: MY.deviceId, deviceShort: MY.deviceShort,
    sigPubRaw: b64u(utf8('mysig')), kexPubRaw: b64u(utf8('mykex')), createdAt: '2026-08-25',
  }),
});
store.apply('setMyProfile', { displayName: 'Mama', colorRef: 'palette-3' });

/**
 * Papa: his own HLC, his own device, his ops through the real `makeOp` and `applyRemote`.
 *
 * ⚠ TWO CLOCKS, AND THE OLD ONE IS THE WHOLE FIXTURE. A founder creates the circle BEFORE the
 * joiner's Mac has ever run, so his genesis ops are older than everything on her disk — and
 * `store.js`'s checkpoint horizon (`resolveHorizon(…, 'read')` = `horizon ?? maxLiveStamp()`) is
 * exactly that boundary: ops at or below it are absorbed into the register map and dropped from
 * `ops.jsonl`. Stamping the circle's formation an hour ago is therefore not a convenience, it is
 * the ONE fact that makes this file a reproduction of `unshare-owner (B)` rather than a
 * variation on `unshare-ui.dom.js`. The MODERATION is stamped forward, as a live op is.
 */
const mkPapa = (skewMs, tag) => {
  let n = 0;
  const clock = createClock(PAPA_SHORT, () => Date.now() + skewMs);
  const ctx = {
    act: PAPA, dev: PAPA_DEV, gid: 'D'.repeat(22), space: 'personal', familySpaceId: SPACE,
    mint: () => clock.tick(), newOpId: () => `${tag}${String(++n).padStart(20, '0')}`,
  };
  return { ctx: () => ({ ...ctx }), op: (k, e, f) => makeOp(ctx, k, e, f, {}) };
};
const papaThen = mkPapa(-3_600_000, 'ol');   // the circle was formed an hour before this Mac woke
const papa = mkPapa(60_000, 'un');           // and the moderation happens now

const PAPA_ATT = blobFor({
  memberId: PAPA, deviceId: PAPA_DEV, deviceShort: PAPA_SHORT,
  sigPubRaw: b64u(utf8('sigP')), kexPubRaw: b64u(utf8('kexP')), createdAt: '2026-08-25',
});

{
  const r = store.applyRemote([
    papaThen.op('member.set', `member:${PAPA}`, { [`dev.${PAPA_SHORT}`]: PAPA_ATT }),
    papaThen.op('member.set', `member:${PAPA}`, { displayName: 'Papa', colorRef: 'palette-1' }),
    papaThen.op('space.set', `space:${SPACE}`, { admin: PAPA, adminPrev: null, name: 'Familie' }),
  ]);
  if (r.applied.length !== 3) throw new Error(`the circle did not form: ${JSON.stringify(r)}`);
}

let seq = 0;
const mkId = () => `own${String(++seq).padStart(4, '0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const settle = () => sleep(30);

/** Create one of MY notes and share it — the shipped mutation, then the shipped plan. */
async function shared(date, text) {
  const uuid = mkId();
  store.apply('createNoteInline', {
    id: uuid, date, text, categoryId: store.state.categories[0].id,
  });
  store.txn('share', (tx) => tx.note(uuid).set({ visibility: 'geteilt' }));
  await settle();
  return { uuid, key: familyKey('fnote', ME, uuid) };
}

/**
 * QUIT AND REOPEN — the move `scripts/shell-family-e2e.mjs` makes 26 times and no other tier-2
 * file makes at all. `persistNow()` then `init()` is the shell's own boot: `board.json` is
 * re-migrated into the ADR 006 spine, `checkpoint.json` is read back, and `ops.jsonl` is the only
 * history that survives. (`retrofit-probe5.dom.js` uses the same two calls for the same reason.)
 */
async function reboot() {
  await store.persistNow();
  await store.init();
  store.emit('init');
  await settle();
}

/** What this Mac folds for one of my notes: the truth registers and the family ones. */
const truthOf = (uuid) => {
  const c = store.registers().get(`note:${uuid}`);
  return c ? Object.fromEntries([...c.entries()].map(([f, cell]) => [f, cell.value])) : null;
};
const pubOf = (key) => {
  const c = store.registers().get(key);
  return c ? Object.fromEntries([...c.entries()].map(([f, cell]) => [f, cell.value])) : null;
};
const noteOf = (uuid) => store.state.notes.find((n) => n && n.id === uuid) || null;

/** `store.applyRemote`'s own fold input on this Mac — see `store.js#applyRemote`, minus the arriving batch. */
const foldInput = () => [
  ...store._absorbedAttestOps(),
  ...store._absorbedChainOps(),
  ...store._log.ops({ includeParked: true }),
];

/**
 * The fold input as it stood BEFORE `store.js#_absorbedChainOps` landed. §4 needs it to keep both
 * arms of its contrast: with the repair in `src/` the ordinary input already carries the link, and
 * comparing a set against itself proves nothing.
 */
const foldInputWithoutChain = () => [
  ...store._absorbedAttestOps(),
  ...store._log.ops({ includeParked: true }),
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · NON-VACUITY — with no reboot, 18.3 holds in this engine
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 · NON-VACUITY · with no reboot the moderation reverts her entry to Privat, whole', async () => {
  const a = await shared('2027-03-03', 'Bescherung 18:00');
  const r = store.applyRemote([adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: a.uuid })]);
  await settle();

  assert.deepEqual(r.refused, [], `the retraction was refused: ${JSON.stringify(r.refused)}`);
  assert.equal(pubOf(a.key)['pub.level'], 'privat', 'the retraction did not fold');
  assert.equal(pubOf(a.key)['pub.text'], null, 'the text was not withdrawn (INV-R4)');

  const mine = noteOf(a.uuid);
  assert.ok(mine, 'IT IS NEVER DELETED: the note must still be on her board');
  assert.equal(mine.text, 'Bescherung 18:00', 'her text is hers and always was');
  assert.equal(mine.visibility, 'privat', 'the owner-side follow-up did not run');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · ⛔ F-SHELL-3(a), OPEN — one reboot, and the same op is refused
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 · CLOSED · after a reboot the same retraction still lands, and her entry reverts', async () => {
  const b = await shared('2027-03-10', 'Elternabend');
  assert.equal(pubOf(b.key)['pub.level'], 'geteilt', 'precondition: it is published');

  await reboot();                                   // ← the one line, and the whole finding

  assert.equal(pubOf(b.key)['pub.level'], 'geteilt',
    'the reboot lost the publication itself — that would be a different defect');

  const op = adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: b.uuid });
  const r = store.applyRemote([op]);
  await settle();

  // INVERTED by `store.js#_absorbedChainOps`. It used to read `r.refused.length === 1` with
  // `REJECT_REASONS.NOT_OWNER`, and that one refusal was the whole of the shipped app's ledger.
  assert.deepEqual(r.refused, [],
    `the admin's retraction is still refused on the owner's Mac: ${JSON.stringify(r.refused)}`);

  assert.equal(pubOf(b.key)['pub.level'], 'privat',
    'the entry did not revert to Privat after the reboot');
  assert.equal(noteOf(b.uuid).visibility, 'privat',
    'the owner is still publishing an entry the admin took out of the circle');
  assert.equal(noteOf(b.uuid).text, 'Elternabend',
    'her text did not survive the retraction — that would be the data loss R-1 alleged');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · ⛔ THE MECHANISM — the chain the FOLD sees, against the chain the STORE reports
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · CLOSED · the reboot still empties the LOG, and the reconstruction refills the FOLD', () => {
  // NON-VACUITY FIRST: the absorption is unchanged and still total. If a `space.set` line ever
  // survives compaction, this row would go green for the other reason and test nothing.
  assert.deepEqual(store._log.ops({ includeParked: true }).filter((o) => o.k === 'space.set'), [],
    'a `space.set` line survived the reboot — the absorption this row is about did not happen, '
    + 'so the reconstruction below is not being tested');

  const ops = foldInput();
  // The attestation half of the same defect IS repaired, and `_absorbedAttestOps` is why. Without
  // this line every row here would fail at stage 0b for a reason that is not the chain.
  assert.ok(ops.some((o) => o.k === 'member.set' && /^dev\./.test(Object.keys(o.f)[0] || '')),
    'the attestation reconstruction did not fire — then stage 0b, not the chain, is what refuses');

  // INVERTED: `store.js#_absorbedChainOps` puts exactly ONE genesis-shaped link back per space.
  const links = ops.filter((o) => o.k === 'space.set');
  assert.equal(links.length, 1, `the fold's input carries ${links.length} chain links, not one`);
  assert.equal(links[0].act, PAPA, 'the rebuilt link is not authored by the admin');
  assert.deepEqual(links[0].f, { admin: PAPA, adminPrev: null },
    'the rebuilt link is not the genesis-shaped one §4.1 roots the chain at');

  // The checkpoint DID keep the register, and the store reads it correctly.
  assert.equal(store.registers().get(`space:${SPACE}`).get('admin').value, PAPA,
    'the checkpoint lost the admin register too — then this is a different defect');
  assert.equal(store.familyAdmin().admin, PAPA,
    '`store.familyAdmin()` disagrees with the register it reads');

  // And the fold, over the very same log, cannot see it.
  const verdict = foldAuthorized(ops, store._authzCtx());
  // INVERTED: `adminAtKey` — the function stage 3a asks — now answers the admin, not `null`.
  assert.deepEqual(verdict.adminChainOf(SPACE).map((o) => o.id), [links[0].id],
    'the fold did not resolve the reconstructed link as the chain');
  assert.equal(verdict.adminOfSpace(SPACE), PAPA,
    'the fold still names no admin, so `adminAtKey` still answers null and §2 cannot pass');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE CONSTRUCTIVE PROOF — one rebuilt link, and the SAME op is admitted
//
// Nothing in `src/` changes here. The link is rebuilt in this file out of the register cell the
// checkpoint kept — `{value, stamp, author, op}` — and handed to `foldAuthorized` as an ordinary
// op, which pays every barrier again. Admitted with it, rejected without it: the absorbed link IS
// the defect, and the repair is a store-side sibling of `_absorbedAttestOps`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4 · handing the fold ONE reconstructed `space.set` link admits the very same retraction', async () => {
  const c = await shared('2027-03-17', 'Zahnarzt 9 Uhr');
  await reboot();
  const op = adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: c.uuid });

  const regs = store._log.registers();
  const cell = regs.get(`space:${SPACE}`).get('admin');
  // The device the link was authored on is the last sixteen characters of its stamp
  // (`stamp.js`), and the author's own member record maps that short to a deviceId. Nothing is
  // invented: an unmatched short leaves `dev` null and stage 0b refuses it — mutant M-2.
  const short = devOf(cell.stamp);
  let dev = null;
  for (const [name, cl] of regs.get(`member:${cell.author}`) || []) {
    if (!/^dev\./.test(name) || !cl || typeof cl.value !== 'string') continue;
    const att = parseAttestationBlob(cl.value);
    if (att && att.deviceShort === short) { dev = att.deviceId; break; }
  }
  assert.equal(dev, PAPA_DEV, 'the authoring device could not be resolved out of the author\'s record');

  const rebuilt = Object.freeze({
    v: 1,
    id: cell.op,
    ts: cell.stamp,
    space: SPACE,
    act: cell.author,
    dev,
    gid: cell.op,
    k: 'space.set',
    e: `space:${SPACE}`,
    f: Object.freeze({ admin: cell.value, adminPrev: null }),
  });
  assert.equal(rebuilt.act, PAPA, 'the register does not name the admin as its own writer');

  // AND THE SHIPPED RECONSTRUCTION IS THIS ONE, FIELD FOR FIELD. This row builds the link by hand
  // to prove the mechanism; `store.js#_absorbedChainOps` now builds it in `src/`, and the two must
  // be the same op or the proof is about something the product does not do.
  const shipped = store._absorbedChainOps();
  assert.equal(shipped.length, 1, `the store rebuilt ${shipped.length} chain links, not one`);
  assert.deepEqual({ ...shipped[0] }, { ...rebuilt },
    'the store\'s reconstruction is not the one this row proves admissible');

  const ops = foldInputWithoutChain();
  const without = foldAuthorized([...ops, op], store._authzCtx());
  const withLink = foldAuthorized([rebuilt, ...ops, op], store._authzCtx());

  const before = without.rejectionOf(op.id);
  assert.ok(before, 'the retraction was not rejected without the link — §2 must be stale');
  assert.equal(before.reason, REJECT_REASONS.NOT_OWNER);

  assert.equal(withLink.rejectionOf(op.id), null,
    `one reconstructed link did not admit it: ${JSON.stringify(withLink.rejectionOf(op.id))}`);
  assert.deepEqual(withLink.adminChainOf(SPACE).map((o) => o.id), [rebuilt.id],
    'the reconstructed link is not the accepted chain');
  assert.equal(withLink.regs.get(c.key).get('pub.level').value, 'privat',
    'the retraction was admitted and still did not set the level');

  // AND IT IS NOT A SKELETON KEY. A NON-admin's identical patch is still refused beside it.
  const oma = (() => {
    const clock = createClock('ZMAZMAZMAZMAZMAZ', () => Date.now() + 60_000);   // Crockford: no I L O U
    return {
      act: `mem_${'O'.repeat(22)}`, dev: `dev_${'O'.repeat(22)}`,
      gid: 'E'.repeat(22), space: 'personal', familySpaceId: SPACE,
      mint: () => clock.tick(), newOpId: () => 'om00000000000000000001',
    };
  })();
  const hostile = adminUnshareOp(oma, { kind: 'fnote', owner: ME, uuid: c.uuid });
  const verdict = foldAuthorized([rebuilt, ...ops, hostile], store._authzCtx());
  const no = verdict.rejectionOf(hostile.id);
  assert.ok(no, 'a non-admin\'s retraction was admitted alongside the rebuilt link');
  assert.equal(verdict.regs.get(c.key).get('pub.level').value, 'geteilt',
    'a non-admin moved the level with the rebuilt link in the fold');

  // AND AN EMPTY CHAIN REFUSES EVERYONE — the whole reason the repair must REBUILD the link
  // rather than let a missing chain mean "whoever asked" (mutant M-1). This is a security
  // property of `adminAtKey`'s null, not an inconvenience.
  const noLink = foldAuthorized([...ops, hostile], store._authzCtx());
  assert.ok(noLink.rejectionOf(hostile.id),
    'with an EMPTY chain a non-admin\'s retraction was admitted — null is being read as "anyone"');
  assert.equal(noLink.regs.get(c.key).get('pub.level').value, 'geteilt',
    'a non-admin moved the level on a Mac whose chain the checkpoint had absorbed');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · ⛔ WHAT ACTUALLY REACHES THE PERSON — and R-1's own wording, corrected
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§5 · CLOSED · it was never a delete — and the reversion now lands too', async () => {
  // `docs/v2/V2-FINAL.md` R-1 and `FINDINGS.md` §21d both say the retraction "arrives as a
  // DELETION". It does not, and nothing in this product can make it one: the patch is `pub.*`
  // only, `pub.alive` is NULLED rather than set false, and the admin cannot address her personal
  // space at all (`core/project.js:750-760`). What is lost is the REVERSION.
  const d = await shared('2027-03-24', 'Impftermin');
  await reboot();
  store.applyRemote([adminUnshareOp(papa.ctx(), { kind: 'fnote', owner: ME, uuid: d.uuid })]);
  await settle();

  const t = truthOf(d.uuid);
  assert.equal(t.text, 'Impftermin', 'her text is gone — then it IS a delete and R-1 is right');
  assert.equal(t._alive, true, 'her entry was tombstoned');
  assert.ok(noteOf(d.uuid), 'the entry left her board');
  assert.ok($$('.board .note').length > 0, 'the board drew nothing at all');
  // INVERTED: `visibility` follows the retraction now that it is admitted.
  assert.equal(t.visibility, 'privat',
    'the retraction did not reach her own truth register — the level moved and the entry did not');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · PRINCIPLE 9 SURVIVES THE DEFECT — nothing on her screen names the admin, either way
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 · no marker, no notice and no name, before or after the reboot', () => {
  const doc = `${document.body.textContent} ${$$('[title]').map((n) => n.title).join(' ')}`;
  for (const w of ['entfernt', 'Verwaltung hat', 'Verwalter hat', 'moderiert', 'removed by',
    'unshared', 'Papa hat', 'zurückgenommen']) {
    assert.equal(doc.includes(w), false, `Principle 9: „${w}" appeared on the owner's screen`);
  }
  assert.equal($$('[class*="unshared"]').length, 0, 'an entry carries a moderation class');
  assert.equal($('.lzp-conflict'), null, '18.5\'s lost-edit notice must never fire for a moderation');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · ⛔ F-SHELL-3(c) — THE HARNESS NEVER FLUSHES, AND THAT IS THE „SHE LOST HER ENTRY" MESSAGE
//
// `shell-macos/main.swift#runTestFile` prints the TAP and calls `exit()` from inside the
// `callAsyncJavaScript` completion. It therefore never runs `applicationShouldTerminate`
// (`main.swift#applicationShouldTerminate`), which is the only thing that calls `window.__lzpFlush` — and `pagehide`
// main.js's `pagehide` handler does not fire on `exit()` either. So the last `SAVE_DEBOUNCE` (700 ms,
// `store.js#SAVE_DEBOUNCE`) of every phase is abandoned, and under ADR 006 `board.json` IS the truth: the
// entry the phase just created is simply not on the board at the next launch.
//
// That is what `scripts/shell-family-e2e.mjs` prints as „the owner lost her own entry — unshare
// DELETED instead of reverting", and it is the HARNESS, not the product. Measured: adding one
// `await store.persistNow()` at the end of each phase puts „Elternabend" back into
// `scratch-B/board.json` and the phase completes.
//
// This row asserts the two halves a page can see — the flush exists and it works — so the day
// `runTestFile` calls it, this row inverts to "and the shell calls it".
// Owner: `shell-macos/main.swift` (the headless-shell rule is untouched: no UI call is added).
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7 · the flush the shell\'s --test exit now calls exists here, and works', async () => {
  const e = await shared('2027-03-31', 'Zeugniskonferenz');
  assert.equal(typeof window.__lzpFlush, 'function',
    'main.js no longer exposes `window.__lzpFlush`, which is the flush the terminate handler calls');

  // The debounce is real: nothing has been written yet, and `exit()` would end the process here.
  assert.ok(store._saveTimer, 'no autosave was armed by a write — then the debounce is not the risk');

  await window.__lzpFlush();
  const raw = await window.__TAURI__.core.invoke('load_board', {});
  const disk = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw || {}));
  const onDisk = (disk.notes || []).filter((n) => n && n.text === 'Zeugniskonferenz');
  assert.equal(onDisk.length, 1,
    'the flush ran and `board.json` still does not carry the entry — that is a worse defect');
  assert.equal(onDisk[0].id, e.uuid, 'the entry on disk is not the one that was written');
});
