// Deploy readiness for the sync server — `node .github/scripts/check-server-config.mjs`
//
// LZP-109, rewritten under LZP-1008's release blocker.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS FILE WAS REWRITTEN.  It passed a configuration that could not work.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `server/prisma/migrations/` did not exist. `prisma migrate deploy` APPLIES migrations; it does
// not create them. So the first deploy against an empty Postgres applied nothing, created no
// tables, and every query would have failed on a missing relation — in production, after the DMG
// had gone out. This script printed `ok every check passed`.
//
// It printed that for a structural reason, not a careless one, and the structure is the actual
// defect: **every substantive check was guarded by `if (existsSync(subject))`**, and the missing
// files were routed to an `owed` list that was reported and then ignored. Absence was the one
// state the check could not fail on. A pre-flight whose blind spot is *"the thing is not there"*
// is worse than no pre-flight, because it is believed.
//
// The three rules this rewrite is built on:
//
//   1. **A missing subject is a FAIL, not a silence.** Deferral still exists — `DEFERRED` below —
//      but it is an explicit, dated list that names the ticket which closes each entry, and a
//      deferred subject that has since ARRIVED is itself a failure, so the list cannot rot into
//      permanent amnesty the way `owed` did.
//   2. **A check that did not run says so, in the exit summary and in the last line.** The
//      script never again prints a sentence about checks it skipped. `SKIP` rows are counted
//      separately and named, with the exact command that would settle them.
//   3. **It names the adapter it is judging.** `server/adapters/` has four. Only the one the
//      deployed entry point actually reaches needs a database at all, and a verdict phrased as
//      if it covered all four is a verdict about nothing.
//
// Nothing here needs a network or a database. `--deep` opts into the two rows that do.
//
// Usage:
//   node .github/scripts/check-server-config.mjs            offline pre-flight (CI, checklist)
//   node .github/scripts/check-server-config.mjs --deep     also: migrations APPLIED, no drift
//                                                           (needs DATABASE_URL + server/node_modules)
//   node .github/scripts/check-server-config.mjs --json     machine-readable rows

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const at = (p) => resolve(ROOT, p);
const read = (p) => readFileSync(at(p), 'utf8');
const has = (p) => existsSync(at(p));

const ARGV = new Set(process.argv.slice(2));
const DEEP = ARGV.has('--deep');
const JSON_OUT = ARGV.has('--json');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The row ledger.  Every check is a row with an id, because a failure has to be nameable — by a
// human reading CI output, and by `tests/server/deploy-readiness.test.js`, which mutates the tree
// and asserts WHICH row dies.
// ─────────────────────────────────────────────────────────────────────────────────────────────
/** @type {Array<{id:string, subject:string, state:'pass'|'FAIL'|'warn'|'skip', msg:string}>} */
const rows = [];
const pass = (id, subject, msg) => rows.push({ id, subject, state: 'pass', msg });
const fail = (id, subject, msg) => rows.push({ id, subject, state: 'FAIL', msg });
const warn = (id, subject, msg) => rows.push({ id, subject, state: 'warn', msg });
const skip = (id, subject, msg) => rows.push({ id, subject, state: 'skip', msg });

/**
 * Subjects that are legitimately not built yet.
 *
 * EMPTY, and that is the point. The old script's `owed` list held five entries and every one of
 * them has existed since WP-7 landed, so the mechanism had quietly become a way of never failing.
 * An entry here must carry the ticket that closes it and the date it was added; `D0` below fails
 * when a deferred subject has arrived, which is what stops this list outliving its reason.
 *
 * @type {Array<{path:string, ticket:string, since:string, why:string}>}
 */
const DEFERRED = [];

/**
 * Require a file or directory to exist. Returns true when it does, so callers can guard the
 * checks that would throw — but the guard now costs a FAIL row instead of silence.
 */
function require_(id, p, why) {
  if (has(p)) {
    pass(id, p, 'is present');
    return true;
  }
  const deferred = DEFERRED.find((d) => d.path === p);
  if (deferred) {
    skip(id, p, `deferred to ${deferred.ticket} (since ${deferred.since}) — ${deferred.why}`);
    return false;
  }
  fail(id, p, `is missing — ${why}`);
  return false;
}

