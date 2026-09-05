#!/usr/bin/env node
// scripts/reports-e2e.mjs — LZP-1009's SECOND PASS, DRIVEN END TO END OVER REAL HTTP.
//
//   node scripts/reports-e2e.mjs
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS, AND WHY IT IS A SCRIPT RATHER THAN A TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/server/reports.test.js` (55 rows) holds the handler's contract and
// `tests/tier2/feedback-admin.dom.js` (16 rows) holds the screen's. Both are green and neither is
// repeated here. What NEITHER can do is spawn a host, put a report through the wire, restart the
// process over the same store and read the answer back — which is the only way to see the parts
// that are nobody's unit: the file adapter's tagged encoding, the sweep across a restart, the
// nonce table, and the fact that the CLIENT'S signed-string builder and the SERVER'S verifier
// agree. That last one has a total, silent failure mode: every real request 401s and nothing
// says why.
//
// So this spawns three real `server/dev-server.mjs` hosts and drives them with `fetch`:
//
//   1  a SOLO Mac composes and sends            → 202, `proves: unsigned`
//   2  the report is in the admin view          → prose verbatim, image byte-identical, 90 days
//   4  an ordinary family device credential     → 401 on every admin route; LZP1 → 401; replay → 401
//   5  a report past 90 days is SWEPT           → invisible to both list and get, after a restart
//   6  „Löschen" removes one                    → the list is empty
//   7  a relay with NO operator configured      → 404, the same answer `/api/v1/nope` gets
//
// ⚠ WHY NOT AGAINST THE LIVE RELAY. `https://langzeitplaner.vercel.app` has no
// `LZP_REPORTS_ADMIN_PUB` set and, as of 2026-09-05, still runs the previous deploy: `GET
// /api/v1/feedback` answers 405 and `POST` answers `501 not_implemented`. Probing it is one curl
// and is written into `docs/v2/STATUS.md`; pretending it was driven here would be the one thing
// this project does not do.
//
// ⚠ THE OPERATOR KEY HERE IS MINTED FRESH ON EVERY RUN and never touches a keychain. It is the
// same SHAPE as his device signing key — a raw uncompressed P-256 point, base64url — because the
// point of the exercise is that the relay cannot tell the difference and does not need to.
//
// PORTS ARE DERIVED FROM THE CLOCK, in triples. A stale host left behind by an interrupted run
// holds a DIFFERENT key, so a fixed port would answer 401 and the run would look like a signature
// bug. That happened once while this was being written; the comment is cheaper than the hour.
//
// Zero dependencies: `node:crypto`, `node:child_process`, `node:fs`, and the shipped client half.

import { webcrypto as wc } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const TE = new TextEncoder();
const PORT = 8800 + (Date.now() % 60) * 3;   // a fresh triple each run: a stale host from an earlier run is a different key and answers 401
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-e2e-'));

// ── the operator's key: a P-256 signing pair, exactly the shape a device key has ──────────────
const kp = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
const rawPub = new Uint8Array(await wc.subtle.exportKey('raw', kp.publicKey));   // 65 bytes, 0x04||X||Y
const ADMIN_PUB = b64u(rawPub);
const sign = async (bytes) => new Uint8Array(await wc.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, kp.privateKey, bytes));

// a SECOND, ordinary family device key — the "valid device credential" of task item 5's last bullet
const fam = await wc.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
const FAM_PUB = b64u(new Uint8Array(await wc.subtle.exportKey('raw', fam.publicKey)));
const famSign = async (bytes) => new Uint8Array(await wc.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, fam.privateKey, bytes));

const srv = spawn(process.execPath, ['server/dev-server.mjs', '--port', String(PORT), '--dir', DIR, '--admin-pub', ADMIN_PUB],
  { cwd: process.cwd(), stdio: ['ignore','pipe','pipe'] });
