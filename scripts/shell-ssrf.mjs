#!/usr/bin/env node
// scripts/shell-ssrf.mjs — THE SSRF RED TEAM DRIVER.  LZP-1002.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS RUNS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/tier2/shell-ssrf.dom.js` holds the assertions; this launches the shipped `.app` the
// number of times they need.
//
//   · **the classification sweep** — the origin validator is Swift (`normalizeSyncOrigin`,
//     `isPrivateOrLocalSyncHost`) and cannot be called from JavaScript, so the only honest way to
//     test it is one LAUNCH per candidate value. Twenty-eight of them: every private range, every
//     IP-literal spelling, the LAN suffixes, the scheme mistakes, the shape mistakes, and the FOUR
//     that must be ACCEPTED — because a sweep in which everything is refused proves nothing.
//   · **the red team** — one launch pinned to `scripts/hostile-relay.mjs`, which redirects,
//     floods, stalls and hands out cookies on purpose.
//
//   node scripts/shell-ssrf.mjs
//   node scripts/shell-ssrf.mjs --only redteam
//
// Zero npm dependencies.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = arg('only', '');
const KEEP = argv.includes('--keep');
const PORT = Number(arg('port', '8792'));
const HOSTILE = `http://127.0.0.1:${PORT}`;
const TEST_FILE = path.join(REPO, 'tests/tier2/shell-ssrf.dom.js');
const BUNDLE_ID = 'org.langzeitplaner.ssrf';

