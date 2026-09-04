#!/usr/bin/env node
// scripts/shell-offline-relaunch.mjs — THE OFFLINE HALF OF THE DEMONSTRATION.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MEASUREMENT THIS EXISTS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `scripts/shell-family-e2e.mjs`'s §6c battery closed F2/F3/F4/F6 on the shipped `.app` FOR A MAC
// THAT REOPENS AGAINST A LIVE RELAY, and the verify pass that ran it said plainly what it could
// not reach:
//
//     "F2/F3/F4 were real for a Mac quitting and opening OFFLINE or against a pruned relay — an
//      ordinary Tuesday, not exotic — and were never reachable in the acceptance topology. I did
//      not close the offline case end-to-end on the binary; that remains the single most valuable
//      missing measurement."
//
// This driver is that measurement, and it is deliberately the CHEAPEST honest form of it: it does
// not build a second circle. It re-uses the one `shell-family-e2e.mjs --keep` already built —
// five real `.app` copies, five WebKit stores holding five real device identities, five
// `--scratch` directories holding real `board.json` / `checkpoint.json` / `ops.jsonl` — and
// relaunches those same binaries over those same disks WITH THE RELAY DEAD.
//
//     node scripts/shell-family-e2e.mjs --keep --port 8797     # prints "work kept at <dir>"
//     node scripts/shell-offline-relaunch.mjs --work <dir>     # this file
//
// `--work` may be omitted if `LZP_E2E_WORK` is set. The relay must ALREADY be down; this driver
// refuses to run if the origin answers, because a green row measured against a live relay is the
// acceptance topology wearing this file's name, which is worse than no measurement.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS AND IS NOT DIFFERENT FROM THE ONLINE RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   SAME   the binary, the web bundle, the bridge, `chooseTransport` → bridge, the configured
//          origin, the bundle identifiers, the WebKit stores, the Keychain items, the scratch
//          directories, and the fixture values — lifted verbatim out of the generated
//          `phase-NN-*.js` files the online run left behind, so no value here is re-derived.
//   DIFFERENT  nothing answers at the origin.
//
// The phase file is `<one fixture line> + tests/tier2/shell-offline-relaunch.dom.js`, the same
// shape `shell-family-e2e.mjs` uses. That tier-2 file is this driver's counterpart and explains
// why it cannot be a §R phase: every §R row begins by awaiting `mount.circleEngine()`, and
// offline that wait is the only thing that ever gets measured (MEASURED: phase-22/§R3 against a
// dead relay is `not ok … waitFor timed out: the circle engine` after 25 903 ms).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ANSWER — measured 2026-09-04, two runs, four rows each
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     THE OFFLINE BATTERY: 4 of 4 green — stories 16.6, 17.5, 18.2, 20.2
//     the circle engine armed on 0 of 4 offline launches, in BOTH runs
//
// F2 (18.2) is green on the co-editor AND on her peer; F4 (16.6) is green on the owner; F3 (20.2)
// is green on a remaining Mac; F6 (17.5)'s INPUT is intact and the dot itself is unreachable
// offline by design (see the tier-2 file's §O3 — `_lastSeenSeqCtx`'s session floor).
//
// So the audit's own pricing stands and is now measured on both sides: the fleet rig IS the
// stricter environment, and the shipped app does not lose these four when the relay is gone.
//
// ⚠ TWO RUNS, NOT ONE, AND THAT IS STRUCTURAL. `shell-family-e2e.mjs` phase 24 is `A · leave`
// and the removal is phases 30-32, so a single stop point cannot hold both the founder's
// exposure badge and a completed removal. Stop after `A · exposure` for F2/F4/F6; stop after
// `B · removed-check` for F2/F3/F6.
//
// ⚠ §O1 WRITES. `applyCoEdit` is the row's point and the write persists, so a second offline
// launch over the same disk reads the previous probe's text. The row asserts a NON-VACUITY (the
// text is not the owner's original) rather than an equality for exactly that reason.
//
// Zero npm dependencies.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const WORK = arg('work', process.env.LZP_E2E_WORK || '');
// `--only coedit,neu` — the online run may have been stopped at a phase boundary that leaves some
// Mac in the wrong state for a role (the founder LEAVES at phase 24, so `exposure` on A is only
// meaningful in a run stopped before it). Naming the roles is honest; running one that cannot
// hold and calling it red is not.
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',').map((x) => x.trim())) : null;
const TEST_FILE = path.join(REPO, 'tests/tier2/shell-offline-relaunch.dom.js');
const log = (s) => process.stdout.write(s + '\n');

