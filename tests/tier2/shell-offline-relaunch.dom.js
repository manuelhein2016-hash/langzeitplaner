// TIER 2 · THE OFFLINE RELAUNCH, ON THE SHIPPED BINARY — the measurement AUDIT §5 left open.
// Stories 18.2 · 16.6 · 17.5 · 20.2 · audit F2 / F4 / F6 / F3 · ADR 001 §7.2 · ADR 006 R1.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS BESIDE `shell-family-e2e.dom.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The audit's §6c battery answered "does a shipped Mac that quits and opens AGAINST A LIVE RELAY
// still co-edit / enforce a removal / report its exposure / draw the dot?" — 8 of 8 green, five
// runs. It could not answer the other half, and said so:
//
//     "F2/F3/F4 were real for a Mac quitting and opening OFFLINE or against a pruned relay — an
//      ordinary Tuesday, not exotic — and were never reachable in the acceptance topology. I did
//      not close the offline case end-to-end on the binary; that remains the single most valuable
//      missing measurement."
//
// This file is that half. It is a separate file rather than a phase because every §R row starts
// with `armed()` — `await waitFor(() => mount.circleEngine())` — and OFFLINE THAT IS EXACTLY WHAT
// CANNOT HAPPEN. Re-running a §R phase with the relay down measures the wait, not the fold:
// MEASURED, phase-22 (§R3) against a dead relay, `not ok 21 … waitFor timed out: the circle
// engine` after 25 903 ms, and nothing about co-editing was ever asked.
//
// So the rule here is the opposite one:
//
//     ⚠ NOTHING IN THIS FILE WAITS FOR THE ENGINE, THE RELAY OR A PULL. Every row reads the
//       projection and the register map this launch rebuilt from `board.json` +
//       `checkpoint.json` + `ops.jsonl` ALONE, which is the whole question. Whether the engine
//       armed is REPORTED as a number, never awaited.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// HOW IT IS DRIVEN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     node scripts/shell-offline-relaunch.mjs
//
// which re-uses `scripts/shell-family-e2e.mjs`'s own work directory: that driver builds the
// circle against a live loopback relay and (with `--keep`) leaves five `.app` copies, five
// `--scratch` directories and five WebKit stores behind. This driver KILLS THE RELAY and launches
// the same binaries over the same disks again. Nothing is stubbed and no transport is injected:
// the app still resolves `chooseTransport` to the bridge and still points at the origin it was
// given — that origin simply answers nothing, which is what "offline" is.
//
// Run plainly (`npm run test:dom`) there is no circle on disk, so every row skips with the driver
// command in its reason — `shell-family-e2e.dom.js`'s own discipline.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// MEASURED — 2026-09-04, on the shipped `.app`, relay dead, over two online runs stopped at two
// different phase boundaries (the founder LEAVES at phase 24 and the removal is phases 30-32, so
// one stop point cannot hold both the exposure case and the removal case):
//
//   run stopped after `A · exposure`      §O1 GREEN on C and B · §O2 GREEN on A · §O3 GREEN on C
//   run stopped after `B · removed-check` §O1 GREEN on C and B · §O3 GREEN on C · §O4 GREEN on B
//
//   THE OFFLINE BATTERY: 4 of 4 green — stories 16.6, 17.5, 18.2, 20.2
//   the circle engine armed on 0 of 4 offline launches, in BOTH runs
//
//   §O1  found=true isForeign=true text="Nordsee" coEdit=true canEdit=true foldLevel="geteilt"
//        applied=true refusals=[] sawNoCoEdit=false          (audit F2 · CLOSED offline)
//   §O2  visibility="geteilt" exposure={"level":"geteilt","pending":false}
//        exposedLevel="geteilt" refusals=[]                  (audit F4 · CLOSED offline)
//   §O3  seqOf="15" found=true isForeign=true isNew=false neuDots=0 lastSeenSeqPref=null
//                                                            (audit F6 · INPUT intact; see §O3)
//   §O4  onBoard=false inRegisters=false refusals=[]         (audit F3 · CLOSED offline)
//
//   And the offline proof itself, on every launch: `engineArmed:false`, family mode entered in
//   **0 ms**, and the bridge answering the relay probe `{"error":"blocked", …}` — „Diese Anfrage
//   ging nicht an den hinterlegten Sync-Server und wurde deshalb gar nicht erst gesendet."
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const OFF = globalThis.__LZP_OFFLINE || null;
const ROLE = OFF ? String(OFF.role || '') : '';
const SKIP_REASON =
  'this file is driven by `node scripts/shell-offline-relaunch.mjs`, which re-launches the '
  + 'instances `scripts/shell-family-e2e.mjs --keep` left on disk with the relay DEAD. Run '
  + 'plainly there is no circle and no relay to be offline from.';

