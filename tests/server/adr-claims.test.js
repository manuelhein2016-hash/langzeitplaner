// tests/server/adr-claims.test.js — the two ADR 003 §4 rules that gate a CLAIM rather than code.
//
// WHY A TEST FILE FOR PROSE. Round 10 items 8 and 9 are half specification. Item 9 in particular
// has no code to write: its whole content is *what a client may say about a log it cannot verify*,
// and the failure mode is a UI that quietly says "geprüft" for history it never witnessed. A rule
// that lives only in a paragraph is a rule the next agent deletes while tidying, and the suite
// stays green while the product starts lying. So the rules are pinned here, by name, the way
// `blindness.test.js` pins the column set: the ADR is the source, this file is the latch.
//
// WHAT THIS FILE DOES **NOT** CLAIM. Pinning a sentence is not proving a behaviour. The behaviour
// half of §4.1 lives in the client's chain engine and in `tests/fleet/*` (R8-2's diagnostic bound,
// `fromGenesis`); the behaviour half of §5.1's namespace decision is proved by
// `tests/server/auth.test.js` STEP 4, contract cases C29b/C29c/C32b, and
// `tests/server/attack-relay-correlate.test.js` §1–§2. This file is the part of the round that is
// a promise, kept where a promise can be checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADR003 = fs.readFileSync(path.join(REPO, 'docs/v2/adr/003-sync-protocol.md'), 'utf8');

/** The text of one `###`/`####` section, up to the next heading of the same or higher level. */
function section(src, heading) {
  const i = src.indexOf(heading);
  assert.notEqual(i, -1, `ADR 003 no longer contains the heading "${heading}"`);
  const rest = src.slice(i + heading.length);
  const end = rest.search(/\n#{1,4} /);
  return rest.slice(0, end === -1 ? rest.length : end);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4.1 — the baseline a joining device may claim
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ADR 003 §4.1 states all five baseline rules, by name', () => {
  const s = section(ADR003, '### 4.1 The baseline a joining device may claim');
  for (const rule of ['**R1 —', '**R2 —', '**R3 —', '**R4 —', '**R5 —']) {
    assert.ok(s.includes(rule),
      `§4.1 has lost ${rule.slice(2, 4).trim()}. The five together are what makes `
      + '„seit dem Beitritt geprüft" testable instead of tasteful; four of them is a client that '
      + 'can be conformant and still lie.');
  }
  assert.match(s, /baselineSeq/, 'R1 names the value a device persists');
  assert.match(s, /baselineChain/);
});

test('ADR 003 §4.1 answers the question HONESTLY — a post-removal joiner cannot prove a baseline', () => {
  const s = section(ADR003, '### 4.1 The baseline a joining device may claim');
  // The whole point of item 9. An unprovable claim reported as proved is worse than one reported
  // as unprovable, so the ADR must say "cannot" and must not offer a construction that pretends.
  assert.match(s, /cannot prove a baseline/i,
    'the answer must be stated as an inability, not softened into a procedure');
  assert.match(s, /fromGenesis/,
    'ADR 002 §5.4\'s flag is the mechanism this answer is carried by, and must be named');
  // The three candidate anchors, each rejected for its own reason, so nobody re-proposes one.
  assert.match(s, /nobody signs it/i, 'the chain is the relay\'s own accumulator');
  assert.match(s, /unverifiable rather than falsifiable/i, 'a peer\'s wit across a purged range');
  assert.match(s, /R10-4/, 'a withhold and a purge are the same event to this client');
  // And the fix that WOULD work, named so its absence stays a decision.
  assert.match(s, /transparency log/i);
  assert.match(s, /§8\.6/, 'ADR 002 §8.6 already owns that item');
});

test('ADR 003 §4.1 forbids the two lies specifically: a rising flag and a break below the baseline', () => {
  const s = section(ADR003, '### 4.1 The baseline a joining device may claim');
  assert.match(s, /may fall and may never rise/i,
    'R3. A device that re-anchors after a cache clear and calls itself verified is the failure '
    + 'this round exists to prevent.');
  assert.match(s, /below `baselineSeq` is not a finding/i,
    'R4. Reporting it would make every honest post-removal join look like an attack, which is how '
    + 'a diagnostic becomes noise and then becomes ignored.');
  assert.match(s, /diagnostic/i, 'and it stays a diagnostic — ADR 002 §5.4, finding R8-2');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4.2 — the versioning contradiction round 8 raised and round 9 left implicit
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ADR 003 §4.2 versions the attestation allow-list by X-LZP-Protocol, checkably', () => {
  const s = section(ADR003, '### 4.2 The attestation allow-list moves with `X-LZP-Protocol`');
  assert.match(s, /attestation_unknown_field/,
    'the error a client actually meets must appear, or the rule is unreachable from the symptom');
  assert.match(s, /maxProto/,
    '`GET /meta` already publishes it, so the rule needs no new surface — and saying which value '
    + 'to read is the difference between a mechanism and an intention');
  assert.match(s, /version signal/i,
    'the 400 must be re-read as "update the relay", not rendered as a pairing error');
});

test('ADR 003 §4.2 names ADR 002 §2.3\'s bullet as the wrong text, and says why it is not a contradiction', () => {
  const s = section(ADR003, '### 4.2 The attestation allow-list moves with `X-LZP-Protocol`');
  assert.match(s, /tolerates extra fields/,
    'the sentence being corrected must be quoted, or a reader cannot find it');
  assert.match(s, /encrypted op stream/i,
    'the reconciliation is that the park rule and the door rule govern DIFFERENT objects');
  assert.match(s, /owed/i, 'and the amendment to ADR 002 is owed, not silently assumed');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5.1 — the namespace decision, and the two things it deliberately does not claim
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ADR 003 §5.1 records the namespace decision AND refuses to oversell it', () => {
  const s = section(ADR003, '#### The `deviceShort` namespace');
  assert.match(s, /@@unique\(\[spaceId, deviceShort\]\)/, 'the decision');
  assert.match(s, /R10-7/, 'the lockout the old constraint permitted');
  assert.match(s, /R10-8a/, 'and the residual it leaves, owned rather than hidden');
  // The two anti-claims. Both matter more than the decision: a reader who takes either of them
  // for a privacy win will build on sand.
  assert.match(s, /per-space device signing key/i,
    'the cross-space join is NOT fixed by this, and the only thing that would fix it is named');
  assert.match(s, /not a control/i,
    'the composite index is a speed bump for ad-hoc SQL, and the operator can CREATE INDEX');
});
