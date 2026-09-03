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

/**
 * @param {string} tag which Mac
 * @param {object} input the fixture parameters this phase needs; `phase` and `origin` are added
 * @returns {{ok:boolean, out:object, rows:Array, raw:string}}
 */
function run(tag, input) {
  launches += 1;
  const spec = { origin: ORIGIN, ...input };
  const file = path.join(WORK, `phase-${String(launches).padStart(2, '0')}-${tag}-${spec.phase}.js`);
  writeFileSync(file, `globalThis.__LZP_E2E = ${JSON.stringify(spec)};\n${SOURCE}`);

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
const failed = results.filter((r) => !r.ok && !attemptedPhases.has(r.phase));

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