const { store } = await importApp('store.js');
const mount = await importApp('family/mount.js');
const sharing = await importApp('family/sharing.js');
const familysettings = await importApp('family/familysettings.js');

const OUT = {};
const emit = () => diag('OFFLINE-OUT ' + JSON.stringify(OUT));

/** `shell-family-e2e.dom.js#logShape`, verbatim — the two files must report the same numbers. */
const logShape = () => {
  try {
    return {
      ops: store._log.ops({ includeParked: true }).length,
      lines: [...store._log.lines()].length,
      horizon: store._log.horizon(),
      registers: [...store._log.registers().keys()].length,
    };
  } catch (e) { return { error: String((e && e.message) || e) }; }
};

const refusalsHere = () => (store.warnings || [])
  .filter((w) => /refused|parked|noCoEdit|notMember|notOwner|lostAdminChain/.test(String(w)))
  .map((w) => String(w).slice(0, 220));

/**
 * ── PROOF THAT THIS LAUNCH REALLY IS OFFLINE ──────────────────────────────────────────────────
 *
 * Asked once, at the top of every row, and reported. A green row on a Mac that quietly reached a
 * relay would be the acceptance topology under a different name, and would be worse than no
 * measurement: it would look like the missing one.
 *
 * The probe is the app's OWN transport — `mount.circleEngine()` if the engine happened to arm,
 * otherwise a bare bridge request to the origin the shell was configured with. Either way it is
 * one round trip and it is not awaited for longer than it takes to fail.
 */
async function offlineProof() {
  const out = { engineArmed: false, metaStatus: null, metaError: null };
  try { out.engineArmed = !!mount.circleEngine(); } catch (e) { out.engineArmed = 'threw: ' + e.message; }
  try {
    const r = await window.__TAURI__.core.invoke('sync_request', {
      method: 'GET', path: '/api/v1/meta', headers: {}, body: null,
    });
    out.metaStatus = r && r.status !== undefined ? r.status : JSON.stringify(r).slice(0, 120);
  } catch (e) {
    out.metaError = String((e && e.message) || e).slice(0, 160);
  }
  return out;
}

/** The one non-vacuity every row shares: this Mac really is in a circle, on its own disk. */
function inACircle() {
  return typeof store.familySpaceId === 'function'
    ? store.familySpaceId() !== null
    : !!store._familySpaceId;
}

/**
 * ── FAMILY MODE, WITHOUT WAITING FOR ANYTHING THAT NEEDS A RELAY ──────────────────────────────
 *
 * `store._familySpaceId` is set by `store.useFamilySpace()`, and its ONE caller in `src/js/` is
 * `family/engine.js#startFamilyEngine`, three statements before it touches a transport. So family
 * mode is reachable offline; what is NOT reachable is `mount.circleEngine()`, which is assigned
 * only after `startFamilyEngine` RESOLVES — after the key pass and the roster, both of which need
 * the relay. That distinction is the whole reason this file exists:
 *
 *   MEASURED, the §R phases against a dead relay: `waitFor(() => mount.circleEngine())` →
 *   `not ok … waitFor timed out: the circle engine` after 25 903 ms, and the fold was never asked
 *   anything at all.
 *
 * So this starts the app's OWN boot-path starter and does not await it. It polls for the store
 * seam — `familySpaceId()` — with a short bound, and reports whether the engine ever armed as a
 * NUMBER. Nothing here is a stub: `startCircleEngine` is the function `boot.js` calls.
 */