if (!WORK || !existsSync(WORK)) {
  log('Bail out! pass --work <dir>, the directory `shell-family-e2e.mjs --keep` printed');
  process.exit(2);
}

// ── 1. recover the fixtures the online run wrote, rather than re-deriving them ─────────────────
//
// Each generated phase file's FIRST LINE is `globalThis.__LZP_E2E = {…};`. Those objects carry
// the entity key, the texts and the note id the online circle actually used. Reading them is the
// only honest source: a value re-invented here would describe a different circle.
const phases = {};
for (const f of readdirSync(WORK).filter((n) => /^phase-\d+-[A-E]-.*\.js$/.test(n)).sort()) {
  const first = readFileSync(path.join(WORK, f), 'utf8').split('\n', 1)[0];
  const m = first.match(/^globalThis\.__LZP_E2E = (\{.*\});$/);
  if (!m) continue;
  const spec = JSON.parse(m[1]);
  const tag = f.match(/^phase-\d+-([A-E])-/)[1];
  phases[`${tag}:${spec.phase}`] = spec;
}
// A role whose ONLINE phase never ran is not an error here: this driver is designed to be pointed
// at a run that was stopped deliberately. `shell-family-e2e.mjs` wipes every Mac's WebKit store
// and Keychain item in its `cleanup()` — with `--keep` as well — so a work dir left behind by a
// driver that EXITED normally has scratch files and no identities, and every launch over it mints
// a fresh member and refuses its own board ("this Mac's durable identity is member X, but
// board.json says Y" — MEASURED). The only way to reuse a circle is to stop the online driver
// with SIGKILL before its exit handler runs, which means stopping it at a phase boundary, which
// means some later phases are absent by design. Stopping AFTER phase 23 keeps the founder in the
// circle (phase 24 is `A-leave`); stopping after 32 has the removal but not the founder.
const have = (k) => phases[k] || null;

const ORIGIN = (phases[Object.keys(phases)[0]] || {}).origin;
if (!ORIGIN) { log('Bail out! no origin recovered from the phase files'); process.exit(2); }

// ── 2. PROVE the relay is down before a single launch ─────────────────────────────────────────
let alive = null;
try {
  const r = await fetch(`${ORIGIN}/api/v1/meta`, { signal: AbortSignal.timeout(3000) });
  alive = r.status;
} catch { alive = null; }
if (alive !== null) {
  log(`Bail out! ${ORIGIN}/api/v1/meta answered ${alive} — the relay is UP, and every row below `
    + 'would then be the acceptance topology under this file\'s name. Stop the relay first.');
  process.exit(2);
}
log(`# ${ORIGIN} is unreachable — this is the offline topology`);

// ── 3. one row = one launch of one instance over its own disk, with nothing answering ─────────
const binFor = (tag) => path.join(WORK, tag, 'LangzeitPlaner.app/Contents/MacOS/LangzeitPlaner');
const results = [];
let launches = 0;

