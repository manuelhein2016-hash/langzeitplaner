#!/usr/bin/env node
// scripts/shell-family-e2e.mjs — THE DEMONSTRATION DRIVER.  LZP-1002.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS RUNS, AND WHY IT IS A SCRIPT RATHER THAN A TEST FILE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier2/shell-family-e2e.dom.js` is one file describing several Macs. It cannot launch
// them: a tier-2 file runs INSIDE one WKWebView, and the whole point of the demonstration is that
// there is more than one. So the orchestration lives here, and everything it asserts lives there.
//
// Five instances of the shipped `.app`, each with:
//
//   · its own CFBundleIdentifier          → its own `~/Library/WebKit/<id>` (localStorage,
//                                            IndexedDB — and therefore its own DEVICE IDENTITY,
//                                            ADR 002 §2.2; without this they are one Mac)
//   · its own WebCrypto master-key item   → `com.apple.WebKit.WebCrypto.master+<id>` in the
//                                            login Keychain, cleared before and after
//   · its own `--scratch` directory       → its own board.json / ops.jsonl / sync.json
//
// …plus one `node server/dev-server.mjs` on loopback, which is the real relay: the same
// `server/core/router.js` and the same 23 handlers that would run in Frankfurt.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// HOW A PHASE IS PARAMETERISED, AND WHY THAT IS NOT CHEATING
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A page cannot read `argv` or the environment. So a phase's input arrives as ONE PREPENDED LINE
// — `globalThis.__LZP_E2E = {…};` — in front of the unmodified test file, and a phase's output
// leaves as a TAP comment (`# E2E-OUT {…}`), which is the channel `diag()` has always used.
//
// Nothing about the APP is different: the same binary, the same web bundle, the same bridge, the
// same `LZP_SYNC_ORIGIN` gate every tier-2 run can use. The prepended line is a FIXTURE
// PARAMETER — which member to remove, which code to paste — and never a stub: no transport, no
// identity, no relay and no crypto is injected anywhere in this run.
//
//   node scripts/shell-family-e2e.mjs                 # everything
//   node scripts/shell-family-e2e.mjs --keep          # leave the work dir for inspection
//   node scripts/shell-family-e2e.mjs --port 8791
//
// Zero npm dependencies.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6c · THE RELAUNCH BATTERY — added after the AUDIT, and why it belongs HERE of all places
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The independent audit's central result is one sentence: **a quit-and-open turns ops into
// registers, and four things a fold reads from ops are never rebuilt.** It was invisible to 5,612
// green rows for a purely mechanical reason the PO verified by counting:
//
//     tests/fleet/e9-attack-coedit.test.js      coEdit 17 · relaunch  0
//     tests/fleet/e9-attack-diverge.test.js     coEdit 22 · relaunch  1
//     scripts/shell-family-e2e.mjs (this file)  coEdit  0 · relaunch  1
//
// **Every rig that co-edits never reboots; the rig that reboots never co-edits.** And this file is
// the one place in the tree where that hole is free to close, because of a property of its own
// design that nothing else in the project has:
//
//     ⚠ IN THIS DRIVER EVERY PHASE IS A RELAUNCH. One phase is one `execFileSync` of the shipped
//       binary: a new process, a cold `store.init()` over the same `--scratch` directory, over the
//       `board.json`/`ops.jsonl`/`checkpoint.json` the PREVIOUS phase's `applicationShouldTerminate`
//       flushed. There is no `quitAndOpen` helper here and there does not need to be one — the
//       Mac that receives a co-edit in §R3 has quit and opened between the grant and the edit
//       because that is the only way this driver can run a second phase at all.
//
// So the four phases below are not "the fleet rows again with a reboot bolted on". They are the
// four audit-FAIL stories asked of the app we actually ship, in the state a family is in from its
// second launch onward — which, as the audit puts it, is the only state the shipped app is ever in.
//
//   §R1/§R2/§R3  story 18.2  „Familie darf bearbeiten"     ← audit F2
//   §R4          story 16.6  the exposure badge             ← audit F4
//   §R5          story 17.5  the quiet „neu" dot            ← audit F6
//   §R6          story 20.2  a removal, across a relaunch   ← audit F3
//
// ── WHY THEY ARE `battery()` AND NOT `must()` ────────────────────────────────────────────────
//
// They are RED ON ARRIVAL against today's code, on purpose, and they go green the day another
// agent's fix to `core/authz.js` / `store.js` lands. A `must()` would bail the demonstration out
// on the first one and destroy the 80 rows this file already earns; a deleted row would hide the
// finding. `battery()` is `attempt()`'s discipline applied to a whole section: every row runs,
// every row is printed, each one names the finding it is waiting for, and THE REPORT PRINTS THE
// SCORE. `# THE RELAUNCH BATTERY: 8 of 8 green` is the acceptance signal for the four compaction
// fixes, and the rows should be promoted to `must()` once that score has held for a release.
//
// ── WHAT THIS BATTERY ALREADY ANSWERED, AND IT IS NOT WHAT THE AUDIT EXPECTED ────────────────
//
// AUDIT §5 item 5, verbatim: *"Every compaction finding (F2, F3, F4, F9) ... ran on the fleet rig
// ... I did not reproduce these on the shipped binary, and that is the first thing I would do
// next."* This battery is that run, and its first result contradicted the audit's own prediction
// that *"a real relaunch loses MORE, never less"*:
//
//     measured at 2026-09-04, on the shipped .app, `ops.jsonl` read from outside the app by this
//     script:  12 · 13 · 21 · 22 · 23 lines on disk, and `log at launch` shows 8–23 LINES with a
//     non-null horizon. **The shipped app was not in the absorbed state at all on any launch.**
//
// The fleet rig's `quitAndOpen` persists and re-inits with NO RELAY in between; the shipped app
// re-pulls from the relay on every launch and the lines come back AS LINES, so its fold never
// sees the absorbed state at all. Driven against the audited tree `2d092a6` itself — my driver,
// its `src/` — the battery reads **7 of 8**: F2, F3 and F4 are all GREEN in the app, and only
// §R5 (17.5 / F6) is red. Against the same tree `tests/fleet/e13-relaunch-sweep.test.js` reports
// **5 rows ABSORBED**. Both numbers are true and they are about different situations:
//
//   the rig  = a Mac that folds after a quit with nothing to re-pull — OFFLINE, or a relay that
//              has pruned, or any peer whose `since` cursor is past the op. F2/F3/F4 are real
//              there, terminally, and that is the case `e13-relaunch-sweep` owns.
//   the app  = a Mac that opens, reaches a relay holding every op, and pulls them back before
//              anything asks the fold a governance question. Measured here, three times.
//
// So the rig is the STRICTER environment for this class and not the weaker one, which is the
// opposite of the audit's own prediction (§5 item 5: *"a real relaunch loses MORE, never less"*).
// Worth knowing before anybody prices F2/F3/F4 as "kills every family from the second launch":
// on this evidence it kills every family that relaunches without the relay. F6 is the one of the
// four that reproduced in the app on every run, and it is the one that is not a compaction
// defect at all. Both numbers are printed, because either alone is a story.
//
// ── WHERE THE PHASE SOURCE LIVES, AND WHY IT IS APPENDED ─────────────────────────────────────
//
// `tests/tier2/shell-family-e2e.dom.js` has one owner and it is not this file. The generated
// per-phase file has always been `<one fixture line> + <that file, unmodified>`; it is now
// `<one fixture line> + <that file, unmodified> + <RELAUNCH_PHASES>`. The shell concatenates
// harness + file + runner into ONE `callAsyncJavaScript` body (`shell-macos/main.swift`
// `runTestFile`), so the appended block shares that one scope and uses the very same `store`,
// `sharing`, `popover`, `mount`, `WIRE`, `OUT`, `emit` and `armShell` the file above it built.
// Nothing is stubbed, nothing is re-implemented, and `npm run test:dom` — which runs the ORIGINAL
// file and never this generated one — is untouched.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const KEEP = argv.includes('--keep');
const PORT = Number(arg('port', '8791'));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TEST_FILE = path.join(REPO, 'tests/tier2/shell-family-e2e.dom.js');