async function enterFamilyMode() {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.map(String).join(' ').slice(0, 200)); realWarn.apply(console, a); };
  try { OUT.armPref = await familysettings.armShellSync(); }
  catch (e) { OUT.armPrefError = String((e && e.message) || e).slice(0, 160); }
  let started = null;
  try { started = mount.startCircleEngine({}); OUT.startReturned = started === null ? 'null' : 'promise'; }
  catch (e) { OUT.startError = String((e && e.message) || e).slice(0, 200); }
  const t0 = Date.now();
  while (!inACircle() && Date.now() - t0 < 20000) await sleep(150);   // eslint-disable-line no-await-in-loop
  OUT.enteredFamilyModeMs = Date.now() - t0;
  console.warn = realWarn;
  OUT.bootWarnings = warns.slice(0, 8);
  OUT.settingsSeen = {
    familySpaceId: (store.state.settings || {}).familySpaceId || null,
    syncOrigin: (store.state.settings || {}).syncOrigin || null,
    familyMemberId: (store.state.settings || {}).familyMemberId || null,
  };
  emit();
  return inACircle();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §O1 · audit F2 · story 18.2 — CO-EDITING, WITH NOTHING TO RE-PULL
//
// The fleet rig's `quitAndOpen` is the offline case and there F2 was terminal: the granting
// `pub.set` is absorbed into a register, `authz.js` stage 3a rebuilds `govRegs` from the ops in
// THIS fold and finds none, stage 3b refuses `noCoEdit`. The battery could not see it because the
// shipped app re-pulled the lines back before anything asked. Nothing re-pulls here.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§O1 · 18.2 · a co-editable entry is still co-editable after an OFFLINE quit-and-open', async () => {
  if (ROLE !== 'coedit') skip(ROLE ? 'role is ' + ROLE : SKIP_REASON);
  OUT.shape = logShape();
  await enterFamilyMode();
  OUT.offline = await offlineProof();
  OUT.shape = logShape();
  assert.ok(inACircle(), 'this Mac holds no family space — the driver handed over the wrong disk');

  const row = (store.state.notes || []).find((n) => n
    && (n.entityKey === OFF.entityKey || n.text === OFF.newText || n.text === OFF.text)) || null;
  // ⚠ READ IT NOW. `store.state` KEEPS ENTRY OBJECT IDENTITY (store.js's rule 3), so `row` is the
  // live object and the probe write below mutates it in place. Asserting on `row.text` afterwards
  // compares the probe text against the expected one and fails with two identical-looking strings
  // in the message — measured, and it cost a run.
  const textBefore = row ? row.text : null;
  OUT.found = !!row;
  OUT.isForeign = row ? row.isForeign : null;
  OUT.text = textBefore;
  OUT.coEdit = row ? row.coEdit : null;
  OUT.canEdit = row ? sharing.canEditEntry(row) : null;
  OUT.foldLevel = row && row.entityKey ? store.familyCoEditLevelOf(row.entityKey) : null;

  // THE WRITE ITSELF, not just the door. A door that opens onto a refusal is the F2 shape.
  OUT.applied = null;
  OUT.textAfter = null;
  if (row && row.entityKey) {
    const probe = OFF.probeText || ('offline-' + Math.random().toString(36).slice(2, 8));
    try { OUT.applied = store.applyCoEdit(row.entityKey, { 'pub.text': probe }); }
    catch (e) { OUT.applied = 'threw: ' + String((e && e.message) || e).slice(0, 120); }
    const after = (store.state.notes || []).find((n) => n && n.entityKey === row.entityKey);
    OUT.textAfter = after ? after.text : null;
    OUT.probe = probe;
  }
  OUT.refusals = refusalsHere().slice(0, 6);
  OUT.sawNoCoEdit = OUT.refusals.some((w) => /noCoEdit/.test(w));
  emit();

  assert.ok(row, 'NON-VACUITY: the entry is not on this Mac at all — the driver, not the finding');
  // THE TEXT IS A NON-VACUITY, NOT AN EQUALITY. This row WRITES through `applyCoEdit`, and the
  // write persists — so a second offline launch over the same disk legitimately reads the
  // previous probe's text rather than the online co-edit's. What must hold on every launch is
  // that this Mac still carries the CO-EDITED value and not the owner's original: the co-edit
  // that arrived online is still folded in after a relaunch with nothing to re-pull.
  assert.notEqual(textBefore, OFF.text,
    'the entry has fallen back to the owner\'s ORIGINAL text after an offline relaunch — the '
    + 'co-edit is gone. Read ' + JSON.stringify(textBefore));
  assert.ok(typeof textBefore === 'string' && textBefore.length > 0,
    'the entry has no text at all: ' + JSON.stringify(textBefore));
  assert.equal(OUT.canEdit, true,
    'AUDIT F2 / STORY 18.2, offline. `sharing.canEditEntry` refuses the gesture on a Mac that '
    + 'reopened with nothing to re-pull. shape ' + JSON.stringify(OUT.shape));
  assert.equal(OUT.foldLevel, 'geteilt',
    'the author-side fold does not grant co-edit on this launch — govRegs was rebuilt from a log '
    + 'the checkpoint had absorbed. foldLevel ' + JSON.stringify(OUT.foldLevel));
  assert.equal(OUT.applied, true,
    'applyCoEdit declined offline: ' + JSON.stringify(OUT.applied)
    + ' · refusals ' + JSON.stringify(OUT.refusals));
  assert.equal(OUT.textAfter, OUT.probe, 'the co-editor cannot see her own offline edit');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §O2 · audit F4 · story 16.6 — THE EXPOSURE BADGE, WITH NOTHING TO RE-PULL
