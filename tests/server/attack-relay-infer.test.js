// ATTACK · T1 — INFER WHAT YOU CANNOT READ.
//
// `attack-relay-read.test.js` failed: there is no content in the database, the logs or any error
// body. This file is the second question, and it is the one that decides whether the Datenschutz
// page is honest: **what can an operator work out with SQL and no cryptography?**
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RULE THIS FILE ENFORCES, AND IT IS NOT "THE SERVER MUST NOT LEAK METADATA"
// ═════════════════════════════════════════════════════════════════════════════════════════════
// A relay that answers in real time knows who asked and when. That is a documented cost, not a
// broken promise (ADR 002 §8.7: *"the largest gap between 'the server can't read your data' and
// 'the server learns nothing about you', and the Datenschutz copy must not blur it"*). So the
// pass/fail line here is DOCUMENTATION, not capability:
//
//   · Every SUCCEEDED test below proves a capability AND then calls `assertDocumented(...)`,
//     which fails unless `docs/v2/server-metadata.md` — the source document for deliverable 21.3
//     — actually names it. A capability the document is silent about is a **finding against story
//     21.3**, and it fails a test rather than appearing in a report nobody re-reads.
//   · Where the document is genuinely silent, the test is named
//     `SUCCEEDED (UNDOCUMENTED — 21.3)` and asserts the silence, so the day somebody writes the
//     sentence the test goes red and gets renamed. That is the only way a documentation gap stays
//     visible after the person who found it has gone.
//
// Everything here uses the REAL router, the REAL store adapters, and a dump T1 really would have.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS, T0, HOUR, DAY, MINUTE, fakeClock, relay, seedSpace, sealFor, spaceKey,
  assertDocumented, documents, b64u, opId,
} from './_attack-relay-kit.js';
import { rateKey } from '../../server/core/limits.js';

const SPACE = 'fsp_INFERaaaaaaaaaaaaaaaaX';

/** The whole file runs against the memory adapter; §7 re-runs the sharpest two on both. */
const A = ADAPTERS[0];

/**
 * Papa (2 Macs, joined at the start), Mama (1 Mac, joined a week later),
 * Kind (1 Mac, joined a month later). This is what the relay stores; the names exist only here.
 */