// D0 — the anti-rot latch on DEFERRED itself.
for (const d of DEFERRED) {
  if (has(d.path)) {
    fail('D0', d.path, `is deferred to ${d.ticket} but now EXISTS. Remove it from DEFERRED so its checks turn binding; a deferral that outlives its subject is how "owed" became permanent.`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// A — WHICH ADAPTER IS THIS RUN JUDGING?
//
// `server/adapters/` holds four: memory, file, prisma, vercel. Three of them cannot have the
// migration problem — memory holds a Map, file holds a JSON document, and vercel is the HTTP
// normalisation layer that delegates its storage to another adapter. Exactly one talks to
// Postgres. So the run resolves the deployed chain from source and states it, and the migration
// section below is demanded only when the resolved store adapter needs a schema to exist.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Store adapters and whether a deploy of them needs migrations to have been generated. */
const STORE_ADAPTERS = {
  memoryStore: { name: 'memory', file: 'server/adapters/memory.js', needsSchema: false, note: 'an in-process Map; tests and the dev host only' },
  fileStore:   { name: 'file',   file: 'server/adapters/file.js',   needsSchema: false, note: 'one JSON document on disk; server/dev-server.mjs only' },
  prismaStore: { name: 'prisma', file: 'server/adapters/prisma.js', needsSchema: true,  note: 'Prisma Postgres in eu-central-1 — the only adapter with a schema to create' },
};

const ENTRY = 'server/api/v1/[[...path]].js';
let judged = null;      // the resolved store adapter, or null if the chain could not be read
let httpAdapter = null; // the adapter that owns the request/response normalisation

if (require_('A1', ENTRY, 'the Vercel filesystem router has no function to match; nothing is deployed')) {
  const entrySrc = read(ENTRY);
  const reexport = /from\s+'([^']*adapters\/([a-z]+)\.js)'/.exec(entrySrc);
  if (!reexport) {
    fail('A1b', ENTRY, 'does not re-export from server/adapters/*.js, so this check cannot tell which adapter is deployed. A readiness check that cannot name its subject must not answer for it.');
  } else {
    httpAdapter = reexport[2];
    const httpPath = join('server/adapters', `${httpAdapter}.js`);
    if (require_('A2', httpPath, `${ENTRY} re-exports its handler from a file that is not there`)) {
      const httpSrc = read(httpPath);
      const found = Object.keys(STORE_ADAPTERS).filter((f) => new RegExp(`\\b${f}\\b`).test(httpSrc));
      if (found.length !== 1) {
        fail('A3', httpPath, `imports ${found.length} store factories (${found.join(', ') || 'none'}). The deployed storage must be unambiguous — this check refuses to guess which of ${Object.keys(STORE_ADAPTERS).length} adapters it is judging.`);
      } else {
        judged = STORE_ADAPTERS[found[0]];
        if (require_('A4', judged.file, `${httpPath} imports ${found[0]} from a file that is not there`)) {
          pass('A3', httpPath, `deploys the ${judged.name} store adapter (${judged.file})`);
        }
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// V — the deployment manifest
// ═════════════════════════════════════════════════════════════════════════════════════════════

if (require_('V1', 'server/vercel.json', 'LZP-109 has nothing to deploy with')) {
  let v = null;
  try {
    v = JSON.parse(read('server/vercel.json'));
  } catch (e) {
    fail('V1', 'server/vercel.json', `is not valid JSON (${e.message}). Vercel would reject the deployment.`);
  }

  if (v) {
    // D2 / addendum §9: functions AND database in Frankfurt. Vercel spells that region "fra1";
    // Prisma Postgres spells the same datacentre "eu-central-1". Both are Frankfurt; neither
    // name is a typo for the other.
    const regions = v.regions || [];
    if (regions.length !== 1 || regions[0] !== 'fra1') {
      fail('V2', 'server/vercel.json', `regions is ${JSON.stringify(regions)}; decision D2 pins it to ["fra1"] (Frankfurt). The Datenschutz text (21.3) names the region — changing it here without changing that text makes the privacy copy false.`);
    } else {
      pass('V2', 'server/vercel.json', 'regions ["fra1"] — Frankfurt, decision D2');
    }

    const build = String(v.buildCommand || '');
    if (!/prisma\s+migrate\s+deploy/.test(build)) {
      fail('V3', 'server/vercel.json', 'buildCommand does not run `prisma migrate deploy` — the schema would drift from the code');
    } else {
      pass('V3', 'server/vercel.json', 'buildCommand runs `prisma migrate deploy`');
    }
    if (/prisma\s+migrate\s+dev/.test(build) || /db\s+push/.test(build)) {
      fail('V4', 'server/vercel.json', 'buildCommand uses `migrate dev` or `db push`. Neither is safe against a live database; use `migrate deploy`.');
    } else {
      pass('V4', 'server/vercel.json', 'buildCommand uses neither `migrate dev` nor `db push`');
    }
    if (!/prisma\s+generate/.test(build)) {
      fail('V5', 'server/vercel.json', 'buildCommand does not run `prisma generate`');
    } else {
      pass('V5', 'server/vercel.json', 'buildCommand runs `prisma generate`');
    }
    if (!/VERCEL_ENV/.test(build)) {
      fail('V6', 'server/vercel.json', 'buildCommand does not distinguish production from preview. A preview deploy that runs `migrate deploy` against the production DATABASE_URL migrates production from a branch — see docs/v2/RELEASE.md § "Preview environments".');
    } else {
      pass('V6', 'server/vercel.json', 'buildCommand gates `migrate deploy` on VERCEL_ENV (docs/v2/RUNBOOK.md §2.3)');
    }

    const allHeaders = (v.headers || []).flatMap((b) => b.headers || []);
    if (allHeaders.some((h) => /^access-control-allow-origin$/i.test(h.key))) {
      fail('V7', 'server/vercel.json', 'sets Access-Control-Allow-Origin. The client is a desktop app, not a web page; CORS here only widens the attack surface (21.5).');
    } else {
      pass('V7', 'server/vercel.json', 'no Access-Control-Allow-Origin (21.5)');
    }
    if (!allHeaders.some((h) => /^cache-control$/i.test(h.key) && /no-store/.test(h.value))) {
      fail('V8', 'server/vercel.json', 'does not send Cache-Control: no-store on /api — encrypted op batches must not sit in an intermediary cache');
    } else {
      pass('V8', 'server/vercel.json', 'Cache-Control: no-store on /api');
    }

    // V9 — the `functions` glob has to match a file that exists. A glob matching nothing is a
    // deploy with no routes at all: every request 404s and the smoke test in server.yml reads
    // that as "the server is not deployed here yet" and passes.
    const globs = Object.keys(v.functions || {});
    if (globs.length === 0) {
      warn('V9', 'server/vercel.json', 'declares no `functions` block; the platform defaults decide maxDuration and memory');
    } else {
      const apiFiles = has('server/api') ? walk('server/api').filter((f) => f.endsWith('.js')) : [];
      if (apiFiles.length === 0) {
        fail('V9', 'server/vercel.json', `functions glob ${JSON.stringify(globs)} matches nothing — server/api holds no .js entry point, so the deployment would answer 404 on every route.`);
      } else {
        pass('V9', 'server/vercel.json', `functions glob ${JSON.stringify(globs)} matches ${apiFiles.length} entry point(s), including ${apiFiles[0]}`);
      }
    }

    // V10 — `npm ci` is not `npm install`: it refuses to run without a lockfile, and it fails the
    // build outright when the lockfile and the manifest disagree. See P5.
    if (String(v.installCommand || '').includes('npm ci') && !has('server/package-lock.json')) {
      fail('V10', 'server/vercel.json', 'installCommand is `npm ci` but server/package-lock.json is missing — `npm ci` exits non-zero without one and the build never starts');
    } else {
      pass('V10', 'server/vercel.json', `installCommand ${JSON.stringify(v.installCommand || '(platform default)')} is satisfiable`);
    }
  }
}

/** Every file under a directory, repo-relative. */
function walk(rel) {
  const out = [];
  const stack = [rel];
  while (stack.length) {
    const cur = stack.pop();
    for (const name of readdirSync(at(cur))) {
      if (name.startsWith('.')) continue;
      const child = `${cur}/${name}`;
      if (statSync(at(child)).isDirectory()) stack.push(child);
      else out.push(child);
    }
  }
  return out.sort();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P — the package boundary, and the two manifests that must agree
// ═════════════════════════════════════════════════════════════════════════════════════════════

const rootPkg = JSON.parse(read('package.json'));
const rootDeps = Object.keys(rootPkg.dependencies || {});
if (rootDeps.length > 0) {
  fail('P1', 'package.json', `the ROOT package.json gained dependencies (${rootDeps.join(', ')}). Server dependencies belong in server/package.json.`);
} else {
  pass('P1', 'package.json', 'the root app has zero runtime dependencies');
}
if (/prisma/i.test(JSON.stringify(rootPkg))) {
  fail('P2', 'package.json', 'the root package.json mentions Prisma. The desktop app never talks to a database.');
} else {
  pass('P2', 'package.json', 'the root package.json does not mention Prisma');
}

const serverPkgOk = require_('P3', 'server/package.json', '`npm ci` has no manifest to install (server/vercel.json installCommand)');
const serverLockOk = require_('P4', 'server/package-lock.json', '`npm ci` refuses to run — it is not `npm install` and will not resolve a tree without a lockfile');

if (serverPkgOk && serverLockOk) {
  const pkg = JSON.parse(read('server/package.json'));
  const lock = JSON.parse(read('server/package-lock.json'));
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const rootEntry = (lock.packages || {})[''] || {};
  const locked = { ...(rootEntry.dependencies || {}), ...(rootEntry.devDependencies || {}) };

  // P5 — `npm ci` compares these two and exits 1 on any disagreement. That failure happens
  // INSIDE the Vercel build, where the previous deployment is already being torn down.
  const disagreements = [];
  for (const [name, range] of Object.entries(declared)) {
    if (!(name in locked)) disagreements.push(`${name} is in package.json but not in the lockfile's root entry`);
    else if (locked[name] !== range) disagreements.push(`${name}: package.json wants ${range}, the lockfile records ${locked[name]}`);
    else if (!(lock.packages || {})[`node_modules/${name}`]) disagreements.push(`${name} has no resolved node_modules entry in the lockfile`);
  }
  for (const name of Object.keys(locked)) {
    if (!(name in declared)) disagreements.push(`${name} is in the lockfile's root entry but not in package.json`);
  }
  if (disagreements.length) {
    fail('P5', 'server/package-lock.json', `disagrees with server/package.json — \`npm ci\` fails the build: ${disagreements.join('; ')}. Run \`cd server && npm install\` and commit both files.`);
  } else {
    pass('P5', 'server/package-lock.json', `agrees with server/package.json on all ${Object.keys(declared).length} package(s)`);
  }

  // P6 — the CLI that runs the migration and the client that runs the queries are two packages
  // with one version number between them. Prisma refuses to start when they diverge across a
  // major, and behaves surprisingly across a minor.
  const cli = (pkg.devDependencies || {}).prisma;
  const client = (pkg.dependencies || {})['@prisma/client'];
  if (!judged) {
    skip('P6', 'server/package.json', 'the deployed adapter could not be resolved (A1b/A3) — this run does not judge which client the deploy needs');
  } else if (judged.needsSchema) {
    if (!cli || !client) {
      fail('P6', 'server/package.json', `the ${judged.name} adapter is deployed but server/package.json declares ${cli ? '' : 'no `prisma` CLI'}${!cli && !client ? ' and ' : ''}${client ? '' : 'no `@prisma/client`'}. The build cannot generate a client or apply a migration.`);
    } else if (cli !== client) {
      fail('P6', 'server/package.json', `prisma CLI is ${cli} and @prisma/client is ${client}. They are versioned together; a mismatch is a build that generates one client and migrates with another.`);
    } else {
      pass('P6', 'server/package.json', `prisma CLI and @prisma/client are both ${cli}`);
    }
  } else {
    skip('P6', 'server/package.json', 'the deployed adapter needs no Prisma client');
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S — the schema
// ═════════════════════════════════════════════════════════════════════════════════════════════

let schemaModels = [];   // [{ name, columns: string[] }]
let schemaEnums = [];    // string[]
let datasourceProvider = null;

// Why an UNRESOLVED adapter skips the database rows instead of demanding them: the whole charge
// against the old script is that it answered for things it had not established. A3 has already
// FAILED at this point, so the run is NOT READY and exit 1 either way — nothing is gained by also
// asserting a migration requirement for an adapter this check could not name, and the honesty of
// the verdict is lost by doing it. Fix A3, and every row below turns binding again.
const adapterState = !judged ? 'unresolved' : judged.needsSchema ? 'needs-db' : 'no-db';
const noDbReason = !judged
  ? 'the deployed adapter could not be resolved (A1b/A3) — fix that first; this run judges nothing about storage'
  : `the deployed adapter (${judged.name}) stores nothing in a database — ${judged.note}`;

const schemaNeeded = adapterState === 'needs-db';
if (!schemaNeeded) {
  skip('S1', 'server/prisma/schema.prisma', noDbReason);
} else if (require_('S1', 'server/prisma/schema.prisma', '`prisma generate` and `prisma migrate deploy` have no schema — the build fails and there is nothing to create tables from')) {
  const schema = read('server/prisma/schema.prisma');
  const code = schema.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  if (!/env\(\s*"DATABASE_URL"\s*\)/.test(code)) {
    fail('S2', 'server/prisma/schema.prisma', 'does not read its url from env("DATABASE_URL")');
  } else {
    pass('S2', 'server/prisma/schema.prisma', 'reads its url from env("DATABASE_URL")');
  }
  if (/postgres(ql)?:\/\/[^"\s]*:[^"\s]*@/.test(code)) {
    fail('S3', 'server/prisma/schema.prisma', 'contains a literal connection string with credentials. Remove it, rotate the database password, and use env("DATABASE_URL").');
  } else {
    pass('S3', 'server/prisma/schema.prisma', 'holds no literal connection string');
  }

  const prov = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/s.exec(code);
  datasourceProvider = prov ? prov[1] : null;
  if (datasourceProvider !== 'postgresql') {
    fail('S4', 'server/prisma/schema.prisma', `datasource provider is ${JSON.stringify(datasourceProvider)}; decision D2 and server/adapters/prisma.js assume postgresql`);
  } else {
    pass('S4', 'server/prisma/schema.prisma', 'datasource provider is postgresql');
  }

  // ADR 003 / addendum §3: the relay is blind. A column that could hold a readable label is a
  // design regression. `tests/server/store-contract.test.js` owns the exact column set; this is
  // the deploy-time smoke alarm, and it stays a warning because it greps rather than parses.
  const suspects = ['plainText', 'noteText', /^\s*title\s+String/m, /^\s*label\s+String/m];
  const hits = suspects.filter((s) => (typeof s === 'string' ? code.includes(s) : s.test(code)));
  if (hits.length) {
    warn('S5', 'server/prisma/schema.prisma', `contains ${hits.map(String).join(', ')} — check it is not a plaintext content column; the relay stores ciphertext only (addendum §3). tests/server/store-contract.test.js is the binding check.`);
  } else {
    pass('S5', 'server/prisma/schema.prisma', 'no plaintext-shaped column name');
  }

  // Parse models and their columns. A relation field's type is another model, so it is not a
  // column; that is why the model names are collected first.
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  const raw = [];
  let m;
  while ((m = modelRe.exec(code))) raw.push({ name: m[1], body: m[2] });
  const modelNames = new Set(raw.map((r) => r.name));
  schemaModels = raw.map((r) => ({
    name: r.name,
    columns: r.body.split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@') && !l.startsWith('///'))
      .map((l) => /^(\w+)\s+(\w+)/.exec(l))
      .filter(Boolean)
      .filter((f) => !modelNames.has(f[2]))
      .map((f) => f[1]),
  }));
  const enumRe = /^enum\s+(\w+)\s*\{/gm;
  while ((m = enumRe.exec(code))) schemaEnums.push(m[1]);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// M — THE MIGRATIONS.  The section this rewrite exists for.
//
// `prisma migrate deploy` applies migrations. It does not create them. Nothing else in the
// pipeline creates a table. If this directory is absent, the deploy is green, the function is
// live, and the first write fails on a missing relation.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const MIGRATIONS = 'server/prisma/migrations';

if (!schemaNeeded) {
  skip('M1', MIGRATIONS, noDbReason);
} else if (require_(
  'M1', MIGRATIONS,
  'THE FIRST DEPLOY WOULD CREATE NO TABLES. `prisma migrate deploy` (server/vercel.json '
  + 'buildCommand) applies migrations and never creates them, so an empty Postgres stays empty, '
  + 'the function goes live, and every query fails on a missing relation. Generate them once '
  + 'against a throwaway database and commit them: `cd server && DATABASE_URL="postgres://…/scratch" '
  + 'npx prisma migrate dev --name init` — docs/v2/RUNBOOK.md §2.4.',
)) {
  const dirs = readdirSync(at(MIGRATIONS))
    .filter((d) => !d.startsWith('.'))
    .filter((d) => statSync(at(join(MIGRATIONS, d))).isDirectory())
    .sort();

  if (dirs.length === 0) {
    fail('M2', MIGRATIONS, 'exists but holds no migration. An empty directory creates exactly as many tables as no directory — see M1.');
  } else {
    pass('M2', MIGRATIONS, `${dirs.length} migration(s): ${dirs.join(', ')}`);
  }

  // M3 — migration_lock.toml records the provider the migrations were written for. Prisma
  // refuses to apply a migration set whose lock names a different provider, and it refuses
  // during the build, not before it.
  const lockPath = join(MIGRATIONS, 'migration_lock.toml');
  if (!has(lockPath)) {
    fail('M3', lockPath, 'is missing. Prisma writes it beside the migrations and reads it back at `migrate deploy`; without it the migration set has no declared provider.');
  } else {
    const lockProv = /provider\s*=\s*"([^"]+)"/.exec(read(lockPath));
    if (!lockProv) {
      fail('M3', lockPath, 'declares no provider');
    } else if (datasourceProvider && lockProv[1] !== datasourceProvider) {
      fail('M3', lockPath, `declares provider "${lockProv[1]}" but schema.prisma's datasource is "${datasourceProvider}". \`migrate deploy\` aborts mid-build on this.`);
    } else {
      pass('M3', lockPath, `provider "${lockProv[1]}" matches the datasource`);
    }
  }

  // Fold the migration set into the table/column state it produces. This is a PROXY for drift,
  // and it is labelled one: the exact answer needs a shadow database and lives in L2 below.
  // The proxy is here because it is the half that runs in CI with no database at all, and it is
  // the half that catches the recurrence this rewrite is guarding against — a schema change
  // committed without the migration that carries it.
  /** @type {Map<string, Set<string>>} */
  const tables = new Map();
  const types = new Set();
  let unparsed = 0;

  for (const d of dirs) {
    const sqlPath = join(MIGRATIONS, d, 'migration.sql');
    if (!has(sqlPath)) {
      fail('M4', sqlPath, 'is missing — a migration directory without migration.sql applies nothing and Prisma errors on it');
      continue;
    }
    const sql = read(sqlPath);
    if (sql.trim() === '') {
      fail('M4', sqlPath, 'is empty');
      continue;
    }
    if (/DROP\s+TABLE|DROP\s+COLUMN/i.test(sql)) {
      warn('M8', sqlPath, 'drops a table or column — destructive migrations need a written rollback plan before they deploy (docs/v2/RELEASE.md § "Rolling back")');
    }

    for (const t of sql.matchAll(/CREATE\s+TYPE\s+"(\w+)"/gi)) types.add(t[1]);

    for (const c of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"\s*\(([\s\S]*?)\n\);/gi)) {
      const cols = new Set();
      for (const line of c[2].split('\n')) {
        const col = /^\s*"(\w+)"\s+\S/.exec(line);
        if (col) cols.add(col[1]);
      }
      tables.set(c[1], cols);
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"/gi)) {
      if (!tables.has(a[1])) tables.set(a[1], new Set());
      tables.get(a[1]).add(a[2]);
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"(\w+)"/gi)) {
      tables.get(a[1])?.delete(a[2]);
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+RENAME\s+COLUMN\s+"(\w+)"\s+TO\s+"(\w+)"/gi)) {
      const t = tables.get(a[1]);
      if (t) { t.delete(a[2]); t.add(a[3]); }
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+RENAME\s+TO\s+"(\w+)"/gi)) {
      if (tables.has(a[1])) { tables.set(a[2], tables.get(a[1])); tables.delete(a[1]); }
    }
    // Anything that reshapes a table by a route this folder does not model makes the M5/M6
    // verdict unsound. Say so rather than answer confidently — L2 is the exact check.
    if (/ALTER\s+TABLE[\s\S]*?(ALTER\s+COLUMN|INHERIT|SET\s+SCHEMA)/i.test(sql)) unparsed++;
  }

  if (unparsed > 0) {
    warn('M4', MIGRATIONS, `${unparsed} migration(s) contain ALTER statements this check does not model. M5/M6 below are a coverage proxy only; run --deep with SHADOW_DATABASE_URL for the exact drift answer (L2).`);
  }

  // M5 — every model has a table.
  const missingTables = schemaModels.filter((m) => !tables.has(m.name)).map((m) => m.name);
  if (schemaModels.length === 0) {
    skip('M5', MIGRATIONS, 'the schema declared no models to compare against');
  } else if (missingTables.length) {
    fail('M5', MIGRATIONS, `no migration creates a table for ${missingTables.join(', ')}. The schema declares ${schemaModels.length} model(s); the migrations create ${tables.size}. Regenerate: \`cd server && npx prisma migrate dev --name <what-changed>\` against a scratch database, then commit.`);
  } else {
    pass('M5', MIGRATIONS, `all ${schemaModels.length} model(s) have a CREATE TABLE`);
  }

  // M6 — every column of every model exists after the fold. THIS is the recurrence guard: a
  // column added to schema.prisma without a migration deploys a client that selects a column
  // Postgres does not have, and Prisma fails at the first query rather than at the build.
  const missingCols = [];
  for (const model of schemaModels) {
    const cols = tables.get(model.name);
    if (!cols) continue; // already reported by M5
    for (const c of model.columns) if (!cols.has(c)) missingCols.push(`${model.name}.${c}`);
  }
  if (missingTables.length) {
    skip('M6', MIGRATIONS, 'M5 already failed — fix the missing table(s) first');
  } else if (missingCols.length) {
    fail('M6', MIGRATIONS, `the schema declares column(s) no migration creates: ${missingCols.join(', ')}. The generated client will SELECT a column Postgres does not have, and the failure lands on the first query in production, not in the build.`);
  } else {
    const total = schemaModels.reduce((n, m) => n + m.columns.length, 0);
    pass('M6', MIGRATIONS, `all ${total} column(s) across ${schemaModels.length} model(s) are created by the migration set`);
  }

  // M7 — enums.
  const missingTypes = schemaEnums.filter((e) => !types.has(e));
  if (schemaEnums.length === 0) {
    skip('M7', MIGRATIONS, 'the schema declares no enums');
  } else if (missingTypes.length) {
    fail('M7', MIGRATIONS, `no migration creates the enum type(s) ${missingTypes.join(', ')}`);
  } else {
    pass('M7', MIGRATIONS, `all ${schemaEnums.length} enum(s) have a CREATE TYPE`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// L — the two rows that need a live database.  SKIPPED without --deep, and SAID to be skipped.
//
// The old script's fatal habit was answering for what it had not looked at. These rows are the
// only ones that can prove "migrations APPLIED" and "the adapter is REACHABLE", and they cannot
// run in CI. So they are named, counted, and printed with the command that settles them — the
// summary line below never claims completeness while a skip is outstanding.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const PRISMA_BIN = 'server/node_modules/.bin/prisma';
const DB_URL = process.env.DATABASE_URL || '';

// `migrate diff` names its own inputs and rejects `--schema`; every other subcommand needs it.
function runPrisma(args) {
  const withSchema = args[1] === 'diff' ? args : [...args, '--schema', at('server/prisma/schema.prisma')];
  return spawnSync(at(PRISMA_BIN), withSchema, {
    cwd: at('server'),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DB_URL },
  });
}

if (!schemaNeeded) {
  skip('L1', 'database', noDbReason);
  skip('L2', 'database', noDbReason);
} else if (!DEEP) {
  skip('L1', 'database', 'migrations APPLIED and the adapter REACHABLE are not checkable offline. Run: `cd server && npm ci && DATABASE_URL="…?connection_limit=1" node ../.github/scripts/check-server-config.mjs --deep`');
  skip('L2', 'database', 'schema-vs-migration DRIFT needs a shadow database. Run --deep with SHADOW_DATABASE_URL set to a second, empty database.');
} else if (!DB_URL) {
  fail('L1', 'database', '--deep was given but DATABASE_URL is unset. A deep run that silently degrades to a shallow one is the exact failure this rewrite exists to remove.');
} else if (!has(PRISMA_BIN)) {
  fail('L1', 'database', `--deep needs the Prisma CLI at ${PRISMA_BIN}. Run \`cd server && npm ci\` first.`);
} else {
  const status = runPrisma(['migrate', 'status']);
  const out = `${status.stdout || ''}${status.stderr || ''}`;
  if (status.status !== 0) {
    fail('L1', 'database', `\`prisma migrate status\` exited ${status.status}. Either the database is unreachable or migrations are not applied:\n${out.trim().split('\n').map((l) => `        ${l}`).join('\n')}`);
  } else if (/not yet been applied|not in sync|drift/i.test(out)) {
    fail('L1', 'database', `the database is reachable but not migrated:\n${out.trim().split('\n').map((l) => `        ${l}`).join('\n')}`);
  } else {
    pass('L1', 'database', 'reachable, and every migration is applied (`prisma migrate status`)');
  }

  const shadow = process.env.SHADOW_DATABASE_URL || '';
  if (!shadow) {
    skip('L2', 'database', 'SHADOW_DATABASE_URL is unset; the exact drift answer needs a second empty database');
  } else {
    const diff = runPrisma(['migrate', 'diff', '--from-migrations', at(MIGRATIONS), '--to-schema-datamodel', at('server/prisma/schema.prisma'), '--shadow-database-url', shadow, '--script']);
    if (diff.status !== 0) {
      fail('L2', 'database', `\`prisma migrate diff\` exited ${diff.status}: ${(diff.stderr || '').trim()}`);
    } else if (/^\s*--\s*This is an empty migration\.\s*$/m.test(diff.stdout || '')) {
      pass('L2', 'database', 'no drift — the migration set reproduces schema.prisma exactly');
    } else {
      fail('L2', 'database', `the migration set does NOT reproduce schema.prisma. The difference:\n${(diff.stdout || '').trim().split('\n').slice(0, 20).map((l) => `        ${l}`).join('\n')}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Report
// ═════════════════════════════════════════════════════════════════════════════════════════════

const failures = rows.filter((r) => r.state === 'FAIL');
const skipped = rows.filter((r) => r.state === 'skip');
const warnings = rows.filter((r) => r.state === 'warn');
const passed = rows.filter((r) => r.state === 'pass');

if (JSON_OUT) {
  console.log(JSON.stringify({
    adapter: judged ? judged.name : null,
    httpAdapter,
    deep: DEEP,
    rows,
    ok: failures.length === 0,
  }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

console.log('LangzeitPlaner sync-server deploy readiness');
console.log('');
if (judged) {
  console.log(`  judging   the ${judged.name} store adapter — ${judged.note}`);
  console.log(`            reached as ${ENTRY} → server/adapters/${httpAdapter}.js → ${judged.file}`);
  const others = Object.values(STORE_ADAPTERS).filter((a) => a.name !== judged.name).map((a) => a.name);
  console.log(`  not judged  ${others.join(', ')} — this run says NOTHING about them. They are never deployed.`);
} else {
  console.log('  judging   NOTHING — the deployed adapter could not be resolved from the entry point (row A1/A3).');
}
console.log('');
for (const r of rows.filter((x) => x.state === 'FAIL')) console.log(`  FAIL  ${r.id}  ${r.subject} ${r.msg}`);
for (const r of warnings) console.log(`  warn  ${r.id}  ${r.subject} — ${r.msg}`);
for (const r of skipped) console.log(`  skip  ${r.id}  ${r.subject} — ${r.msg}`);
if (process.env.LZP_CHECK_VERBOSE === '1') {
  for (const r of passed) console.log(`  ok    ${r.id}  ${r.subject} — ${r.msg}`);
}
console.log('');

const tally = `${passed.length} passed · ${failures.length} failed · ${warnings.length} warning(s) · ${skipped.length} not checked here`;
if (failures.length === 0) {
  // NEVER "every check passed" while something was skipped. That sentence is what made the
  // missing migrations survive three audits.
  console.log(skipped.length === 0
    ? `  ready    ${tally} — every check this script has ran, and passed.`
    : `  ready?   ${tally}. The ${skipped.length} unchecked row(s) above are NOT a pass; read them before you deploy.`);
  process.exit(0);
}
console.log(`  NOT READY  ${tally}`);
console.log('\nSee docs/v2/RUNBOOK.md §2 and docs/v2/RELEASE.md § "The sync server".');
process.exit(1);