const WORK = mkdtempSync(path.join(tmpdir(), 'lzp-ssrf-'));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'pipe', ...opts });
const log = (s) => process.stdout.write(s + '\n');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TABLE — every value, and the rule that must refuse it
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `null` means ACCEPTED. Four rows are `null` on purpose and they are the control: a validator
// that refused everything would pass all 24 refusal rows and be useless, and the whole sweep
// would be a test of nothing.
//
// The rule is `isPrivateOrLocalSyncHost`, and it is deliberately BLUNTER than "no private
// ranges": **every IP literal is refused, v4 and v6, public ones included.** A relay is a NAME,
// and an origin spelled as an address is a misconfiguration whichever address it is. That is why
// `https://93.184.216.34` — a perfectly routable public address — is in this table as a refusal.
const TABLE = [
  // ── accepted ────────────────────────────────────────────────────────────────────────────
  ['https://relay.example.org', null],
  ['https://RELAY.example.ORG', null],            // normalised to lower case, then accepted
  // ── the dev carve-out: http to loopback, HEADLESS ONLY ───────────────────────────────────
  [`http://127.0.0.1:${PORT}`, null],
  ['http://localhost:8787', null],
  // ── private ranges and every IP-literal spelling ─────────────────────────────────────────
  ['https://10.0.0.5', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://192.168.1.1', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://172.20.0.1', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://169.254.169.254', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://100.64.0.1', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://127.0.0.1', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://0.0.0.0', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://93.184.216.34', 'origin_host_is_local_private_or_an_ip_literal'],   // public, still an address
  ['https://[::1]', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://[fd00::1]', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://[fe80::1]', 'origin_host_is_local_private_or_an_ip_literal'],
  // ── names that resolve only on this LAN ──────────────────────────────────────────────────
  ['https://router.local', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://nas', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://box.home.arpa', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://relay.internal', 'origin_host_is_local_private_or_an_ip_literal'],
  ['https://relay.example.org.', 'origin_host_is_local_private_or_an_ip_literal'],  // trailing dot
  ['https://localhost', 'origin_host_is_local_private_or_an_ip_literal'],
  // ── the scheme ───────────────────────────────────────────────────────────────────────────
  ['http://relay.example.org', 'origin_is_not_https'],
  // ── the shape ────────────────────────────────────────────────────────────────────────────
  ['https://relay.example.org/api', 'origin_is_not_scheme_host_port'],
  ['https://user:pw@relay.example.org', 'origin_is_not_scheme_host_port'],
  ['https://relay.example.org?x=1', 'origin_is_not_scheme_host_port'],
  ['file:///etc/passwd', 'origin_is_not_scheme_host_port'],
  ['javascript:alert(1)', 'origin_is_not_scheme_host_port'],
  ['not a url at all', 'origin_is_not_scheme_host_port'],
];

// ═════════════════════════════════════════════════════════════════════════════════════════════

function webkit() {
  return {
    data: path.join(homedir(), 'Library/WebKit', BUNDLE_ID),
    account: `com.apple.WebKit.WebCrypto.master+${BUNDLE_ID}`,
  };
}
function wipe() {
  const { data, account } = webkit();
  try { sh('security', ['delete-generic-password', '-a', account]); } catch { /* absent is fine */ }
  rmSync(data, { recursive: true, force: true });
}
function cleanup() {
  wipe();
  if (relay && !relay.killed) { try { relay.kill('SIGKILL'); } catch { /* gone */ } }
  if (KEEP) log(`# work kept at ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

log(`# building shell-macos → ${WORK}`);
try {
  sh(path.join(REPO, 'shell-macos/build.sh'), ['--dest', WORK]);
} catch (e) {
  log('Bail out! build failed');
  log(String(e.stdout || '') + String(e.stderr || ''));
  process.exit(2);
}
const APP = path.join(WORK, 'LangzeitPlaner.app');
const BIN = path.join(APP, 'Contents/MacOS/LangzeitPlaner');
sh('plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, path.join(APP, 'Contents/Info.plist')]);
try { sh('codesign', ['--force', '--deep', '--sign', '-', APP]); } catch { /* ad hoc */ }
wipe();

// ── the adversary ─────────────────────────────────────────────────────────────────────────────

const relayLog = [];
const relay = spawn(process.execPath, [path.join(REPO, 'scripts/hostile-relay.mjs'), '--port', String(PORT)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
relay.stdout.on('data', (d) => relayLog.push(String(d)));
relay.stderr.on('data', (d) => relayLog.push(String(d)));
for (let i = 0; i < 100; i += 1) {
  try {
    const r = await fetch(`${HOSTILE}/api/v1/meta`);
    if (r.status === 200) break;
  } catch { /* not up yet */ }
  // eslint-disable-next-line no-await-in-loop
  await new Promise((r) => setTimeout(r, 100));
}
log(`# hostile relay up at ${HOSTILE} — it redirects, floods, stalls and hands out cookies`);

// ── one launch ────────────────────────────────────────────────────────────────────────────────

const SOURCE = readFileSync(TEST_FILE, 'utf8');
let launches = 0;
const results = [];

function run(spec, originForShell) {
  launches += 1;
  const file = path.join(WORK, `ssrf-${String(launches).padStart(2, '0')}.js`);
  writeFileSync(file, `globalThis.__LZP_SSRF = ${JSON.stringify(spec)};\n${SOURCE}`);
  const scratch = path.join(WORK, 'scratch-' + launches);
  mkdirSync(scratch, { recursive: true });

  let raw = '';
  let code = 0;
  try {
    raw = String(sh(BIN, ['--test', file, '--scratch', scratch, '--sync-origin', originForShell], {
      timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (e) {
    raw = String(e.stdout || '') + String(e.stderr || '');
    code = e.status === undefined ? 1 : e.status;
  }
  const rows = raw.split('\n').filter((l) => /^(not )?ok \d/.test(l))
    .map((l) => ({ ok: l.startsWith('ok '), skip: / # SKIP/.test(l), line: l.trim() }))
    .filter((r) => !r.skip);
  const ok = code === 0 && rows.length > 0 && rows.every((r) => r.ok);
  results.push({ spec, ok, rows, raw });
  return { ok, rows, raw };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE CLASSIFICATION SWEEP — one launch per candidate origin
// ═════════════════════════════════════════════════════════════════════════════════════════════

let swept = 0;
let acceptedRows = 0;
if (ONLY !== 'redteam') {
  log('');
  log('# ── the origin sweep: one launch of the shipped .app per value ───────────────────────');
  for (const [origin, expect] of TABLE) {
    const r = run({ mode: 'classify', origin, expect }, origin);
    swept += 1;
    if (expect === null) acceptedRows += 1;
    const verdict = expect === null ? 'ACCEPTED' : expect;
    log(`${r.ok ? 'ok  ' : 'NOT OK'}  ${origin.padEnd(34)} → ${verdict}`);
    if (!r.ok) {
      log(r.raw.split('\n').filter((l) => /not ok|message:/.test(l)).map((l) => '        ' + l.trim()).join('\n'));
    }
  }
  log(`# ${swept} launches · ${acceptedRows} of them ACCEPTED — a sweep in which everything is `
    + 'refused proves nothing, so the accepted rows are the control');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE RED TEAM — pinned to the hostile relay, attacked from page script
// ═════════════════════════════════════════════════════════════════════════════════════════════

let red = null;
if (ONLY !== 'classify') {
  log('');
  log('# ── the red team: the shell is pinned to the hostile relay ───────────────────────────');
  red = run({ mode: 'redteam', origin: HOSTILE }, HOSTILE);
  for (const r of red.rows) log(`      ${r.line}`);
  if (!red.ok) {
    log('  ── output ──');
    log(red.raw.split('\n').filter((l) => l.trim()).map((l) => '  ' + l).join('\n'));
  }
}

// ── what the adversary actually saw ───────────────────────────────────────────────────────────
//
// The second witness, from the other end of the wire and from a process that shares no code with
// the page: if a refusal had leaked, the request would be in this list.
try {
  const all = await (await fetch(`${HOSTILE}/api/v1/seen`)).json();
  // This SCRIPT talks to the fixture too — the readiness probe and `/api/v1/seen` — over plain
  // node `fetch`. Excluded by user agent, or the summary would report the driver's own identity
  // beside the shell's and read as a leak. Node's agent starts `node/`; the shell's is the pinned
  // constant `LangzeitPlaner`, which is the whole point of the line below.
  const seen = { seen: all.seen.filter((s) => !/^node/i.test(String(s.headers['user-agent'] || ''))) };
  const paths = {};
  for (const s of seen.seen) paths[s.path] = (paths[s.path] || 0) + 1;
  log('');
  log(`# the hostile relay saw ${seen.seen.length} request(s), all of them to the pinned origin:`);
  for (const [p, n] of Object.entries(paths).sort()) log(`#   ${n} × ${p}`);
  const agents = [...new Set(seen.seen.map((s) => s.headers['user-agent']))];
  log(`# every one of them identified itself as: ${JSON.stringify(agents)}`);
  const langs = [...new Set(seen.seen.map((s) => s.headers['accept-language']))];
  log(`# and asked for language: ${JSON.stringify(langs)}`);
  const cookied = seen.seen.filter((s) => s.headers.cookie).length;
  log(`# requests that carried a cookie: ${cookied}`);
} catch (e) {
  log(`# (the hostile relay's log could not be read: ${e.message})`);
}

const failed = results.filter((r) => !r.ok);
const totalRows = results.reduce((n, r) => n + r.rows.length, 0);
log('');
log('# ═════════════════════════════════════════════════════════════════════════════════════');
log(`# ${launches} launches of the shipped .app · ${totalRows} rows · ${failed.length} failed`);
log('# ═════════════════════════════════════════════════════════════════════════════════════');
process.exit(failed.length === 0 ? 0 : 1);