const WORK = mkdtempSync(path.join(tmpdir(), 'lzp-e2e-'));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...opts });

// ── the five Macs ─────────────────────────────────────────────────────────────────────────────
//
// A is the founder. B, C and D join. E never joins anything and is the solo control — without it
// "solo makes zero requests" would be measured on a Mac that had been configured out of solo.
const MACS = {
  A: { id: 'org.langzeitplaner.e2e.a', name: 'Papa', color: 'violett' },
  B: { id: 'org.langzeitplaner.e2e.b', name: 'Mama', color: 'gruen' },
  C: { id: 'org.langzeitplaner.e2e.c', name: 'Oma', color: 'orange' },
  D: { id: 'org.langzeitplaner.e2e.d', name: 'Opa', color: 'blau' },
  E: { id: 'org.langzeitplaner.e2e.e', name: 'Allein', color: 'rot' },
};

const log = (s) => process.stdout.write(s + '\n');
const results = [];
let launches = 0;

function webkitPaths(bundleId) {
  return {
    data: path.join(homedir(), 'Library/WebKit', bundleId),
    account: `com.apple.WebKit.WebCrypto.master+${bundleId}`,
  };
}

function wipeMac(tag) {
  const { data, account } = webkitPaths(MACS[tag].id);
  try { sh('security', ['delete-generic-password', '-a', account]); } catch { /* absent is fine */ }
  rmSync(data, { recursive: true, force: true });
}

/**
 * ── THE DISK, MEASURED FROM OUTSIDE THE APP ───────────────────────────────────────────────────
 *
 * The second witness for §6c, and the counterpart of the relay-store block at the foot of this
 * file: the driver owns each Mac's `--scratch` directory, so it can read what the app WROTE
 * without asking the app. `ops.jsonl` is the file the audit's mechanism is about — `_persistOps`
 * ① skips every line at or below the horizon, so a checkpoint that absorbed the log leaves this
 * file EMPTY. `opsLines: 0` beside a non-empty `checkpoint.json` is absorption; a positive
 * `opsLines` is a log that still carries history as lines. Reported per Mac, in bytes and lines,
 * because "the app relaunched and it still worked" is a story and this is a number.
 */
function diskOf(tag) {
  const dir = path.join(WORK, 'scratch-' + tag);
  const out = {};
  for (const f of ['board.json', 'ops.jsonl', 'checkpoint.json', 'snapshots.json', 'sync.json']) {
    const p = path.join(dir, f);
    if (!existsSync(p)) { out[f] = null; continue; }
    const bytes = readFileSync(p, 'utf8');
    out[f] = f === 'ops.jsonl'
      ? { bytes: bytes.length, lines: bytes.split('\n').filter((l) => l.trim()).length }
      : { bytes: bytes.length };
  }
  return out;
}

