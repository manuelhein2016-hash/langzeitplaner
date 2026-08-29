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
//  3. `prisma.js` IS SPECIFIED, NOT VERIFIED, AND SAYS SO. It cannot be executed on this
//     machine. What is checked is that it implements the full interface surface, that it does
//     not statically import a client that is not installed, and that every `U-` claim marked
//     UNVERIFIED in its source is enumerated in its `UNVERIFIED_CLAIMS` export. The day a
//     machine with Postgres exists, running STORE_CONTRACT_CASES against `prismaStore` settles
//     every one of those rows at once — which is the whole reason the cases are data.

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
import { prismaStore, UNVERIFIED_CLAIMS } from '../../server/adapters/prisma.js';

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
// 3. prisma.js — SPECIFIED, NOT VERIFIED, AND HONEST ABOUT IT
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
