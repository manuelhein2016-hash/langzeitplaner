// tests/server/deploy-readiness.test.js — LZP-1008.  The pre-flight check has to be able to FAIL.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  WHY THIS FILE EXISTS, AND WHY IT IS THE PRODUCT RATHER THAN THE FIX
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `server/prisma/migrations/` did not exist, and `.github/scripts/check-server-config.mjs`
// printed `ok every check passed` on that tree. `prisma migrate deploy` APPLIES migrations; it
// does not create them. So the first deploy against an empty Postgres would have created no
// tables, gone live green, and failed every query on a missing relation — in production, after
// the DMG had shipped.
//
// The directory has since been generated and committed. **That is not the fix.** The fix is this
// file, because the defect was never "a directory is absent"; it was "the check that exists to
// notice cannot notice". A check is worth exactly what its failure modes are worth, and until
// something asserts that it fails, its passing means nothing. The same mistake recurs on the very
// next schema change otherwise, and the next reader has the same reason to believe the same
// green line.
//
// So every test below MUTATES A SCRATCH COPY of the repo, runs the real script against it, and
// asserts WHICH ROW DIES. Nothing here mutates the real tree. The honest-path control in §1 runs
// the same script over an unmutated copy and requires zero failures, so a script that failed
// everything could not pass this file either.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE MUTANTS ARE FOR, precisely
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A row that never fires is indistinguishable from a row that is not there. Each case names the
// broken state, the row that must die, and the consequence in production if it does not — that
// third column is why the list is not padding. Eleven of these cases (§5) were WAVED THROUGH by
// the first rewrite of the script and were found by running exactly this enumeration; they are
// the ones where the deploy is green and the damage is silent.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE DOES NOT PROVE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// That the migration is CORRECT against a real Postgres. It proves the check's offline model of
// the migration agrees with schema.prisma. The migration was separately applied to a real
// PostgreSQL 17.10 and introspected — 10 tables, 64 columns, 3 unique constraints, 8 indexes,
// 6 foreign keys, exact agreement with this check's fold, and the eight load-bearing constraints
// exercised with live SQL. That run is written up in docs/v2/RUNBOOK.md §2.4.2. It needs a
// database, so it is not in this file; §6 asserts the two rows that WOULD have covered it are
// honestly reported as unchecked rather than quietly counted as passes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = '.github/scripts/check-server-config.mjs';
const MIGRATIONS = 'server/prisma/migrations';
const MIGRATION_SQL = `${MIGRATIONS}/20260903092140_init/migration.sql`;

/** Everything the script reads. Copied per case so no test can affect another, or the real tree. */
const SUBSET = [
  CHECK,
  'package.json',
  'server/vercel.json',
  // The build itself, which `vercel.json` only POINTS at. Vercel caps `buildCommand` at 256
  // characters; it reached 271 and made the project undeployable, so the pipeline moved into this
  // script and rows V3–V6 follow the delegation to scan it. Leave it out of the scratch tree and
  // those four rows judge a build that is not there — which is how a readiness check starts
  // passing a configuration that cannot deploy, the exact failure this whole file exists to stop.
  'server/vercel-build.sh',
  'server/package.json',
  'server/package-lock.json',
  'server/prisma/schema.prisma',
  MIGRATIONS,
  'server/api',
  'server/adapters',
  'server/core',
];

function scratchTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-readiness-'));
  for (const rel of SUBSET) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  return dir;
}

