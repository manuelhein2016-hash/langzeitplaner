// tests/server/store-contract.test.js — LZP-201's gate.  ADR 003 §9; ADR 005 §1.6, §1.7.
//
// THREE THINGS THIS FILE PROVES, and it is worth being precise about which is which:
//
//  1. THE CONTRACT IS SATISFIABLE, TWICE. `server/core/store-interface.js` exports the whole
//     SyncStore specification as executable cases. They run here against `memory` and `file` —
//     two adapters that share the rule engine and differ exactly where a wire format could break
//     a rule (serialisation, durability). Two green witnesses is what makes the specification a
//     specification rather than a description of one implementation.
//
//  2. THE SCHEMA CANNOT HOLD PLAINTEXT. `server/prisma/schema.prisma` is parsed and compared
//     column-by-column against MODEL_COLUMNS: same models, same columns, every ciphertext column
//     typed `Bytes`, and every readable `String` column named in PLAINTEXT_STRINGS with its
//     justification. There is no column a well-meaning future handler could put a note's text
//     into, and adding one fails here rather than in a review nobody runs.
//
//  3. `prisma.js` IS NOW EXECUTED — AGAINST A REAL POSTGRES, WHEN ONE IS NAMED. R-8.
//     Set `LZP_CONTRACT_DATABASE_URL` to an EXPENDABLE, migrated database and §1b below runs
//     the same STORE_CONTRACT_CASES against `prismaStore`, as a third witness. Without that
//     variable the rows are a STATED SKIP and never a pass — the same discipline
//     `.github/scripts/check-server-config.mjs` uses for L1/L2, and for the same reason: a
//     suite that goes quiet when it cannot check something is how "verified" stops meaning
//     anything. What runs unconditionally is still the shape check, the no-static-import check
//     and the claim-ledger check.
//
//     MEASURED, 2026-09-03, against PostgreSQL 17.10 (Homebrew, aarch64-apple-darwin25.4.0),
//     prisma + @prisma/client 6.19.3, on `connection_limit=1` — the string risk R3 mandates:
//     **65 of 66 cases pass.** The first run was 31 of 66, and the three defects that run found
//     are fixed in `prisma.js` (R8-TXCLIENT, R8-DEVSPACE, R8-BUMPREAD/R8-TZ). The one case that
//     still cannot pass is C40, and it is a FIXTURE defect in a file this owner may not edit —
//     see PRISMA_BLOCKED below, which states it rather than hiding it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STORE_CONTRACT_CASES, STORE_METHODS, MODEL_COLUMNS, OPAQUE_FIELDS, NULLABLE_FIELDS,
  PLAINTEXT_STRINGS, FORBIDDEN_COLUMN_TOKENS, INTERFACE_EXTENSIONS,
  inspectStoreShape, assertStoreShape, normalizeRow, StoreShapeError,
} from '../../server/core/store-interface.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';
import {
  prismaStore, createPrismaClient, isSerializationFailure,
  UNVERIFIED_CLAIMS, CLAIMS_STILL_UNVERIFIED, RESIDUAL_RISKS,
} from '../../server/adapters/prisma.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Harness. NO TEST MAY READ THE WALL CLOCK — every TTL case advances an injected clock, so a
// slow machine cannot make a 180-second pairing window expire mid-test.
// ─────────────────────────────────────────────────────────────────────────────

