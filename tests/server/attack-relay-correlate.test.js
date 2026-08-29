// ATTACK · T1 — CORRELATE. Two spaces to one person; one machine across spaces.
//
// This is the attack that turns a pile of pseudonymous households into a social graph. The relay
// holds every space in one database, so anything that is EQUAL across two spaces is a join, and a
// join is a person.
//
// The result is unusual and it is worth stating at the top, because a green suite hides it:
//
//   · **The device join does not work today, and it does not work because of a BUG.** Finding
//     E2-203-1 (`server/core/handlers/spaces.js`, `HANDLER_FINDINGS[0]`) is that `deviceShort` is
//     globally unique while `IK_sig` is per Mac, so one machine can have a `Device` row in
//     exactly one space — which blocks the product's main flow and, as a side effect, denies T1
//     its cheapest join column.
//   · **E2-203-1's own proposed fix creates that column.** `@@unique([memberId, deviceShort])`
//     puts one machine's identical `deviceShort` and identical `sigPubRaw` into a row in every
//     space it belongs to, and the operator's query is then one equality on an indexed column.
//     §2 below models the post-fix schema and runs that query, so the consequence is on the
//     record BEFORE the schema changes rather than after.
//   · **The recovery key is already a latent join and nothing forbids it.** ADR 002 §2.1 mints
//     `RK_sig`/`RK_kex` per MEMBER — "survives every device" — and no constraint anywhere stops
//     the same 65-byte public point appearing in two spaces' `Member` rows. §3.
//   · **Behaviour needs no join column at all.** §4 links two member ids in two different
//     households with nothing but `Op.receivedAt`.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS, T0, DAY, MINUTE, fakeClock, relay, seedSpace, sealFor, spaceKey, mintDevice,
  assertDocumented, documents, b64u, memberId, deviceId,
} from './_attack-relay-kit.js';
import { fixtures, StoreShapeError } from '../../server/core/store-interface.js';
import { HANDLER_FINDINGS } from '../../server/core/handlers/spaces.js';
import { rateKey } from '../../server/core/limits.js';
import { attestDevice, buildDeviceAttestation, importKexPublic } from '../../src/js/crypto/identity.js';

const PERSONAL = 'psp_CORRELATEpersonalAAAxy';
const FAMILY_A = 'fsp_CORRELATEfamilyAaaaaxy';
const FAMILY_B = 'fsp_CORRELATEfamilyBbbbbxy';