/** Run the real script over a scratch tree and parse its ledger. */
function runCheck(dir, args = []) {
  const r = spawnSync(process.execPath, [path.join(dir, CHECK), '--json', ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* the script crashed; assertions below say so */ }
  return {
    exit: r.status,
    json,
    stdout: r.stdout,
    stderr: r.stderr,
    rows: json ? json.rows : [],
    failed: json ? json.rows.filter((x) => x.state === 'FAIL').map((x) => x.id) : [],
    warned: json ? json.rows.filter((x) => x.state === 'warn').map((x) => x.id) : [],
    skipped: json ? json.rows.filter((x) => x.state === 'skip').map((x) => x.id) : [],
  };
}

const rd = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');
const wr = (dir, p, s) => fs.writeFileSync(path.join(dir, p), s);
const rm = (dir, p) => fs.rmSync(path.join(dir, p), { recursive: true, force: true });
const editJson = (dir, p, f) => { const j = JSON.parse(rd(dir, p)); f(j); wr(dir, p, JSON.stringify(j, null, 2)); };
const editSql = (dir, f) => wr(dir, MIGRATION_SQL, f(rd(dir, MIGRATION_SQL)));

/**
 * The shape of every case below.
 *
 * `row` is the assertion that matters: a mutant that turns the tree red by killing the WRONG row
 * has not proven that row can fail, and it sends whoever reads the CI output to the wrong file.
 * That is not hypothetical — folding the migration set used to auto-create a table entry when it
 * saw a foreign key, so deleting a model's CREATE TABLE killed M6 ("a column is missing") instead
 * of M5 ("a table is missing"). Both are red; only one is the truth.
 */
function mutantCase({ what, mutate, row, state = 'FAIL', because }) {
  return { what, mutate, row, state, because };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE HONEST-PATH CONTROL
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 the committed tree passes the readiness check with zero failures', () => {
  const dir = scratchTree();
  try {
    const r = runCheck(dir);
    assert.ok(r.json, `the check did not produce JSON. stderr:\n${r.stderr}`);
    assert.deepEqual(r.failed, [], `the honest tree must be READY; these rows failed: ${r.failed.join(', ')}`);
    assert.equal(r.exit, 0, 'the honest tree must exit 0');
  } finally { rm(dir, '.'); }
});

test('§1 the check names the ONE adapter it judges, and refuses to answer for the other three', () => {
  const dir = scratchTree();
  try {
    const r = runCheck(dir);
    // `server/adapters/` has four. Three cannot have a migration problem at all: memory holds a
    // Map, file holds a JSON document, vercel delegates its storage. A verdict phrased as if it
    // covered all four is a verdict about nothing.
    assert.equal(r.json.adapter, 'prisma', 'the deployed store adapter must be resolved from the entry point, not assumed');
    assert.equal(r.json.httpAdapter, 'vercel', 'the HTTP normalisation adapter must be resolved too');
  } finally { rm(dir, '.'); }
});

