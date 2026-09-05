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
//   · **the carve-out** (LZP-1009) — one launch pinned to the hostile relay with `sync_enabled`
//     OFF, proving from the wire that exactly one (method, path) pair gets out and everything
//     else is still refused locally. Its assertions live HERE rather than in the tier-2 file,
//     for the reason under `CARVEOUT_PROBE` below.
//   · **the red team** — one launch pinned to `scripts/hostile-relay.mjs`, which redirects,
//     floods, stalls and hands out cookies on purpose.
//
//   node scripts/shell-ssrf.mjs
//   node scripts/shell-ssrf.mjs --only redteam
//   node scripts/shell-ssrf.mjs --only carveout
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
// LZP-1009 added a third mode, and the two ad-hoc `ONLY !== 'x'` guards this file used could not
// express "carveout alone" — `--only carveout` would still have run the 28-launch sweep. One
// selector instead; the behaviour of the two modes that already existed is unchanged.
const wants = (mode) => ONLY === '' || ONLY === mode;
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
// ── LZP-1009 · RE-MEASURED AFTER THE PREFLIGHT REORDER, AND THE ANSWER WAS "NO CHANGE" ──────
//
// `syncPreflight` moved its `sync_enabled` check below the pin and the canonical rebuild, and
// the worry was that some of these rows are refused today only because `sync_disabled` fires
// first — which would mean every expectation below is about the wrong rule and would silently
// change under the reorder.
//
// **Measured, not assumed: none of them were.** Both halves of every row read a state in which
// the switch is already ON. `st.reason` comes from `sync_status`, which reports
// `pinnedSyncOrigin()`'s verdict and never consults the switch at all; and the `probe` half of
// `tests/tier2/shell-ssrf.dom.js`'s classify row calls
// `set_shell_pref { sync_enabled: true }` before it calls `sync_request`. So all 24 refusal
// reasons below were `origin_*` before the reorder and are byte-identical after it — re-run
// 2026-09-05, 28/28 launches green, and the numbers are in the report for this pass.
//
// What the reorder DID change is the sync-OFF surface, which this table never touched. That is
// what the `carveout` mode below is for.
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

/**
 * What the hostile relay has seen so far, from ITS side of the wire, with this driver's own
 * `fetch` calls excluded by user agent — node's starts `node/`, the shell's is the pinned
 * constant `LangzeitPlaner`. Returns [] when the fixture cannot be reached, so a probe failure
 * is reported by the probe rather than by an exception here.
 */
async function wireLog() {
  try {
    const all = await (await fetch(`${HOSTILE}/api/v1/seen`)).json();
    return all.seen.filter((s) => !/^node/i.test(String(s.headers['user-agent'] || '')));
  } catch {
    return [];
  }
}

const SOURCE = readFileSync(TEST_FILE, 'utf8');
let launches = 0;
const results = [];

