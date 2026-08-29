// tests/server/_rotation-wire-domain.js — THE ROTATION WIRE, ENUMERATED AS DATA.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHY IT IS A TABLE RATHER THAN A TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The hostile-client adversary put the E2↔E3 seam exactly:
//
//   > "E2 and E3 were each proved against their own side of a seam nobody drove."
//
// Both sides were green. `src/js/crypto/spacekeys.js` proved every clause of ADR 002 §4.2 against
// a hand-built member list; `server/core/handlers/` proved every clause of ADR 003 §3 against a
// hand-built request body. Neither suite ever put one side's OUTPUT into the other side's INPUT,
// and `server/dev/two-client.js` — the one program that runs both — carried the sender's key
// **by courier** (its own comment: *"STAND-IN: the wire carries no attestation"*) and hand-rolled
// `packWrap`, so it stepped over every gap rather than hitting one.
//
// Round 7's lesson applies here without modification: **enumerate the input domain as data,
// exhaustively, BEFORE choosing a branch.** Six field mismatches were reported. Naming six
// branches and fixing six branches is precisely the shape of fix the next adversary relocates.
// So the domain is not "the six mismatches". The domain is:
//
//     EVERY FIELD OF THE ROTATION WIRE, AT EVERY STATION IT PASSES THROUGH.
//
// A field is *sound* when every station that participates agrees on its NAME, its ENCODING and
// its OBLIGATION. A field is *broken* when two stations disagree — and it does not matter
// whether the disagreement is a spelling, a base64url-versus-object, or a station that refuses
// what the previous station emits. All three are the same defect and this table cannot tell them
// apart, which is the property that makes it a domain rather than a checklist.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FIVE STATIONS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//   produce  the client builds the value                    src/js/crypto/spacekeys.js
//   send     the relay parses it off a request body         server/core/handlers/spaces.js
//   store    the relay keeps it                             MODEL_COLUMNS + schema.prisma
//   publish  the relay serves it back                       handlers/keys.js, handlers/members.js
//   consume  the other client uses it                       src/js/crypto/spacekeys.js
//
// `null` at a station means the field does not pass through it, and that is a claim as strong as
// any other: `senderDeviceId` is `null` at `produce` **because a client may not supply it**, and
// the test asserts the relay 400s a body that tries.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `expect` — the four dispositions, and what closing a row means
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//   'agree'    every non-null station uses the name and encoding in the row. The default.
//   'refused'  the field MUST be rejected at `send` with the stated reason. A relay that
//              accepted it would be taking a value it is supposed to derive.
//   'derived'  the relay writes it from something it authenticated, never from the body.
//   'suspended' the design names this field and the product deliberately does not have it yet,
//              because having it would open a hole. Closing the row means BUILDING THE BINDING —
//              deleting the row instead would close it while making the product unsafe. There is
//              exactly one such row and it is `rec.family.wrap`.
//
// `openFinding` names a row in `docs/v2/FINDINGS.md`. A `null` finding on a broken row would be
// a defect the register does not know about, and `rotation-wire.test.js` asserts there are none.
//
// ZERO IMPORTS. A leaf, like `tests/helpers/domains.js` and `tests/helpers/sync-domains.js`. A
// domain that imported the thing it describes could not describe it being wrong.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Freeze a structure all the way down, so a walker cannot mutate the domain it is walking. */
export function deep(v) {
  if (Object.isFrozen(v)) return v;
  if (Array.isArray(v)) return Object.freeze(v.map(deep));
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = deep(v[k]);
    return Object.freeze(v);
  }
  return v;
}

/** The stations, in wire order. */
export const STATIONS = deep(['produce', 'send', 'store', 'publish', 'consume']);