test('§1 every row id in the ledger is reachable and unique per subject', () => {
  const dir = scratchTree();
  try {
    const r = runCheck(dir);
    const seen = new Set();
    for (const row of r.rows) {
      const k = `${row.id}|${row.subject}`;
      assert.ok(!seen.has(k), `row ${row.id} is emitted twice for ${row.subject}; a row id must name one verdict`);
      seen.add(k);
    }
    assert.ok(r.rows.length >= 39, `expected the full ledger, got ${r.rows.length} rows`);
  } finally { rm(dir, '.'); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE ROW THIS TICKET EXISTS FOR
//
// If only one test in this file survives, it is this one.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 THE MIGRATIONS ROW: a missing server/prisma/migrations/ FAILS the check', () => {
  const dir = scratchTree();
  try {
    // Reproduce the exact E10 state: the directory the audit found absent.
    rm(dir, MIGRATIONS);
    assert.ok(!fs.existsSync(path.join(dir, MIGRATIONS)), 'the mutant must actually remove the directory');

    const r = runCheck(dir);
    assert.ok(r.failed.includes('M1'), `M1 must FAIL when the migrations directory is absent. Failed rows: ${r.failed.join(', ') || 'NONE'}`);
    assert.equal(r.exit, 1, 'the check must exit non-zero — this is the state that shipped a database with no tables');
    assert.equal(r.json.ok, false);

    // The message has to send the operator somewhere. A red row with no remedy is a red row that
    // gets overridden at 23:00 on release night.
    const m1 = r.rows.find((x) => x.id === 'M1');
    assert.match(m1.msg, /migrate deploy/, 'M1 must explain that `migrate deploy` applies migrations and never creates them');
    assert.match(m1.msg, /migrate dev --name/, 'M1 must carry the command that generates them');
  } finally { rm(dir, '.'); }
});

test('§2 an EMPTY migrations directory fails too — the old check would have been satisfied by the mkdir', () => {
  const dir = scratchTree();
  try {
    // The cheapest possible "fix" for the row above, and it creates exactly as many tables as no
    // directory at all. A check that a `mkdir` can satisfy has taught the operator the wrong move.
    rm(dir, `${MIGRATIONS}/20260903092140_init`);
    const r = runCheck(dir);
    assert.ok(r.failed.includes('M2'), `M2 must FAIL on an empty migrations directory. Failed: ${r.failed.join(', ') || 'NONE'}`);
    assert.equal(r.exit, 1);
  } finally { rm(dir, '.'); }
});

test('§2 the migrations rows are DEMANDED because the deployed adapter is prisma', () => {
  const dir = scratchTree();
  try {
    // The migration section must be conditional on the adapter that is actually deployed, not on
    // a hardcoded assumption — but it must be DEMANDED when that adapter is the Postgres one.
    // Both halves matter: unconditional, it lies about memory/file; unconditioned, it never fires.
    rm(dir, MIGRATIONS);
    const withPrisma = runCheck(dir);
    assert.ok(withPrisma.failed.includes('M1'), 'with prisma deployed, a missing migration set must FAIL');

    // Now deploy the memory adapter instead. The same missing directory must become a stated SKIP.
    wr(dir, 'server/adapters/vercel.js',
      rd(dir, 'server/adapters/vercel.js')
        .replace("import { prismaStore, createPrismaClient } from './prisma.js';", "import { memoryStore } from './memory.js';")
        .replace(/prismaStore\(await createPrismaClient\(\)\)/g, 'memoryStore()'));
    const withMemory = runCheck(dir);
    assert.equal(withMemory.json.adapter, 'memory', 'the check must follow the entry point to the adapter actually deployed');
    assert.ok(!withMemory.failed.includes('M1'), 'the memory adapter has no schema to create; demanding one would be a verdict about nothing');
    assert.ok(withMemory.skipped.includes('M1'), 'but the row must be SAID to be skipped, never silently dropped');
  } finally { rm(dir, '.'); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE MIGRATION SET AGREES WITH THE SCHEMA (names)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const NAME_CASES = [
  mutantCase({
    what: 'a migration directory holds no migration.sql',
    row: 'M4', mutate: (d) => rm(d, MIGRATION_SQL),
    because: 'Prisma errors on the directory during the build, after the previous deployment is torn down',
  }),
  mutantCase({
    what: 'migration.sql is empty',
    row: 'M4', mutate: (d) => wr(d, MIGRATION_SQL, ''),
    because: 'an empty migration is recorded as applied and creates nothing, so the state can never be repaired by re-running it',
  }),
  mutantCase({
    what: 'migration_lock.toml is missing',
    row: 'M3', mutate: (d) => rm(d, `${MIGRATIONS}/migration_lock.toml`),
    because: 'the migration set has no declared provider and `migrate deploy` aborts mid-build',
  }),
  mutantCase({
    what: 'migration_lock.toml names a different provider than the datasource',
    row: 'M3', mutate: (d) => wr(d, `${MIGRATIONS}/migration_lock.toml`, 'provider = "mysql"\n'),
    because: 'Prisma refuses the set during the build rather than before it',
  }),
  mutantCase({
    what: 'a model has no CREATE TABLE (KeyWrap)',
    row: 'M5', mutate: (d) => editSql(d, (s) => s.replace(/-- CreateTable\nCREATE TABLE "KeyWrap"[\s\S]*?\n\);\n/, '')),
    because: 'every key-wrap query fails on a missing relation; no device can ever obtain an epoch key',
  }),
  mutantCase({
    what: 'a schema column is created by no migration (Member.recoveryPubKex)',
    row: 'M6', mutate: (d) => editSql(d, (s) => s.replace('    "recoveryPubKex" BYTEA NOT NULL,\n', '')),
    because: 'the generated client SELECTs a column Postgres does not have — E3-2 all over again, and it lands on the first query rather than in the build',
  }),
  mutantCase({
    what: 'the SpaceKind enum has no CREATE TYPE',
    row: 'M7', mutate: (d) => editSql(d, (s) => s.replace(/-- CreateEnum\nCREATE TYPE "SpaceKind"[^\n]*\n/, '')),
    because: 'CREATE TABLE "Space" references a type that does not exist and the whole migration aborts',
  }),
];

for (const c of NAME_CASES) {
  test(`§3 ${c.row} fails when ${c.what}`, () => {
    const dir = scratchTree();
    try {
      c.mutate(dir);
      const r = runCheck(dir);
      assert.ok(r.json, `the check crashed instead of reporting. stderr:\n${r.stderr}`);
      assert.ok(r.failed.includes(c.row), `${c.row} must FAIL — ${c.because}. Failed rows were: ${r.failed.join(', ') || 'NONE'}`);
      assert.equal(r.exit, 1);
    } finally { rm(dir, '.'); }
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE DEPLOYMENT MANIFEST, THE PACKAGE BOUNDARY, THE SCHEMA
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CONFIG_CASES = [
  mutantCase({ what: 'the Vercel entry point is deleted', row: 'A1',
    mutate: (d) => rm(d, 'server/api/v1/[[...path]].js'),
    because: 'the filesystem router matches no function; every route 404s and a smoke test reads that as "not deployed yet"' }),
  mutantCase({ what: 'the entry point no longer re-exports from an adapter', row: 'A1b',
    mutate: (d) => wr(d, 'server/api/v1/[[...path]].js', 'export default function h(){}\nexport const config={};\n'),
    because: 'the check cannot name the adapter it is judging, and a check that cannot name its subject must not answer for it' }),
  mutantCase({ what: 'the http adapter imports two store factories', row: 'A3',
    mutate: (d) => wr(d, 'server/adapters/vercel.js', `import { memoryStore } from './memory.js';\n${rd(d, 'server/adapters/vercel.js')}`),
    because: 'the deployed storage is ambiguous and the check must refuse to guess which of four adapters it is judging' }),
  mutantCase({ what: 'the resolved store adapter file is missing', row: 'A4',
    mutate: (d) => rm(d, 'server/adapters/prisma.js'),
    because: 'the function cannot import its own store' }),

  mutantCase({ what: 'server/vercel.json is deleted', row: 'V1',
    mutate: (d) => rm(d, 'server/vercel.json'),
    because: 'there is nothing to deploy with' }),
  mutantCase({ what: 'server/vercel.json is not valid JSON', row: 'V1',
    mutate: (d) => wr(d, 'server/vercel.json', '{ "regions": ["fra1", }'),
    because: 'Vercel rejects the deployment' }),
  mutantCase({ what: 'the region leaves Frankfurt', row: 'V2',
    mutate: (d) => wr(d, 'server/vercel.json', rd(d, 'server/vercel.json').replace('"fra1"', '"iad1"')),
    because: 'decision D2 pins the datacentre and the Datenschutz copy (21.3) NAMES it — moving it without moving the copy makes the privacy text false' }),
  mutantCase({ what: 'buildCommand stops running `prisma migrate deploy`', row: 'V3',
    mutate: (d) => editJson(d, 'server/vercel.json', (v) => { v.buildCommand = 'npx prisma generate'; }),
    because: 'the schema drifts from the code with nothing to notice' }),
  mutantCase({ what: 'buildCommand uses `prisma db push`', row: 'V4',
    mutate: (d) => editJson(d, 'server/vercel.json', (v) => { v.buildCommand = 'npx prisma generate && npx prisma db push && [ "$VERCEL_ENV" = production ] && npx prisma migrate deploy'; }),
    because: '`db push` is not safe against a live database — it reshapes it with no migration history and no rollback' }),
  // This mutant edits the SCRIPT, not the field, and that is the point of it. The three mutants
  // above replace `buildCommand` with an inline string, so they exercise the direct-scan path.
  // This one leaves the delegation in place and removes `prisma generate` from
  // `server/vercel-build.sh` — so if V5 ever stopped following the delegation it would go green
  // over a build with no client generation. Until 2026-09-05 this case did
  // `buildCommand.replace('npx prisma generate && ', '')`, which became a silent no-op the moment
  // the pipeline moved out of the field: the mutant "passed" because it changed nothing.
  mutantCase({ what: 'the build script stops running `prisma generate`', row: 'V5',
    mutate: (d) => wr(d, 'server/vercel-build.sh',
      rd(d, 'server/vercel-build.sh').replace(/^npx prisma generate$/m, '')),
    because: 'no client is generated for the deployed schema' }),
  mutantCase({ what: 'buildCommand migrates without gating on VERCEL_ENV', row: 'V6',
    mutate: (d) => editJson(d, 'server/vercel.json', (v) => { v.buildCommand = 'npx prisma generate && npx prisma migrate deploy'; }),
    because: 'a PREVIEW deploy from a branch then runs `migrate deploy` against the PRODUCTION database' }),
  mutantCase({ what: 'an Access-Control-Allow-Origin header is added', row: 'V7',
    mutate: (d) => editJson(d, 'server/vercel.json', (v) => v.headers[0].headers.push({ key: 'Access-Control-Allow-Origin', value: '*' })),
    because: 'the client is a desktop app, not a web page; CORS here only widens the attack surface (21.5)' }),
  mutantCase({ what: 'Cache-Control: no-store is dropped', row: 'V8',
    mutate: (d) => editJson(d, 'server/vercel.json', (v) => { v.headers[0].headers = v.headers[0].headers.filter((h) => h.key !== 'Cache-Control'); }),
    because: 'encrypted op batches sit in an intermediary cache' }),
  mutantCase({ what: 'the functions glob matches no entry point', row: 'V9',
    mutate: (d) => rm(d, 'server/api'),
    because: 'the deployment answers 404 on every route and the smoke test misreads it as "not deployed here yet"' }),

  mutantCase({ what: 'the ROOT package.json gains a runtime dependency', row: 'P1',
    mutate: (d) => editJson(d, 'package.json', (p) => { p.dependencies = { lodash: '^4' }; }),
    because: 'the desktop app is a zero-dependency build; server dependencies belong in server/package.json' }),
  mutantCase({ what: 'the ROOT package.json mentions Prisma', row: 'P2',
    mutate: (d) => editJson(d, 'package.json', (p) => { p.devDependencies = { ...p.devDependencies, prisma: '6.19.3' }; }),
    because: 'the desktop app never talks to a database' }),
  mutantCase({ what: 'server/package.json is deleted', row: 'P3',
    mutate: (d) => rm(d, 'server/package.json'),
    because: '`npm ci` has no manifest to install' }),
  mutantCase({ what: 'the lockfile is deleted while installCommand is `npm ci`', row: 'P4',
    mutate: (d) => rm(d, 'server/package-lock.json'),
    because: '`npm ci` is not `npm install`: it exits non-zero without a lockfile and the build never starts' }),
  mutantCase({ what: 'the lockfile disagrees with server/package.json', row: 'P5',
    mutate: (d) => editJson(d, 'server/package.json', (p) => { p.dependencies['@prisma/client'] = '6.20.0'; }),
    because: '`npm ci` exits 1 INSIDE the Vercel build, after the previous deployment is already being torn down' }),
  mutantCase({ what: 'the prisma CLI and @prisma/client versions diverge', row: 'P6',
    mutate: (d) => {
      editJson(d, 'server/package.json', (p) => { p.devDependencies.prisma = '6.18.0'; });
      editJson(d, 'server/package-lock.json', (l) => { l.packages[''].devDependencies.prisma = '6.18.0'; });
    },
    because: 'the build generates one client and migrates with another' }),

  mutantCase({ what: 'schema.prisma is deleted', row: 'S1',
    mutate: (d) => rm(d, 'server/prisma/schema.prisma'),
    because: '`prisma generate` and `migrate deploy` have nothing to work from' }),
  mutantCase({ what: 'the datasource url is hardcoded', row: 'S2',
    mutate: (d) => wr(d, 'server/prisma/schema.prisma', rd(d, 'server/prisma/schema.prisma').replace('env("DATABASE_URL")', '"postgresql://localhost/lzp"')),
    because: 'the deployed function connects to whatever was committed, not to the configured database' }),
  mutantCase({ what: 'a literal connection string with credentials is committed', row: 'S3',
    mutate: (d) => wr(d, 'server/prisma/schema.prisma', rd(d, 'server/prisma/schema.prisma').replace('url      = env("DATABASE_URL")', 'url      = "postgresql://lzp:hunter2@db.example.com/lzp"')),
    because: 'the database password is in git history and must be rotated, not just deleted' }),
  mutantCase({ what: 'the datasource provider is switched away from postgresql', row: 'S4',
    mutate: (d) => wr(d, 'server/prisma/schema.prisma', rd(d, 'server/prisma/schema.prisma').replace('provider = "postgresql"', 'provider = "mysql"')),
    because: 'decision D2 and server/adapters/prisma.js both assume postgresql' }),
];

for (const c of CONFIG_CASES) {
  test(`§4 ${c.row} fails when ${c.what}`, () => {
    const dir = scratchTree();
    try {
      c.mutate(dir);
      const r = runCheck(dir);
      assert.ok(r.json, `the check crashed instead of reporting. stderr:\n${r.stderr}`);
      assert.ok(r.failed.includes(c.row), `${c.row} must FAIL — ${c.because}. Failed rows were: ${r.failed.join(', ') || 'NONE'}`);
      assert.equal(r.exit, 1);
    } finally { rm(dir, '.'); }
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE SHAPE, NOT THE NAMES.
//
// Every case in this section passed the check before M9–M16 existed. None of them renames
// anything, so a comparison of table names, column names and enum names sees a perfect tree. Four
// of them are SILENT in production: the deploy is green, the queries succeed, and a guarantee the
// ADRs are built on is simply gone. Those are worse than the missing directory this whole ticket
// started from, because that one at least failed loudly on the first request.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const SHAPE_CASES = [
  mutantCase({
    what: 'the KeyWrap primary key is narrowed by one column',
    row: 'M9',
    mutate: (d) => editSql(d, (s) => s.replace('PRIMARY KEY ("spaceId","epoch","recipientId","senderDeviceId")', 'PRIMARY KEY ("spaceId","epoch","recipientId")')),
    because: 'SILENT. schema.prisma calls this @@id "a constraint and not a hint" for finding T5-K3: with the depositor in the key, an honest wrap and a junk wrap COEXIST and admitWraps picks the one that opens. Narrowed, ONE member can overwrite every other depositor\'s wrap for every epoch below her own, the relay counts it as coverage because coverage counts ROWS and the relay may not open a wrap, and nobody online notices — the readers who lose are every future joiner, every device paired in tomorrow, and ADR 002 §7.3\'s A2 recovery',
  }),
  mutantCase({
    what: 'the Op idempotency unique constraint is dropped',
    row: 'M10',
    mutate: (d) => editSql(d, (s) => s.replace(/-- CreateIndex\nCREATE UNIQUE INDEX "Op_spaceId_opId_key"[^\n]*\n/, '')),
    because: 'SILENT. @@unique([spaceId, opId]) is "what makes a lost response cost one retry and never a duplicate entry" (schema.prisma). Without it a retried push after a dropped response appends the entry twice, and the user sees a duplicated bar on the poster',
  }),
  mutantCase({
    what: 'the Member colour unique constraint is dropped',
    row: 'M10',
    mutate: (d) => editSql(d, (s) => s.replace(/-- CreateIndex\nCREATE UNIQUE INDEX "Member_spaceId_colorRef_key"[^\n]*\n/, '')),
    because: 'SILENT. Story 15.3 needs this constraint server-side to stop two members choosing the same colour, and the check cannot be done inside the ciphertext — it is the ONE reason colorRef is plaintext at all',
  }),
  mutantCase({
    what: 'the Device (spaceId, deviceShort) unique constraint is dropped',
    row: 'M10',
    mutate: (d) => editSql(d, (s) => s.replace(/-- CreateIndex\nCREATE UNIQUE INDEX "Device_spaceId_deviceShort_key"[^\n]*\n/, '')),
    because: 'ADR 003 §2 step 4 then has two rows to choose between inside one space with nothing to choose on — the exact ambiguity round 10 item 8 chose the per-space namespace to make impossible',
  }),
  mutantCase({
    what: 'a Bytes column is created as TEXT',
    row: 'M12',
    mutate: (d) => editSql(d, (s) => s.replace('"envelope" BYTEA NOT NULL', '"envelope" TEXT NOT NULL')),
    because: 'SILENT. schema.prisma\'s structural rule is that every ciphertext-bearing column is Bytes, and store-interface.js refuses a String at the adapter boundary. A TEXT column is a place a readable note CAN live; the blindness claim in addendum §3 is about what the database can hold, not only about what today\'s handlers write',
  }),
  mutantCase({
    what: 'ON DELETE CASCADE is downgraded to NO ACTION',
    row: 'M15',
    mutate: (d) => editSql(d, (s) => s.replace('ALTER TABLE "Op" ADD CONSTRAINT "Op_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;', 'ALTER TABLE "Op" ADD CONSTRAINT "Op_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE NO ACTION ON UPDATE CASCADE;')),
    because: 'the cascade is how deleting a Space actually purges its ops — story 20.2 and the Datenschutz deletion promise. Downgraded, the DELETE errors and the deletion silently never happens',
  }),
  mutantCase({
    what: 'a foreign key is dropped entirely',
    row: 'M15',
    mutate: (d) => editSql(d, (s) => s.replace(/-- AddForeignKey\nALTER TABLE "Member" ADD CONSTRAINT "Member_spaceId_fkey"[^\n]*\n/, '')),
    because: 'members are orphaned rather than purged when their space is deleted, and the relay keeps pseudonymous rows it promised to remove',
  }),
  mutantCase({
    what: 'a @default() is dropped from the migration',
    row: 'M14',
    mutate: (d) => editSql(d, (s) => s.replace('"nextSeq" BIGINT NOT NULL DEFAULT 0', '"nextSeq" BIGINT NOT NULL')),
    because: 'Prisma omits a defaulted column from the INSERT, so every space creation fails on a NOT NULL violation at RUNTIME — the build is green',
  }),
  mutantCase({
    what: 'a nullable column is created NOT NULL',
    row: 'M13',
    mutate: (d) => editSql(d, (s) => s.replace('    "removedAt" TIMESTAMP(3),\n\n    CONSTRAINT "Member_pkey"', '    "removedAt" TIMESTAMP(3) NOT NULL,\n\n    CONSTRAINT "Member_pkey"')),
    because: 'a live member has no removedAt, so no member can ever be inserted; Space.founderMemberId has the same shape and finding T5-M1a requires its null to fail OPEN',
  }),
  mutantCase({
    what: 'the migration creates a table the schema does not declare',
    row: 'M16',
    mutate: (d) => editSql(d, (s) => `${s}\nCREATE TABLE "AuditLog" (\n    "id" TEXT NOT NULL,\n    "note" TEXT NOT NULL\n);\n`),
    because: 'SILENT. Nothing queries it so nothing fails — but story 21.1\'s Datenschutz inventory enumerates everything this relay can see, and a table outside schema.prisma is outside that list and outside store-contract.test.js\'s closed column set',
  }),
];

for (const c of SHAPE_CASES) {
  test(`§5 ${c.row} fails when ${c.what}`, () => {
    const dir = scratchTree();
    try {
      c.mutate(dir);
      const r = runCheck(dir);
      assert.ok(r.json, `the check crashed instead of reporting. stderr:\n${r.stderr}`);
      assert.ok(r.failed.includes(c.row),
        `${c.row} must FAIL.\n  WHAT BREAKS: ${c.because}\n  Failed rows were: ${r.failed.join(', ') || 'NONE'}`);
      assert.equal(r.exit, 1, 'a corrupted migration set must make the check NOT READY');
    } finally { rm(dir, '.'); }
  });
}

test('§5 M11 warns — but does not fail — when a non-unique @@index is missing', () => {
  const dir = scratchTree();
  try {
    editSql(dir, (s) => s.replace(/-- CreateIndex\nCREATE INDEX "Device_memberId_idx"[^\n]*\n/, ''));
    const r = runCheck(dir);
    // A missing @@index costs a sequential scan, not a wrong answer. Failing the deploy for it
    // would train the operator to override the check, and the override is what the M-rows above
    // cannot survive. It must still be SAID.
    assert.ok(r.warned.includes('M11'), `M11 must warn. warned=${r.warned.join(', ') || 'NONE'} failed=${r.failed.join(', ') || 'NONE'}`);
    assert.ok(!r.failed.includes('M11'), 'a missing non-unique index is not a correctness defect and must not block the deploy');
  } finally { rm(dir, '.'); }
});

test('§5 CONTROL: M11 does NOT report an @@index the primary key already serves', () => {
  const dir = scratchTree();
  try {
    // Op declares BOTH @@id([spaceId, seq]) and @@index([spaceId, seq]). Postgres builds a real
    // btree for the primary key, so Op_pkey alone answers every query Op_spaceId_seq_idx was
    // declared for. A check that flagged this would be crying wolf on a correct tree — and a
    // check that cries wolf is a check that gets overridden.
    editSql(dir, (s) => s.replace(/-- CreateIndex\nCREATE INDEX "Op_spaceId_seq_idx"[^\n]*\n/, ''));
    const r = runCheck(dir);
    assert.ok(!r.warned.includes('M11'), `Op_pkey(spaceId, seq) serves Op(spaceId, seq); M11 must not report it. warned=${r.warned.join(', ')}`);
    assert.deepEqual(r.failed, [], 'and nothing else may fail on this tree');
  } finally { rm(dir, '.'); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 — A CHECK THAT DID NOT RUN SAYS SO.
//
// This is rule 2 of the script's own header, and the script broke it: with `--deep` and no
// DATABASE_URL, the L2 row was never pushed onto the ledger AT ALL — 32 rows instead of 33, skip
// count zero. A check that did not run, saying nothing, is the precise shape of the defect that
// let the missing migrations survive three audits.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 the offline run reports L1 and L2 as UNCHECKED rather than counting them as passes', () => {
  const dir = scratchTree();
  try {
    const r = runCheck(dir);
    assert.ok(r.skipped.includes('L1'), 'migrations-APPLIED is not checkable offline and must be named as unchecked');
    assert.ok(r.skipped.includes('L2'), 'schema-vs-migration drift needs a shadow database and must be named as unchecked');
    for (const id of ['L1', 'L2']) {
      const row = r.rows.find((x) => x.id === id);
      assert.match(row.msg, /--deep|shadow|SHADOW_DATABASE_URL/i, `${id} must carry the command that would settle it`);
    }
  } finally { rm(dir, '.'); }
});

test('§6 --deep without DATABASE_URL fails L1 and STILL puts L2 on the ledger', () => {
  const dir = scratchTree();
  try {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r0 = spawnSync(process.execPath, [path.join(dir, CHECK), '--json', '--deep'], { encoding: 'utf8', env });
    const json = JSON.parse(r0.stdout);
    const ids = json.rows.map((x) => x.id);

    assert.ok(json.rows.some((x) => x.id === 'L1' && x.state === 'FAIL'),
      'a deep run that silently degrades to a shallow one is the exact failure this script exists to remove');
    assert.ok(ids.includes('L2'),
      'L2 must appear on the ledger even when it cannot run. Dropping the row is how a check that did not run says nothing at all — the script\'s own rule 2.');
    assert.equal(json.rows.find((x) => x.id === 'L2').state, 'skip');
  } finally { rm(dir, '.'); }
});

test('§6 the summary never claims completeness while a row is unchecked', () => {
  const dir = scratchTree();
  try {
    const r = spawnSync(process.execPath, [path.join(dir, CHECK)], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'the honest tree exits 0');
    assert.doesNotMatch(r.stdout, /every check passed/,
      '"every check passed" is the sentence that made the missing migrations survive three audits; it may not be printed while L1/L2 are unchecked');
    assert.match(r.stdout, /not checked here/, 'the tally must name the unchecked rows');
    assert.match(r.stdout, /NOT a pass/, 'and must say plainly that they are not passes');
  } finally { rm(dir, '.'); }
});

test('§6 the check states which adapters it did NOT judge', () => {
  const dir = scratchTree();
  try {
    const r = spawnSync(process.execPath, [path.join(dir, CHECK)], { encoding: 'utf8' });
    assert.match(r.stdout, /not judged\s+memory, file/, 'the three adapters this run says nothing about must be named');
    assert.match(r.stdout, /says NOTHING about them/, 'and the silence must be explicit');
  } finally { rm(dir, '.'); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 — THE DEFERRAL LATCH.
//
// The script this replaced had an `owed` list: subjects that were missing, reported, and then
// ignored. Five entries, every one of which had existed since WP-7 — the mechanism had become a
// way of never failing. `DEFERRED` may only survive if a deferral that outlives its subject is
// itself a failure.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7 DEFERRED is empty, and D0 fails any deferral whose subject has arrived', () => {
  const dir = scratchTree();
  try {
    const src = rd(dir, CHECK);
    assert.match(src, /const DEFERRED = \[\];/,
      'DEFERRED must be empty. An entry here is an amnesty, and the previous amnesty list is why a missing migrations directory shipped.');

    // Arm it with a subject that DOES exist, and D0 must fire.
    wr(dir, CHECK, src.replace('const DEFERRED = [];',
      "const DEFERRED = [{ path: 'server/prisma/schema.prisma', ticket: 'LZP-999', since: '2026-01-01', why: 'test' }];"));
    const r = runCheck(dir);
    assert.ok(r.failed.includes('D0'),
      'a subject that is deferred but present must FAIL, or DEFERRED rots into permanent amnesty the way `owed` did');
  } finally { rm(dir, '.'); }
});