function run(spec, originForShell, source = SOURCE) {
  launches += 1;
  const file = path.join(WORK, `ssrf-${String(launches).padStart(2, '0')}.js`);
  writeFileSync(file, `globalThis.__LZP_SSRF = ${JSON.stringify(spec)};\n${source}`);
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
if (wants('classify')) {
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
// 1b · THE CARVE-OUT — LZP-1009, proved with the switch OFF and from the wire
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY THESE ASSERTIONS ARE IN THE DRIVER AND NOT IN `tests/tier2/shell-ssrf.dom.js` ────────
//
// ONE OWNER PER FILE. `shell-ssrf.dom.js` belongs to the LZP-1002 pass and its `§1` row asserts,
// in its own words, that `sync_disabled` is the FIRST check — a claim this pass amends. Editing
// someone else's row to describe my change is exactly how a pinned row stops meaning anything.
//
// So this launch carries its own probe, written here, and the hand-off is stated rather than
// implied: **its permanent home is a `§1b` in `tests/tier2/shell-ssrf.dom.js`**, next to the §1
// it qualifies, and the owner of that file should move it there and amend §1's message from "the
// switch is not the first check" to "the switch is not read before the pin and the rebuild".
// Until then it runs here, in the same shipped `.app`, against the same hostile relay.
//
// WHAT IT PROVES THAT A STATIC ROW CANNOT. `tests/tier1/headless-shell.test.js` holds the SHAPE
// of the carve-out — one method, one exact path, on the canonical URL. It cannot run it. This
// does: the shell is launched with `sync_enabled` false (its default), the page calls
// `sync_request` raw, and the hostile relay's own log is asked afterwards what actually arrived.
// A shell that had quietly widened the exemption would show it here as a second path on the wire.
const CARVEOUT_PROBE = `
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
const raw = (args) => invoke('sync_request', args);
const PIN = globalThis.__LZP_SSRF.origin;
const OUT = {};

test('§1b·1 SYNC IS OFF, AND IT IS OFF BY DEFAULT — the state a solo Mac is actually in', async () => {
  // Not set here on purpose for the first read: a fresh scratch dir has no sync.json, and
  // \`SyncPrefs.enabled\` defaults to false. e10-network-scope §1f holds that statically; this is
  // the same fact from inside a running shell.
  const st = await invoke('sync_status');
  assert.equal(st.enabled, false, 'a fresh install came up with sync ON');
  assert.equal(st.originConfigured, true, 'the harness relay was not accepted as a pin');

  // AND THE SENTENCE. It used to say this Mac makes „keine einzige Netzwerkanfrage", which the
  // carve-out made false. It must name the exception, in German first, and as a condition on a
  // press — this Mac still originates nothing by itself.
  assert.ok(st.message && st.message.de && st.message.en, 'no sentence for a switched-off sync');
  assert.equal(/keine einzige Netzwerkanfrage/.test(st.message.de), false,
    'the shell still claims a solo Mac makes not one request: ' + st.message.de);
  assert.equal(/Ausnahme/.test(st.message.de), true, 'the German sentence does not name the exception');
  assert.equal(/selbst/.test(st.message.de), true, 'the German sentence drops the press');
  assert.equal(/exception/.test(st.message.en), true, 'the English sentence does not name it');
  assert.equal(/fehler|error/i.test(st.message.de + st.message.en), false,
    'nothing has gone wrong in solo mode — this must not read as an error');
  OUT.soloSentence = st.message.de;
});

test('§1b·2 THE ONE PAIR — POST to /api/v1/feedback gets out with the switch off', async () => {
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  const r = await raw({
    url: PIN + '/api/v1/feedback', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{"v":1,"prose":"ich kann nicht mitmachen"}',
  });
  // The hostile relay answers 404 on this path — it speaks no real protocol. A STATUS is the
  // proof, not the code: a status at all means the request left the process, which is the whole
  // claim. \`blocked\` here would mean a solo Mac still cannot send the one report that matters.
  assert.equal(r.error, undefined, 'the solo send was refused: ' + JSON.stringify(r));
  assert.equal(typeof r.status, 'number', 'no HTTP answer — the request never reached the wire');
  assert.equal(r.url, PIN + '/api/v1/feedback', 'the reply names a different URL than the one asked for');
  assert.equal(r.redirected, false);
  OUT.soloSendStatus = r.status;
});

test('§1b·3 EVERYTHING ELSE IS STILL sync_disabled — the exemption is one pair, not a door', async () => {
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  // Each row is one way an exemption stops being one pair. The reason must be \`sync_disabled\`
  // for every one of them: that is the SAME word the shell used before this pass, which is why
  // no new refusal name was added — the two shells' vocabularies stay byte-identical.
  const NOT_EXEMPT = [
    ['POST', '/api/v1/ops', 'the endpoint that carries the family log'],
    ['POST', '/api/v1/pull', 'and the one that reads it back'],
    ['GET',  '/api/v1/feedback', 'the right path, the wrong method — a read-back is not a send'],
    ['GET',  '/api/v1/meta', 'the cheapest possible probe'],
    ['POST', '/api/v1/feedbackx', 'a PREFIX of the carve-out is not the carve-out'],
    ['POST', '/api/v1/feedback/extra', 'nor is anything under it'],
    ['POST', '/api/v1/feedback.json', 'nor a neighbour that shares its first 17 bytes'],
  ];
  for (const [method, p, why] of NOT_EXEMPT) {
    const r = await raw({ url: PIN + p, method, headers: {}, body: method === 'POST' ? '{}' : '' });
    assert.equal(r.error, 'blocked', method + ' ' + p + ' (' + why + ') was NOT refused: ' + JSON.stringify(r));
    assert.equal(r.reason, 'sync_disabled', method + ' ' + p + ' was refused by a different rule: ' + r.reason);
    assert.equal(r.status, undefined, method + ' ' + p + ' produced an HTTP answer');
  }
  // A QUERY. \`?\` is where the carve-out would leak if it compared only the path.
  const q = await raw({ url: PIN + '/api/v1/feedback?x=1', method: 'POST', headers: {}, body: '{}' });
  assert.equal(q.error, 'blocked', 'a query rode along on the exempt path');
  assert.equal(q.reason, 'sync_disabled');
  OUT.notExempt = NOT_EXEMPT.length + 1;
});

test('§1b·4 THE PIN AND THE REBUILD RUN FIRST — and that is now visible in the reason', async () => {
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  // THE ORDER, OBSERVED. Before this pass every one of these answered \`sync_disabled\`, because
  // the switch was check 1. They now answer the rule that actually applies — which is the point:
  // the exemption is decided on the CANONICAL rebuild, so a URL that never survives the rebuild
  // is refused before the switch is even read.
  const ORDER = [
    ['https://evil.example/api/v1/feedback', 'url_is_not_the_pinned_origin', 'another origin entirely'],
    ['https://evil.example@127.0.0.1:8792/api/v1/feedback', 'url_is_not_the_pinned_origin', 'userinfo dressed as a host'],
    [PIN + '/api/v1/feedback/../ops', 'url_path_is_not_an_api_v1_path', 'dot-dot inside the exempt path'],
    [PIN + '//api/v1/feedback', 'url_path_is_not_an_api_v1_path', 'a doubled leading slash'],
    [PIN + '/api/v1/%66eedback', 'url_path_is_not_an_api_v1_path', 'percent-encoded, decodes to the carve-out'],
    [PIN + '/api/v1/feedback#x', 'url_carries_a_fragment', 'a fragment'],
  ];
  for (const [url, expect, why] of ORDER) {
    const r = await raw({ url, method: 'POST', headers: {}, body: '{}' });
    assert.equal(r.error, 'blocked', url + ' (' + why + ') was NOT refused: ' + JSON.stringify(r));
    assert.equal(r.reason, expect, url + ' (' + why + ') was refused by ' + r.reason + ', not ' + expect);
    assert.equal(r.status, undefined, url + ' produced an HTTP answer');
  }
  OUT.orderObserved = ORDER.length;
});

test('§1b·5 THE OTHER RULES ARE UNCHANGED ON THE EXEMPT PATH — same allowlist, same caps', async () => {
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  // The subset claim, checked on the one address where a widening would hide. Everything the
  // header allowlist, the caps and the redirect refusal do with the switch ON, they still do
  // with it off — the exemption changes WHICH pair passes, not what happens to it afterwards.
  const cookie = await raw({
    url: PIN + '/api/v1/feedback', method: 'POST',
    headers: { Cookie: 'a=1' }, body: '{}',
  });
  assert.equal(cookie.error, 'blocked', 'a Cookie reached the wire on the exempt path');
  assert.equal(cookie.reason, 'header_is_not_on_the_allowlist');

  const inject = await raw({
    url: PIN + '/api/v1/feedback', method: 'POST',
    headers: { 'X-LZP-Client': 'a\\r\\nX-Evil: 1' }, body: '{}',
  });
  assert.equal(inject.error, 'blocked', 'a CRLF reached the wire on the exempt path');
  assert.equal(inject.reason, 'header_value_is_not_printable_ascii');

  const big = await raw({
    url: PIN + '/api/v1/feedback', method: 'POST', headers: {},
    body: 'x'.repeat(4 * 1024 * 1024 + 1),
  });
  assert.equal(big.error, 'blocked', 'the 4 MiB request cap does not apply to the exempt path');
  assert.equal(big.reason, 'request_body_exceeds_the_cap');
  OUT.otherRulesHeld = 3;
});

test('§1b·6 THE HONEST-PATH CONTROL — with the switch ON the rest of the surface returns', async () => {
  // Without this the five rows above would pass on a shell that had simply stopped working, and
  // it is also the subset claim's other half: everything refused above is reachable with the
  // switch on, so sync-off ⊂ sync-on rather than merely "different".
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  const meta = await raw({ url: PIN + '/api/v1/meta', method: 'GET', headers: {}, body: '' });
  assert.equal(meta.status, 200, 'the honest control did not go through: ' + JSON.stringify(meta));
  const ops = await raw({ url: PIN + '/api/v1/ops', method: 'POST', headers: {}, body: '{}' });
  assert.equal(typeof ops.status, 'number', '/api/v1/ops is unreachable even with sync on');
  const fb = await raw({ url: PIN + '/api/v1/feedback', method: 'POST', headers: {}, body: '{}' });
  assert.equal(typeof fb.status, 'number', 'the exempt path is not reachable with sync on');
  await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
  OUT.controlStatus = meta.status;
  diag('SSRF-OUT ' + JSON.stringify(OUT));
});
`;

let carve = null;
if (wants('carveout')) {
  log('');
  log('# ── the carve-out: one launch with sync_enabled OFF, pinned to the hostile relay ──────');
  const before = await wireLog();
  carve = run({ mode: 'carveout', origin: HOSTILE }, HOSTILE, CARVEOUT_PROBE);
  for (const r of carve.rows) log(`      ${r.line}`);
  if (!carve.ok) {
    log('  ── output ──');
    log(carve.raw.split('\n').filter((l) => l.trim()).map((l) => '  ' + l).join('\n'));
  }
  // ── THE SECOND WITNESS, from the other end of the wire ────────────────────────────────────
  //
  // Everything above is the page's word for what happened. This is the relay's, from a process
  // that shares no code with the shell: with the switch off, exactly ONE pair may appear here.
  const after = await wireLog();
  const fresh = after.slice(before.length);
  // §1b·6 turns the switch on at the end, so only the requests before that count as sync-off.
  const soloPhase = [];
  for (const s of fresh) {
    if (s.path === '/api/v1/meta' && s.method === 'GET') break;   // the control opens §1b·6
    soloPhase.push(s);
  }
  const pairs = [...new Set(soloPhase.map((s) => `${s.method} ${s.path}`))].sort();
  log(`# with sync OFF the relay saw ${soloPhase.length} request(s): ${JSON.stringify(pairs)}`);
  if (pairs.length !== 1 || pairs[0] !== 'POST /api/v1/feedback') {
    log(`NOT OK  the sync-off wire is ${JSON.stringify(pairs)}, not exactly ["POST /api/v1/feedback"]`);
    results.push({ spec: { mode: 'carveout-wire' }, ok: false, rows: [{ ok: false, line: 'not ok — sync-off wire' }], raw: '' });
  } else {
    log('#   → exactly one pair reached the wire with the switch off, and it is the one the PO ruled on');
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE RED TEAM — pinned to the hostile relay, attacked from page script
// ═════════════════════════════════════════════════════════════════════════════════════════════

let red = null;
if (wants('redteam')) {
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