async function household(clock, adapter) {
  const h = (adapter || A).make(clock);
  const seeded = await seedSpace(h, clock, {
    id: SPACE, createdAt: T0,
    members: [
      { name: 'Papa', colorRef: 'gruen', devices: 2, joinedAt: T0, addedAt: T0 },
      { name: 'Mama', colorRef: 'blau', devices: 1, joinedAt: T0 + 7 * DAY, addedAt: T0 + 7 * DAY },
      { name: 'Kind', colorRef: 'rot', devices: 1, joinedAt: T0 + 30 * DAY, addedAt: T0 + 30 * DAY },
    ],
  });
  return { h, r: relay(h, clock), ...seeded };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 The roster — who is in which family, and how many
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — the dump is a household census: size, machines each, and the join order to the second', async () => {
  const clock = fakeClock(T0);
  const { h } = await household(clock);
  const state = h.dump();

  // Exactly the query an operator writes.
  const bySpace = new Map();
  for (const m of state.members.values()) {
    if (!bySpace.has(m.spaceId)) bySpace.set(m.spaceId, []);
    bySpace.get(m.spaceId).push(m);
  }
  const roster = bySpace.get(SPACE);
  assert.equal(roster.length, 3, 'the household size, read off a COUNT(*)');

  const devicesOf = (mid) => [...state.devices.values()].filter((d) => d.memberId === mid).length;
  const shape = roster
    .map((m) => ({ joinedAt: m.joinedAt.getTime(), colour: m.colorRef, macs: devicesOf(m.id) }))
    .sort((a, b) => a.joinedAt - b.joinedAt);

  assert.deepEqual(shape, [
    { joinedAt: T0, colour: 'gruen', macs: 2 },
    { joinedAt: T0 + 7 * DAY, colour: 'blau', macs: 1 },
    { joinedAt: T0 + 30 * DAY, colour: 'rot', macs: 1 },
  ], 'three people, four machines, in the order they joined, with one of them owning two Macs');

  // And the space kind separates a household from one person's two Macs, before any join at all.
  assert.equal(state.spaces.get(SPACE).kind, 'FAMILY');

  assertDocumented(assert, 'household size, machines per person, and join order', [
    'how many people are in it, and how many machines each of them has',
    'the order they joined in, to the second',
    'which household this person belongs to',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 The rhythm — when is this family awake, and where does it live
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — a per-machine activity histogram from `Op.receivedAt`, and the quiet hours it leaves', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const key = await spaceKey();
  const papa = members[0].devices[0];
  const mama = members[1].devices[0];

  // One ordinary weekday. Papa writes before work and late; Mama writes over lunch. Nobody
  // touches the board between 23:00 and 06:00.
  const schedule = [
    { dev: papa, hour: 7 }, { dev: papa, hour: 7 }, { dev: mama, hour: 12 },
    { dev: mama, hour: 13 }, { dev: papa, hour: 22 }, { dev: papa, hour: 22 },
  ];
  for (const [i, s] of schedule.entries()) {
    clock.set(T0 + (s.hour - 8) * HOUR + i * MINUTE);
    const env = await sealFor(key, s.dev, { space: SPACE, n: i + 1, op: { k: 'note', text: 'x' } });
    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev: s.dev, body: { space: SPACE, ops: [env] }, at: clock.now() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  // The operator's query: GROUP BY deviceShort, hour(receivedAt).
  const hours = new Map();
  for (const row of h.dump().ops.get(SPACE).values()) {
    const hour = new Date(row.receivedAt).getUTCHours();
    if (!hours.has(row.deviceShort)) hours.set(row.deviceShort, new Set());
    hours.get(row.deviceShort).add(hour);
  }
  assert.deepEqual([...hours.get(papa.deviceShort)].sort((a, b) => a - b), [7, 22]);
  assert.deepEqual([...hours.get(mama.deviceShort)].sort((a, b) => a - b), [12, 13]);

  // The quiet window is the inference that matters: nobody in this house was at a Mac at 03:00.
  const allHours = new Set([...hours.values()].flatMap((s) => [...s]));
  for (const h3 of [0, 1, 2, 3, 4, 5]) assert.equal(allHours.has(h3), false);

  assertDocumented(assert, 'per-machine, per-day activity and the household rhythm', [
    'when that Mac is awake and has the app open',
    'who writes in the morning, who writes at 23:00',
    'the arrival time of every single operation',
  ]);
});

test('SUCCEEDED (UNDOCUMENTED — 21.3) — a member living in another time zone is visible as a shifted activity window', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const key = await spaceKey();
  const home = members[0].devices[0];   // Frankfurt
  const away = members[2].devices[0];   // the Kind, at university, six hours west

  // Both write across their own local waking day, 08:00–22:00 local. `home` is at UTC+0 and
  // `away` is six hours west, so `away`'s local day lands six hours later in UTC — the only
  // clock the relay has.
  let n = 0;
  const write = async (dev, utcHour) => {
    clock.set(T0 + (utcHour - 8) * HOUR + (n++) * MINUTE);
    const env = await sealFor(key, dev, { space: SPACE, n, op: { k: 'note', text: 'x' } });
    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [env] }, at: clock.now() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  const LOCAL_DAY = [8, 9, 12, 15, 18, 21];
  for (const hour of LOCAL_DAY) await write(home, hour);
  for (const hour of LOCAL_DAY) await write(away, (hour + 6) % 24);

  /**
   * The operator's arithmetic, and it is the obvious one: find each machine's NIGHT — its LONGEST
   * unbroken run of silent hours on the 24-hour clock — and read the hour that run starts.
   * Bimodal traffic (a morning burst and an evening one) breaks a circular mean; it does not
   * break this, which is why an operator would use it.
   */
  const nightStart = (short) => {
    const active = new Set([...h.dump().ops.get(SPACE).values()]
      .filter((o) => o.deviceShort === short)
      .map((o) => new Date(o.receivedAt).getUTCHours()));
    let best = { start: null, len: 0 };
    for (let s = 0; s < 24; s++) {
      if (active.has(s) || !active.has((s + 23) % 24)) continue;   // only a run's first hour
      let len = 0;
      while (len < 24 && !active.has((s + len) % 24)) len++;
      if (len > best.len) best = { start: s, len };
    }
    return best;
  };
  const a = nightStart(home.deviceShort);
  const b = nightStart(away.deviceShort);
  assert.ok(a.len >= 8 && b.len >= 8, `each machine has a real night; got ${a.len} h and ${b.len} h`);
  const offset = ((b.start - a.start) + 24) % 24;
  assert.equal(offset, 6,
    `expected the two nights to be exactly six hours apart; measured ${offset} h `
    + `(${a.start}:00 vs ${b.start}:00 UTC)`);

  // THE FINDING. §5 says the relay learns "when that Mac is awake" and "who writes at 23:00" —
  // which is the raw material — but the document never draws the conclusion that the OFFSET
  // between two members' windows locates one of them in a different time zone, i.e. tells the
  // operator that somebody in this household is not at home. For a family product whose
  // Datenschutz page is written from this file, that is a sentence that is missing.
  assert.equal(documents(['time zone']) || documents(['timezone']) || documents(['zeitzone']), false,
    'server-metadata.md now discusses time zones — rename this test to SUCCEEDED and add the phrase '
    + 'to an assertDocumented call, so the capability stays covered');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 Who is the admin
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Story 15.2: the creator of a Familienkreis "automatically become[s] its admin". Story 20.1: the
// admin — and by the client's own UI nobody else — invites, revokes invites, removes members,
// renames the space and transfers the role. ADR 003 §5.1 is emphatic that there is "no role
// column" and server-metadata.md §3 lists "no role or admin column" among the things that cannot
// be added quietly. Both are true about COLUMNS. Neither is true about the DUMP.

test('SUCCEEDED (UNDOCUMENTED — 21.3) — a dump names the admin four independent ways, and never says so', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const papa = members[0];        // the founder, therefore the admin (15.2)
  const mama = members[1];
  const kind = members[2];

  // (1) THE FOUNDER. The earliest `joinedAt` in a FAMILY space is the person who created the
  // circle, because every other member arrived through an invite that this row predates.
  const roster = [...h.dump().members.values()].filter((m) => m.spaceId === SPACE);
  const founder = roster.slice().sort((a, b) => a.joinedAt - b.joinedAt)[0];
  assert.equal(founder.id, papa.id, 'the founding admin, from one ORDER BY');

  // (2) THE ISSUER. 20.1 makes inviting an admin-only act, and `Invite.createdBy` records it.
  clock.set(T0 + 40 * DAY);
  const inv = await r.send({
    method: 'POST', path: '/api/v1/invites', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, inviteId: opId(3), verifier: b64u(new Uint8Array(32)) },
  });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const issuers = new Set([...h.dump().invites.values()].filter((i) => i.spaceId === SPACE).map((i) => i.createdBy));
  assert.deepEqual([...issuers], [papa.id]);

  // (3) THE REMOVER — and this is the one that is at rest FOR EVER. `RATE_RULES.memberRemove` is
  // keyed on the member, so removing somebody writes `["memberRemove","mem_…"]` into
  // `RateBucket.key`. Only the admin removes members (20.1). Nothing sweeps `RateBucket`
  // (server-metadata.md §11), so this row outlives the count it was created for, outlives the
  // membership it recorded, and names the admin in a table whose stated purpose is abuse defence.
  const rm = await r.send({
    method: 'POST', path: '/api/v1/members/remove', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, memberId: kind.id },
  });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  const buckets = [...h.dump().rates.keys()];
  assert.ok(buckets.includes(rateKey('memberRemove', papa.id)),
    `expected the admin's own member id in a RateBucket key; saw ${JSON.stringify(buckets)}`);
  // It really is the ADMIN's id and not the removed member's — so the row identifies the actor.
  assert.equal(buckets.includes(rateKey('memberRemove', kind.id)), false);

  // (4) THE TRANSFER. `POST /members/transfer` stores nothing — the handler says so on the wire —
  // but the RUNNING relay sees both ends of it: the caller is the outgoing admin and the body
  // names the successor. One log line and one request body, in real time.
  const tr = await r.send({
    method: 'POST', path: '/api/v1/members/transfer', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, memberId: mama.id },
  });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  assert.equal(tr.body.stored, 'nothing');
  const line = r.lines.find((l) => l.route === 'transferAdmin');
  assert.ok(line, 'the transfer is logged');
  assert.equal(line.deviceShort, papa.devices[0].deviceShort,
    'and the log line attributes it to a machine, which maps to a member by one join');

  // THE FINDING. `server-metadata.md` says "no role or admin column" (§3) and never once says
  // that the admin is nevertheless identifiable. §7's dump list — the paragraph a Datenschutz
  // page is written from — does not include the admin. It should, because in a household the
  // admin is a specific person and "the relay can tell which of the five of you is in charge" is
  // exactly the kind of sentence 21.3 exists to say out loud.
  assert.equal(documents(['admin']) && (documents(['identify the admin']) || documents(['which member is admin'])),
    false,
    'server-metadata.md now names the admin inference — rename this test and move the phrases into '
    + 'an assertDocumented call');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 Size and shape from the padded blob
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — the padding hides the length and not the size CLASS; `k` comes off the column with arithmetic', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const key = await spaceKey();
  const papa = members[0].devices[0];

  const texts = [
    'Zahnarzt',                                              // a short note
    'Zahnarzt Mama 14:30 Dr. Weber Hauptstraße 12',          // a longer one — must land in the same bucket
    'x'.repeat(900),                                         // a bar with a long label and a blob
  ];
  for (const [i, text] of texts.entries()) {
    const env = await sealFor(key, papa, { space: SPACE, n: i + 1, op: { k: 'note', text } });
    const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev: papa, body: { space: SPACE, ops: [env] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  const lens = [...h.dump().ops.get(SPACE).values()]
    .sort((a, b) => Number(a.seq - b.seq)).map((o) => o.envelope.length);

  // ADR 002 §5.3's step function, recomputed here from the ADR and not from the code.
  for (const L of lens) {
    assert.equal((L - 92) % 256, 0, `len(envelope) must be 92 + 256k; saw ${L}`);
    assert.ok(L > 92);
  }
  const k = lens.map((L) => (L - 92) / 256);

  // WHAT THE PADDING BUYS: the two short notes are indistinguishable.
  assert.equal(k[0], k[1], 'a one-word note and a four-line note must be the same row');
  // WHAT IT DOES NOT: the third is visibly a different kind of object.
  assert.ok(k[2] > k[0], `expected the big op to be a bigger bucket; k = ${k}`);
  // And `k` is a lower bound on how much was written.
  assert.ok(256 * k[2] >= 900, 'k under-reports but never over-reports the payload');

  assertDocumented(assert, 'the size class of an op, from the padded envelope length', [
    '92 + 256',
    'the size *class*',
    'a lower bound on how much was written',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 A rotation row is a family event
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED — the KeyWrap recipient set is a census, and the diff between two epochs names the event', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const papa = members[0];
  const kind = members[2];

  const recipientsFor = async (epoch, memberRows, deviceRows) => {
    const out = [];
    for (const m of memberRows) {
      if (m.removedAt) continue;
      out.push({ recipientId: `rec_${m.id}`, epoch, wrapped: b64u(new Uint8Array(156)) });
      for (const d of deviceRows.filter((x) => x.memberId === m.id && !x.revokedAt)) {
        out.push({ recipientId: d.id, epoch, wrapped: b64u(new Uint8Array(156)) });
      }
    }
    return out;
  };
  /** A full, coverage-complete rotation to `epoch`, backfilling every earlier epoch. */
  const rotate = async (epoch) => {
    const ms = await h.store.listMembers(SPACE);
    const ds = await h.store.listDevices(SPACE);
    const wraps = [];
    for (let e = 1; e <= epoch; e++) wraps.push(...await recipientsFor(e, ms, ds));
    const res = await r.send({
      method: 'POST', path: `/api/v1/spaces/${SPACE}/epoch`, dev: papa.devices[0], at: clock.now(),
      body: { epoch, wraps },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };

  clock.set(T0 + 31 * DAY);
  await rotate(2);                                  // epoch 2: the whole household as it stands

  // A device is revoked — the family's second Mac disappears.
  clock.set(T0 + 60 * DAY);
  const revoked = papa.devices[1];
  const rev = await r.send({
    method: 'POST', path: '/api/v1/devices/revoke', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, deviceId: revoked.id },
  });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  await rotate(3);

  // A member leaves.
  clock.set(T0 + 90 * DAY);
  const rm = await r.send({
    method: 'POST', path: '/api/v1/members/remove', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, memberId: kind.id },
  });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  await rotate(4);

  // THE OPERATOR'S QUERY: SELECT recipientId FROM KeyWrap WHERE epoch = ? — one row per member of
  // the household at the instant that epoch was created.
  const state = h.dump();
  const census = (e) => new Set([...state.keyWraps.values()]
    .filter((w) => w.spaceId === SPACE && w.epoch === e).map((w) => w.recipientId));

  // NOTE, and it is the operator's own caveat: `deleteKeyWrapsForDevices` purges the stale rows,
  // so a SINGLE dump shows only the survivors of every epoch. The diff is therefore taken here
  // over what a relay OPERATOR has — successive observations, i.e. what anyone with backups or
  // with the running server sees — and the retained timestamps below reconstruct the same thing
  // from one dump anyway.
  assert.equal(census(4).has(revoked.id), false, 'the revoked Mac is gone from the current census');
  assert.equal(census(4).has(`rec_${kind.id}`), false, 'and so is the departed member');
  assert.ok(census(4).has(`rec_${papa.id}`) && census(4).has(papa.devices[0].id));

  // …and from ONE dump, the retained columns date every event to the second.
  const kindRow = [...state.members.values()].find((m) => m.id === kind.id);
  assert.equal(kindRow.removedAt.getTime(), T0 + 90 * DAY, 'a departure is permanently legible');
  const devRow = [...state.devices.values()].find((d) => d.id === revoked.id);
  assert.equal(devRow.revokedAt.getTime(), T0 + 60 * DAY, 'so is a revoked Mac');
  const epochRows = [...state.epochs.values()].filter((e) => e.spaceId === SPACE)
    .sort((a, b) => a.epoch - b.epoch).map((e) => [e.epoch, e.createdAt.getTime()]);
  assert.deepEqual(epochRows, [[2, T0 + 31 * DAY], [3, T0 + 60 * DAY], [4, T0 + 90 * DAY]],
    'every rotation is timestamped, and by §6 each one is a family event');

  assertDocumented(assert, 'the recipient set of a rotation, and the household event behind it', [
    'the complete recipient set of every rotation',
    'A rotation timestamp is therefore a family-event timestamp',
    'somebody was removed or left',
    'a machine was revoked',
  ]);
});

test('SUCCEEDED — the holes a purge leaves in `seq` say how much the departed member had written', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const key = await spaceKey();
  const papa = members[0].devices[0];
  const kind = members[2].devices[0];

  // Kind writes eleven ops; Papa writes three.
  let n = 0;
  const write = async (dev, count) => {
    for (let i = 0; i < count; i++) {
      const env = await sealFor(key, dev, { space: SPACE, n: ++n, op: { k: 'note', text: 'x' } });
      const res = await r.send({ method: 'POST', path: '/api/v1/ops', dev, body: { space: SPACE, ops: [env] } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  };
  await write(kind, 11);
  await write(papa, 3);

  clock.set(T0 + 90 * DAY);
  await r.send({ method: 'POST', path: '/api/v1/members/remove', dev: papa, at: clock.now(),
    body: { spaceId: SPACE, memberId: members[2].id } });

  const state = h.dump();
  const surviving = [...state.ops.get(SPACE).values()].map((o) => Number(o.seq)).sort((a, b) => a - b);
  const head = Number(state.spaces.get(SPACE).nextSeq);

  assert.equal(head, 14, '`Space.nextSeq` is a LIFETIME counter and never goes down');
  assert.deepEqual(surviving, [12, 13, 14], 'and the purge left holes exactly where the ops were');
  assert.equal(head - surviving.length, 11,
    'so the count of the holes IS the number of ops the departed member had written');

  assertDocumented(assert, 'how much a departed member had written, from purge holes in seq', [
    'how much that person had written before they left',
    'a lifetime activity counter that never goes down',
    'purge gaps in `Op.seq`',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 The application log is a labelled action timeline
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('SUCCEEDED (UNDOCUMENTED — 21.3) — `route` turns the log into a NAMED per-member event feed', async () => {
  const clock = fakeClock(T0);
  const { r, members } = await household(clock);
  const papa = members[0];

  clock.set(T0 + 40 * DAY);
  await r.send({ method: 'POST', path: '/api/v1/invites', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, inviteId: opId(9), verifier: b64u(new Uint8Array(32)) } });
  clock.set(T0 + 41 * DAY);
  await r.send({ method: 'POST', path: `/api/v1/spaces/${SPACE}/rename`, dev: papa.devices[0], at: clock.now(), body: {} });
  clock.set(T0 + 42 * DAY);
  await r.send({ method: 'POST', path: '/api/v1/members/remove', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, memberId: members[2].id } });
  clock.set(T0 + 43 * DAY);
  await r.send({ method: 'POST', path: '/api/v1/members/transfer', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, memberId: members[1].id } });

  const feed = r.lines.map((l) => l.route);
  assert.deepEqual(feed, ['createInvite', 'renameSpace', 'removeMember', 'transferAdmin'],
    'four route names, in order, each attributed to a deviceShort and a spaceId');
  for (const l of r.lines) {
    assert.equal(l.spaceId, SPACE);
    assert.equal(l.deviceShort, papa.devices[0].deviceShort);
  }

  // THE FINDING. §8 lists the seven fields the application log may carry and then says what is
  // NOT in it ("No IP, no path, no body, no ciphertext"). It never says what the fields that ARE
  // in it mean together: `(route, spaceId, deviceShort)` at a timestamp is "this machine renamed
  // the circle / invited somebody / removed somebody / handed over the admin role", by name, and
  // `LOG_ROUTES` is a closed enum of exactly those 23 verbs. `renameSpace` is the sharpest case
  // — the handler stores nothing and is documented as storing nothing, and the log still records
  // that the family renamed its circle on 25 July.
  assert.equal(documents(['the log line', 'names the event']) || documents(['action timeline']), false,
    'server-metadata.md now explains what a log route name discloses — rename this test');
});

test('SUCCEEDED (UNDOCUMENTED — 21.3) — `RateBucket` keys are a per-member action record, at rest, unswept', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const papa = members[0];

  clock.set(T0 + 40 * DAY);
  await r.send({ method: 'POST', path: '/api/v1/members/remove', dev: papa.devices[0], at: clock.now(),
    body: { spaceId: SPACE, memberId: members[2].id } });
  await r.send({ method: 'POST', path: '/api/v1/pair/offer', dev: papa.devices[0], at: clock.now(),
    body: { rid: opId(4), boxA: b64u(new Uint8Array(64)) } });

  const keys = [...h.dump().rates.keys()];
  assert.ok(keys.includes(rateKey('memberRemove', papa.id)));
  assert.ok(keys.includes(rateKey('pairSession', papa.id)));

  // A YEAR LATER the rows are still there. `rateAllow` replaces `{count, windowStart}` and never
  // deletes the key (server-metadata.md §11), so a bucket is a permanent record that member
  // `mem_…` removed somebody and added a Mac — long after both counters expired.
  clock.set(T0 + 400 * DAY);
  await r.send({ method: 'GET', path: '/api/v1/ops', dev: papa.devices[0], at: clock.now(), query: { space: SPACE } });
  const later = [...h.dump().rates.keys()];
  assert.ok(later.includes(rateKey('memberRemove', papa.id)), 'the key survives its own window');
  assert.ok(later.includes(rateKey('pairSession', papa.id)));

  // §11 is honest that the ROW survives and names the IP case. It frames the survival as a
  // privacy problem about IP ADDRESSES only ("a key containing an IP address survives
  // indefinitely"). The member-keyed rules survive identically and say something different: not
  // "somebody at this address", but "this member did this thing".
  assert.ok(documents(['survives', 'indefinitely']), 'the survival itself IS documented');
  assert.equal(documents(['memberRemove', 'names the actor']) || documents(['a per-member action record']), false,
    'server-metadata.md now says what the MEMBER-keyed buckets disclose — rename this test');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 Where the inference stops
// ═════════════════════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  test(`[${adapter.name}] FAILED — nothing in the dump maps a pseudonymous id to a human`, async () => {
    const clock = fakeClock(T0);
    const { h, r, members } = await household(clock, adapter);
    const key = await spaceKey();
    for (const [i, m] of members.entries()) {
      const env = await sealFor(key, m.devices[0], { space: SPACE, n: i + 1, op: { k: 'member.set', displayName: m.name } });
      await r.send({ method: 'POST', path: '/api/v1/ops', dev: m.devices[0], body: { space: SPACE, ops: [env] } });
    }
    const { readableStrings, findText } = await import('./_attack-relay-kit.js');
    assert.deepEqual(findText(readableStrings(h.dump()), ['Papa', 'Mama', 'Kind']), [],
      'a display name reached the relay');

    // What T1 has instead is a colour and a random id — which is exactly what §7 claims.
    assertDocumented(assert, 'the limit of the inference', [
      'a single word anyone wrote',
      'which of the pseudonymous ids is which human',
      'the realistic re-identification path is not the database — it is the IP address',
    ]);
  });
}

test('FAILED — no column anywhere records an AUTHORING time; only arrival', async () => {
  const clock = fakeClock(T0);
  const { h, r, members } = await household(clock);
  const key = await spaceKey();
  const papa = members[0].devices[0];

  // A device that has been offline for three weeks pushes an op it wrote on day one. The relay
  // stamps the ARRIVAL, and there is no second timestamp for it to learn the difference from.
  clock.set(T0 + 21 * DAY);
  const env = await sealFor(key, papa, { space: SPACE, n: 1, op: { k: 'note', text: 'x', ts: T0 } });
  await r.send({ method: 'POST', path: '/api/v1/ops', dev: papa, at: clock.now(), body: { space: SPACE, ops: [env] } });

  const row = [...h.dump().ops.get(SPACE).values()][0];
  assert.equal(new Date(row.receivedAt).getTime(), T0 + 21 * DAY);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'ts'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'authoredAt'), false);
  const { MODEL_COLUMNS, FORBIDDEN_COLUMN_TOKENS } = await import('../../server/core/store-interface.js');
  assert.equal(MODEL_COLUMNS.Op.includes('ts'), false);
  assert.ok(FORBIDDEN_COLUMN_TOKENS.includes('authoredat'),
    'and the name is on the forbidden list, so it cannot arrive in a later commit');

  assertDocumented(assert, 'arrival time is stored and authoring time is not', [
    'Not the authoring time: that is inside the ciphertext and stays there',
  ]);
});
