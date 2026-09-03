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

/**
 * One spelling for a Postgres type, so the schema side and the migration side can be compared.
 * `TIMESTAMP(3)` and `timestamp` are the same type; `"SpaceKind"` is the enum SpaceKind.
 */
const normType = (t) => String(t).trim()
  .replace(/^"|"$/g, '')
  .replace(/\(\s*\d+(?:\s*,\s*\d+)?\s*\)/, '')
  .trim()
  .toLowerCase();

/** A comma-separated list of identifiers → an array. Used on both sides of the comparison. */
const listOf = (s) => String(s).split(',').map((x) => x.trim().replace(/\(.*$/, '')).filter(Boolean);

/** Two column lists are the same constraint when they name the same columns in the same order. */
const sameCols = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

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

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Parse the models into the RELATIONAL SHAPE they demand, not just a list of names.
  //
  // The first version of this parser collected column NAMES and nothing else, and M5/M6 below
  // compared name sets. That is why eleven separate corruptions of the migration set passed the
  // check — measured, `docs/v2/RUNBOOK.md` §2.4.1. A `@@id` narrowed by one column, a `@@unique`
  // deleted, `Bytes` degraded to `TEXT`, `onDelete: Cascade` turned into `NO ACTION`: every one
  // of those leaves the table and column names untouched, and every one of them is a defect that
  // reaches production silently, because the deploy is green and the client only fails — or
  // worse, does NOT fail — at the first write.
  //
  // So a field carries its type, its nullability and whether it has a default; a model carries
  // its primary key, its unique constraints, its indexes, and the delete behaviour of each
  // relation. M9–M16 compare those.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  const enumRe = /^enum\s+(\w+)\s*\{/gm;
  let m;
  while ((m = enumRe.exec(code))) schemaEnums.push(m[1]);
  const enumNames = new Set(schemaEnums);

  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  const raw = [];
  while ((m = modelRe.exec(code))) raw.push({ name: m[1], body: m[2] });
  const modelNames = new Set(raw.map((r) => r.name));

  /** Prisma scalar → the Postgres type `prisma migrate` emits for it. */
  const PG_TYPE = {
    String: 'text', Boolean: 'boolean', Int: 'integer', BigInt: 'bigint',
    Float: 'double precision', Decimal: 'decimal', DateTime: 'timestamp',
    Bytes: 'bytea', Json: 'jsonb',
  };
  const cols = listOf;

  schemaModels = raw.map((r) => {
    const fields = [];
    const uniques = [];
    const indexes = [];
    const fks = [];
    let pk = null;
    let nativeTyped = false;

    for (const line0 of r.body.split('\n')) {
      const line = line0.trim();
      if (!line || line.startsWith('//')) continue;

      if (line.startsWith('@@')) {
        let a;
        if ((a = /^@@id\(\s*\[([^\]]*)\]/.exec(line))) pk = cols(a[1]);
        else if ((a = /^@@unique\(\s*\[([^\]]*)\]/.exec(line))) uniques.push(cols(a[1]));
        else if ((a = /^@@index\(\s*\[([^\]]*)\]/.exec(line))) indexes.push(cols(a[1]));
        continue;
      }

      const f = /^(\w+)\s+(\w+)(\?)?(\[\])?\s*(.*)$/.exec(line);
      if (!f) continue;
      const [, fname, ftype, optional, list, attrs] = f;

      // A relation field's type is another model. It is not a column — but its @relation does
      // declare a foreign key, and `onDelete` is the whole of the 20.2 purge.
      if (modelNames.has(ftype)) {
        const rel = /@relation\(([^)]*)\)/.exec(attrs);
        if (rel && /fields\s*:/.test(rel[1])) {
          const fcols = /fields\s*:\s*\[([^\]]*)\]/.exec(rel[1]);
          const onDel = /onDelete\s*:\s*(\w+)/.exec(rel[1]);
          fks.push({
            cols: fcols ? cols(fcols[1]) : [],
            references: ftype,
            // Prisma's default for a required relation is RESTRICT; for optional, SET NULL.
            onDelete: onDel ? onDel[1] : (optional ? 'SetNull' : 'Restrict'),
          });
        }
        continue;
      }
      if (list) continue; // a list of a scalar is not a plain column here

      if (/@db\./.test(attrs)) nativeTyped = true;
      if (/\B@id\b/.test(attrs)) pk = [fname];
      if (/\B@unique\b/.test(attrs)) uniques.push([fname]);

      fields.push({
        name: fname,
        pgType: enumNames.has(ftype) ? ftype.toLowerCase() : (PG_TYPE[ftype] || null),
        prismaType: ftype,
        nullable: Boolean(optional),
        hasDefault: /@default\(/.test(attrs),
      });
    }

    return { name: r.name, fields, columns: fields.map((f) => f.name), pk, uniques, indexes, fks, nativeTyped };
  });
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
  /**
   * @type {Map<string, {cols: Map<string,{type:string,notNull:boolean,hasDefault:boolean}>,
   *                     pk: string[]|null,
   *                     uniques: Map<string,string[]>,
   *                     indexes: Map<string,string[]>,
   *                     fks: Map<string,{cols:string[],onDelete:string}>}>}
   */
  const tables = new Map();
  const types = new Set();
  /** Tables an index or constraint names that no CREATE TABLE in the set ever created. */
  const dangling = new Set();
  let unparsed = 0;

  // `table()` CREATES the entry, and only the two statements that really create a table or a
  // column may call it. An index or a foreign key must use `tables.get()` and tolerate `undefined`.
  //
  // WHY THE DISTINCTION IS LOAD-BEARING: every model here is also the target of an
  // `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`. When the FK handler auto-vivified, deleting a
  // model's whole CREATE TABLE left an EMPTY entry behind, `tables.has(name)` stayed true, M5
  // passed, and the failure surfaced as M6 ("the schema declares columns no migration creates")
  // — a true statement that names the wrong defect and sends the reader to the wrong fix.
  // Measured while building the mutant table in docs/v2/RUNBOOK.md §2.4.1.
  const table = (n) => {
    if (!tables.has(n)) tables.set(n, { cols: new Map(), pk: null, uniques: new Map(), indexes: new Map(), fks: new Map() });
    return tables.get(n);
  };
  /** `"a", "b"` → ['a','b'] */
  const sqlCols = (s) => [...String(s).matchAll(/"(\w+)"/g)].map((x) => x[1]);

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
      const t = table(c[1]);
      for (const line of c[2].split('\n')) {
        // An inline table constraint, e.g. `CONSTRAINT "Op_pkey" PRIMARY KEY ("spaceId","seq")`.
        const pkc = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line);
        if (pkc) { t.pk = sqlCols(pkc[1]); continue; }
        const uqc = /CONSTRAINT\s+"(\w+)"\s+UNIQUE\s*\(([^)]*)\)/i.exec(line);
        if (uqc) { t.uniques.set(uqc[1], sqlCols(uqc[2])); continue; }
        if (/^\s*(CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.test(line)) continue;

        // A column: `"name" TYPE [NOT NULL] [DEFAULT …],`
        const col = /^\s*"(\w+)"\s+((?:"[\w]+")|(?:\w+(?:\s+PRECISION)?))\s*(\(\s*\d+(?:\s*,\s*\d+)?\s*\))?\s*(.*?),?\s*$/.exec(line);
        if (!col) continue;
        const rest = col[4] || '';
        t.cols.set(col[1], {
          type: normType(col[2]),
          notNull: /\bNOT\s+NULL\b/i.test(rest),
          hasDefault: /\bDEFAULT\b/i.test(rest),
        });
      }
    }

    for (const i of sql.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"\s+ON\s+"(\w+)"\s*\(([^)]*)\)/gi)) {
      const t = tables.get(i[3]);
      if (!t) { dangling.add(i[3]); continue; }
      (i[1] ? t.uniques : t.indexes).set(i[2], sqlCols(i[4]));
    }
    for (const i of sql.matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"(\w+)"/gi)) {
      for (const t of tables.values()) { t.uniques.delete(i[1]); t.indexes.delete(i[1]); }
    }

    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+CONSTRAINT\s+"(\w+)"\s+FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"(\w+)"[^;]*?;/gi)) {
      const onDel = /ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i.exec(a[0]);
      if (!tables.has(a[1])) { dangling.add(a[1]); continue; }
      tables.get(a[1]).fks.set(a[2], {
        cols: sqlCols(a[3]),
        references: a[4],
        onDelete: (onDel ? onDel[1] : 'NO ACTION').toUpperCase().replace(/\s+/g, ' '),
      });
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+CONSTRAINT\s+"(\w+)"\s+PRIMARY\s+KEY\s*\(([^)]*)\)/gi)) {
      if (!tables.has(a[1])) { dangling.add(a[1]); continue; }
      tables.get(a[1]).pk = sqlCols(a[3]);
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+CONSTRAINT\s+"(\w+)"\s+UNIQUE\s*\(([^)]*)\)/gi)) {
      if (!tables.has(a[1])) { dangling.add(a[1]); continue; }
      tables.get(a[1]).uniques.set(a[2], sqlCols(a[3]));
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"(\w+)"/gi)) {
      const t = tables.get(a[1]);
      if (t) { t.fks.delete(a[2]); t.uniques.delete(a[2]); }
    }

    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"(\w+)"\s+((?:"[\w]+")|(?:\w+(?:\s+PRECISION)?))\s*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?\s*([^;,]*)/gi)) {
      table(a[1]).cols.set(a[2], {
        type: normType(a[3]),
        notNull: /\bNOT\s+NULL\b/i.test(a[4] || ''),
        hasDefault: /\bDEFAULT\b/i.test(a[4] || ''),
      });
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"(\w+)"/gi)) {
      tables.get(a[1])?.cols.delete(a[2]);
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+RENAME\s+COLUMN\s+"(\w+)"\s+TO\s+"(\w+)"/gi)) {
      const t = tables.get(a[1]);
      if (t?.cols.has(a[2])) { t.cols.set(a[3], t.cols.get(a[2])); t.cols.delete(a[2]); }
    }
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+RENAME\s+TO\s+"(\w+)"/gi)) {
      if (tables.has(a[1])) { tables.set(a[2], tables.get(a[1])); tables.delete(a[1]); }
    }

    // ALTER COLUMN reshapes a column in place. Model the three forms Prisma emits; anything else
    // makes the verdict unsound and is counted into `unparsed`.
    for (const a of sql.matchAll(/ALTER\s+TABLE\s+"(\w+)"\s+ALTER\s+COLUMN\s+"(\w+)"\s+(SET\s+NOT\s+NULL|DROP\s+NOT\s+NULL|SET\s+DEFAULT|DROP\s+DEFAULT|SET\s+DATA\s+TYPE\s+((?:"[\w]+")|(?:\w+(?:\s+PRECISION)?)))/gi)) {
      const c = tables.get(a[1])?.cols.get(a[2]);
      if (!c) continue;
      const op = a[3].toUpperCase();
      if (op.startsWith('SET NOT NULL')) c.notNull = true;
      else if (op.startsWith('DROP NOT NULL')) c.notNull = false;
      else if (op.startsWith('SET DEFAULT')) c.hasDefault = true;
      else if (op.startsWith('DROP DEFAULT')) c.hasDefault = false;
      else if (a[4]) c.type = normType(a[4]);
    }
    // Anything that reshapes a table by a route this folder does not model makes the M5–M16
    // verdicts unsound. Say so rather than answer confidently — L2 is the exact check.
    if (/ALTER\s+TABLE[\s\S]*?\b(INHERIT|SET\s+SCHEMA)\b/i.test(sql)) unparsed++;
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
    const t = tables.get(model.name);
    if (!t) continue; // already reported by M5
    for (const c of model.columns) if (!t.cols.has(c)) missingCols.push(`${model.name}.${c}`);
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

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  M9–M16 — THE SHAPE, not the names.
  //
  //  M5/M6/M7 above compare NAMES: a model has a table, a field has a column, an enum has a
  //  type. Eleven distinct corruptions of the migration set pass all three, because none of them
  //  renames anything — measured and listed in docs/v2/RUNBOOK.md §2.4.1. They are not exotic;
  //  they are what a hand-edited migration, a bad merge, or a `migrate diff` run against the
  //  wrong baseline actually produces. Four of them are silent in production, which makes them
  //  strictly worse than the missing directory this script was rewritten for: that one at least
  //  failed every query on the first request.
  //
  //  Each row below names the invariant it defends and what is lost when it goes.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  const shapeReady = !missingTables.length && !missingCols.length;
  const shapeSkip = (id, why) => skip(id, MIGRATIONS, why);

  if (!shapeReady) {
    for (const id of ['M9', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16']) {
      shapeSkip(id, 'M5/M6 already failed — the table and column set must agree before the shape can be compared');
    }
  } else {
    // ── M9 — PRIMARY KEYS, column for column and in order. ───────────────────────────────────
    // `KeyWrap.@@id([spaceId, epoch, recipientId, senderDeviceId])` is not a hint. Narrow it by
    // one column and T5-K3 reopens: one member can overwrite every other depositor's wrap for
    // every epoch below her own, the relay counts it as coverage because coverage counts ROWS,
    // and the readers who lose is every future joiner and every A2 recovery. Nothing fails.
    const pkBad = [];
    for (const model of schemaModels) {
      const t = tables.get(model.name);
      if (!model.pk) continue;
      if (!t.pk) pkBad.push(`${model.name}: the schema declares a primary key on (${model.pk.join(', ')}) and the migration creates none`);
      else if (!sameCols(model.pk, t.pk)) pkBad.push(`${model.name}: schema (${model.pk.join(', ')}) vs migration (${t.pk.join(', ')})`);
    }
    if (pkBad.length) {
      fail('M9', MIGRATIONS, `PRIMARY KEY disagrees with the schema — ${pkBad.join('; ')}. A primary key is a CONSTRAINT the handlers rely on for race resolution and write-once (see the KeyWrap and Epoch notes in schema.prisma); a narrowed one is not a slow query, it is a silently different guarantee.`);
    } else {
      pass('M9', MIGRATIONS, `all ${schemaModels.filter((s) => s.pk).length} primary key(s) match the schema column-for-column`);
    }

    // ── M10 — UNIQUE constraints. ────────────────────────────────────────────────────────────
    // `Op.@@unique([spaceId, opId])` is the idempotency key: it is the whole reason a lost
    // response costs one retry and never a duplicate entry. `Member.@@unique([spaceId,
    // colorRef])` is story 15.3. `Device.@@unique([spaceId, deviceShort])` is what makes ADR 003
    // §2 step 4 resolve to exactly one row. Drop any of them and the relay keeps answering 200.
    const uqBad = [];
    for (const model of schemaModels) {
      const have = [...tables.get(model.name).uniques.values()];
      for (const want of model.uniques) {
        if (!have.some((h) => sameCols(want, h))) uqBad.push(`${model.name}(${want.join(', ')})`);
      }
    }
    const uqTotal = schemaModels.reduce((n, s) => n + s.uniques.length, 0);
    if (uqBad.length) {
      fail('M10', MIGRATIONS, `the schema declares unique constraint(s) no migration creates: ${uqBad.join(', ')}. Postgres will accept the duplicate rows these forbid, and the handler that assumed uniqueness will not notice — Op(spaceId, opId) is the idempotency key, Member(spaceId, colorRef) is story 15.3, Device(spaceId, deviceShort) is ADR 003 §2 step 4.`);
    } else {
      pass('M10', MIGRATIONS, `all ${uqTotal} unique constraint(s) are created by the migration set`);
    }

    // ── M11 — non-unique indexes. Correctness is not at stake; a table scan on the op log is. ─
    //
    // A PRIMARY KEY and a UNIQUE constraint each build a real btree in Postgres, so an @@index
    // whose columns they already lead is SERVED and must not be reported missing. `Op` is the
    // case in the tree: `@@id([spaceId, seq])` and `@@index([spaceId, seq])` name the same pair,
    // and `Op_pkey` alone would answer every query `Op_spaceId_seq_idx` was declared for.
    const ixBad = [];
    for (const model of schemaModels) {
      const t = tables.get(model.name);
      const have = [...t.indexes.values(), ...t.uniques.values(), ...(t.pk ? [t.pk] : [])];
      for (const want of model.indexes) {
        // A btree on (a, b, c) serves a lookup on any LEADING prefix of its columns.
        if (!have.some((h) => h.length >= want.length && want.every((c, i) => h[i] === c))) {
          ixBad.push(`${model.name}(${want.join(', ')})`);
        }
      }
    }
    const ixTotal = schemaModels.reduce((n, s) => n + s.indexes.length, 0);
    if (ixBad.length) {
      warn('M11', MIGRATIONS, `the schema declares @@index(es) no migration creates: ${ixBad.join(', ')}. Nothing is incorrect without them; every pull becomes a sequential scan of the op log. A warning, not a failure, because the deploy does work.`);
    } else {
      pass('M11', MIGRATIONS, `all ${ixTotal} @@index(es) are created by the migration set`);
    }

    // ── M12 — COLUMN TYPES. The structural rule in schema.prisma's header lives here. ─────────
    // "every ciphertext-bearing column below is `Bytes`". A migration that writes TEXT where the
    // schema says Bytes gives the relay a column that CAN hold a readable string. store-
    // interface.js refuses a String at the adapter boundary, so this is defence in depth — but
    // the depth is the point: the addendum §3 claim is about what the database can hold.
    const typeBad = [];
    const typeSkipped = [];
    for (const model of schemaModels) {
      if (model.nativeTyped) { typeSkipped.push(model.name); continue; }
      const t = tables.get(model.name);
      for (const f of model.fields) {
        if (!f.pgType) { typeSkipped.push(`${model.name}.${f.name}`); continue; }
        const got = t.cols.get(f.name);
        if (got && got.type !== f.pgType) typeBad.push(`${model.name}.${f.name}: schema ${f.prismaType} (${f.pgType}) vs migration ${got.type}`);
      }
    }
    if (typeBad.length) {
      fail('M12', MIGRATIONS, `column type(s) disagree with the schema: ${typeBad.join('; ')}. A Bytes column created as TEXT is a column that can hold a readable note — the relay is blind by structure (schema.prisma header, addendum §3), and the structure is the column type.`);
    } else if (typeSkipped.length) {
      warn('M12', MIGRATIONS, `types match everywhere they could be compared; ${typeSkipped.length} field(s)/model(s) use a native @db. type or a type this check does not map (${typeSkipped.slice(0, 5).join(', ')}) and were NOT compared. Run --deep with SHADOW_DATABASE_URL for the exact answer (L2).`);
    } else {
      const n = schemaModels.reduce((a, s) => a + s.fields.length, 0);
      pass('M12', MIGRATIONS, `all ${n} column type(s) match the schema`);
    }

    // ── M13 — NULLABILITY. `Space.founderMemberId` MUST stay nullable (finding T5-M1a: a null
    // fails OPEN, and every pre-existing space has no founder recorded). `Member.removedAt` must
    // stay nullable or a live member cannot be inserted at all.
    const nullBad = [];
    for (const model of schemaModels) {
      const t = tables.get(model.name);
      for (const f of model.fields) {
        const got = t.cols.get(f.name);
        if (!got) continue;
        if (f.nullable && got.notNull) nullBad.push(`${model.name}.${f.name} is optional in the schema and NOT NULL in the migration`);
        if (!f.nullable && !got.notNull) nullBad.push(`${model.name}.${f.name} is required in the schema and nullable in the migration`);
      }
    }
    if (nullBad.length) {
      fail('M13', MIGRATIONS, `nullability disagrees with the schema: ${nullBad.join('; ')}. The first direction refuses rows the client will write; the second lets a null reach a client that has been told it cannot be null.`);
    } else {
      pass('M13', MIGRATIONS, 'nullability matches the schema on every column');
    }

    // ── M14 — DEFAULTS. `Space.nextSeq @default(0)` is ADR 003 §3.3's gapless counter starting
    // point; without the DEFAULT every space insert that omits it fails on a NOT NULL violation.
    const defBad = [];
    for (const model of schemaModels) {
      const t = tables.get(model.name);
      for (const f of model.fields) {
        const got = t.cols.get(f.name);
        if (got && f.hasDefault && !got.hasDefault) defBad.push(`${model.name}.${f.name}`);
      }
    }
    if (defBad.length) {
      fail('M14', MIGRATIONS, `the schema gives a @default() to column(s) the migration creates without one: ${defBad.join(', ')}. Prisma omits a defaulted column from the INSERT, so the write fails on a NOT NULL violation at runtime — not at build time.`);
    } else {
      pass('M14', MIGRATIONS, 'every @default() in the schema has a DEFAULT in the migration');
    }

    // ── M15 — FOREIGN KEYS and their ON DELETE. This is the 20.2 purge and the Datenschutz
    // deletion promise: `onDelete: Cascade` is what makes deleting a Space actually remove its
    // members, devices, ops, invites, epochs and key wraps. Downgraded to NO ACTION, the DELETE
    // errors; dropped entirely, the rows are orphaned and the promise is false.
    const PRISMA_TO_SQL_DELETE = { Cascade: 'CASCADE', Restrict: 'RESTRICT', SetNull: 'SET NULL', SetDefault: 'SET DEFAULT', NoAction: 'NO ACTION' };
    const fkBad = [];
    let fkTotal = 0;
    for (const model of schemaModels) {
      const have = [...tables.get(model.name).fks.values()];
      for (const want of model.fks) {
        fkTotal++;
        const got = have.find((h) => sameCols(want.cols, h.cols) && h.references === want.references);
        if (!got) {
          fkBad.push(`${model.name}(${want.cols.join(', ')}) → ${want.references} has no FOREIGN KEY in the migration`);
          continue;
        }
        const wantDel = PRISMA_TO_SQL_DELETE[want.onDelete] || want.onDelete.toUpperCase();
        if (got.onDelete !== wantDel) {
          fkBad.push(`${model.name}(${want.cols.join(', ')}) → ${want.references}: schema says ON DELETE ${wantDel}, migration says ON DELETE ${got.onDelete}`);
        }
      }
    }
    if (fkBad.length) {
      fail('M15', MIGRATIONS, `foreign key(s) disagree with the schema: ${fkBad.join('; ')}. onDelete: Cascade is how a space deletion purges its members, devices, ops, invites, epochs and key wraps (story 20.2 and the Datenschutz deletion promise). Without it the DELETE either errors or leaves the rows behind.`);
    } else {
      pass('M15', MIGRATIONS, `all ${fkTotal} foreign key(s) match the schema, ON DELETE included`);
    }

    // ── M16 — REVERSE DRIFT: a table the migrations create that the schema does not declare. ──
    // The client never selects it, so nothing fails — which is exactly why it survives. A stray
    // table on the blind relay is a place for readable data to accumulate outside the column set
    // `tests/server/store-contract.test.js` polices, and outside the Datenschutz inventory
    // (21.1) that names everything this server can see.
    const declared = new Set(schemaModels.map((s) => s.name));
    const stray = [...tables.keys()].filter((t) => !declared.has(t)).sort();
    if (stray.length) {
      fail('M16', MIGRATIONS, `the migration set creates table(s) schema.prisma does not declare: ${stray.join(', ')}. Nothing queries them, so nothing fails — but the Datenschutz inventory (story 21.1) enumerates what this relay can see, and a table outside schema.prisma is outside that list and outside tests/server/store-contract.test.js.`);
    } else {
      pass('M16', MIGRATIONS, `the migration set creates no table beyond the ${declared.size} the schema declares`);
    }
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
  // BOTH rows, not just L1. The `--deep` branch used to fail L1 and never push an L2 row at all,
  // so the ledger came back 32 rows instead of 33 with a skip count of ZERO — a check that did
  // not run, saying nothing. That is rule 2 of this file's own header, broken by this file.
  fail('L1', 'database', '--deep was given but DATABASE_URL is unset. A deep run that silently degrades to a shallow one is the exact failure this rewrite exists to remove.');
  skip('L2', 'database', 'not reached — L1 has no DATABASE_URL to work from');
} else if (!has(PRISMA_BIN)) {
  fail('L1', 'database', `--deep needs the Prisma CLI at ${PRISMA_BIN}. Run \`cd server && npm ci\` first.`);
  skip('L2', 'database', `not reached — the Prisma CLI is absent at ${PRISMA_BIN}`);
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