function run(tag, spec, label) {
  if (ONLY && !ONLY.has(spec.role)) { skipped.push(`${spec.role} on ${tag} — not in --only`); return true; }
  launches += 1;
  const file = path.join(WORK, `offline-${String(launches).padStart(2, '0')}-${tag}-${spec.role}.js`);
  writeFileSync(file, `globalThis.__LZP_OFFLINE = ${JSON.stringify(spec)};\n${readFileSync(TEST_FILE, 'utf8')}\n`);

  let raw = '';
  let code = 0;
  try {
    raw = String(execFileSync(binFor(tag), ['--test', file, '--scratch', path.join(WORK, 'scratch-' + tag)], {
      stdio: 'pipe',
      env: { ...process.env, LZP_SYNC_ORIGIN: ORIGIN },
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    raw = String(e.stdout || '') + String(e.stderr || '');
    code = e.status === undefined ? 1 : e.status;
  }
  writeFileSync(file.replace(/\.js$/, '.out.txt'), raw);

  const rows = raw.split('\n')
    .filter((l) => /^(not )?ok \d/.test(l))
    .map((l) => ({ ok: l.startsWith('ok '), skip: / # SKIP/.test(l), line: l.trim() }))
    .filter((r) => !r.skip);
  let out = {};
  for (const l of raw.split('\n')) {
    const m = l.match(/^#\s*OFFLINE-OUT\s+(\{.*\})\s*$/);
    if (m) { try { out = JSON.parse(m[1]); } catch { /* keep the last good one */ } }
  }
  const ok = code === 0 && rows.length > 0 && rows.every((r) => r.ok);
  results.push({ tag, role: spec.role, label, ok, rows, out });

  log(`${ok ? 'ok  ' : 'NOT OK'} ${tag} · ${spec.role}  — ${label}`);
  for (const r of rows) log(`      ${r.line}`);
  if (out.offline) {
    log(`      offline proof: engineArmed=${JSON.stringify(out.offline.engineArmed)} `
      + `metaStatus=${JSON.stringify(out.offline.metaStatus)} `
      + `metaError=${JSON.stringify(out.offline.metaError)}`);
  }
  if (out.shape) log(`      log at launch ${JSON.stringify(out.shape)}`);
  const rest = { ...out }; delete rest.offline; delete rest.shape;
  if (Object.keys(rest).length) log(`      ${JSON.stringify(rest)}`);
  if (!ok) {
    log('  ── output ──');
    log(raw.split('\n').filter((l) => l.trim()).map((l) => '  ' + l).join('\n'));
  }
  return ok;
}

// The four audit findings, each on the Mac the online run put in the right state.
const skipped = [];
const coedit = have('C:coedit-receive');
const exposure = have('A:exposure');
const neu = have('C:neu');
const removed = have('B:removed-check');

// ⚠ ORDER MATTERS AND IT IS NOT COSMETIC. §O1 WRITES through `applyCoEdit` and the write
// PERSISTS, so after it the entry's newest op is a local one with no server seq — and
// `materialize.js#isNewOf` returns false the moment `seqOf` is null. Running the co-edit row
// first therefore makes the „neu" row measure the probe rather than the product (MEASURED:
// `isNew:false`, `foundText:"offline-2s5i9j"`). The read-only rows go first.
log('# ── audit F6 · story 17.5 · the quiet „neu" dot ────────────────────────────────────');
// The `neu` fixture carries only a text, and the co-edit RENAMED that entry ("Herbstferien" →
// "Nordsee") before this driver ever runs — measured, `found:false` on the first attempt. The
// entity key is the stable name for the same entry, so it is merged in from the co-edit fixture.
if (neu) run('C', { role: 'neu', ...neu, ...(coedit ? { entityKey: coedit.entityKey, newText: coedit.newText } : {}) },
  'the peer\'s new entry on an offline launch');
else skipped.push('F6 · 17.5 — no neu phase in this work dir');

log('# ── audit F4 · story 16.6 · the exposure badge ─────────────────────────────────────');
if (exposure) run('A', { role: 'exposure', ...exposure }, 'the owner\'s badge on an offline launch');
else skipped.push('F4 · 16.6 — no exposure phase in this work dir (the founder LEAVES at phase 24)');

log('# ── audit F3 · story 20.2 · a removal ──────────────────────────────────────────────');
if (removed) run('B', { role: 'removed-check', ...removed }, 'a remaining Mac reopens offline');
else skipped.push('F3 · 20.2 — no removed-check phase in this work dir (it is phases 30-32)');

log('# ── audit F2 · story 18.2 · co-editing with nothing to re-pull ──────────────────────');
if (coedit) {
  run('C', { role: 'coedit', ...coedit }, 'the co-editor\'s peer reopens offline');
  run('B', { role: 'coedit', ...coedit }, 'the CO-EDITOR reopens offline');
} else skipped.push('F2 · 18.2 — no coedit-receive phase in this work dir');

// ── 4. the report ─────────────────────────────────────────────────────────────────────────────
const green = results.filter((r) => r.ok).length;
log('');
log('# ═════════════════════════════════════════════════════════════════════════════════════');
log(`# ${launches} OFFLINE launches of the shipped .app · ${results.reduce((n, r) => n + r.rows.length, 0)} rows`);
log(`# THE OFFLINE BATTERY: ${green} of ${results.length} green — stories 16.6, 17.5, 18.2, 20.2`);
for (const r of results) {
  log(`#   ${r.ok ? 'GREEN' : 'RED  '} ${r.tag} · ${r.role.padEnd(14)} ${r.label}`);
}
const armed = results.filter((r) => r.out.offline && r.out.offline.engineArmed === true).length;
log(`# the circle engine armed on ${armed} of ${results.length} offline launches (it is REPORTED, never awaited)`);
for (const s2 of skipped) log(`#   NOT REACHED  ${s2}`);
log('# ═════════════════════════════════════════════════════════════════════════════════════');
process.exit(green === results.length ? 0 : 1);