const F = (id, o) => ({
  id,
  produce: null, send: null, store: null, publish: null, consume: null,
  expect: 'agree',
  openFinding: null,
  ...o,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// W1 — `POST /api/v1/spaces/:id/epoch`, the rotation body, field by field
//
// The client's producer is `buildRotation()` → the POST body. Before this pass there was NO
// function in `spacekeys.js` that produced a body: `buildRotation` returned a `Rotation` whose
// shape is the client's internal one, and every caller in the world (there was one, and it was
// `two-client.js`) translated by hand. A hand translation is a courier.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const W1 = deep([
  F('epoch', {
    field: 'epoch',
    produce: 'rotation.epoch (number)',
    send: "readInt(body,'epoch',{min:1,max:1e6})",
    store: 'Epoch.epoch / Space.currentEpoch',
    publish: 'keys.currentEpoch',
    consume: 'ring.currentEpoch(spaceId)',
    note: 'The one field that never disagreed.',
  }),

  F('wraps.recipientId', {
    field: 'wraps[].recipientId',
    produce: "wireWraps(): 'recipientId'",
    send: "readWraps(): 'recipientId'",
    store: 'KeyWrap.recipientId',
    publish: "fetchKeys(): 'recipientId'",
    consume: "parseKeysResponse(): 'recipientId'",
    openFinding: 'E2E3-1',
    was: "the client emitted `deviceId` (wrapToRecipients) and the relay required `recipientId`; "
      + 'readObject refuses an unknown key, so every honest rotation was a 400 on field `wraps[0]`.',
    note: 'The relay spelling wins, and it is also the TRUE one: a recipient is a device id OR '
      + "the reserved `rec_<memberId>` (finding E3-4), and `rec_…` is not a device id. The client's "
      + 'internal `Recipient.deviceId` keeps its name; exactly ONE function crosses the boundary.',
  }),

  F('wraps.epoch', {
    field: 'wraps[].epoch',
    produce: 'wireWraps(): number',
    send: "readInt(w,'epoch',{min:1,max:epoch})",
    store: 'KeyWrap.epoch',
    publish: 'wraps[].epoch',
    consume: 'admitWraps(row.epoch)',
    note: 'Per-entry because a rotation carries the 1..e backfill alongside e+1 (ADR 002 §4.3).',
  }),

  F('wraps.wrapped', {
    field: 'wraps[].wrapped',
    produce: 'encodeWrap(WrapBlob) → b64u of canonical JSON',
    send: "readBytes(w,'wrapped',{maxLen:1024})",
    store: 'KeyWrap.wrapped (Bytes, OPAQUE)',
    publish: 'bytesToB64u(wrapped)',
    consume: 'decodeWrap(b64u) → WrapBlob → parseWrapBlob',
    openFinding: 'E2E3-2',
    was: 'the client emitted the `WrapBlob` OBJECT `{v,salt,iv,ct}` and the relay required a '
      + 'base64url STRING; `b64uToBytes` 400s an object. There was no packer anywhere in `src/`, '
      + 'which is why `two-client.js` hand-rolled one.',
    note: 'Bytes on the wire and Bytes in the column, because `OPAQUE_FIELDS.KeyWrap` refuses a '
      + 'String at the adapter boundary — that refusal is what makes RULE 1 true, so the encoding '
      + 'had to move to the client rather than the column to the wire.',
  }),

  F('wraps.senderDeviceId', {
    field: 'wraps[].senderDeviceId',
    expect: 'derived',
    produce: null,
    send: 'REFUSED — readObject allows exactly [recipientId, epoch, wrapped]',
    store: 'KeyWrap.senderDeviceId ← auth.deviceId (rotateEpoch) / device.deviceId (createSpace)',
    publish: null,
    consume: null,
    openFinding: 'E2E3-3',
    was: '`admitWraps` REQUIRED `row.senderKexPubRaw` (ADR 002 §4.2 step 6, finding S1) and '
      + '`MODEL_COLUMNS.KeyWrap` had no sender column at all, so `GET /keys` could not carry one '
      + 'and `POST /epoch` 400d a client that tried to supply it. `admitWraps` threw on every row.',
    note: 'THE DECISION: the relay STAMPS the sender from the request it already authenticated, '
      + 'rather than accepting the ADR\'s client-supplied `senderKexPubRaw`. A stamped device id '
      + 'carries ZERO client-chosen bits (a 65-byte client blob per row is a covert channel the '
      + 'blind relay has no reason to accept) and adds no fact the relay did not already observe: '
      + 'it authenticated that device on that request. See W2.senderKexPubRaw for the publication '
      + 'half — the ADR\'s wire spelling is unchanged on the way OUT.',
  }),

  F('invites', {
    field: 'invites',
    expect: 'refused',
    produce: null,
    send: "400 bad_request {field:'invites', reason:'retired_by_d9'}",
    openFinding: 'E2E3-4',
    was: '`buildRotation` emitted `invites: [{id, epoch}]` and `rotateEpoch` refuses the KEY\'s '
      + 'presence, so a body built from a `Rotation` was a 400 even after the wraps were fixed.',
    note: 'D9 wins: an invite carries no key material, so there is nothing for a client to send '
      + 'and the relay refreshes open invites itself. `Rotation.invites` survives as a LOCAL '
      + 'report — it is what refuses an invite arriving with `wrappedKeys` — and `rotationBody()` '
      + 'does not put it on the wire.',
  }),
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// W2 — `GET /api/v1/spaces/:id/keys`, the delivery response
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const W2 = deep([
  F('keys.epoch', { field: 'wraps[].epoch', publish: 'number', consume: 'admitWraps(row.epoch)' }),
  F('keys.recipientId', { field: 'wraps[].recipientId', publish: 'string', consume: 'ignored — the relay already filtered to me' }),
  F('keys.wrapped', {
    field: 'wraps[].wrapped',
    publish: 'b64u(Bytes)',
    consume: 'decodeWrap → WrapBlob',
    openFinding: 'E2E3-2',
  }),
  F('keys.senderKexPubRaw', {
    field: 'wraps[].senderKexPubRaw',
    publish: 'b64u(Device.kexPubRaw) JOINED from KeyWrap.senderDeviceId',
    consume: 'admitWraps → SenderSet.lookup(row.senderKexPubRaw)',
    openFinding: 'E2E3-3',
    note: 'ADR 002 §4.2 step 6\'s spelling is preserved EXACTLY on the way out, so `admitWraps` '
      + 'and `SenderSet.lookup` are unchanged and finding S1\'s whole argument survives verbatim: '
      + 'THE ROW SELECTS A SENDER, IT CANNOT SUPPLY ONE. The bytes are an index into a set the '
      + 'receiver verified itself; the `CryptoKey` the KEK is derived against was imported from '
      + 'the sender\'s own attestation. A relay that lies here can cause a refusal and never an '
      + 'admission. `null` when the sender device row is gone — which is the correct answer, and '
      + 'is what a removed member\'s deposits become.',
  }),
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// W3 — `GET /api/v1/spaces/:id/members`, the roster `familyRecipients()` is built from
//
// This is the half the brief calls "two defensible positions that together are a rotation nobody
// can build": `members.js` deliberately withheld `Device.attestation` ("the log is the
// authority") and `familyRecipients` requires it ("device … has no attestation blob").
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const W3 = deep([
  F('roster.memberId', { field: 'members[].memberId', publish: 'string', consume: 'familyRecipients: m.memberId' }),
  F('roster.removedAt', { field: 'members[].removedAt', publish: 'ISO|null', consume: 'familyRecipients: skip + report' }),
  F('roster.recoveryPubSig', {
    field: 'members[].recoveryPubSig',
    publish: 'b64u(65)',
    consume: 'familyRecipients: housingRecoveryPubRaw → verifyAttestation',
    note: 'Already agreed. It is the ONLY field of this roster that both sides already spelled '
      + 'the same way, and it is the root of trust for every other one.',
  }),
  F('roster.recoveryPubKex', {
    field: 'members[].recoveryPubKex',
    publish: 'b64u(65)',
    consume: 'familyRecipientsReport: m.recoveryPubKex → missingRecoveryKex',
    openFinding: 'E2E3-5',
    was: '`familyRecipientsReport` read `m.recoveryKexPubRaw` while the relay published '
      + '`recoveryPubKex`, so `missingRecoveryKex` named EVERY member of every family for a '
      + 'column finding E3-2 had already added and `members.js` had already published. A '
      + 'mismatch nobody reported, because the symptom was a report field nobody read.',
    note: 'The relay spelling wins. `personalRecipients` keeps `recoverySigPubRaw`/'
      + '`recoveryKexPubRaw` and that is NOT a second spelling of this field: it takes MY OWN '
      + 'identity, assembled locally, never a relay row. Two objects, each internally consistent.',
  }),
  F('roster.devices.deviceId', { field: 'devices[].deviceId', publish: 'string', consume: 'familyRecipients: d.deviceId → recipientId' }),
  F('roster.devices.kexPubRaw', { field: 'devices[].kexPubRaw', publish: 'b64u(65)', consume: 'familyRecipients: rawOf(d.kexPubRaw)' }),
  F('roster.devices.revokedAt', { field: 'devices[].revokedAt', publish: 'ISO|null', consume: 'familyRecipients: skip' }),
  F('roster.devices.attestation', {
    field: 'devices[].attestation',
    produce: "attestDevice() → 'b64u(payload).b64u(sig)'",
    send: "readDevice(): the blob STRING, self-consistency enforced",
    store: 'Device.attestation (Bytes = UTF-8 of the blob, OPAQUE)',
    publish: 'the blob string',
    consume: 'familyRecipients: d.attestation → verifyAttestation under recoveryPubSig',
    openFinding: 'E2E3-6',
    was: '`familyRecipients` THREW "device … has no attestation blob" on the roster the relay '
      + 'actually serves, because `DEVICE_PROJECTION` deliberately omitted it. The only '
      + 'constructor of the branded sender set could not be called at all.',
    note: 'THE DECISION: publish it, and never as authority. The 21.1 cost is NIL and that is '
      + 'checkable rather than argued — every field inside the blob is already a column the relay '
      + 'holds (`Device.id`, `.memberId`, `.deviceShort`, `.sigPubRaw`, `.kexPubRaw`, `.addedAt`), '
      + 'the relay already STORES the blob itself, and every member can already read it out of '
      + 'the E2EE stream (§2.3: "the blob is inside the E2EE stream, so every member can read '
      + 'it"). It is a signed blob, not ciphertext, and it is verified under `recoveryPubSig` '
      + 'before it decides anything — so `members.js`\'s "the log is the authority" survives '
      + 'intact, restated as the distinction ADR 002 §2.3 already draws: this is KEY '
      + 'DISTRIBUTION, not ADMISSIBILITY. And it is the roster ADR 002 §4.2 step 6 already '
      + 'specified in as many words — "its roster must come from relay coordination data '
      + '(`MemberRowDb.recoveryPubSig` plus the `dev.*` blobs)". `members.js` was out of step '
      + 'with the ADR, not with a preference.',
  }),
  F('roster.attestation.encoding', {
    field: 'device.attestation — ONE contract, not two',
    produce: "'b64u(payload).b64u(sig)'",
    send: 'POST /spaces + POST /invites/redeem: the STRING (was: base64url bytes, unverified)',
    store: 'UTF-8 bytes, on all three write paths',
    publish: 'the string',
    consume: 'parseAttestationBlob',
    openFinding: 'E2E3-7',
    was: '`POST /spaces` read base64url via `readBytes` and verified NOTHING, while `POST '
      + '/devices` took the blob string and verified P2+S1+S2 via `verifyDeviceClaim`. Same '
      + 'column, two encodings, one unverified — so `Device.attestation` had no type, and a '
      + 'publication of it would have published two different things.',
  }),
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// W4 — THE COVERAGE OBLIGATION, crossed with space kind and recipient role
//
// `requiredRecipients()` is what turns "rotate" from a capability into an obligation, and it is
// the only server-side check that stops a hostile admin rotating to a ring that omits an honest
// member. It is therefore the last place a wrong obligation can hide: an obligation the client
// CANNOT discharge is indistinguishable, from the user's chair, from a client that will not.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const W4 = deep([
  {
    id: 'cover.personal.device',
    kind: 'PERSONAL', role: 'device',
    expect: { required: true, producible: true },
    by: 'personalRecipients() — my own attested devices',
    openFinding: null,
  },
  {
    id: 'cover.personal.recovery',
    kind: 'PERSONAL', role: 'recovery',
    expect: { required: true, producible: true },
    by: 'personalRecipients() — `me.recoveryKexPubRaw`, MY OWN key, held locally, never off the wire',
    openFinding: null,
    note: 'Sound because the key never came off the relay. This is why `recipientProblem` may '
      + 'wave a recovery recipient through without an attestation — and why that bypass had to '
      + 'be narrowed to this one cell.',
  },
  {
    id: 'cover.family.device',
    kind: 'FAMILY', role: 'device',
    expect: { required: true, producible: true },
    by: 'familyRecipients() — every non-removed member\'s attested, non-revoked devices',
    openFinding: 'E2E3-6',
  },
  {
    id: 'cover.family.recovery',
    kind: 'FAMILY', role: 'recovery',
    expect: { required: false, producible: false },
    by: 'NOBODY — and the relay must therefore not demand it',
    openFinding: 'E2E3-8',
    disposition: 'suspended',
    was: '`requiredRecipients` demanded `rec_<memberId>` for EVERY member of EVERY space, and '
      + '`familyRecipients` produces no recovery recipient at all, so every family rotation was '
      + '409 `incomplete_coverage` even with all six field mismatches repaired. The two halves '
      + 'were written against ADR 002 §4.2 step 2 and ADR 002 §4.2 step 6 respectively and each '
      + 'is right about its own clause.',
    note: 'THE DECISION, AND IT IS THE ONE PLACE THIS PASS REFUSES THE OBVIOUS FIX. Making '
      + '`familyRecipients` build the recovery recipient from `Member.recoveryPubKex` would make '
      + 'every suite green and would hand the relay the family key: NOTHING SIGNS '
      + '`recoveryPubKex`. Swapping `recoveryPubSig` is loud — every device attestation of that '
      + 'member then fails to verify and rotation stops — but swapping `recoveryPubKex` alone is '
      + 'SILENT, leaves every attestation genuine, and is invisible in the member list. That is '
      + 'not §8.5\'s accepted phantom member; it is a new, unattributable key injection into the '
      + 'family key, and it is a live break of 21.1/21.2. So: `recipientProblem` REFUSES a '
      + 'family-scoped recovery recipient by name, `familyRecipients` builds none, and the relay '
      + 'stops demanding one. The binding is specified in ADR 002 §2.3 (an OPTIONAL seventh '
      + 'signed field `recoveryPubKex` in `DeviceAttestation`, which `parseAttestationBlob` '
      + 'already tolerates and whose extra fields are already covered by the signature) and '
      + 'CLOSING THIS ROW MEANS BUILDING THAT — deleting it instead would close it while leaving '
      + 'family A2 recovery (ADR 002 §7.3) with no delivery path.',
  },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FINDINGS THIS DOMAIN NAMES
//
// Documented as data because `docs/v2/FINDINGS.md` is the AUTHORITY and "the row lived only in
// `tests/`" is the failure mode the round-5 and round-7 updates both had to correct. The test
// asserts every `openFinding` above names one of these, so a row cannot cite a finding that does
// not exist and a finding cannot be quietly dropped.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const OPEN_FINDINGS = deep({
  'E2E3-1': { severity: 'HIGH', title: 'the wrap recipient is spelled `deviceId` by the client and `recipientId` by the relay', status: 'fixed-this-pass' },
  'E2E3-2': { severity: 'HIGH', title: 'the wrap blob is an object on one side and base64url bytes on the other; no packer existed', status: 'fixed-this-pass' },
  'E2E3-3': { severity: 'HIGH', title: '`admitWraps` requires a sender the wire cannot carry — no column, no response field, and the POST refuses one', status: 'fixed-this-pass' },
  'E2E3-4': { severity: 'MEDIUM', title: '`buildRotation` emits `invites`, which `POST /epoch` refuses as `retired_by_d9`', status: 'fixed-this-pass' },
  'E2E3-5': { severity: 'MEDIUM', title: '`familyRecipientsReport` reads `recoveryKexPubRaw`; the relay publishes `recoveryPubKex`', status: 'fixed-this-pass' },
  'E2E3-6': { severity: 'HIGH', title: 'the relay does not publish `Device.attestation`, so `familyRecipients()` throws on the roster it serves', status: 'fixed-this-pass' },
  'E2E3-7': { severity: 'HIGH', title: '`device.attestation` has two wire contracts and `POST /spaces` verifies neither', status: 'fixed-this-pass' },
  'E2E3-8': { severity: 'HIGH', title: 'family coverage demands a `rec_<memberId>` wrap that cannot be built without handing the relay the family key', status: 'open — binding specified, not built' },
});

export const DOMAINS = deep({
  W1: { title: 'POST /spaces/:id/epoch — the rotation body', entries: W1 },
  W2: { title: 'GET /spaces/:id/keys — the delivery response', entries: W2 },
  W3: { title: 'GET /spaces/:id/members — the roster familyRecipients() is built from', entries: W3 },
  W4: { title: 'the coverage obligation × space kind × recipient role', entries: W4 },
});

/** Counts, so a truncated file is a loud failure rather than a quiet one. */
export const DOMAIN_SIZES = deep({ W1: 6, W2: 4, W3: 9, W4: 4 });
