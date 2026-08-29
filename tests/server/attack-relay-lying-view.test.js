// ATTACK · T1 — SERVE A LYING VIEW.
//
// The relay cannot read and it can still decide what each member SEES. Six lies, in increasing
// order of how hard they are to notice:
//
//   1. withhold ops from one member, from the middle of the log
//   2. withhold the TAIL — the same lie, told by stopping early
//   3. replay ops the client already has
//   4. reorder a page
//   5. hand a client a stale `seq` and `hasMore: false`
//   6. fork the log, so two members hold different histories for ever
//   7. accept a push, answer 200, and drop it
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE DESIGNED DEFENCE, AND WHAT IS ACTUALLY THERE
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ADR 002 §5.4 names the chain witness for exactly this: `chain = SHA-256(prevChain ‖ opId)` per
// space, and `Envelope.wit` set by each client to the highest chain it had pulled, "so every op a
// member authors commits to what that member had seen". §8.6 scopes it honestly —
// detection-only, best-effort, "a consistently-lying relay defeats it".
//
// This file answers the two questions that scoping leaves open:
//
//   · **Is it implemented?** The server half is: `pushOps` computes the chain and stores `wit`,
//     and both really are on the wire on every pull. The CLIENT half is not. The one function
//     named for it — `verifyChain(ops, lastChain)` in `docs/v2/contracts/sync.contract.js` — is a
//     stub that throws `not implemented`, `src/js/sync/` does not exist, and §5 below greps the
//     whole tree and finds no comparison anywhere. **So today, nothing checks either value.**
//   · **Would it work?** Not a rhetorical question. §1–§6 write the detector — five lines, in the
//     kit as `verifyChainHere` — and run every one of the seven lies past it. It catches four and
//     misses three, and the three it misses are the three that matter most. That is a result
//     about the DESIGN, and it is available now rather than after WP-8 has written the client.
//
// One structural finding falls out of §7: a member removal purges that member's ops, so the chain
// over what survives no longer verifies **on an honest relay**. A censoring relay can therefore
// present its censorship as a removal, and the detector cannot tell them apart.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADAPTERS, T0, DAY, fakeClock, relay, seedSpace, sealFor, spaceKey,
  verifyChainHere, chainAfter, ub64, b64u,
} from './_attack-relay-kit.js';