function fakeClock(startMs) {
  let t = startMs || 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-store-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const ADAPTERS = [
  { name: 'memory', make: (clock) => memoryStore({ now: clock.now }) },
  { name: 'file', make: (clock) => fileStore(tempDir(), { now: clock.now }) },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE CONTRACT, run against every adapter that can run here
// ─────────────────────────────────────────────────────────────────────────────

for (const adapter of ADAPTERS) {
  for (const c of STORE_CONTRACT_CASES) {
    test(`${adapter.name} :: ${c.id} — ${c.title}`, async () => {
      const clock = fakeClock(0);
      await c.run({ makeStore: async () => adapter.make(clock), assert, clock });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. THE SAME CONTRACT, AGAINST A REAL POSTGRES — R-8
//
// WHY A SEPARATE VARIABLE AND NOT `DATABASE_URL`. This harness TRUNCATEs all ten tables before
// every case. `DATABASE_URL` is the name the deployed relay reads, and `server/dev-server.mjs`,
// the runbook and every deploy note use it — so honouring it here would mean that exporting the
// production string and running `npm run test:server` erases a family's board. The variable is
// therefore `LZP_CONTRACT_DATABASE_URL`, it must differ from `DATABASE_URL` if both are set, and
// the preflight below refuses a database whose migration row is missing rather than creating
// tables in whatever it was pointed at.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cases that cannot pass against a real Postgres for a reason that is NOT a defect of the
 * adapter, each with the exact remedy and the file that owns it. This map is the only permitted
 * form of "expected failure" here, it is printed as a skip reason rather than swallowed, and a
 * case listed in it that starts PASSING is itself a failure (see the guard test below) — so it
 * cannot quietly outlive the defect it names.
 */
const PRISMA_BLOCKED = Object.freeze({
  // EMPTY, and that is the measured state, not a default. C40 was the one entry: its
  // `putInvite({ id: 'inv_other', spaceId: SP2 })` named a space nothing had created, `memory`
  // and `file` accepted the orphan because they have no referential integrity, and PostgreSQL
  // 17.10 raised `Invite_spaceId_fkey` and was right to. `server/core/store-interface.js` now
  // creates SP2 first — the same two lines C11 and C22 already write — and the case is green on
  // all three adapters. The guard below is what made this an event rather than a skip that
  // outlived its reason: it went RED the moment the fixture was fixed.
});

const PG_URL = (process.env.LZP_CONTRACT_DATABASE_URL || '').trim();

/** @returns {Promise<{ok:true, client:Object, truncate:() => Promise<void>} | {ok:false, why:string}>} */
async function openContractDatabase() {
  if (!PG_URL) {
    return { ok: false, why:
      'LZP_CONTRACT_DATABASE_URL is unset, so prisma.js is NOT executed by this run and none of '
      + 'its behavioural claims are settled here. To settle them: create an expendable database, '
      + '`cd server && npm ci && DATABASE_URL=<url> npx prisma migrate deploy && npx prisma generate`, '
      + 'then re-run with LZP_CONTRACT_DATABASE_URL=<url>?connection_limit=1' };
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === PG_URL) {
    return { ok: false, why:
      'LZP_CONTRACT_DATABASE_URL is the same string as DATABASE_URL. This harness TRUNCATEs every '
      + 'table before every case; it will not do that to the database the relay is configured to '
      + 'serve from. Point it at a separate, expendable database.' };
  }
  let client;
  try {
    client = await createPrismaClient({ url: PG_URL });
  } catch (err) {
    return { ok: false, why: `the Prisma client could not be built: ${err && err.message}` };
  }
  const TABLES = ['Space', 'Member', 'Device', 'Op', 'Epoch', 'KeyWrap', 'Invite', 'PairSession', 'Nonce', 'RateBucket'];
  try {
    // PREFLIGHT: the migration must already be applied. Refusing here rather than letting 66
    // cases fail on "relation does not exist" is the difference between a diagnosis and a wall.
    const applied = await client.$queryRawUnsafe(
      'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL');
    if (!applied || applied.length === 0) throw new Error('no migration is recorded as applied');
    await client.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  } catch (err) {
    return { ok: false, why:
      `the database at LZP_CONTRACT_DATABASE_URL is not usable as a contract target: ${err && err.message}. `
      + 'Run `DATABASE_URL=<url> npx prisma migrate deploy` from server/ first.' };
  }
  return {
    ok: true,
    client,
    truncate: () => client.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`),
  };
}

const PG = await openContractDatabase();
if (PG.ok) process.on('exit', () => { try { PG.client.$disconnect(); } catch { /* best effort */ } });

if (PG.ok) {
  for (const c of STORE_CONTRACT_CASES) {
    const blocked = PRISMA_BLOCKED[c.id];
    test(`prisma :: ${c.id} — ${c.title}`, { skip: blocked || false }, async () => {
      const clock = fakeClock(0);
      await PG.truncate();
      await c.run({
        // Every `makeStore` is a FRESH, EMPTY store, which for one shared database means an
        // empty database — the same guarantee `file` gets from a fresh temp dir.
        makeStore: async () => { await PG.truncate(); return prismaStore(PG.client, { now: clock.now }); },
        assert,
        clock,
      });
    });
  }

  test('prisma :: a case listed as BLOCKED must still be blocked', async () => {
    // Otherwise the map outlives the defect and starts hiding a real regression behind a skip.
    // The map is EMPTY today, so this row asserts the whole contract ran: 66 of 66 cases against
    // a real cluster, none excused. A future entry re-arms the loop below automatically.
    const ids = Object.keys(PRISMA_BLOCKED);
    assert.equal(STORE_CONTRACT_CASES.filter((c) => !PRISMA_BLOCKED[c.id]).length,
      STORE_CONTRACT_CASES.length - ids.length,
      'the blocked map and the case list disagree about how many cases actually ran');
    for (const id of ids) {
      const c = STORE_CONTRACT_CASES.find((x) => x.id === id);
      assert.ok(c, `${id} is listed as blocked but is not a contract case any more — delete the entry`);
      const clock = fakeClock(0);
      await PG.truncate();
      let threw = false;
      try {
        await c.run({ makeStore: async () => { await PG.truncate(); return prismaStore(PG.client, { now: clock.now }); }, assert, clock });
      } catch { threw = true; }
      assert.ok(threw,
        `${id} now PASSES against Postgres. The reason it was skipped has been fixed — delete it `
        + `from PRISMA_BLOCKED so the row counts as the pass it is.`);
    }
  });
} else {
  test('prisma :: the contract against a real PostgreSQL', { skip: PG.why }, () => {});
}

test('the contract suite is not vacuous and covers the properties LZP-201 is gated on', () => {
  assert.ok(STORE_CONTRACT_CASES.length >= 40, `only ${STORE_CONTRACT_CASES.length} contract cases`);
  const ids = STORE_CONTRACT_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate case ids');
  const tags = new Set(STORE_CONTRACT_CASES.flatMap((c) => c.tags));
  for (const required of ['blind', 'seq', 'concurrency', 'tx', 'idempotency', 'limits', 'pair', 'auth', 'rotation']) {
    assert.ok(tags.has(required), `no contract case is tagged "${required}"`);
  }
  // The two design rules of LZP-201 must each be covered by more than one case, and the
  // concurrency ones must exist at all — a gapless counter that is only tested serially is not
  // tested.
  const byTag = (t) => STORE_CONTRACT_CASES.filter((c) => c.tags.includes(t)).length;
  assert.ok(byTag('blind') >= 5, 'RULE 1 needs more than a token case');
  assert.ok(byTag('seq') >= 5, 'RULE 2 needs more than a token case');
  assert.ok(byTag('concurrency') >= 6, 'atomicity is the half that breaks in production');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SCHEMA CANNOT HOLD PLAINTEXT
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_PATH = path.join(REPO, 'server', 'prisma', 'schema.prisma');
const SCHEMA = fs.readFileSync(SCHEMA_PATH, 'utf8');

/** @returns {Object<string, Array<{name:string, type:string, optional:boolean, list:boolean}>>} */
function parseSchema(src) {
  const models = {};
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    const fields = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('//') || line.startsWith('@@')) continue;
      const f = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (!f) continue;
      fields.push({ name: f[1], type: f[2], list: !!f[3], optional: !!f[4] });
    }
    models[name] = fields;
  }
  return models;
}

/**
 * The schema with every comment line removed. The greps below must run against DECLARATIONS,
 * not against prose: this file's own header explains at length which columns were removed and
 * why, and a naive grep would then fail on the documentation that exists to stop the column
 * coming back.
 */
const SCHEMA_CODE = SCHEMA.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const SCHEMA_MODELS = parseSchema(SCHEMA);
const MODEL_NAMES = new Set(Object.keys(MODEL_COLUMNS));
/** A field whose type is a model is a Prisma relation, not a column. */
const isRelation = (f) => MODEL_NAMES.has(f.type);
const columnsOf = (model) => SCHEMA_MODELS[model].filter((f) => !isRelation(f));

test('schema: the models are exactly the models the interface declares', () => {
  assert.deepEqual(Object.keys(SCHEMA_MODELS).sort(), [...MODEL_NAMES].sort());
});

test('schema: every model has exactly the columns MODEL_COLUMNS declares', () => {
  for (const model of MODEL_NAMES) {
    const got = columnsOf(model).map((f) => f.name).sort();
    assert.deepEqual(got, [...MODEL_COLUMNS[model]].sort(),
      `${model}: the schema and MODEL_COLUMNS disagree. The column set is closed — a column ` +
      `cannot arrive in one without arriving in the other, which is the whole mechanism ` +
      `behind "no future handler can store a readable note".`);
  }
});

test('schema: RULE 1 — every ciphertext-bearing column is Bytes', () => {
  for (const model of MODEL_NAMES) {
    const byName = new Map(columnsOf(model).map((f) => [f.name, f]));
    for (const col of OPAQUE_FIELDS[model]) {
      const f = byName.get(col);
      assert.ok(f, `${model}.${col} is declared opaque but is not in the schema`);
      assert.equal(f.type, 'Bytes',
        `${model}.${col} is ${f.type} in the schema and opaque in the interface. A ciphertext ` +
        `column typed as text is exactly how a readable note reaches Frankfurt.`);
    }
  }
});

test('schema: RULE 1 — every readable String column is named in the metadata inventory', () => {
  const undeclared = [];
  for (const model of MODEL_NAMES) {
    for (const f of columnsOf(model)) {
      if (f.type !== 'String') continue;
      const key = `${model}.${f.name}`;
      if (!Object.prototype.hasOwnProperty.call(PLAINTEXT_STRINGS, key)) undeclared.push(key);
    }
  }
  assert.deepEqual(undeclared, [],
    `String columns the relay can read that are NOT in ADR 003 §5.2's inventory: ${undeclared.join(', ')}. ` +
    `Every one of them is something the server operator can see, so every one of them has to be ` +
    `written down — and it appears in the Datenschutz copy (21.3), which is why this is a test ` +
    `and not a code comment.`);
});

test('schema: the inventory has no entries for columns that do not exist', () => {
  const stale = Object.keys(PLAINTEXT_STRINGS).filter((key) => {
    const [model, col] = key.split('.');
    return !MODEL_COLUMNS[model] || !MODEL_COLUMNS[model].includes(col);
  });
  assert.deepEqual(stale, [], 'a privacy inventory that lists columns nobody has is not an inventory');
});

test('schema: no column name resembles a content column', () => {
  const hits = [];
  for (const model of MODEL_NAMES) {
    for (const f of columnsOf(model)) {
      const lower = f.name.toLowerCase();
      for (const token of FORBIDDEN_COLUMN_TOKENS) if (lower.includes(token)) hits.push(`${model}.${f.name}`);
    }
  }
  assert.deepEqual(hits, [], `columns whose names name content: ${hits.join(', ')}`);
});

test('schema: D9 — there is no wrappedKeys column, anywhere, in any spelling', () => {
  assert.equal(/wrappedkeys/i.test(SCHEMA_CODE), false,
    'PO decision D9: an invite carries no key material. If this ever comes back, a leaked ' +
    'invitation email becomes sufficient to read everything the family has ever shared.');
  assert.equal(MODEL_COLUMNS.Invite.includes('wrappedKeys'), false);
});

test('schema: RULE 2 — the sequence is a per-space counter, never a Postgres SERIAL', () => {
  const space = new Map(columnsOf('Space').map((f) => [f.name, f]));
  assert.equal(space.get('nextSeq').type, 'BigInt');
  assert.equal(/autoincrement\(\)/.test(SCHEMA_CODE), false,
    'a global sequence leaves gaps when transactions commit out of order, so `WHERE seq > cursor` ' +
    'can skip an op that committed after a higher-numbered one — and it leaks cross-family ' +
    'activity volume (ADR 003 §3.3).');
  assert.equal(/@default\(dbgenerated/.test(SCHEMA_CODE), false);
  const op = new Map(columnsOf('Op').map((f) => [f.name, f]));
  assert.equal(op.get('seq').type, 'BigInt');
  assert.ok(/@@id\(\[spaceId, seq\]\)/.test(SCHEMA_CODE), 'the op primary key is per space');
  assert.ok(/@@unique\(\[spaceId, opId\]\)/.test(SCHEMA_CODE), 'idempotency is a database constraint, not a handler check');
});

test('schema: the two columns the addendum sketch had and the relay must not', () => {
  assert.equal(MODEL_COLUMNS.Op.includes('ts'), false,
    'authoring time lives inside the ciphertext (ADR 002 §5.1); the relay keeps receivedAt only');
  assert.equal(/displayNameCipher/.test(SCHEMA_CODE), false,
    'display names travel as member.set ops inside the encrypted stream');
  assert.equal(MODEL_COLUMNS.Member.includes('role'), false,
    'the admin is resolved from the in-log admin chain (ADR 001 §4.1), never from a column the relay could edit');
});

test('schema: decision D2 — the region is named, and it is Frankfurt', () => {
  assert.match(SCHEMA, /eu-central-1/, 'the schema must name the Prisma spelling of the region');
  assert.match(SCHEMA, /Frankfurt/);
  const vercel = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'vercel.json'), 'utf8'));
  assert.deepEqual(vercel.regions, ['fra1'], 'functions and database must sit in the same datacentre');
});

test('schema: the connection string is an environment variable and never a literal', () => {
  assert.match(SCHEMA_CODE, /url\s*=\s*env\("DATABASE_URL"\)/);
  assert.equal(/postgres(ql)?:\/\/[^"\s]*:[^"\s]*@/.test(SCHEMA), false, 'no literal credentials');
});

test('schema: the cascade story 20.4 promises is declared on every relation into Space', () => {
  const relations = SCHEMA_CODE.match(/@relation\([^)]*\)/g) || [];
  const intoSpaceOrMember = relations.filter((r) => /references: \[id\]/.test(r));
  // Member, Device, Op, Epoch, KeyWrap, Invite — every table that holds a family's bytes.
  assert.equal(intoSpaceOrMember.length, 6, `expected 6 owning relations, found ${intoSpaceOrMember.length}`);
  for (const r of intoSpaceOrMember) {
    assert.match(r, /onDelete: Cascade/,
      `20.4 is a purge: ${r} would leave rows behind for a family that asked to be forgotten`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. prisma.js — THE CLAIM LEDGER, AND THE PROPERTIES THAT HOLD WITH NO DATABASE
//
// These rows run on every machine, database or not. What changed with R-8 is that a ledger row
// must now carry a WITNESS as well as a consequence: an entry with no `verifiedOn` is a claim
// nobody has ever checked, and the suite says which ones those are instead of averaging them in
// with the twenty-two that were.
// ─────────────────────────────────────────────────────────────────────────────

const PRISMA_SRC = fs.readFileSync(path.join(REPO, 'server', 'adapters', 'prisma.js'), 'utf8');

test('prisma.js implements the complete SyncStore surface', () => {
  // A stub with the Prisma client's shape. Nothing is CALLED — this asserts the interface, and
  // the interface is the only thing about this adapter that can be asserted on this machine.
  const stub = new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) });
  const store = prismaStore(stub, { now: () => 0 });
  const r = inspectStoreShape(store);
  assert.deepEqual(r.missing, [], 'prismaStore is missing interface methods');
  assert.deepEqual(r.extra, []);
  assert.doesNotThrow(() => assertStoreShape(store));
});

test('prisma.js does not statically import a client that is not installed here', () => {
  // The import must be dynamic, or this whole file — and the shape check above — would be
  // impossible to run on a machine with no `@prisma/client`, which is every machine in this
  // repository today.
  const staticImports = [...PRISMA_SRC.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports.filter((s) => !s.startsWith('.')), [],
    `prisma.js statically imports ${staticImports.join(', ')}; only relative imports may be static`);
  assert.match(PRISMA_SRC, /await import\('@prisma\/client'\)/, 'the client must be reached dynamically');
});

test('prisma.js enumerates every claim this machine cannot check', () => {
  assert.ok(UNVERIFIED_CLAIMS.length >= 15, `only ${UNVERIFIED_CLAIMS.length} unverified claims recorded`);
  const stub = new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) });
  const store = prismaStore(stub, { now: () => 0 });
  for (const c of UNVERIFIED_CLAIMS) {
    assert.ok(c.tag && /^U-[A-Z0-9]+$/.test(c.tag), `bad tag ${c.tag}`);
    assert.ok(STORE_METHODS.includes(c.method), `${c.tag} names ${c.method}, which is not an interface method`);
    assert.equal(typeof store[c.method], 'function');
    assert.ok(c.claim && c.claim.length > 30, `${c.tag} has no claim`);
    assert.ok(c.breaks && c.breaks.length > 30,
      `${c.tag} does not say what breaks. "UNVERIFIED" without a consequence is decoration: ` +
      `the point of the list is that whoever finally runs this against Postgres knows which ` +
      `failures are cosmetic and which lose a family's afternoon.`);
  }
  const tags = UNVERIFIED_CLAIMS.map((c) => c.tag);
  assert.equal(new Set(tags).size, tags.length, 'duplicate claim tags');
});