//
// `_exposureCtx` answers `lastAckedPubLevel` by walking `_log.lines()`, and lines are what a
// persist absorbs. ADR 004 §6: "the badge never UNDER-reports what others can see."
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§O2 · 16.6 · the exposure badge still says Geteilt after an OFFLINE quit-and-open', async () => {
  if (ROLE !== 'exposure') skip(ROLE ? 'role is ' + ROLE : SKIP_REASON);
  OUT.shape = logShape();
  await enterFamilyMode();
  OUT.offline = await offlineProof();
  OUT.shape = logShape();
  assert.ok(inACircle(), 'this Mac holds no family space — the driver handed over the wrong disk');

  const mine = (store.state.notes || []).find((n) => n && n.id === OFF.noteId) || null;
  OUT.found = !!mine;
  OUT.visibility = mine ? mine.visibility : null;
  OUT.exposure = mine ? mine.exposure : null;
  OUT.exposedLevel = mine ? sharing.exposedLevel(mine) : null;
  OUT.pendingWord = mine ? sharing.exposurePending(mine) : null;
  OUT.refusals = refusalsHere().slice(0, 6);
  emit();

  assert.ok(mine, 'NON-VACUITY: the owner\'s own entry is gone from her board');
  assert.equal(mine.visibility, 'geteilt',
    'NON-VACUITY: the entry is no longer shared, so there is no badge claim to test');
  assert.deepEqual(mine.exposure, { level: 'geteilt', pending: false },
    'AUDIT F4 / STORY 16.6, offline. The badge under-reports what the family can still see on a '
    + 'Mac that reopened with no relay. exposure ' + JSON.stringify(OUT.exposure)
    + ' · exposedLevel ' + JSON.stringify(OUT.exposedLevel)
    + ' · shape ' + JSON.stringify(OUT.shape));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §O3 · audit F6 · story 17.5 — THE „neu" DOT'S INPUT, WITH NOTHING TO RE-PULL