const A = ADAPTERS[0];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 The device join — refused today, and refused by a defect
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('FAILED — one Mac cannot appear in two spaces, so there is no device join column at all', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);

  const seeded = await seedSpace(h, clock, {
    id: PERSONAL, kind: 'PERSONAL', members: [{ name: 'me', colorRef: 'gruen', devices: 1 }],
  });
  const mac = seeded.members[0].devices[0];

  await h.store.createSpace(fixtures.space({ id: FAMILY_A, kind: 'FAMILY', createdAt: new Date(T0) }));
  const secondMember = memberId(4242);
  await h.store.addMember(fixtures.member({ id: secondMember, spaceId: FAMILY_A, colorRef: 'blau' }));

  // The same Mac, in the family space. `IK_sig` is per DEVICE (ADR 002 §2.1), so `deviceShort` is
  // the same value for life — and the store refuses the second row outright.
  await assert.rejects(
    () => h.store.addDevice(fixtures.device({
      id: deviceId(4242), memberId: secondMember, deviceShort: mac.deviceShort,
      sigPubRaw: mac.sigPubRaw, kexPubRaw: mac.kexPubRaw,
    })),
    (err) => err instanceof StoreShapeError && /already registered/.test(err.message));

  // …and the same refusal on the wire, with a named reason rather than a 500. This is the flow a
  // real user takes: they already have a paired second Mac (so `psp_` exists) and now try to
  // create a Familienkreis from that same machine.
  const r = relay(h, clock);
  const res = await r.send({
    method: 'POST', path: '/api/v1/spaces', dev: mac, body: {
      spaceId: FAMILY_B, kind: 'FAMILY', colorRef: 'gelb',
      member: {
        memberId: memberId(4244),
        recoveryPubSig: b64u(mac.sigPubRaw), recoveryPubKex: b64u(mac.kexPubRaw),
      },
      device: {
        deviceId: deviceId(4243), deviceShort: mac.deviceShort,
        sigPubRaw: b64u(mac.sigPubRaw), kexPubRaw: b64u(mac.kexPubRaw),
        // A REAL attestation, minted with the shipping `buildDeviceAttestation`/`attestDevice`
        // and signed by the very key this body declares as `recoveryPubSig`. Finding E2E3-7 made
        // `POST /spaces` verify the blob, so 64 zero bytes now stops at the door — and stopping
        // at the door would make this row prove the wrong refusal. The attack still has to reach
        // the `deviceShort` uniqueness check, which is what it is about.
        attestation: await attestDevice(
          await buildDeviceAttestation(
            { memberId: memberId(4244), deviceId: deviceId(4243), createdAt: '2026-08-29' },
            mac.pair.publicKey, await importKexPublic(mac.kexPubRaw),
          ),
          mac.pair.privateKey,
        ),
      },
      wraps: [{ recipientId: deviceId(4243), epoch: 1, wrapped: b64u(new Uint8Array(156)) }],
    },
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'bad_request', field: 'device.deviceShort', reason: 'registered' });

  // The finding is on the record in the handler, and it says exactly this.
  const f = HANDLER_FINDINGS.find((x) => x.id === 'E2-203-1');
  assert.ok(f, 'E2-203-1 must still be declared');
  assert.match(f.what, /one Mac can therefore have a Device row in exactly ONE space/i);
  assert.match(f.fix, /@@unique\(\[memberId, deviceShort\]\)/);
});

