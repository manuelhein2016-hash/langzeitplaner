// Deploy pre-flight for the sync server — `node .github/scripts/check-server-config.mjs`
//
// LZP-109. The server itself is E2's work (WP-7); this checks the deployment
// contract around it, and it is written to run *before* E2 exists: anything
// E2 has not built yet is reported as an owed item, not a failure. Once the
// file appears, the same check becomes binding. Nothing here needs a network,
// a Vercel account or a database.
//
// The four things it refuses to let through:
//   · a region that is not Frankfurt (decision D2, addendum §9 — EU by default)
//   · a build that does not run the Prisma migration
//   · a connection string written into a file instead of an environment variable
//   · CORS on the sync API — the desktop app is not a browser origin, so an
//     Access-Control-Allow-Origin header can only ever help a web page that
//     should not be talking to this server (21.5)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const at = (p) => resolve(ROOT, p);
const read = (p) => readFileSync(at(p), 'utf8');

const problems = [];
const owed = [];
const fail = (m) => problems.push(m);
const owe = (m) => owed.push(m);

// ── vercel.json — the part that exists today ─────────────────────────────────
if (!existsSync(at('server/vercel.json'))) {
  fail('server/vercel.json is missing — LZP-109 has nothing to deploy with');
} else {
  const v = JSON.parse(read('server/vercel.json'));

  // D2 / addendum §9: functions AND database in Frankfurt. Vercel spells that
  // region "fra1"; Prisma Postgres spells the same datacentre "eu-central-1".
  // Both are Frankfurt; neither name is a typo for the other.
  const regions = v.regions || [];
  if (regions.length !== 1 || regions[0] !== 'fra1') {
    fail(
      `server/vercel.json regions is ${JSON.stringify(regions)}; decision D2 pins it to ["fra1"] ` +
        '(Frankfurt). The Datenschutz text (21.3) names the region — changing it here without ' +
        'changing that text makes the privacy copy false.',
    );
  }

  const build = String(v.buildCommand || '');
  if (!/prisma\s+migrate\s+deploy/.test(build)) {
    fail('server/vercel.json buildCommand does not run `prisma migrate deploy` — the schema would drift from the code');
  }
  if (/prisma\s+migrate\s+dev/.test(build) || /db\s+push/.test(build)) {
    fail('server/vercel.json buildCommand uses `migrate dev` or `db push`. Neither is safe against a live database; use `migrate deploy`.');
  }
  if (!/prisma\s+generate/.test(build)) {
    fail('server/vercel.json buildCommand does not run `prisma generate`');
  }
  if (!/VERCEL_ENV/.test(build)) {
    fail(
      'server/vercel.json buildCommand does not distinguish production from preview. A preview ' +
        'deploy that runs `migrate deploy` against the production DATABASE_URL migrates production ' +
        'from a branch — see docs/v2/RELEASE.md § "Preview environments".',
    );
  }

  const headerBlocks = v.headers || [];
  const allHeaders = headerBlocks.flatMap((b) => b.headers || []);
  if (allHeaders.some((h) => /^access-control-allow-origin$/i.test(h.key))) {
    fail('server/vercel.json sets Access-Control-Allow-Origin. The client is a desktop app, not a web page; CORS here only widens the attack surface (21.5).');
  }
  if (!allHeaders.some((h) => /^cache-control$/i.test(h.key) && /no-store/.test(h.value))) {
    fail('server/vercel.json does not send Cache-Control: no-store on /api — encrypted op batches must not sit in an intermediary cache');
  }
}

// ── the root app must stay dependency-free ───────────────────────────────────
// The server needs Prisma; the desktop app must not inherit it. These are two
// package.json files on purpose and the boundary is worth a check.
const rootPkg = JSON.parse(read('package.json'));
const rootDeps = Object.keys(rootPkg.dependencies || {});
if (rootDeps.length > 0) {
  fail(`the ROOT package.json gained dependencies (${rootDeps.join(', ')}). Server dependencies belong in server/package.json.`);
}
if (/prisma/i.test(JSON.stringify(rootPkg))) {
  fail('the root package.json mentions Prisma. The desktop app never talks to a database.');
}

// ── what E2 still owes this pipeline ─────────────────────────────────────────
const owedFiles = [
  ['server/package.json', 'so `npm ci` has a lockfile-backed manifest to install (Vercel installCommand)'],
  ['server/package-lock.json', 'so `npm ci` is reproducible — without it the install command fails outright'],
  ['server/prisma/schema.prisma', 'so `prisma generate` and `prisma migrate deploy` have a schema'],
  ['server/api', 'the Vercel function entry points the `functions` glob in vercel.json refers to'],
  ['tests/server', 'the suite the deploy gate runs before anything reaches Frankfurt'],
];
for (const [p, why] of owedFiles) {
  if (!existsSync(at(p))) owe(`${p} — ${why}`);
}

// ── schema checks, binding once the schema exists ────────────────────────────
if (existsSync(at('server/prisma/schema.prisma'))) {
  const schema = read('server/prisma/schema.prisma');
  if (!/env\(\s*"DATABASE_URL"\s*\)/.test(schema)) {
    fail('server/prisma/schema.prisma does not read its url from env("DATABASE_URL")');
  }
  if (/postgres(ql)?:\/\/[^"\s]*:[^"\s]*@/.test(schema)) {
    fail('server/prisma/schema.prisma contains a literal connection string with credentials. Remove it, rotate the database password, and use env("DATABASE_URL").');
  }
  // ADR 003 / addendum §3: the relay is blind. A column that could hold a
  // readable label is a design regression, and this is where it would show up.
  for (const forbidden of ['plainText', 'title ', 'label ', 'noteText']) {
    if (schema.includes(forbidden)) {
      owe(`schema.prisma contains "${forbidden.trim()}" — check it is not a plaintext content column; the relay stores ciphertext only (addendum §3)`);
    }
  }
}

if (existsSync(at('server/prisma/migrations'))) {
  const migrations = readdirSync(at('server/prisma/migrations')).filter((d) => !d.startsWith('.'));
  console.log(`  info  ${migrations.length} migration(s) present`);
  for (const m of migrations) {
    const sqlPath = join('server/prisma/migrations', m, 'migration.sql');
    if (existsSync(at(sqlPath)) && /DROP\s+TABLE|DROP\s+COLUMN/i.test(read(sqlPath))) {
      owe(`${sqlPath} drops a table or column — destructive migrations need a written rollback plan before they deploy (docs/v2/RELEASE.md § "Rolling back")`);
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log('LangzeitPlaner sync-server deploy pre-flight');
for (const o of owed) console.log(`  owed  ${o}`);
if (problems.length === 0) {
  console.log(`  ok    ${owed.length ? 'no blocking problems; the owed items above are E2/WP-7 work' : 'every check passed'}`);
  process.exit(0);
}
for (const p of problems) console.log(`  FAIL  ${p}`);
console.log(`\n${problems.length} problem(s). See docs/v2/RELEASE.md § "The sync server".`);
process.exit(1);