//
// ⚠ WHAT THIS ROW CAN AND CANNOT ASK, AND WHY THE DIFFERENCE IS THE PRODUCT'S AND NOT THIS
//   FILE'S. F6's mechanism is `materialize.js#isNewOf`, which needs `ctx.seqOf` — supplied by
//   `store.js#_exposureCtx` out of the register map — and a baseline from
//   `store.js#_lastSeenSeqCtx`. THE BASELINE IS THE PART THE OFFLINE TOPOLOGY REMOVES:
//
//       `_lastSeenSeqCtx` installs a SESSION FLOOR of `_maxFamilySeq()` whenever the
//       `lastSeenSeq.<spaceId>` pref has never been written, and its own docblock says why —
//       "correct as a formula and wrong as a first launch, where it would dot every entry the
//       family has ever shared." So on ANY relaunch nothing this Mac already holds is new, and
//       offline nothing new can arrive. **17.5's dot is unreachable offline BY DESIGN, and that
//       is right.**
//
//   MEASURED, and it is why this row does not assert a dot: on a clean offline relaunch the peer
//   entry reads `seqOf "15"`, `lastSeenSeq` pref absent, `isNew false`, `.neu-dot 0`. Moving the
//   pref back with `setSettings` inside the launch does not move it either — the projection this
//   row reads was computed at boot from the floor.
//
//   So the row asks the half that IS a claim about F6: THE INPUT SURVIVED. `seqOf` answering a
//   real seq on a launch with no relay is exactly what `_exposureCtx` was fixed to do, and a
//   `null` there is `isNewOf`'s own `return false` — the defect, one layer down.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§O3 · 17.5 · the „neu" dot\'s INPUT survives an OFFLINE quit-and-open', async () => {
  if (ROLE !== 'neu') skip(ROLE ? 'role is ' + ROLE : SKIP_REASON);
  OUT.shape = logShape();
  await enterFamilyMode();
  OUT.offline = await offlineProof();
  OUT.shape = logShape();
  assert.ok(inACircle(), 'this Mac holds no family space — the driver handed over the wrong disk');

  // The INPUT F6 is about, asked directly: `_exposureCtx().seqOf` is what `isNewOf` needs, and
  // it is derived from the register map this launch rebuilt from disk. A null here IS F6's
  // mechanism; a number means the input survived the offline relaunch.
  let ctxSeq = null;
  try {
    const ctx = store._exposureCtx();
    ctxSeq = ctx && typeof ctx.seqOf === 'function' && OFF.entityKey ? ctx.seqOf(OFF.entityKey) : 'no-seqOf';
  } catch (e) { ctxSeq = 'threw: ' + String((e && e.message) || e).slice(0, 100); }
  OUT.seqOfEntry = ctxSeq === null ? null : String(ctxSeq);
  // REPORTED, never asserted — see the header. The pref is absent, so the floor is this launch's
  // own max family seq and nothing already on disk can be new.
  const prevSeen = (store.state.settings || {}).lastSeenSeq || null;
  OUT.lastSeenSeqPref = prevSeen && OFF.spaceId ? (prevSeen[OFF.spaceId] ?? null) : null;

  const row = (store.state.notes || []).find((n) => n
    && (n.entityKey === OFF.entityKey || n.text === OFF.newText || n.text === OFF.text)) || null;
  OUT.found = !!row;
  OUT.foundText = row ? row.text : null;
  OUT.isForeign = row ? row.isForeign : null;
  OUT.isNew = row ? (row.isNew === undefined ? null : row.isNew) : null;
  // The board must have rendered from disk alone; give it a moment, but never wait on a network.
  try {
    await waitFor(() => document.querySelector('.board')
      && (document.body.textContent.includes(OFF.text) || document.body.textContent.includes(OFF.newText || '\u0000')),
      { timeout: 8000, what: 'the entry to render from disk' });
  } catch (e) { OUT.renderError = String((e && e.message) || e).slice(0, 160); }
  OUT.neuDots = document.querySelectorAll('.neu-dot').length;
  OUT.refusals = refusalsHere().slice(0, 6);
  emit();

  assert.ok(row, 'NON-VACUITY: the peer\'s entry is not on this Mac');
  assert.equal(row.isForeign, true, 'NON-VACUITY: this is not a peer\'s entry');
  assert.ok(OUT.seqOfEntry !== null && OUT.seqOfEntry !== 'no-seqOf',
    'AUDIT F6 / STORY 17.5, offline, THE INPUT. `_exposureCtx().seqOf` answers '
    + JSON.stringify(OUT.seqOfEntry) + ' for this entry on a launch with no relay, and `isNewOf` '
    + 'returns false the moment that is null. shape ' + JSON.stringify(OUT.shape));
  assert.equal(typeof OUT.isNew, 'boolean',
    'the projection could not decide 17.5 at all offline: isNew ' + JSON.stringify(OUT.isNew));
  // NOT ASSERTED, DELIBERATELY: `isNew === true`. See the header — the session floor makes it
  // false on every relaunch, and offline nothing can arrive above the floor. Recording the
  // measured value keeps the claim honest without pretending the dot was reachable.
  diag('§O3 · 17.5 offline · isNew=' + JSON.stringify(OUT.isNew)
    + ' neuDots=' + OUT.neuDots + ' (the session floor makes this the CORRECT answer)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §O4 · audit F3 · story 20.2 — THE REMOVAL, WITH NOTHING TO RE-PULL
//
// Two layers, asked apart, exactly as §R6 asks them: the BOARD (materialize's currentMembers
// filter) and the REGISTER MAP (what the fold actually admitted). F3 is a claim about the second.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§O4 · 20.2 · a removal is still enforced after an OFFLINE quit-and-open', async () => {
  if (ROLE !== 'removed-check') skip(ROLE ? 'role is ' + ROLE : SKIP_REASON);
  OUT.shape = logShape();
  await enterFamilyMode();
  OUT.offline = await offlineProof();
  OUT.shape = logShape();
  assert.ok(inACircle(), 'this Mac holds no family space — the driver handed over the wrong disk');

  OUT.onBoard = (store.state.notes || []).some((n) => n && n.text === OFF.text);
  OUT.inRegisters = false;
  OUT.regError = null;
  try {
    for (const [k, cells] of store.registers()) {
      if (String(k).slice(0, 6) !== 'fnote:') continue;
      const c = cells.get('pub.text');
      if (c && c.value === OFF.text) { OUT.inRegisters = true; break; }
    }
  } catch (e) { OUT.regError = String((e && e.message) || e); }
  OUT.refusals = refusalsHere().slice(0, 6);
  OUT.sawNotMember = OUT.refusals.some((w) => /notMember/.test(w));
  emit();

  assert.equal(OUT.onBoard, false,
    'STORY 20.2, offline: a removed member\'s entry is drawn on a remaining Mac\'s board. Text '
    + JSON.stringify(OFF.text));
  assert.equal(OUT.inRegisters, false,
    'AUDIT F3 / STORY 20.2, offline, the second layer. The entry is not drawn but this Mac\'s '
    + 'FOLD ADMITTED it on a launch with no relay: `_absorbedAttestOps` rebuilds every `dev.*` '
    + 'cell, and if `member:_alive` is not rebuilt beside it a removed member is alive again '
    + 'inside the fold. shape ' + JSON.stringify(OUT.shape)
    + ' · refusals ' + JSON.stringify(OUT.refusals));
});