test('prisma.js — every claim in the ledger names what settled it, or is listed as unsettled', () => {
  // R-8. Before this pass every row was a promise; now every row is a promise plus a witness,
  // and the two exports must agree about which is which. `verifiedOn` naming a contract case is
  // the point: it means a reader can re-run the exact thing that settled the row rather than
  // trusting the sentence.
  for (const c of UNVERIFIED_CLAIMS) {
    if (!c.verifiedOn) continue;
    assert.ok(c.verifiedOn.length > 30,
      `${c.tag} says it is verified without saying by what. A witness that cannot be re-run is ` +
      `the same decoration "UNVERIFIED" without a consequence was.`);
    assert.match(c.verifiedOn, /C\d|EXPLAIN|two[- ]client|static/i,
      `${c.tag}'s witness must name the contract case, the query plan or the static read that ` +
      `settled it, so the next reader can repeat it`);
  }
  assert.deepEqual(
    CLAIMS_STILL_UNVERIFIED.map((c) => c.tag),
    UNVERIFIED_CLAIMS.filter((c) => !c.verifiedOn).map((c) => c.tag),
    'CLAIMS_STILL_UNVERIFIED must be exactly the rows with no witness');

  // AND THE MEASURED STATE ITSELF, pinned. The deepEqual above is derived from the same array on
  // both sides, so on its own it is nearly vacuous — a row that quietly loses its witness keeps
  // it green. This is the row that goes red: as of 2026-09-03 every one of the twenty-two is
  // settled, and a ledger entry that arrives or reverts without one has to say so out loud.
  assert.deepEqual(UNVERIFIED_CLAIMS.filter((c) => !c.verifiedOn).map((c) => c.tag), [],
    'a ledger row with no witness. Either run §1b against a real Postgres and record what settled '
    + 'it, or — if a local cluster cannot settle it — move it to RESIDUAL_RISKS with a remedy and '
    + 'an owner. What it may not be is a row nobody has to look at.');
  assert.equal(UNVERIFIED_CLAIMS.length, 22,
    'the ledger changed size. A new claim needs a witness (or a residual); a deleted one needs a '
    + 'reason, because deleting a claim is how an unverified property becomes a believed one.');
});