const SPACE = 'fsp_LYINGVIEWaaaaaaaaaaaaz';
const A = ADAPTERS[0];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Papa and Mama, one Mac each, and a log of `n` ops written by Papa. */
async function logOf(n) {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  const seeded = await seedSpace(h, clock, {
    id: SPACE,
    members: [{ name: 'Papa', colorRef: 'gruen', devices: 1 }, { name: 'Mama', colorRef: 'blau', devices: 1 }],
  });
  const r = relay(h, clock);
  const key = await spaceKey();
  const papa = seeded.members[0].devices[0];
  const mama = seeded.members[1].devices[0];
  for (let i = 1; i <= n; i++) {
    const env = await sealFor(key, papa, { space: SPACE, n: i, op: { k: 'note', text: `entry ${i}` } });
    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev: papa, body: { space: SPACE, ops: [env] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const honest = await r.send({ method: 'GET', path: '/api/v1/ops', dev: mama, query: { space: SPACE } });
  assert.equal(honest.status, 200);
  assert.equal(honest.body.ops.length, n);
  return { clock, h, r, key, papa, mama, honest: honest.body };
}

/** Mama's client, as it would be if somebody had written `verifyChain`. */
const detect = (page, lastChain) => verifyChainHere(page.ops, lastChain);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 The detector works at all
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('CONTROL — an HONEST page verifies against the chain, from the first op and from a cursor', async () => {
  const { honest } = await logOf(6);
  assert.deepEqual(await detect(honest, null), { ok: true, brokeAt: null },
    'if an honest page does not verify, every result below is meaningless');

  // …and from halfway, which is the shape every pull after the first one has.
  const mid = { ops: honest.ops.slice(3) };
  assert.deepEqual(await detect(mid, ub64(honest.ops[2].chain)), { ok: true, brokeAt: null });

  // The chain really is the ADR's, recomputed here from ADR 002 §5.4 and not from the handler.
  let prev = null;
  for (const o of honest.ops) {
    prev = await chainAfter(prev, o.oid);
    assert.equal(b64u(prev), o.chain);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 Withhold from the middle
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED today / would FAIL against the chain — withholding op 3 of 6 breaks continuity at the seam', async () => {
  const { honest } = await logOf(6);

  // T1 drops one op on its way to Mama. Nothing in the store changes; every other member still
  // sees six. This is ADR 002 §5.4's opening sentence, performed.
  const censored = { ops: honest.ops.filter((o) => o.seq !== '3') };
  assert.equal(censored.ops.length, 5);

  // The lie SUCCEEDS today: the response is well-formed, the status is 200, and no code anywhere
  // in this repository looks at `chain`.
  assert.equal(censored.ops.every((o) => typeof o.chain === 'string' && o.chain.length === 43), true);

  // And it would FAIL against five lines of client. `chain_4 = SHA-256(chain_3 ‖ oid_4)`, and the
  // client holding `chain_2` cannot reproduce it.
  const seen = await detect(censored, null);
  assert.equal(seen.ok, false, 'a middle withholding must break the chain');
  assert.equal(seen.brokeAt, 2, 'at exactly the op that followed the missing one');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 Withhold the tail — the same lie, told by stopping early
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — truncating the page is INVISIBLE to the chain, and that is the gap `wit` exists for', async () => {
  const { honest } = await logOf(6);

  // Serve Mama the first three and say there is nothing more. Every hash still checks out,
  // because a prefix of a hash chain is a hash chain.
  const truncated = { ops: honest.ops.slice(0, 3), nextCursor: '3', hasMore: false };
  assert.deepEqual(await detect(truncated, null), { ok: true, brokeAt: null },
    'THE CHAIN CANNOT SEE A TRUNCATION — this is the whole reason §5.4 also needs `wit`');

  // What WOULD see it: Mama's next own push carries `wit = chain_3`, Papa pulls it, and Papa
  // knows his own chain went to `chain_6` before Mama's op arrived. A `wit` naming a chain that is
  // not the head Papa saw is the signal. The material is on the wire in both directions —
  const witness = truncated.ops[2].chain;
  assert.equal(typeof witness, 'string');
  assert.notEqual(witness, honest.ops[5].chain, 'Mama would commit to a head Papa never had');
  // — and nothing compares them. §5 proves that by grep.
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 Replay, and §4 reorder
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('FAILED (harmless) — replaying old ops changes nothing, because the fold is idempotent by construction', async () => {
  const { honest, r, mama } = await logOf(4);

  // The relay re-serves the whole log to a client that already has it, and the pull is answered
  // honestly for anyone else.
  const replayed = { ops: [...honest.ops, ...honest.ops] };
  // A client folding this applies each `oid` twice. ADR 001 §6 makes that a no-op, and ADR 003
  // §3.1 makes the same true on the push side — so this lie has no effect worth having.
  const distinct = new Set(replayed.ops.map((o) => o.oid));
  assert.equal(distinct.size, 4, 'four ops, served eight times');

  // A pull from the real relay with the same cursor twice returns the same bytes, and returns
  // NOTHING when the cursor is at the head — the honest behaviour a replay is imitating.
  const again = await r.send({ method: 'GET', path: '/api/v1/ops', dev: mama, query: { space: SPACE, since: '4' } });
  assert.deepEqual(again.body.ops, []);
  assert.equal(again.body.nextCursor, '4', 'an empty page returns the caller\'s OWN cursor, never the head');
});

test('SUCCEEDED today / would FAIL against the chain — a reordered page verifies nowhere, and its cursor skips', async () => {
  const { honest } = await logOf(5);

  const reordered = { ops: [honest.ops[4], ...honest.ops.slice(0, 4)] };
  const seen = await detect(reordered, null);
  assert.equal(seen.ok, false, 'the chain is order-dependent by construction');
  assert.equal(seen.brokeAt, 0);

  // THE SECOND HALF, and it is the dangerous one. ADR 003 §3.2's cursor rule is "the seq of the
  // last op ACTUALLY RETURNED". A client that applies that rule to a REORDERED page advances its
  // cursor to `ops[last].seq`, which here is 4 — and op 5 is then never fetched again, because
  // the next pull asks for `since=4`. One reorder, one op lost, silently, on one device.
  const naiveCursor = reordered.ops[reordered.ops.length - 1].seq;
  assert.equal(naiveCursor, '4');
  assert.ok(reordered.ops.some((o) => o.seq === '5'), 'op 5 was in the page…');
  assert.ok(Number(naiveCursor) < 5, '…and the cursor the client would keep is behind it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 A stale cursor, and the pure censorship it enables
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — `{ops: [], hasMore: false}` is indistinguishable from a quiet family, for ever', async () => {
  const { r, mama, honest } = await logOf(6);

  // The relay simply answers "nothing new" to Mama, always. The chain has nothing to work on;
  // `hasMore` and `nextCursor` are the relay's own words; and ADR 003 §8.3 says a healthy sync
  // shows NOTHING in the UI ("silence is the design"). So the failure mode of this attack is a
  // board that quietly stops updating, with no indicator anywhere.
  const lying = { ops: [], nextCursor: '0', hasMore: false, currentEpoch: 1, members: [] };
  assert.deepEqual(await detect(lying, null), { ok: true, brokeAt: null },
    'an empty page always verifies — there is nothing to verify');

  // The one number that would betray it is not on this endpoint. `spaceSeq` is returned by PUSH,
  // and a client that pushed would learn the head is 6 while its cursor says 0. A client that
  // only READS — the whole family except the one person writing — never sees a head at all.
  const push = await r.send({
    method: 'POST', path: '/api/v1/ops', dev: mama,
    body: { space: SPACE, ops: [] },
  });
  assert.equal(push.status, 200);
  assert.equal(push.body.spaceSeq, '6', 'the head IS available — on the write path only');
  assert.equal(Object.prototype.hasOwnProperty.call(honest, 'spaceSeq'), false,
    'GET /ops does not report the space head, so a read-only client cannot cross-check its cursor');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 Fork the log
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — two members can be given permanently different histories, and `wit` is the only trace', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  const seeded = await seedSpace(h, clock, {
    id: SPACE,
    members: [{ name: 'Papa', colorRef: 'gruen', devices: 1 }, { name: 'Mama', colorRef: 'blau', devices: 1 }],
  });
  const r = relay(h, clock);
  const key = await spaceKey();
  const papa = seeded.members[0].devices[0];
  const mama = seeded.members[1].devices[0];

  // Papa writes three. Mama is shown only the first.
  for (let i = 1; i <= 3; i++) {
    const env = await sealFor(key, papa, { space: SPACE, n: i, op: { k: 'note', text: `p${i}` } });
    await r.send({ method: 'POST', path: '/api/v1/ops', dev: papa, body: { space: SPACE, ops: [env] } });
  }
  const full = await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, query: { space: SPACE } });
  const mamasView = { ops: full.body.ops.slice(0, 1) };
  assert.deepEqual(await detect(mamasView, null), { ok: true, brokeAt: null }, 'a truncation, again');

  // Mama now writes, honestly committing to the head SHE was shown — which is what §5.4 says an
  // author does: `wit` = the highest chain pulled.
  const witMama = mamasView.ops[0].chain;
  const env = await sealFor(key, mama, { space: SPACE, n: 10, wit: witMama, op: { k: 'note', text: 'm1' } });
  const pushed = await r.send({ method: 'POST', path: '/api/v1/ops', dev: mama, body: { space: SPACE, ops: [env] } });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));

  // Papa pulls, and Mama's op arrives carrying a witness Papa can measure against his own view.
  const papaNow = await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, query: { space: SPACE, since: '3' } });
  const mamasOp = papaNow.body.ops[0];
  assert.equal(mamasOp.dv, mama.deviceShort);
  assert.equal(mamasOp.wit, witMama, 'the witness really does survive the round trip, verbatim');

  // THE DETECTION THAT NOBODY PERFORMS: Papa's own chain at the moment Mama's op was appended was
  // `chain_3`. Mama says she had seen `chain_1`. Papa holds both values and could compare them.
  const papaChains = full.body.ops.map((o) => o.chain);
  assert.equal(papaChains[papaChains.length - 1] !== mamasOp.wit, true,
    'Mama committed to a head that was three ops behind Papa\'s — which is either a fork or a '
    + 'device that had simply not caught up, and THAT ambiguity is why §5.4 is diagnostic-only');
  // It is nevertheless a real signal, because Mama's `wit` names a chain Papa has and Papa can
  // see it is not the newest. A relay that rewrote the chain per device consistently would erase
  // even this — §8.6's "a consistently-lying relay defeats it", which is exactly true.

  // And the server itself never looks. `wit` is stored and never compared, by design.
  const src = fs.readFileSync(path.join(REPO, 'server/core/handlers/ops.js'), 'utf8');
  assert.ok(src.includes('it never compares them, and a mismatched `wit` is'),
    'ops.js must still say out loud that it does not compare the witness');
  // And it is not merely a comment. The file DOES compare two witnesses — in fork detection, to
  // decide whether a re-pushed `oid` carries the same bytes — and it never compares a witness to
  // a CHAIN, which is the comparison §5.4 describes and the only one that would detect anything.
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal(/witness[^\n]*\b(chain|head|headChain)\b/.test(code), false,
    'the relay must never compare a witness against a chain — that is the client\'s job (§5.4)');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 Drop a push, answer 200
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — a fabricated `accepted[]` empties the client\'s outbox and the op is gone', async () => {
  const { honest, key, mama } = await logOf(2);

  // What the honest server returns. The client's contract (ADR 003 §8.1) is: remove from the
  // outbox when the server reports the oid in `accepted` OR `duplicate`. Nothing else.
  const env = await sealFor(key, mama, { space: SPACE, n: 99, op: { k: 'note', text: 'Zahnarzt' } });
  const forged = {
    accepted: [{ oid: env.oid, seq: '3', chain: b64u(new Uint8Array(32)) }],
    duplicate: [],
    spaceSeq: '3',
    serverTime: T0,
  };
  // The client sees its own oid in `accepted` and drops the envelope. It never re-reads it: the
  // outbox has no read-back check, and `duplicate` exists precisely so that a retry is cheap —
  // which means the client is designed NOT to be suspicious here.
  assert.equal(forged.accepted[0].oid, env.oid);
  assert.equal(forged.accepted.length + forged.duplicate.length, 1);

  // The chain would catch it only on a LATER pull, and only if the client re-checked its own ops
  // against what came back — which no contract requires. The forged chain is 32 zero bytes and
  // is not `SHA-256(chain_2 ‖ oid)`, so a client that DID keep it and verify would notice.
  const real = await chainAfter(ub64(honest.ops[1].chain), env.oid);
  assert.notEqual(b64u(real), forged.accepted[0].chain,
    'the relay cannot forge a chain that a verifying client would accept — but nothing verifies it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8 Is the chain witness implemented anywhere at all?
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the chain witness: the RELAY computes it, serves it, and never checks it', async () => {
  // The SERVER half, which is this file's scope and is real: a 32-byte chain per op, a `wit`
  // round-tripped verbatim, and both on the wire in both directions.
  const { honest, r, mama, key } = await logOf(2);
  for (const o of honest.ops) {
    assert.equal(ub64(o.chain).length, 32, 'every op carries a 32-byte chain on the wire');
    assert.equal(typeof o.wit, 'string');
  }
  const env = await sealFor(key, mama, { space: SPACE, n: 50, wit: honest.ops[1].chain, op: { k: 'note', text: 'x' } });
  const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev: mama, body: { space: SPACE, ops: [env] } });
  assert.equal(res.status, 200);
  assert.equal(ub64(res.body.accepted[0].chain).length, 32);
  const back = await r.send({ method: 'GET', path: '/api/v1/ops', dev: mama, query: { space: SPACE, since: '2' } });
  assert.equal(back.body.ops[0].wit, honest.ops[1].chain, 'the witness survives the round trip verbatim');

  // THE SCOPE, which is what makes every "SUCCEEDED" above survive a client that DOES check:
  // §5.4 and §8.6 make the witness detection-only and forbid it from blocking sync in v2. So a
  // detector that fires does not stop the lie; it writes a diagnostic. The relay's capability is
  // unchanged by the client's vigilance — only the family's chance of noticing changes.
  const contract = fs.readFileSync(path.join(REPO, 'docs/v2/contracts/sync.contract.js'), 'utf8');
  assert.match(contract, /Diagnostic only; never blocks sync in v2 \(ADR 002 §5\.4, §8\.6\)\. \*\/\s*\nexport function verifyChain/,
    'sync.contract.js must still declare verifyChain, and still scope it as diagnostic-only');
  const adr = fs.readFileSync(path.join(REPO, 'docs/v2/adr/002-crypto.md'), 'utf8');
  assert.ok(adr.includes('detection-only, best-effort'));
  assert.ok(adr.includes('A relay that rewrites the chain consistently per-device still wins'),
    'ADR 002 §5.4 must still concede the limit this file measured');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §9 THE STRUCTURAL FINDING — a purge makes censorship deniable
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED (STRUCTURAL) — after an honest member removal the chain no longer verifies, so censorship is deniable', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  const seeded = await seedSpace(h, clock, {
    id: SPACE,
    members: [{ name: 'Papa', colorRef: 'gruen', devices: 1 }, { name: 'Kind', colorRef: 'rot', devices: 1 }],
  });
  const r = relay(h, clock);
  const key = await spaceKey();
  const papa = seeded.members[0].devices[0];
  const kind = seeded.members[1].devices[0];

  // Interleaved writing, which is what a family does.
  for (let i = 1; i <= 6; i++) {
    const dev = i % 2 === 0 ? kind : papa;
    const env = await sealFor(key, dev, { space: SPACE, n: i, op: { k: 'note', text: `e${i}` } });
    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [env] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const before = await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, query: { space: SPACE } });
  assert.deepEqual(await detect(before.body, null), { ok: true, brokeAt: null });

  // A perfectly ordinary, perfectly honest removal (20.2). ADR 003 §6.3: the member's `Op` rows
  // are purged in the same transaction, and §3.3 forbids rewinding `nextSeq`.
  clock.set(T0 + 30 * DAY);
  const rm = await r.send({
    method: 'POST', path: '/api/v1/members/remove', dev: papa, at: clock.now(),
    body: { spaceId: SPACE, memberId: seeded.members[1].id },
  });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal(rm.body.purgedOps, 3);

  // A NEW device joining this family — or any client re-syncing from scratch — pulls the
  // survivors and cannot verify them: `chain_3` commits to `chain_2`, and op 2 is gone.
  const after = await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa, at: clock.now(), query: { space: SPACE } });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.deepEqual(after.body.ops.map((o) => o.seq), ['1', '3', '5']);
  const seen = await detect(after.body, null);
  assert.equal(seen.ok, false, 'an HONEST relay now serves a page that fails the chain check');
  assert.equal(seen.brokeAt, 1);

  // THE CONSEQUENCE, and it is a design finding rather than a bug in any file:
  // a chain break has two causes that a client cannot tell apart — a censoring relay, and a
  // removal that happened while the client was away. `members[].removedAt` is on the pull
  // response, so a client could *plausibly* excuse a break near a removal; it cannot bound WHICH
  // ops the removal was entitled to take, because the ops it would need to check are the ones
  // that are gone. A relay that wants to censor Papa's op 5 can therefore withhold it and let the
  // client attribute the break to the removal it can see.
  const removed = after.body.members.filter((m) => m.removedAt !== null);
  assert.equal(removed.length, 1, 'the removal IS visible…');
  assert.equal(after.body.ops.some((o) => o.dv === kind.deviceShort), false,
    '…and every op it took is unavailable, so the break it caused cannot be bounded');

  // ADR 002 §5.4 does not mention purges, and neither does §8.6. Whoever implements
  // `verifyChain` inherits this: either the chain skips purged ranges (and stops detecting
  // withholding inside them), or it fires on honest removals. Owner: WP-8 / LZP-501.
  const adr = fs.readFileSync(path.join(REPO, 'docs/v2/adr/002-crypto.md'), 'utf8');
  const s54 = adr.slice(adr.indexOf('### 5.4'), adr.indexOf('## 6. Device pairing'));
  assert.equal(/purge|removed member|20\.2/i.test(s54), false,
    'ADR 002 §5.4 now discusses purges — fold this finding into it and rename this test');
});