let banner = '';
srv.stdout.on('data', (d) => { banner += d; });
srv.stderr.on('data', (d) => { banner += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80; i++) { try { const r = await fetch(`${BASE}/api/v1/meta`); if (r.ok) break; } catch {} await sleep(100); }

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

// ── the operator credential, built by the SHIPPED client builder ──────────────────────────────
const { adminSignedString, ADMIN_SCHEME } = await import('../src/js/feedback/relay.js');
async function cred(method, path, signer = sign, pub = ADMIN_PUB) {
  const nonce = b64u(wc.getRandomValues(new Uint8Array(16)));
  const ts = String(Date.now());
  const str = adminSignedString({ method, path, sortedQuery: '', ts, nonce });
  const sig = await signer(TE.encode(str));
  return `${ADMIN_SCHEME} ts=${ts}, nonce=${nonce}, sig=${b64u(sig)}`;
}
const H = { 'X-LZP-Protocol': '1', 'X-LZP-Client': '2.0.0' };
const J = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

say('BANNER  :', (banner.match(/\d+ of \d+/) || ['—'])[0], '| dir', DIR);

// ═══ 1 · A SOLO MAC COMPOSES, PREVIEWS, SENDS ═════════════════════════════════════════════════
// The payload is exactly what `feedback/report.js#buildReport` puts on the wire for a SOLO Mac:
// no `device` block at all, because a solo Mac has no device key.
const PROSE = 'Ich komme nicht mehr rein — nach dem Update fragt der Mac nach einem Schlüssel,\n'
  + 'den ich nie hatte. Der Balken „Urlaub Südtirol" ist auch weg. Ümläute: ÄÖÜ ß.';
// a real 1x1 indexed PNG, so "image inline" is bytes and not a promise
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735e01d0000000049454e44ae426082','hex');
let r = await fetch(`${BASE}/api/v1/feedback`, { method:'POST', headers:{...H,'content-type':'application/json'},
  body: JSON.stringify({ v:1, report: PROSE, image: b64u(PNG) }) });
const posted = await J(r);
say('1 SEND  :', r.status, JSON.stringify(posted));

// ═══ 2 · THE REPORT APPEARS IN THE ADMIN VIEW ═════════════════════════════════════════════════
r = await fetch(`${BASE}/api/v1/feedback`, { headers:{...H, Authorization: await cred('GET','/api/v1/feedback')} });
const list = await J(r);
say('2 LIST  :', r.status, 'reports:', (list.reports||[]).length);
const row = (list.reports||[])[0] || {};
say('  prose verbatim :', row.prose === PROSE);
say('  hasImage       :', row.hasImage, '| signed:', row.signed, '| id:', row.id);
const ttl = row.expiresAt - row.receivedAt;
say('  retention      :', ttl, 'ms =', ttl / 86400000, 'days');

r = await fetch(`${BASE}/api/v1/feedback/${row.id}`, { headers:{...H, Authorization: await cred('GET',`/api/v1/feedback/${row.id}`)} });
const one = await J(r);
const img = Buffer.from(String(one.report?.image||'').replace(/-/g,'+').replace(/_/g,'/'), 'base64');
say('3 IMAGE :', r.status, 'bytes', img.length, '| byte-identical:', img.equals(PNG));

// ═══ 3 · AN ORDINARY FAMILY DEVICE CREDENTIAL GETS 401 ON EVERY ADMIN ROUTE ════════════════════
for (const [m, p] of [['GET','/api/v1/feedback'], ['GET',`/api/v1/feedback/${row.id}`], ['POST',`/api/v1/feedback/${row.id}/delete`]]) {
  const rr = await fetch(`${BASE}${p}`, { method:m, headers:{...H, Authorization: await cred(m,p,famSign,FAM_PUB)} });
  say('4 FAMILY:', m, p, '->', rr.status, JSON.stringify(await J(rr)));
}
// …and a well-formed LZP1 DEVICE credential — the real scheme a family Mac sends — is refused too
{
  const rr = await fetch(`${BASE}/api/v1/feedback`, { headers:{...H, Authorization: `LZP1 dev=AAAAAAAAAAAAAAAA, ts=${Date.now()}, nonce=${b64u(wc.getRandomValues(new Uint8Array(16)))}, bh=x, sig=y`} });
  say('4 LZP1  : GET /api/v1/feedback ->', rr.status, JSON.stringify(await J(rr)));
}
// …and no credential at all
{
  const rr = await fetch(`${BASE}/api/v1/feedback`, { headers: H });
  say('4 ANON  : GET /api/v1/feedback ->', rr.status, JSON.stringify(await J(rr)));
}
// …and a REPLAY of the operator's own credential
{
  const c = await cred('GET','/api/v1/feedback');
  const a = await fetch(`${BASE}/api/v1/feedback`, { headers:{...H, Authorization:c} });
  const b = await fetch(`${BASE}/api/v1/feedback`, { headers:{...H, Authorization:c} });
  say('4 REPLAY:', a.status, 'then', b.status, JSON.stringify(await J(b)));
}

// ═══ 4 · A REPORT PAST 90 DAYS IS SWEPT AND IS INVISIBLE TO BOTH LIST AND GET ══════════════════
// Written straight into the file adapter's store, dated 91 days ago, then read back through HTTP.
r = await fetch(`${BASE}/api/v1/feedback`, { method:'POST', headers:{...H,'content-type':'application/json'},
  body: JSON.stringify({ v:1, report: 'Ein alter Bericht, 91 Tage.' }) });
const old = await J(r);
r = await fetch(`${BASE}/api/v1/feedback`, { headers:{...H, Authorization: await cred('GET','/api/v1/feedback')} });
const before = await J(r);
const oldId = before.reports.find((x) => x.prose === 'Ein alter Bericht, 91 Tage.').id;
// age it on disk
const storeFile = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).find((f) => f.endsWith('.json'));
const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
let aged = 0;
const NINETY_ONE = 91 * 86400000;
const walk = (o) => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  // `adapters/file.js` writes a TIME column as the tagged `{"$d": ms}` — the tagged encoding its
  // header describes. Subtracting from the wrapper (the first attempt) writes NaN, which JSON
  // renders as null, which is a corrupt row rather than an old one: the host answered 500 and
  // said so. Aging the tagged number is the same edit an operator's clock would make.
  if (o.id === oldId && o.expiresAt && typeof o.expiresAt.$d === 'number') {
    o.receivedAt.$d -= NINETY_ONE; o.expiresAt.$d -= NINETY_ONE; aged++;
  }
  for (const k of Object.keys(o)) walk(o[k]);
};
walk(raw);
fs.writeFileSync(storeFile, JSON.stringify(raw));
say('5 AGED  :', aged, 'row(s) moved back 91 days in', path.basename(storeFile));
srv.kill('SIGTERM'); await sleep(400);
const srv2 = spawn(process.execPath, ['server/dev-server.mjs','--port',String(PORT+1),'--dir',DIR,'--admin-pub',ADMIN_PUB], { cwd: process.cwd(), stdio:['ignore','pipe','pipe'] });
srv2.stdout.on('data',()=>{}); srv2.stderr.on('data',()=>{});
const B2 = `http://127.0.0.1:${PORT+1}`;
for (let i=0;i<80;i++){ try { const rr=await fetch(`${B2}/api/v1/meta`); if (rr.ok) break; } catch {} await sleep(100); }
r = await fetch(`${B2}/api/v1/feedback`, { headers:{...H, Authorization: await cred('GET','/api/v1/feedback')} });
const after = await J(r);
say('5 LIST  :', r.status, 'before', before.reports.length, '-> after', (after.reports||[]).length,
    '| swept id present:', after.reports.some((x)=>x.id===oldId));