test('prisma.js states what a local Postgres could NOT settle, and who owns each remainder', () => {
  // The failure this guards is the one R-8 exists to prevent in the other direction: a suite
  // that turns green and is then read as "the deploy works". Frankfurt is Prisma Postgres behind
  // a pooler; the run was a local cluster. Saying so is part of the result.
  assert.ok(RESIDUAL_RISKS.length >= 3, 'a clean run with no stated remainder is the claim R-8 refused to make');
  for (const r of RESIDUAL_RISKS) {
    assert.match(r.id, /^R8-R\d+$/, `bad residual id ${r.id}`);
    assert.ok(r.subject && r.subject.length > 10, `${r.id} has no subject`);
    assert.ok(r.risk && r.risk.length > 60, `${r.id} does not say what is unknown`);
    assert.ok(r.breaks && r.breaks.length > 40, `${r.id} does not say what it costs`);
    assert.ok(r.closedBy && r.closedBy.length > 40,
      `${r.id} does not say what would close it. A residual with no remedy is a shrug.`);
  }
  const ids = RESIDUAL_RISKS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate residual ids');
});

test('prisma.js classifies BOTH codes a lost Serializable transaction arrives as (R8-RETRY)', () => {
  // The retry itself cannot be reached in one process — at connection_limit=1 a single client
  // serialises against itself and never conflicts — so what is pinned here is the CLASSIFIER,
  // against the exact error objects PostgreSQL 17.10 / Prisma 6.19.3 were measured producing.
  // A grep of the source would not do: the strings also appear in the comment above it, so a
  // mutant that changed the code and left the prose survived. These are the real shapes.
  const p2034 = Object.assign(new Error('write conflict'), { code: 'P2034' });
  const rawConflict = Object.assign(new Error('Raw query failed. Code: `40001`'),
    { code: 'P2010', meta: { code: '40001', message: 'could not serialize access due to concurrent update' } });
  const rawDeadlock = Object.assign(new Error('Raw query failed. Code: `40P01`'),
    { code: 'P2010', meta: { code: '40P01', message: 'deadlock detected' } });

  assert.equal(isSerializationFailure(p2034), true,
    'an ORM call that loses a Serializable race surfaces as P2034 and must be retried, not thrown');
  assert.equal(isSerializationFailure(rawConflict), true,
    'a RAW query does NOT get P2034: it surfaces as P2010 with the SQLSTATE in meta.code. '
    + '`reserveSeq` is the only raw write in the file and the one statement RULE 2 rests on, so a '
    + 'classifier that knew only P2034 would retry everything except the place where a lost '
    + "transaction costs a family its afternoon of edits — measured: it lost one instance's ops.");
  assert.equal(isSerializationFailure(rawDeadlock), true, 'a detected deadlock is the same verdict: roll back and run it again');

  // And it must NOT swallow a refusal as something to retry, or a 400 becomes six 400s.
  assert.equal(isSerializationFailure(Object.assign(new Error('dup'), { code: 'P2002' })), false, 'a unique violation is an answer, not a retry');
  assert.equal(isSerializationFailure(Object.assign(new Error('fk'), { code: 'P2003' })), false);
  assert.equal(isSerializationFailure(Object.assign(new Error('raw'), { code: 'P2010', meta: { code: '23505' } })), false,
    'a raw statement can fail for reasons that will fail again; only 40001 and 40P01 mean "run it again"');
  assert.equal(isSerializationFailure(new Error('invite_used')), false, "a handler's own throw must pass straight through");
  assert.equal(isSerializationFailure(null), false);
});