function cleanup() {
  for (const tag of Object.keys(MACS)) wipeMac(tag);
  if (relay && !relay.killed) { try { relay.kill('SIGKILL'); } catch { /* gone */ } }
  if (KEEP) log(`# work kept at ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ── 1. build the shipped bundle once, then clone it per Mac ───────────────────────────────────

log(`# building shell-macos → ${WORK}`);
try {
  sh(path.join(REPO, 'shell-macos/build.sh'), ['--dest', path.join(WORK, 'base')]);
} catch (e) {
  log('Bail out! build failed');
  log(String(e.stdout || '') + String(e.stderr || ''));
  process.exit(2);
}

const appFor = (tag) => path.join(WORK, tag, 'LangzeitPlaner.app');
const binFor = (tag) => path.join(appFor(tag), 'Contents/MacOS/LangzeitPlaner');

for (const [tag, mac] of Object.entries(MACS)) {
  mkdirSync(path.join(WORK, tag), { recursive: true });
  sh('cp', ['-R', path.join(WORK, 'base/LangzeitPlaner.app'), path.join(WORK, tag) + '/']);
  sh('plutil', ['-replace', 'CFBundleIdentifier', '-string', mac.id,
    path.join(appFor(tag), 'Contents/Info.plist')]);
  try { sh('codesign', ['--force', '--deep', '--sign', '-', appFor(tag)]); } catch { /* ad hoc */ }
  wipeMac(tag);
  mkdirSync(path.join(WORK, 'scratch-' + tag), { recursive: true });
}
log(`# five instances built: ${Object.entries(MACS).map(([t, m]) => `${t}=${m.id}`).join(' ')}`);

// ── 2. the relay ──────────────────────────────────────────────────────────────────────────────

const relayDir = path.join(WORK, 'relay');
mkdirSync(relayDir, { recursive: true });
const relayLog = [];
const relay = spawn(process.execPath, [
  path.join(REPO, 'server/dev-server.mjs'), '--port', String(PORT), '--dir', relayDir,
], { stdio: ['ignore', 'pipe', 'pipe'] });
relay.stdout.on('data', (d) => relayLog.push(String(d)));
relay.stderr.on('data', (d) => relayLog.push(String(d)));

async function waitForRelay() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${ORIGIN}/api/v1/meta`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
if (!(await waitForRelay())) {
  log('Bail out! the relay did not come up');
  log(relayLog.join(''));
  process.exit(2);
}
log(`# relay up at ${ORIGIN} (server/core/router.js over server/adapters/file.js)`);

// ── 3. one phase = one launch of one instance ─────────────────────────────────────────────────

const SOURCE = readFileSync(TEST_FILE, 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RELAUNCH BATTERY'S PHASE SOURCE — appended to the unmodified tier-2 file, in its scope.
//
// Read the header (§6c) first. Six phases, four stories, one property:
//
//     THE ANSWER A FOLD GIVES MUST BE THE SAME BEFORE AND AFTER A QUIT-AND-OPEN.
//
// Every row below calls `emit()` BEFORE its verdict assertion, so the driver gets the MEASURED
// numbers off a red phase as well as a green one. A finding that arrives with no measurement is
// a story; this file only reports numbers.
//
// ⚠ No backtick and no `$`+`{` may appear inside this literal.
// ═════════════════════════════════════════════════════════════════════════════════════════════
const RELAUNCH_PHASES = `

// ═══════════════════════════════════════════════════════════════════════════════════════════
// §R · THE RELAUNCH BATTERY — appended by scripts/shell-family-e2e.mjs
// ═══════════════════════════════════════════════════════════════════════════════════════════

const R = E2E || {};

/** Pull hard, the way the cadence would, and hand back this Mac's own warnings. */
async function pullHard(parts, times) {
  let last = null;
  for (let i = 0; i < (times || 8); i += 1) {
    try { await parts.sync.keys.admit(); } catch (e) { /* nothing new to admit */ }
    try { last = await parts.sync.pullNow(); } catch (e) { diag('pull threw ' + e.message); }
    await sleep(200);
  }
  return last;
}
const refusalsHere = () => (store.warnings || [])
  .filter((w) => /refused|parked|noCoEdit|notMember|notOwner/.test(String(w)))
  .map((w) => String(w).slice(0, 220));

/**
 * ── THE MEASUREMENT THE AUDIT SAID IT HAD NOT MADE ─────────────────────────────────────────
 *
 * AUDIT §5 item 5: *"Every compaction finding (F2, F3, F4, F9) ... ran on the fleet rig ... I did
 * not reproduce these on the shipped binary, and that is the first thing I would do next."*
 *
 * This is that measurement. \`ops\` counts the lines this Mac's log holds; \`horizon\` is the
 * checkpoint stamp \`_persistOps\` skips at or below. On the fleet rig, one quit-and-open takes a
 * converged circle from 8 ops to 0 with the horizon covering everything — which is what makes the
 * fold's govRegs/_alive/acked-level answers disappear. Every §R row reports the shape at the top
 * of the launch AND at the end, so a green row says WHY it is green rather than merely that it is.
 */
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

/** The circle engine, armed, holding a key. Every §R phase starts here. */
async function armed() {
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  await waitFor(() => parts.keyring.currentEpoch(R.spaceId) > 0,
    { ...settleTimeout, what: 'this Mac to hold an epoch key' });
  return parts;
}

// ── §R1 · the owner grants 18.2's permission, through the shipped plan functions ────────────

test('§R1 the owner shares an entry AND grants „Familie darf bearbeiten" (18.2)', async () => {
  if (PHASE !== 'share-coedit') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  const parts = await armed();
  popover.useSharing(sharing);

  const id = 'coedit-' + Math.random().toString(36).slice(2, 10);
  const catId = store.state.categories[0].id;
  store.apply('createNoteInline', {
    id, date: R.date, text: R.text, categoryId: catId,
    visibility: 'privat', unhideCategoryId: null, lastCategoryId: catId,
  });

  // Two shipped plan functions, two shipped transactions — the same pair \`popover.js\` runs when
  // a person moves the level control and then ticks the box underneath it.
  let plan = null;
  store.txn('set-visibility', (tx) => {
    const x = tx.get('note', id);
    if (!x) return false;
    plan = sharing.planVisibilityChange(x, 'geteilt');
    if (!plan) return false;
    tx.note(id).set(plan.patch);
  });
  assert.ok(plan, 'planVisibilityChange declined — the note was not shareable');

  let grant = null;
  store.txn('set-coedit', (tx) => {
    const x = tx.get('note', id);
    if (!x) return false;
    grant = sharing.planCoEditChange(x, true);
    if (!grant) return false;
    tx.note(id).set(grant.patch);
  });
  assert.ok(grant, 'planCoEditChange declined — 18.2 has no gesture at all on this build');

  const mine = (store.state.notes || []).find((n) => n && n.id === id);
  assert.ok(mine, 'the entry vanished from the owner own board');
  assert.equal(mine.coEdit, true, 'the grant did not reach the owner own truth register');
  assert.equal(mine.visibility, 'geteilt');

  const pushed = await waitFor(async () => {
    const r = await parts.sync.pushNow();
    return r && r.pushed > 0 ? r : null;
  }, { ...settleTimeout, what: 'the grant to reach the relay' });
  assert.ok(pushed.pushed >= 1, 'nothing was pushed: ' + JSON.stringify(pushed));
  assert.deepEqual(WIRE.fetch, [], 'the sharing path reached for fetch: ' + JSON.stringify(WIRE.fetch));

  OUT.shapeAtEnd = logShape();
  OUT.noteId = id;
  OUT.entityKey = mine.entityKey || null;
  OUT.pushed = pushed.pushed;
  emit();
});

// ── §R2 · the invited co-editor makes the edit ──────────────────────────────────────────────

test('§R2 an invited co-editor edits the entry — the gesture the app offers (18.2)', async () => {
  if (PHASE !== 'coedit') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  const parts = await armed();

  const found = await waitFor(async () => {
    try { await parts.sync.keys.admit(); } catch (e) { /* nothing new */ }
    await parts.sync.pullNow();
    return (store.state.notes || []).find((n) => n && n.text === R.text) || null;
  }, { timeout: 60000, interval: 400, what: 'the co-editable entry to cross' });

  assert.equal(found.isForeign, true, 'the entry is not marked as somebody else own');
  assert.equal(found.coEdit, true, 'the GRANT did not travel — 18.2 cannot even be attempted');

  // THE DOOR, asked exactly the way the product asks it before it offers the gesture.
  assert.equal(sharing.canEditEntry(found), true,
    'the product refuses the gesture on the receiving Mac — 18.2 offers nothing here');
  assert.equal(store.familyCoEditLevelOf(found.entityKey), 'geteilt',
    'the author-side fold does not grant co-edit on this Mac');

  assert.equal(store.applyCoEdit(found.entityKey, { 'pub.text': R.newText }), true,
    'applyCoEdit declined the write');
  const after = (store.state.notes || []).find((n) => n && n.entityKey === found.entityKey);
  assert.equal(after.text, R.newText, 'the co-editor cannot even see her own edit');

  const pushed = await waitFor(async () => {
    const r = await parts.sync.pushNow();
    return r && r.pushed > 0 ? r : null;
  }, { ...settleTimeout, what: 'the co-edit to reach the relay' });
  assert.deepEqual(WIRE.fetch, [], 'the co-edit path reached for fetch');

  OUT.shapeAtEnd = logShape();
  OUT.entityKey = found.entityKey;
  OUT.newText = R.newText;
  OUT.pushed = pushed.pushed;
  emit();
});

// ── §R3 · does it arrive? THE ROW THE AUDIT SAYS IS RED — audit F2 ──────────────────────────

test('§R3 the co-edit reaches a Mac that has quit and opened since the grant (18.2)', async () => {
  if (PHASE !== 'coedit-receive') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  const parts = await armed();
  await pullHard(parts, 8);
  OUT.shapeAtEnd = logShape();

  const row = (store.state.notes || []).find((n) => n
    && (n.entityKey === R.entityKey || n.text === R.newText || n.text === R.text)) || null;
  const refused = refusalsHere();
  for (const w of refused) diag('WARN ' + w);
  OUT.text = row ? row.text : null;
  OUT.refusals = refused.slice(0, 6);
  OUT.sawNoCoEdit = refused.some((w) => /noCoEdit/.test(w));
  emit();

  assert.ok(row, 'the entry is not on this Mac at all — the rig, not the finding');
  assert.equal(row.text, R.newText,
    'AUDIT F2 / STORY 18.2. This Mac quit and opened between the owner grant and the co-edit — '
    + 'which in this driver is every Mac on every phase, and in the field is every family from '
    + 'its second launch onward. _persistOps absorbed the granting pub.set into a register, '
    + 'authz.js stage 3a rebuilt govRegs from the ops in THIS fold and found none, and stage 3b '
    + 'refused the co-edit noCoEdit — a reason absent from CURABLE_REFUSALS, so the line is '
    + 'dropped and the relay since-cursor has moved past it. TERMINAL. '
    + 'Measured here: this Mac reads ' + JSON.stringify(row ? row.text : null)
    + ' while the co-editor reads ' + JSON.stringify(R.newText)
    + ' after 8 pulls. Refusals on this launch: ' + JSON.stringify(refused)
    + ' — WAITING ON: the fix to core/authz.js stage 3a (govRegs must be seeded from the '
    + 'register map, not folded from the ops present in this fold).');
});

// ── §R4 · the exposure badge, one launch later — audit F4 ───────────────────────────────────

test('§R4 the exposure badge still says Geteilt on a later launch (16.6)', async () => {
  if (PHASE !== 'exposure') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  await armed();
  OUT.shapeAtEnd = logShape();

  const mine = (store.state.notes || []).find((n) => n && n.id === R.noteId);
  OUT.visibility = mine ? mine.visibility : null;
  OUT.exposure = mine ? mine.exposure : null;
  OUT.exposedLevel = mine ? sharing.exposedLevel(mine) : null;
  OUT.pendingWord = mine ? sharing.exposurePending(mine) : null;
  emit();

  assert.ok(mine, 'the owner own entry is gone from her board');
  assert.equal(mine.visibility, 'geteilt',
    'NON-VACUITY: the entry really is still shared — the family really can still read it');
  assert.deepEqual(mine.exposure, { level: 'geteilt', pending: false },
    'AUDIT F4 / STORY 16.6. store.js#_exposureCtx answers lastAckedPubLevel by walking '
    + '_log.lines(), and lines are exactly what a persist absorbs. On this launch the walk sees '
    + 'nothing, so materialize.js#exposureOf reads (null || privat). ADR 004 section 6, quoted in '
    + 'the source directly above that function: "the badge never UNDER-reports what others can '
    + 'see." Measured here: visibility ' + JSON.stringify(mine ? mine.visibility : null)
    + ' · exposure ' + JSON.stringify(mine ? mine.exposure : null)
    + ' · exposedLevel(entry) ' + JSON.stringify(mine ? sharing.exposedLevel(mine) : null)
    + ' — note that exposedLevel takes the HIGHER of acked and folded, so the §7.4 downgrade '
    + 'SENTENCE is unaffected and only the BADGE lies. WAITING ON: store.js#_exposureCtx '
    + '(the acked-pub-level trail must survive compaction, or be rebuilt from the checkpoint).');
});

// ── §R5 · the quiet „neu" dot on a peer's brand-new entry — audit F6 ────────────────────────

test('§R5 a peer brand-new entry carries the quiet „neu" dot (17.5)', async () => {
  if (PHASE !== 'neu') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  const parts = await armed();

  const row = await waitFor(async () => {
    try { await parts.sync.keys.admit(); } catch (e) { /* nothing new */ }
    await parts.sync.pullNow();
    return (store.state.notes || []).find((n) => n && n.text === R.text) || null;
  }, { timeout: 60000, interval: 400, what: 'the peer entry to cross' });

  await waitFor(() => document.querySelector('.board') && document.body.textContent.includes(R.text),
    { timeout: 8000, what: 'the entry to render' });
  const dots = document.querySelectorAll('.neu-dot').length;

  OUT.shapeAtEnd = logShape();
  OUT.isNew = row.isNew === undefined ? null : row.isNew;
  OUT.isForeign = row.isForeign;
  OUT.neuDots = dots;
  emit();

  assert.equal(row.isForeign, true, 'NON-VACUITY: this really is a peer entry, freshly arrived');
  assert.equal(row.isNew, true,
    'AUDIT F6 / STORY 17.5. materialize.js#isNewOf needs one of ctx.seqOf / ctx.isNew and its '
    + 'only reachable exit without them is return false. store.js#_project() supplies me, '
    + 'familySpaceId, _memberCtx(), _exposureCtx() and defaultSettings — and none of seqOf, '
    + 'isNew, lastSeenSeq or levelDecreased. Everything downstream is wired and blameless: '
    + 'board.js appends the dot, layout.js gates it on foreign, app.css styles it, and '
    + 'settings.lastSeenSeq.<spaceId> exists as a pref. Measured here on an entry that arrived '
    + 'seconds ago: isNew ' + JSON.stringify(row.isNew) + ' · .neu-dot nodes on the whole board '
    + dots + '. WAITING ON: store.js#_project() (one call site short of joining them).');
  assert.ok(dots >= 1, 'the projection says isNew but the board drew no dot — that would be board.js');
});

// ── §R6 · a removal, across a relaunch — audit F3, and the question §5.6 left open ──────────

test('§R6 a removed Mac cannot publish into the circle it was removed from (20.2)', async () => {
  if (PHASE !== 'removed-write') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  popover.useSharing(sharing);

  const id = 'nachher-' + Math.random().toString(36).slice(2, 10);
  const catId = store.state.categories[0].id;
  store.apply('createNoteInline', {
    id, date: R.date, text: R.text, categoryId: catId,
    visibility: 'privat', unhideCategoryId: null, lastCategoryId: catId,
  });
  let plan = null;
  store.txn('set-visibility', (tx) => {
    const x = tx.get('note', id);
    if (!x) return false;
    plan = sharing.planVisibilityChange(x, 'geteilt');
    if (!plan) return false;
    tx.note(id).set(plan.patch);
  });

  let pushed = null;
  let threw = null;
  try { pushed = await parts.sync.pushNow(); } catch (e) { threw = String((e && e.message) || e); }
  let rosterOk = null;
  try { rosterOk = (await parts.sync.keys.roster()).ok; } catch (e) { rosterOk = 'threw: ' + e.message; }

  OUT.shapeAtEnd = logShape();
  OUT.noteId = id;
  OUT.planned = !!plan;
  OUT.pushed = pushed && Number.isFinite(pushed.pushed) ? pushed.pushed : 0;
  OUT.pushError = threw;
  OUT.epoch = parts.keyring.currentEpoch(R.spaceId);
  OUT.rosterOk = rosterOk;
  emit();

  assert.equal(rosterOk, false, 'the relay still serves a removed member');
  assert.equal(OUT.pushed, 0,
    'a removed member pushed ' + OUT.pushed + ' op(s) into the circle it was removed from');
  assert.deepEqual(WIRE.fetch, [], 'the removed engine reached for fetch');
});

test('§R6 …and no remaining Mac admits it, on a launch after the removal (20.2)', async () => {
  if (PHASE !== 'removed-check') skip(PHASE ? 'phase is ' + PHASE : SKIP_REASON);
  OUT.shapeAtStart = logShape();
  const parts = await armed();
  await pullHard(parts, 6);
  OUT.shapeAtEnd = logShape();

  const onBoard = (store.state.notes || []).some((n) => n && n.text === R.text);
  // THE SECOND LAYER, asked separately and on purpose. The audit F3 claim is not about the board
  // — materialize()'s render-time currentMembers filter still hides a removed member's entries
  // today — it is about whether the FOLD still refuses to admit them. So this row asks the
  // register map, which is what the fold wrote, rather than the projection, which is what the
  // filter drew. Two layers became one; this is the row that can tell them apart.
  let inRegisters = false;
  let regError = null;
  try {
    for (const [k, cells] of store.registers()) {
      if (String(k).slice(0, 6) !== 'fnote:') continue;
      const c = cells.get('pub.text');
      if (c && c.value === R.text) { inRegisters = true; break; }
    }
  } catch (e) { regError = String((e && e.message) || e); }

  const refused = refusalsHere();
  for (const w of refused) diag('WARN ' + w);
  OUT.onBoard = onBoard;
  OUT.inRegisters = inRegisters;
  OUT.regError = regError;
  OUT.sawNotMember = refused.some((w) => /notMember/.test(w));
  OUT.refusals = refused.slice(0, 6);
  emit();

  assert.equal(onBoard, false,
    'STORY 20.2: a removed member entry is on a remaining Mac board. Text '
    + JSON.stringify(R.text));
  assert.equal(inRegisters, false,
    'AUDIT F3 / STORY 20.2, the second layer. The entry is not drawn — materialize()\\'s '
    + 'currentMembers filter still hides it — but this Mac FOLD ADMITTED it and its register map '
    + 'now holds it. authz.js stage 2 derives currentMembers from a fresh fold of the ops in this '
    + 'fold; _absorbedAttestOps rebuilds every dev.* cell and no _alive cell, so a removed member '
    + 'is alive again inside the fold. store.js#_withdrawalsOf own docblock names the hazard: '
    + '"the two mechanisms must be designed together or a re-join will resurrect what the other '
    + 'one hid." WAITING ON: core/authz.js stage 2 + store.js#_absorbedAttestOps.');
});
`;

/**
 * @param {string} tag which Mac
 * @param {object} input the fixture parameters this phase needs; `phase` and `origin` are added
 * @returns {{ok:boolean, out:object, rows:Array, raw:string}}
 */
function run(tag, input) {
  launches += 1;
  const spec = { origin: ORIGIN, ...input };
  const file = path.join(WORK, `phase-${String(launches).padStart(2, '0')}-${tag}-${spec.phase}.js`);
  writeFileSync(file, `globalThis.__LZP_E2E = ${JSON.stringify(spec)};\n${SOURCE}\n${RELAUNCH_PHASES}`);

  let raw = '';
  let code = 0;
  try {
    raw = String(sh(binFor(tag), ['--test', file, '--scratch', path.join(WORK, 'scratch-' + tag)], {
      env: { ...process.env, LZP_SYNC_ORIGIN: ORIGIN },
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    raw = String(e.stdout || '') + String(e.stderr || '');
    code = e.status === undefined ? 1 : e.status;
  }

  // Rows that are neither `ok … # SKIP` nor a skip are this phase's real verdicts.
  const rows = raw.split('\n')
    .filter((l) => /^(not )?ok \d/.test(l))
    .map((l) => ({ ok: l.startsWith('ok '), skip: / # SKIP/.test(l), line: l.trim() }));
  const live = rows.filter((r) => !r.skip);

  writeFileSync(file.replace(/\.js$/, '.out.txt'), raw);
  let out = {};
  for (const l of raw.split('\n')) {
    const m = l.match(/^#\s*E2E-OUT\s+(\{.*\})\s*$/);
    if (m) { try { out = JSON.parse(m[1]); } catch { /* keep the last good one */ } }
  }

  const ok = code === 0 && live.length > 0 && live.every((r) => r.ok);
  // THE REFUSAL LEDGER (LZP-1008). `OUT.refused` counts the lines `store.warnings` records
  // as refused or parked in this launch. It is the number finding F-SHELL-1 was measured
  // by — 0 → 6 → 13 → 25 over four launches of the founder — and the acceptance bar.
  results.push({ tag, phase: spec.phase, ok, rows: live,
    refused: Number.isFinite(out.refused) ? out.refused : null });

  const mark = ok ? 'ok  ' : 'NOT OK';
  log(`${mark} ${tag} · ${spec.phase}  (${live.length} row${live.length === 1 ? '' : 's'})`);
  for (const r of live) log(`      ${r.line}`);
  if (!ok) {
    log('  ── output ──');
    log(raw.split('\n').filter((l) => l.trim()).map((l) => '  ' + l).join('\n'));
  }
  return { ok, out, rows: live, raw };
}

function must(r, what) {
  if (!r.ok) {
    log(`Bail out! ${what} failed — the demonstration cannot continue`);
    log(relayLog.join(''));
    process.exit(1);
  }
  return r.out;
}

/**
 * A step that is REPORTED rather than required.
 *
 * Exactly one thing in this demonstration is attempted and not required, and it is not a
 * convenience: **finding F-SHELL-3** — `unshare-owner (B)`. The admin's „→ Privat" reaches the
 * owner's Mac as a DELETION rather than as a reversion, so the owner loses her own entry. That is
 * a defect in `family/sharing.js`'s unshare path; every other hop in this file is required.
 *
 * F-SHELL-1 used to live here and no longer does. It was two defects: `selfAttest` re-signing on
 * every launch (closed in `crypto/identity.js#ensureAttestedDevice`) and the checkpoint absorbing
 * the attestation op out of `foldAuthorized`'s input (closed in `store.js#_absorbedAttestOps`).
 *
 * Marking a step `attempt` rather than deleting it keeps the failure VISIBLE in every run, which
 * is what a finding is for.
 */
const attempted = [];
function attempt(r, what) {
  attempted.push({ what, ok: r.ok });
  if (!r.ok) log(`#    ⚠ ATTEMPTED, NOT REQUIRED — ${what} did not complete`);
  return r.out;
}

/**
 * §6c · A RELAUNCH-BATTERY STEP. See the header for why these are not `must()`.
 *
 * The battery's rows assert the CORRECT behaviour of four stories the audit moved to FAIL, in the
 * state the shipped app is in from its second launch onward. They are red on arrival against
 * today's `core/authz.js` / `store.js` and go green when that owner's fix lands. Each carries the
 * finding it is waiting for, so a red line in this run is a work order and not a mystery.
 *
 * A red row here NEVER fails the demonstration — the exit code still belongs to the 80 rows that
 * were green before the audit — but it is printed in the phase list AND scored in the report, so
 * it cannot be run past.
 */
const battery = [];
function relaunchRow(r, what, story, waitingOn) {
  const tag = (what.match(/\(([A-E])\)/) || [])[1] || null;
  battery.push({ what, story, waitingOn, ok: r.ok, out: r.out || {}, disk: tag ? diskOf(tag) : null });
  log(`#    ${r.ok ? '✓' : '✗'} §R ${what} · story ${story} · ${r.ok ? 'GREEN' : 'RED — waiting on ' + waitingOn}`);
  return r.out || {};
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════

const TODAY = new Date().toISOString().slice(0, 10);
const DAY = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
};

log('');
log('# ── 1. Papa creates the Familienkreis ────────────────────────────────────────────────');
const created = must(run('A', {
  phase: 'create', displayName: MACS.A.name, colorRef: MACS.A.color, extraInvites: 2,
}), 'create');
const SPACE = created.spaceId;
log(`#    space ${SPACE} · transport ${created.transportKind} · ${created.bridgeCalls} bridge calls`);
log(`#    three invite codes minted in one launch — see below on why the launch count is minimal`);

log('');
log('# ── 2. Mama, Oma and Opa join, each from its OWN instance ────────────────────────────');
const joined = {};
for (const [i, tag] of ['B', 'C', 'D'].entries()) {
  joined[tag] = must(run(tag, {
    phase: 'join', code: created.codes[i], spaceId: SPACE,
    displayName: MACS[tag].name, colorRef: MACS[tag].color,
  }), `join (${tag})`);
}
const mama = joined.B;
const oma = joined.C;
const opa = joined.D;

log('');
log('# ── 3. the engines settle: the admin delivers the epoch key, D9 clears ───────────────');
// ONE round each, and the count is the MINIMUM rather than a convenience.
//
//   · Every join ROTATES the epoch (ADR 002 §4.1), so after three joins the ring is ahead of
//     anything a joiner has been handed. Only the admin's `keys.deliver()` wraps the current
//     epoch to their devices, and it can only wrap to devices that already exist — so the admin
//     settles FIRST, once every joiner exists.
//   · It USED to be that every additional launch made the circle worse — finding F-SHELL-1, whose
//     measurement was the founder's refusal ledger growing 0 → 6 → 13 → 25 over four launches,
//     after which ADR 003 §8.2 had released the cursor and that peer's entries could never be
//     admitted again. Running this loop twice instead of once took the demonstration from "the
//     entry crosses to both peers" to "the entry crosses to neither". Both halves are closed
//     (LZP-1008) and the ledger is now printed in the report so a regression is a NUMBER and not
//     a story. The loop is still minimal because the minimum is what the protocol needs, and the
//     invites are still minted in launch 1 for the same reason.
for (const tag of ['A', 'B', 'C', 'D']) {
  must(run(tag, { phase: 'settle', spaceId: SPACE, expectMembers: 4 }), `settle (${tag})`);
}
const settleB = must(run('A', { phase: 'settle', spaceId: SPACE, expectMembers: 4 }), 'settle (A, final)');
log(`#    transport in the running engine: ${settleB.transportKind} · epoch ${settleB.epoch}`);

log('');
log('# ── 5. a Geteilt entry crosses ───────────────────────────────────────────────────────');
const SHARED = 'Omas Geburtstag';
must(run('A', { phase: 'share', spaceId: SPACE, text: SHARED, date: DAY(9) }), 'share (A)');
// THE CLAIM: a Geteilt entry authored on one shipped instance reaches ANOTHER shipped instance,
// sealed, transported through `sync_request`, and opened there with its text. That is what the
// conformance audit put in doubt and it is what this step requires.
//
// It is required of at least one peer and REPORTED for both. That framing was written when
// F-SHELL-1 made which peer admitted the entry a coin flip; since LZP-1008 both peers admit it on
// every run measured, and the line printed below says which did. The weaker bar is kept as the
// bail-out condition so that a regression reads as "the entry reached NEITHER peer" — the
// sentence that is actually about the product — rather than as an arbitrary named Mac going red.
const receivers = [];
for (const tag of ['B', 'C']) {
  // TWO LAUNCHES, because that is what a person does and because `store.init()` re-judges held
  // ops on every launch (`unparkAttested`, L-3). An op parked `unattestedDevice` can still be
  // admitted on the next launch; one refused `badAttestation` cannot, and that asymmetry is
  // exactly finding F-SHELL-1.
  let ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt += 1) {
    const r = run(tag, { phase: 'receive', spaceId: SPACE, text: SHARED, date: DAY(9) });
    ok = r.ok;
  }
  receivers.push({ tag, ok });
  if (!ok) attempted.push({ what: `receive (${tag})`, ok: false });
}
if (!receivers.some((r) => r.ok)) {
  log('Bail out! the shared entry reached NEITHER peer — the demonstration\'s central claim failed');
  process.exit(1);
}
log(`#    the entry crossed to: ${receivers.filter((r) => r.ok).map((r) => r.tag).join(', ')}`
  + (receivers.some((r) => !r.ok)
    ? ` · blocked on ${receivers.filter((r) => !r.ok).map((r) => r.tag).join(', ')} (F-SHELL-3)`
    : ''));

log('');
log('# ── 6. the entry crosses the OTHER way, and the unshare button ─────────────────────');
// Mama shares one of her own and the ADMIN receives it. This is the direction finding F-SHELL-1
// made impossible — `receive (A)` was 0 of 5 in `docs/v2/SHELL-VERIFICATION.md` §9 — and since
// LZP-1008 closed F-SHELL-1(b) (`store.js#_absorbedAttestOps`) it is REQUIRED, not attempted.
// It is the acceptance criterion of LZP-1008 in one line: does the founder see a joiner's entry,
// in the app we ship, on a relaunch.
const MAMAS = 'Elternabend';
must(run('B', { phase: 'share', spaceId: SPACE, text: MAMAS, date: DAY(14) }), 'share (B)');
must(run('A', { phase: 'receive', spaceId: SPACE, text: MAMAS, date: DAY(14) }), 'receive (A)');
must(run('A', { phase: 'unshare', spaceId: SPACE, text: MAMAS }), 'unshare (A)');
// STILL ATTEMPTED, and it is NOT F-SHELL-1: the owner's board loses the entry outright instead of
// reverting it to Privat — tier-2 row §10, owner `family/sharing.js`'s unshare path. See
// `docs/v2/FINDINGS.md` F-SHELL-3.
attempt(run('B', { phase: 'unshare-owner', spaceId: SPACE, text: MAMAS }), 'unshare-owner (B)');

log('');
log('# ── 6b. „Rückmeldung senden" — LZP-1009, bound by the app and taken by the relay ──────');
// The one path a Mac addresses that is not sync. It is REQUIRED, not attempted: `mount.js`
// binds the port (E10-1009-A, closed this pass) and `server/dev-server.mjs` binds the sink, so a
// 501 here is a real regression rather than a known gap.
must(run('B', { phase: 'feedback', spaceId: SPACE }), 'feedback (B)');

log('');
log('# ── 6c. THE RELAUNCH BATTERY — the four stories the audit moved to FAIL ──────────────');
// EVERY LINE BELOW IS A SEPARATE LAUNCH OF THE SHIPPED BINARY. That is the whole point: the Mac
// that reads a co-edit in §R3 has quit and opened since the grant in §R1, because a second phase
// is a second process over the same scratch directory. No helper simulates the reboot; the driver
// cannot avoid it.
const COEDIT_TEXT = 'Herbstferien';
const COEDIT_EDIT = 'Nordsee';
const coedit = relaunchRow(run('A', {
  phase: 'share-coedit', spaceId: SPACE, text: COEDIT_TEXT, date: DAY(21),
}), 'share-coedit (A)', '18.2', 'nothing — this is the author side and it must be green');

// 17.5 first, while the entry is genuinely NEW to Oma. A dot that is measured after the entry has
// been on the board for three launches is not a measurement of 17.5.
relaunchRow(run('C', { phase: 'neu', spaceId: SPACE, text: COEDIT_TEXT }),
  'neu (C)', '17.5', 'F6 · store.js#_project() supplies no seqOf/isNew/lastSeenSeq');

const edited = relaunchRow(run('B', {
  phase: 'coedit', spaceId: SPACE, text: COEDIT_TEXT, newText: COEDIT_EDIT,
}), 'coedit (B)', '18.2', 'nothing — the co-editor own client, which must stay green');

// BOTH directions, and they are two different claims. Oma is a BYSTANDER; Papa is the entry's
// OWNER. If only one of them is red the finding is about receiving; if both are, 18.2 is dead.
for (const tag of ['C', 'A']) {
  relaunchRow(run(tag, {
    phase: 'coedit-receive', spaceId: SPACE,
    entityKey: edited.entityKey || coedit.entityKey || null,
    text: COEDIT_TEXT, newText: COEDIT_EDIT,
  }), `coedit-receive (${tag})`, '18.2', 'F2 · authz.js stage 3a rebuilds govRegs from ops only');
}

relaunchRow(run('A', { phase: 'exposure', spaceId: SPACE, noteId: coedit.noteId }),
  'exposure (A)', '16.6', 'F4 · store.js#_exposureCtx walks _log.lines()');

log('');
log('# ── 7. the founder LEAVES — the circle is now founder-less ───────────────────────────');
must(run('A', { phase: 'leave', spaceId: SPACE }), 'leave (A)');
must(run('B', { phase: 'settle', spaceId: SPACE, expectMembers: 3 }), 'settle (B, post-leave)');
must(run('C', { phase: 'settle', spaceId: SPACE, expectMembers: 3 }), 'settle (C, post-leave)');

log('');
log('# ── 8. THE CO-SIGNATURE, in the founder-less circle ──────────────────────────────────');
const ask = must(run('B', {
  phase: 'cosign-ask', spaceId: SPACE, target: opa.memberId,
}), 'cosign-ask (B)');
log(`#    the relay refused with: ${ask.reason} · ${ask.eligible} member(s) may co-sign`);
const sign = must(run('C', {
  phase: 'cosign-sign', spaceId: SPACE, request: ask.request,
}), 'cosign-sign (C)');
log(`#    co-signed by ${sign.by} — a different Mac, a different key`);
const spent = must(run('B', {
  phase: 'cosign-spend', spaceId: SPACE, target: opa.memberId,
  answer: sign.answer, terms: ask.terms,
}), 'cosign-spend (B)');
log(`#    authorizedBy=${spent.authorizedBy} · epoch ${spent.epochBefore} → ${spent.epochAfter}`);

log('');
log('# ── 9. the removed Mac, and the two-member caveat ────────────────────────────────────');
must(run('D', {
  phase: 'removed', spaceId: SPACE, epochBefore: spent.epochBefore,
}), 'removed (D)');
// §R6 · 20.2 ACROSS A RELAUNCH. Opa was removed one launch ago with a real epoch rotation; he now
// quits, opens and writes. The audit could not answer this one — its §5 item 6 says so in as many
// words: *"whether epoch rotation independently blocks a removed member in the field is a question
// I did not answer."* The two rows below answer it in the shipped app, and they answer it in two
// separately reported layers: `pushed`/`rosterOk` is the relay-and-crypto layer, `inRegisters` is
// the FOLD, which is the layer F3 is actually about.
const REMOVED_TEXT = 'NACH DER ENTFERNUNG';
relaunchRow(run('D', {
  phase: 'removed-write', spaceId: SPACE, text: REMOVED_TEXT, date: DAY(28),
}), 'removed-write (D)', '20.2', 'F3 · if this is RED a removed member can still publish');
relaunchRow(run('B', { phase: 'removed-check', spaceId: SPACE, text: REMOVED_TEXT }),
  'removed-check (B)', '20.2', 'F3 · authz.js stage 2 rebuilds no _alive cell after a persist');

must(run('B', { phase: 'settle', spaceId: SPACE, expectMembers: 2 }), 'settle (B, post-removal)');
const stranded = must(run('B', { phase: 'stranded', spaceId: SPACE, target: oma.memberId }), 'stranded (B)');
// F-SHELL-2's deciding number, printed rather than buried in a phase file. `eligibleCosigners`
// answers log ∩ roster when this Mac HOLDS a roster and `null` (UNKNOWN) for a positive log-only
// count when it does not — so the two numbers together say which defect F-SHELL-2 is.
// `SHELL-VERIFICATION.md` §5 recorded eligible=2, which no log state can produce with a roster.
log(`#    eligibleCosigners=${JSON.stringify(stranded.eligibleFromLog)} · rosterCache=`
  + `${JSON.stringify(stranded.rosterCached)} · alive on the relay=${JSON.stringify(stranded.aliveOnRelay)}`);

log('');
log('# ── 10. solo mode, on an instance that never joined anything ─────────────────────────');
must(run('E', { phase: 'solo', date: TODAY }), 'solo (E)');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT
// ═════════════════════════════════════════════════════════════════════════════════════════════

const totalRows = results.reduce((n, r) => n + r.rows.length, 0);
const attemptedPhases = new Set(attempted.map((a) => a.what.replace(/\s*\(.*$/, '')));
// The relaunch battery's phases are scored separately and never decide the exit code — see
// `relaunchRow`'s docblock. Promote them into `must()` on the day the score reads 6 of 6.
const BATTERY_PHASES = new Set(battery.map((b) => b.what.replace(/\s*\(.*$/, '')));
const failed = results.filter((r) => !r.ok
  && !attemptedPhases.has(r.phase) && !BATTERY_PHASES.has(r.phase));

log('');
log('# ═════════════════════════════════════════════════════════════════════════════════════');
log(`# ${launches} launches of the shipped .app · ${totalRows} rows · ${failed.length} phase(s) failed`);
for (const a of attempted) {
  log(`# attempted, not required: ${a.what} — ${a.ok ? 'completed' : 'BLOCKED'}`);
}
const ledger = results.filter((r) => r.refused !== null);
const ledgerTotal = ledger.reduce((n, r) => n + r.refused, 0);
log(`# THE REFUSAL LEDGER: ${ledgerTotal} across ${ledger.length} reporting launch(es)`
  + ` — ${ledger.map((r) => `${r.tag}/${r.phase}:${r.refused}`).join(' ')}`);
const receivedA = results.find((r) => r.tag === 'A' && r.phase === 'receive');
log(`# THE FOUNDER RECEIVED A JOINER'S ENTRY: ${receivedA ? (receivedA.ok ? 'YES' : 'NO') : 'not attempted'}`);

// ── §6c · THE RELAUNCH BATTERY'S SCORE ───────────────────────────────────────────────────────
//
// The audit's finding in one number. `6 of 6` is the acceptance signal for the four compaction
// fixes; anything less names the story and the finding it is still waiting on.
const batteryGreen = battery.filter((b) => b.ok).length;
log(`# THE RELAUNCH BATTERY: ${batteryGreen} of ${battery.length} green`
  + ` — stories ${[...new Set(battery.map((b) => b.story))].sort().join(', ')}`);
for (const b of battery) {
  const m = [];
  if (b.out.text !== undefined) m.push(`reads=${JSON.stringify(b.out.text)}`);
  if (b.out.newText !== undefined) m.push(`co-editor wrote=${JSON.stringify(b.out.newText)}`);
  if (b.out.exposure !== undefined) m.push(`exposure=${JSON.stringify(b.out.exposure)}`
    + ` visibility=${JSON.stringify(b.out.visibility)}`);
  if (b.out.isNew !== undefined) m.push(`isNew=${JSON.stringify(b.out.isNew)} .neu-dot=${b.out.neuDots}`);
  if (b.out.pushed !== undefined && b.what.startsWith('removed-write')) {
    m.push(`pushed=${b.out.pushed} rosterOk=${JSON.stringify(b.out.rosterOk)} epoch=${b.out.epoch}`);
  }
  if (b.out.onBoard !== undefined) m.push(`onBoard=${b.out.onBoard} inRegisters=${b.out.inRegisters}`
    + ` sawNotMember=${b.out.sawNotMember}`);
  if (b.out.sawNoCoEdit !== undefined) m.push(`sawNoCoEdit=${b.out.sawNoCoEdit}`);
  log(`#   ${b.ok ? 'GREEN' : 'RED  '} ${b.what.padEnd(22)} story ${b.story}`
    + `  ${m.join(' · ')}${b.ok ? '' : `  ← ${b.waitingOn}`}`);
  // WHY it is green or red, in the two numbers the audit's mechanism is stated in. `shapeAtStart`
  // is this Mac's log the moment the phase's first row ran — i.e. what the PREVIOUS quit left —
  // and `disk.ops.jsonl` is the same fact read from outside the app by this script.
  const d = b.disk && b.disk['ops.jsonl'];
  if (b.out.shapeAtStart || d) {
    log(`#         log at launch ${JSON.stringify(b.out.shapeAtStart ?? null)}`
      + ` · after ${JSON.stringify(b.out.shapeAtEnd ?? null)}`
      + ` · ops.jsonl on disk ${d ? d.lines + ' line(s), ' + d.bytes + ' B' : 'absent'}`);
  }
}
log(`# transport reported by the running family engine: ${settleB.transportKind}`);
log(`# space ${SPACE} · founder-less removal authorizedBy=${spent.authorizedBy} · `
  + `epoch ${spent.epochBefore} → ${spent.epochAfter}`);
log('# ═════════════════════════════════════════════════════════════════════════════════════');

// ── THE RELAY'S OWN STORE IS THE SECOND WITNESS ──────────────────────────────────────────────
//
// Everything above is measured from inside the app. This is measured from the other end of the
// wire, by a process that is not the app and shares no code with the page: the rows
// `server/adapters/file.js` actually wrote. If the bridge had not carried the bytes, this file
// would be empty.
try {
  // `server/adapters/file.js` writes `{format, v, state}` where every collection is a Map encoded
  // as `{"$m": [[k, v], …]}`. Counting the entries is enough here — the VALUES are sealed
  // envelopes and member rows, and this script has no business decoding either.
  const raw = JSON.parse(readFileSync(path.join(relayDir, 'sync-store.json'), 'utf8'));
  const unwrap = (v) => (v && typeof v === 'object' && v.$o ? v.$o : v);
  const state = unwrap(raw.state) || {};
  const n = (k) => {
    const v = state[k];
    if (v && Array.isArray(v.$m)) return v.$m.length;
    if (v && v.$o) return Object.keys(v.$o).length;
    if (Array.isArray(v)) return v.length;
    return v && typeof v === 'object' ? Object.keys(v).length : 0;
  };
  const parts = Object.keys(state).map((k) => `${k} ${n(k)}`).join(' · ');
  log(`# the relay's own store, written by a process that shares no code with the page: ${parts}`);
} catch (e) {
  log(`# (the relay store could not be read: ${e.message})`);
}

process.exit(failed.length === 0 ? 0 : 1);