r = await fetch(`${B2}/api/v1/feedback/${oldId}`, { headers:{...H, Authorization: await cred('GET',`/api/v1/feedback/${oldId}`)} });
say('5 GET   : the swept id ->', r.status, JSON.stringify(await J(r)));

// ═══ 5 · „LÖSCHEN" REMOVES ONE ═══════════════════════════════════════════════════════════════
r = await fetch(`${B2}/api/v1/feedback/${row.id}/delete`, { method:'POST', headers:{...H, Authorization: await cred('POST',`/api/v1/feedback/${row.id}/delete`)} });
say('6 DELETE:', r.status, JSON.stringify(await J(r)));
r = await fetch(`${B2}/api/v1/feedback`, { headers:{...H, Authorization: await cred('GET','/api/v1/feedback')} });
const end = await J(r);
say('6 LIST  :', r.status, 'reports:', end.reports.length);

// ═══ 6 · AND ON A HOST WITH NO OPERATOR: 404, THE SAME AS /nope ═══════════════════════════════
const DIR2 = fs.mkdtempSync(path.join(os.tmpdir(),'lzp-e2e-noop-'));
const srv3 = spawn(process.execPath, ['server/dev-server.mjs','--port',String(PORT+2),'--dir',DIR2], { cwd: process.cwd(), stdio:['ignore','pipe','pipe'] });
srv3.stdout.on('data',()=>{}); srv3.stderr.on('data',()=>{});
const B3 = `http://127.0.0.1:${PORT+2}`;
for (let i=0;i<80;i++){ try { const rr=await fetch(`${B3}/api/v1/meta`); if (rr.ok) break; } catch {} await sleep(100); }
for (const [m,p] of [['GET','/api/v1/feedback'],['GET',`/api/v1/feedback/${row.id}`],['POST',`/api/v1/feedback/${row.id}/delete`],['GET','/api/v1/nope']]) {
  const rr = await fetch(`${B3}${p}`, { method:m, headers:{...H, Authorization: await cred(m,p)} });
  say('7 NOOP  :', m, p, '->', rr.status, JSON.stringify(await J(rr)));
}
srv2.kill('SIGTERM'); srv3.kill('SIGTERM');
await sleep(200);
process.exit(0);