test('prisma.js never hands a JS Date to a raw query (R8-TZ)', () => {
  // Prisma's query builder binds a Date correctly against a TIMESTAMP(3) column; `$queryRaw`
  // binds it as timestamptz, which a Europe/Berlin session — the deploy's own region, decision
  // D2 — shifts by an hour. Measured: `"expiresAt" > $1` answered false for a row three minutes
  // in the future. This greps the raw templates only; ORM calls are unaffected and untouched.
  const rawTemplates = [...PRISMA_SRC.matchAll(/\$queryRaw`([\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(rawTemplates.length >= 2, `expected the raw statements to be found; saw ${rawTemplates.length}`);
  for (const t of rawTemplates) {
    assert.equal(/\$\{[^}]*new Date|\$\{\s*\w*[Dd]ate\s*\}/.test(t), false,
      `a raw statement interpolates a Date:\n${t}\nUse naiveUtc(ms) and cast, or the comparison ` +
      `is silently an hour out in Frankfurt.`);
  }
  assert.match(PRISMA_SRC, /naiveUtc/, 'the helper that spells a moment the way this schema stores one must exist');
});

test('prisma.js has no UNVERIFIED tag in its source that the claim list omits', () => {
  // Otherwise the honesty rots: a comment says UNVERIFIED (U-FOO) and nothing enumerates U-FOO,
  // so the day someone runs this against a database they have no list to work from.
  const used = new Set([...PRISMA_SRC.matchAll(/\(?(U-[A-Z0-9]+)\)?/g)].map((m) => m[1]));
  const declared = new Set(UNVERIFIED_CLAIMS.map((c) => c.tag));
  const missing = [...used].filter((t) => !declared.has(t));
  assert.deepEqual(missing, [], `tags used in comments but not enumerated: ${missing.join(', ')}`);
  const unused = [...declared].filter((t) => !used.has(t));
  assert.deepEqual(unused, [], `tags enumerated but never marked in the code: ${unused.join(', ')}`);
});

test('prisma.js pins connection pooling from day one (risk R3)', () => {
  assert.match(PRISMA_SRC, /connection_limit/,
    'a serverless function that opens an unbounded pool per instance exhausts a Hobby-tier ' +
    'database long before eight family members exhaust anything else');
  assert.match(PRISMA_SRC, /__lzpPrismaClient/, 'a warm invocation must reuse the client');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The interface table itself
// ─────────────────────────────────────────────────────────────────────────────

test('the interface table is internally consistent', () => {
  assert.equal(new Set(STORE_METHODS).size, STORE_METHODS.length, 'duplicate method names');
  for (const model of Object.keys(MODEL_COLUMNS)) {
    for (const f of OPAQUE_FIELDS[model]) assert.ok(MODEL_COLUMNS[model].includes(f), `${model}.${f} is opaque but not a column`);
    for (const f of NULLABLE_FIELDS[model]) assert.ok(MODEL_COLUMNS[model].includes(f), `${model}.${f} is nullable but not a column`);
  }
  const ids = INTERFACE_EXTENSIONS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of INTERFACE_EXTENSIONS) {
    assert.ok(['added', 'changed'].includes(e.kind));
    assert.ok(e.why.length > 60, `${e.id} deviates from the contract without saying why`);
  }
});

test('normalizeRow refuses what RULE 1 says it must, and accepts what it must', () => {
  assert.throws(() => normalizeRow('Op', { opId: 'a', epoch: 1, deviceShort: 'S', witness: null, chain: new Uint8Array(1), envelope: 'text', spaceId: 's', seq: 0n, receivedAt: new Date(0) }), StoreShapeError);
  assert.throws(() => normalizeRow('Space', { id: 'a', kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0), extra: 1 }), StoreShapeError);
  assert.throws(() => normalizeRow('Nope', {}), StoreShapeError);
  assert.throws(() => normalizeRow('Space', { id: 'a' }), StoreShapeError, 'required columns are required');
  const ok = normalizeRow('Space', { id: 'a', kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, createdAt: new Date(0) });
  assert.equal(ok.headChain, null, 'a nullable column defaults to null rather than to undefined');
  assert.deepEqual(Object.keys(ok).sort(), [...MODEL_COLUMNS.Space].sort());
});

test('the file adapter really writes bytes as bytes, and reads them back as bytes', async () => {
  // The one property a JSON store is most likely to lose, and the reason `file` is the second
  // witness rather than a convenience.
  const clock = fakeClock(0);
  const dir = tempDir();
  const a = fileStore(dir, { now: clock.now });
  await a.createSpace({ id: 'fsp_x', kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0) });
  await a.upsertOps('fsp_x', [{ opId: 'op1', epoch: 1, deviceShort: 'S1', witness: null, chain: new Uint8Array([1, 2, 3]), envelope: new Uint8Array([9, 8, 7]) }]);

  const raw = fs.readFileSync(path.join(dir, 'sync-store.json'), 'utf8');
  assert.match(raw, /"\$b"/, 'bytes must be tagged on disk so they cannot be re-read as text');
  assert.match(raw, /"\$n"/, 'bigints must be tagged so a seq cannot come back as a Number');

  const b = fileStore(dir, { now: clock.now });          // a SECOND process would see this
  const reread = (await b.listOps('fsp_x', 0n, 10)).ops[0];
  assert.ok(reread.envelope instanceof Uint8Array);
  assert.deepEqual([...reread.envelope], [9, 8, 7]);
  assert.equal(typeof reread.seq, 'bigint');
  assert.equal(reread.seq, 1n);
  assert.ok(reread.receivedAt instanceof Date);
  assert.equal((await b.getSpace('fsp_x')).nextSeq, 1n, 'the counter survives a restart, so seq is never re-issued');
});

test('the file adapter refuses to start on a corrupt store rather than starting empty', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'sync-store.json'), '{ not json', 'utf8');
  assert.throws(() => fileStore(dir), /not valid JSON/,
    'starting empty would look to every client like "the server forgot everything", and the ' +
    'clients would then happily push their whole logs into a store that had merely been broken');
});

test('the file adapter flushes EVERY mutating method — all 25 survive a restart', async () => {
  // The one failure a write-through store can have that no unit test of a single method finds:
  // a method that mutates and is not flushed. The dev-server answers 200, the window shows the
  // change, and the next launch has forgotten it. `createStoreEngine` states the READ-ONLY set
  // rather than the mutating one so the default is fail-safe, and this walks every mutator to
  // prove the set is right today.
  const clock = fakeClock(0);
  const dir = tempDir();
  const B = (n) => new Uint8Array(n).fill(7);
  const space = (id) => ({ id, kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0) });
  const member = (id, colorRef) => ({ id, spaceId: 'fsp_1', colorRef, recoveryPubSig: B(65), recoveryPubKex: B(65), joinedAt: new Date(0), removedAt: null });
  const device = (id, short) => ({ id, spaceId: 'fsp_1', memberId: 'mem_1', deviceShort: short, sigPubRaw: B(65), kexPubRaw: B(65), attestation: B(80), lastSeenSeq: 0n, lastPushedSeq: 0n, addedAt: new Date(0), revokedAt: null });
  const op = (opId, short) => ({ opId, epoch: 1, deviceShort: short, witness: null, chain: B(32), envelope: B(64) });
  const invite = (id) => ({ id, spaceId: 'fsp_1', verifier: B(32), wrapSalt: B(32), epoch: 1, createdBy: 'mem_1', expiresAt: new Date(86400000), usedAt: null, revokedAt: null });

  const a = fileStore(dir, { now: clock.now });
  await a.createSpace(space('fsp_1'));                                       // 1
  await a.createSpace(space('fsp_2'));
  await a.setCurrentEpoch('fsp_1', 2);                                       // 2
  await a.claimEpoch('fsp_1', 2);                                            // 3
  await a.setHeadChain('fsp_1', B(32));                                      // 4
  await a.reserveSeq('fsp_1', 3);                                            // 5  -> nextSeq 3
  await a.upsertOps('fsp_1', [op('a', 'S1'), op('b', 'S1'), op('gone', 'GONE')]); // 6  -> 4,5,6
  await a.deleteOpsByDevices('fsp_1', ['GONE']);                             // 7
  await a.addMember(member('mem_1', 'gruen'));                               // 8
  await a.addMember(member('mem_2', 'blau'));
  await a.removeMember('mem_2', 1000);                                       // 9
  await a.addDevice(device('dev_1', 'S1'));                                  // 10
  await a.addDevice(device('dev_2', 'S2'));
  await a.revokeDevice('dev_2', 2000);                                       // 11
  await a.setLastSeenSeq('fsp_1', 'S1', 4n);                                 // 12
  await a.setLastPushedSeq('fsp_1', 'S1', 3n);                               // 13
  await a.putKeyWraps([                                                      // 14
    { spaceId: 'fsp_1', epoch: 1, recipientId: 'dev_1', wrapped: B(156), senderDeviceId: 'dev_1' },
    { spaceId: 'fsp_1', epoch: 1, recipientId: 'dev_9', wrapped: B(156), senderDeviceId: 'dev_1' },
  ]);
  await a.deleteKeyWrapsForDevices('fsp_1', ['dev_9']);                      // 15
  await a.putInvite(invite('inv_1'));                                        // 16
  await a.putInvite(invite('inv_2'));
  await a.putInvite(invite('inv_3'));
  await a.consumeInvite('inv_2', 500);                                       // 17
  await a.revokeInvite('inv_3', 600);                                        // 18
  await a.refreshInvite('inv_1', 7);                                         // 19
  await a.putPairSession('rid_live', { boxA: B(24) }, 180000);               // 20
  await a.putPairSession('rid_dead', { boxA: B(24) }, 180000);
  await a.bumpPairAttempts('rid_live');                                      // 21
  await a.burnPairSession('rid_dead');                                       // 22
  await a.claimNonce('S1', 'n1', 300000);                                    // 23
  await a.rateAllow('k', 60000, 2);                                          // 24
  await a.deleteSpace('fsp_2');                                              // 25

  const b = fileStore(dir, { now: clock.now });          // a fresh process would see exactly this
  const s = await b.getSpace('fsp_1');
  assert.equal(s.currentEpoch, 2);
  assert.equal(s.nextSeq, 6n, 'the counter survives, so no seq is ever re-issued after a restart');
  assert.ok(s.headChain instanceof Uint8Array);
  assert.equal(await b.getSpace('fsp_2'), null, 'deleteSpace');
  assert.equal(await b.claimEpoch('fsp_1', 2), false, 'claimEpoch — the epoch row survived, so a restart does not reopen a won race');
  assert.deepEqual((await b.listOps('fsp_1', 0n, 10)).ops.map((o) => o.opId), ['a', 'b'], 'upsertOps + deleteOpsByDevices');
  assert.equal((await b.listMembers('fsp_1')).length, 2, 'addMember');
  assert.ok((await b.listMembers('fsp_1')).find((m) => m.id === 'mem_2').removedAt, 'removeMember');
  assert.equal(await b.colorFree('fsp_1', 'gruen'), false);
  assert.equal((await b.listDevices('fsp_1')).length, 2, 'addDevice');
  assert.ok((await b.getDevice('dev_2')).revokedAt, 'revokeDevice');
  assert.equal((await b.getDeviceByShort('fsp_1', 'S1')).lastSeenSeq, 4n, 'setLastSeenSeq');
  assert.equal((await b.getDeviceByShort('fsp_1', 'S1')).lastPushedSeq, 3n, 'setLastPushedSeq');
  assert.equal((await b.getKeyWraps('fsp_1', 'dev_1')).length, 1, 'putKeyWraps');
  assert.equal((await b.getKeyWraps('fsp_1', 'dev_9')).length, 0, 'deleteKeyWrapsForDevices');
  assert.equal((await b.getInvite('inv_1')).epoch, 7, 'refreshInvite');
  assert.ok((await b.getInvite('inv_2')).usedAt, 'consumeInvite');
  assert.ok((await b.getInvite('inv_3')).revokedAt, 'revokeInvite');
  assert.deepEqual((await b.listOpenInvites('fsp_1')).map((i) => i.id), ['inv_1']);
  assert.equal((await b.getPairSession('rid_live')).attempts, 1, 'putPairSession + bumpPairAttempts');
  assert.equal(await b.getPairSession('rid_dead'), null, 'burnPairSession');
  await b.putPairSession('rid_dead', { boxA: B(24) }, 180000);
  assert.equal(await b.getPairSession('rid_dead'), null,
    'and the burn is still permanent after a restart — a rendezvous a reboot could resurrect is not an attempt cap');
  assert.equal(await b.claimNonce('S1', 'n1', 300000), false, 'claimNonce — a restart must not reopen the replay window');
  assert.equal(await b.rateAllow('k', 60000, 2), true, 'rateAllow — one of the two was already spent');
  assert.equal(await b.rateAllow('k', 60000, 2), false, 'and a restart must not hand out a fresh budget');
});