test('FAILED — and the member id cannot span two spaces either: `Member.id` is a global primary key', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  await seedSpace(h, clock, { id: FAMILY_A, members: [{ id: memberId(7), name: 'me', colorRef: 'gruen', devices: 1 }] });
  await h.store.createSpace(fixtures.space({ id: FAMILY_B, kind: 'FAMILY', createdAt: new Date(T0) }));

  await assert.rejects(
    () => h.store.addMember(fixtures.member({ id: memberId(7), spaceId: FAMILY_B, colorRef: 'blau' })),
    (err) => err instanceof StoreShapeError && /already exists/.test(err.message),
    'the same person in two circles is not representable, which is also why T1 cannot join on it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 The join E2-203-1's fix would create
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED (LATENT — finding against E2-203-1; 21.3 now DOCUMENTED) — the proposed fix hands T1 a cross-space join key', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);

  // Model the schema E2-203-1 proposes — `@@unique([memberId, deviceShort])` rather than a global
  // `@unique` — by writing the rows the fixed store would hold. Nothing else about the row
  // changes: same `deviceShort`, same `sigPubRaw`, which is the whole point, because both are
  // functions of one Mac's `IK_sig` and ADR 002 §2.1 mints that per DEVICE and not per space.
  const mac = await mintDevice('one Mac');
  const state = h.dump();
  for (const [space, kind, mid, colour] of [
    [PERSONAL, 'PERSONAL', memberId(11), 'gruen'],
    [FAMILY_A, 'FAMILY', memberId(12), 'blau'],
    [FAMILY_B, 'FAMILY', memberId(13), 'rot'],
  ]) {
    await h.store.createSpace(fixtures.space({ id: space, kind, createdAt: new Date(T0) }));
    await h.store.addMember(fixtures.member({ id: mid, spaceId: space, colorRef: colour }));
    state.devices.set(`${space}:dev`, fixtures.device({
      id: `dev_${space.slice(4)}`, memberId: mid, deviceShort: mac.deviceShort,
      sigPubRaw: mac.sigPubRaw, kexPubRaw: mac.kexPubRaw, addedAt: new Date(T0),
    }));
  }

  // THE OPERATOR'S QUERY, once the schema allows the rows:
  //   SELECT m.spaceId FROM Device d JOIN Member m ON m.id = d.memberId WHERE d.deviceShort = ?
  const spacesOf = (short) => [...state.devices.values()]
    .filter((d) => d.deviceShort === short)
    .map((d) => state.members.get(d.memberId).spaceId)
    .sort();
  assert.deepEqual(spacesOf(mac.deviceShort), [FAMILY_A, FAMILY_B, PERSONAL].sort(),
    'one equality on an INDEXED column returns every circle this person is in');

  // And the three pseudonymous member ids collapse into one human.
  const people = [...state.devices.values()]
    .filter((d) => d.deviceShort === mac.deviceShort).map((d) => d.memberId);
  assert.equal(new Set(people).size, 3, 'three ids…');
  assert.equal(new Set([...state.devices.values()]
    .filter((d) => d.deviceShort === mac.deviceShort)
    .map((d) => Buffer.from(d.sigPubRaw).toString('base64'))).size, 1, '…one public key');

  // THE FINDING, and it belongs to the schema owner rather than to a handler:
  // E2-203-1's `fix` field describes the constraint change and the auth change. It says nothing
  // about the consequence proved above — that the fixed schema makes `deviceShort` a global
  // person-identifier across every household on the relay. Nor does server-metadata.md, whose §7
  // dump list and §2 Device table are both written for the current, single-space world.
  const f = HANDLER_FINDINGS.find((x) => x.id === 'E2-203-1');
  assert.equal(/correlat|link|across spaces|privacy/i.test(f.fix + f.consequence), false,
    'E2-203-1 now mentions the correlation consequence of its own fix — fold this into the finding '
    + 'and rename this test');
  // INVERTED — the CAPABILITY is unchanged; the SILENCE is what closed. `server-metadata.md` §7's
  // fifth inference now says that three joins work across spaces and names `deviceShort` as the
  // first of them. The finding against E2-203-1 stands (its `fix` field still does not mention
  // the consequence of its own fix) and is asserted above; this half is 21.3's and is now met.
  assertDocumented(assert, 'cross-space correlation by deviceShort', [
    'cross-space correlation',
    'across spaces',
    'unique per machine',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 The recovery key is a latent join and no constraint forbids it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED (LATENT; 21.3 now DOCUMENTED) — the same 65-byte recovery point may sit in two spaces\' Member rows', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);

  // One person, one recovery identity. ADR 002 §2.1: RK_sig / RK_kex are per MEMBER and "survive
  // every device"; §7 puts exactly one of them in the backup file. So a person who is in two
  // circles has one recovery key and — unless a client mints a second one, which nothing in
  // `identity.js` does — the same public point is what both spaces are told about.
  const rk = await mintDevice('the recovery identity');

  for (const [space, mid, colour] of [[FAMILY_A, memberId(21), 'gruen'], [FAMILY_B, memberId(22), 'gruen']]) {
    await h.store.createSpace(fixtures.space({ id: space, kind: 'FAMILY', createdAt: new Date(T0) }));
    // The store accepts it. There is no uniqueness, no check and no warning anywhere.
    await h.store.addMember(fixtures.member({
      id: mid, spaceId: space, colorRef: colour,
      recoveryPubSig: rk.sigPubRaw, recoveryPubKex: rk.kexPubRaw,
    }));
  }

  const state = h.dump();
  const byKey = new Map();
  for (const m of state.members.values()) {
    const k = Buffer.from(m.recoveryPubSig).toString('base64');
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m.spaceId);
  }
  const linked = [...byKey.values()].find((v) => v.length > 1);
  assert.deepEqual(linked.sort(), [FAMILY_A, FAMILY_B].sort(),
    'GROUP BY recoveryPubSig HAVING COUNT(DISTINCT spaceId) > 1 — one query, and the two '
    + 'households are one person');

  // The document describes these columns as harmless: "**public** keys. They reveal nothing on
  // their own and are stable identifiers for as long as the member exists." Both halves are true
  // and the sentence still misses the point — a stable identifier is exactly what a JOIN needs,
  // and the scope that matters is not "as long as the member exists" but "across every space in
  // the database".
  assert.ok(documents(['stable identifiers for as long as the member exists']),
    'the sentence this finding is about must still be in the document');
  // INVERTED — §7's fifth inference quotes §2's sentence, agrees that both halves are true, and
  // then says the thing §2 leaves out: a stable identifier is exactly what a JOIN needs, and the
  // scope that matters is the whole database rather than one member's lifetime.
  assertDocumented(assert, 'the recovery point as a latent cross-space join', [
    'recoveryPubSig',
    'stable identifier is exactly what a JOIN needs',
    'across every space in the database',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 Behaviour needs no join column
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — two unrelated member ids in two households, linked by arrival times alone', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  const key = await spaceKey();

  // Two circles that share nothing: different space ids, different member ids, different device
  // keys, different colours. In one of them `alice` is a member; in the other, `alias` is. They
  // are the same human on two Macs, and NOTHING in the schema says so.
  const a = await seedSpace(h, clock, {
    id: FAMILY_A, memberSeed: 100, deviceSeed: 100,
    members: [{ name: 'alice', colorRef: 'gruen', devices: 1 }, { name: 'partner', colorRef: 'blau', devices: 1 }],
  });
  const b = await seedSpace(h, clock, {
    id: FAMILY_B, memberSeed: 200, deviceSeed: 200,
    members: [{ name: 'alias', colorRef: 'rot', devices: 1 }, { name: 'friend', colorRef: 'gelb', devices: 1 }],
  });
  const r = relay(h, clock);

  const alice = a.members[0].devices[0];
  const partner = a.members[1].devices[0];
  const alias = b.members[0].devices[0];
  const friend = b.members[1].devices[0];

  // Over ten days, alice and alias write within the same minute — because it is one person
  // sitting down once a day and updating both boards. The two unrelated members write at
  // unrelated times.
  let n = 0;
  const write = async (dev, atMs) => {
    clock.set(atMs);
    const space = [alice, partner].includes(dev) ? FAMILY_A : FAMILY_B;
    const env = await sealFor(key, dev, { space, n: ++n, op: { k: 'note', text: 'x' } });
    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space, ops: [env] }, at: atMs });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  for (let d = 0; d < 10; d++) {
    const t = T0 + d * DAY + (d * 37 % 600) * MINUTE;    // an irregular but shared daily moment
    await write(alice, t);
    await write(alias, t + MINUTE);                       // the same sitting, one minute later
    await write(partner, T0 + d * DAY + ((d * 53 + 700) % 900) * MINUTE);
    await write(friend, T0 + d * DAY + ((d * 91 + 200) % 900) * MINUTE);
  }

  /** Arrival minutes for one machine, across every space — the operator has all of them. */
  const minutesOf = (short) => {
    const out = [];
    for (const perSpace of h.dump().ops.values()) {
      for (const o of perSpace.values()) {
        if (o.deviceShort === short) out.push(Math.floor(new Date(o.receivedAt).getTime() / MINUTE));
      }
    }
    return out.sort((x, y) => x - y);
  };
  /** How many of A's writes have a write of B within five minutes. */
  const coincidence = (x, y) => {
    const ys = minutesOf(y);
    return minutesOf(x).filter((m) => ys.some((k) => Math.abs(k - m) <= 5)).length;
  };

  const same = coincidence(alice.deviceShort, alias.deviceShort);
  const noise = Math.max(
    coincidence(alice.deviceShort, friend.deviceShort),
    coincidence(partner.deviceShort, alias.deviceShort),
    coincidence(partner.deviceShort, friend.deviceShort));

  assert.equal(same, 10, 'every one of the ten sittings is visible as a pair across two circles');
  assert.ok(noise <= 2,
    `and the control pairs do not coincide (noise = ${noise}); the signal is not an artefact of `
    + 'everybody writing at the same time of day');

  // The document is thorough about the rhythm INSIDE one household (§5) and about the IP being
  // the re-identification path (§7). It never says that the rhythm is also a LINK BETWEEN
  // households — that two circles with no column in common can be attached to one person by
  // arrival times alone, with no cryptography and no IP address.
  assert.ok(documents(['when a person is actually editing']), 'the raw material is documented');
  // INVERTED — §7's fifth inference now states the conclusion §5 stopped short of: the rhythm is a
  // link BETWEEN households as well as a portrait of one, with no cryptography and no IP address.
  assertDocumented(assert, 'timing alone as a link between two households', [
    'between households',
    'two circles with no column in common',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 What the design really does stop
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('FAILED — `seq` is per space, so no counter anywhere compares one family\'s volume with another\'s', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  const key = await spaceKey();
  const a = await seedSpace(h, clock, { id: FAMILY_A, memberSeed: 300, deviceSeed: 300, members: [{ name: 'x', colorRef: 'gruen', devices: 1 }] });
  const b = await seedSpace(h, clock, { id: FAMILY_B, memberSeed: 400, deviceSeed: 400, members: [{ name: 'y', colorRef: 'gruen', devices: 1 }] });
  const r = relay(h, clock);

  let n = 0;
  for (const [space, dev, count] of [[FAMILY_A, a.members[0].devices[0], 3], [FAMILY_B, b.members[0].devices[0], 5]]) {
    for (let i = 0; i < count; i++) {
      const env = await sealFor(key, dev, { space, n: ++n, op: { k: 'note', text: 'x' } });
      const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space, ops: [env] } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  }

  const state = h.dump();
  // Both spaces start at 1 and count their own ops. A global `BIGSERIAL` would have interleaved
  // them, and the gaps in one family's numbering would have measured the other's traffic.
  assert.deepEqual([...state.ops.get(FAMILY_A).values()].map((o) => Number(o.seq)).sort((x, y) => x - y), [1, 2, 3]);
  assert.deepEqual([...state.ops.get(FAMILY_B).values()].map((o) => Number(o.seq)).sort((x, y) => x - y), [1, 2, 3, 4, 5]);

  assertDocumented(assert, 'why seq is per space and not global', [
    '`seq` is per space and never global, which is deliberate: a global sequence would leak cross-family activity volume',
  ]);
});

test('the one place an IP is at rest is not joined to a space, and the join it DOES allow is bounded', async () => {
  const clock = fakeClock(T0);
  const h = A.make(clock);
  const r = relay(h, clock);

  // Two anonymous pairing lookups from one residential address. Both miss, but `pairGet` is a
  // `pre-auth` rule and is charged on entry, by design (`limits.js`: a limiter that runs after
  // the signature bounds the database and not the CPU), so the row is written either way.
  for (let i = 0; i < 2; i++) {
    const res = await r.send({ method: 'GET', path: `/api/v1/pair/${'A'.repeat(22)}`, ip: '203.0.113.7' });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  }
  const state = h.dump();
  const bucket = state.rates.get(rateKey('pairGet', '203.0.113.7'));
  assert.ok(bucket, `the address is at rest; saw ${JSON.stringify([...state.rates.keys()])}`);
  assert.equal(bucket.count, 2, 'and the COUNT says how much of the API this address read this hour');

  // What it does NOT carry: any space, member or device id. So the IP row on its own links one
  // address to a NUMBER of attempts, never to a particular circle. That much of §2's claim holds
  // exactly as written, and it is worth pinning because it is the difference between "an IP is
  // stored" and "an IP is stored next to your family".
  for (const k of state.rates.keys()) {
    assert.equal(/fsp_|psp_|mem_|dev_/.test(k), /"(memberRemove|pairSession)"/.test(k) ? true : false,
      `${k} must not carry a space or device id`);
  }

  assertDocumented(assert, 'an IP address at rest in RateBucket.key, and what it is not joined to', [
    'an IP address is written into a database row',
    'It is not joined to a',
    'The realistic re-identification path is not the database — it is the IP address',
  ]);
});
