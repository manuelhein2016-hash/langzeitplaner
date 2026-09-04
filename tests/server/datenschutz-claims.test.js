// tests/server/datenschutz-claims.test.js — the Datenschutz screen, held to the LIVE server enums.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE, AND WHY HERE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// F5 replaced four false sentences on the Datenschutz screen (21.3, LZP-1001) and added the five
// dump-level disclosures `docs/v2/server-metadata.md` §7 names. Four of those five rest on
// SERVER facts — a route enum, a rate-rule table, a field allowlist, two public-key columns —
// and the screen states them as NUMBERS: „eine von vierundzwanzig festen Bezeichnungen", „drei
// der Zeilen … sind … auf ein Mitglied" ausgestellt.
//
// `tests/tier2/e13-datenschutz.dom.js` §4b pins those numbers as CONSTANTS, with the one-line
// command that produced each — which is the most that file can do, because `build.sh` copies
// `index.html` and `src/` into the WebView bundle and nothing else, so a tier-2 row cannot import
// `server/`. Its own comment says a `tests/server/` row is owed. This is that row.
//
// THE FAILURE IT EXISTS TO CATCH is not a wrong sentence. It is a sentence that was true when it
// was written and quietly stopped being true when somebody added a twenty-fifth route or a fourth
// member-keyed rate rule — the drift that produced F12's five disagreements. The screen is the
// one surface whose entire job is that trust is INFORMED; a stale number there is worse than no
// number, because a reader can check it and will conclude the rest is careful too.
//
// ⚠ THIS FILE ASSERTS AGREEMENT, NOT CORRECTNESS. It cannot tell you the disclosure is complete —
//   that is `server-metadata.md` §7's job and a human's. It tells you the screen and the server
//   have not drifted apart. Both halves are needed and neither substitutes for the other.
//
// ⚠ AND IT DELIBERATELY READS THE WORDS, NOT A CONSTANT. Asserting `DATENSCHUTZ.de.infer4`
//   contains `String(ROUTE_NAMES.length)` would be satisfied by a screen that says "24" about
//   something else entirely, so each row below also requires the CLAIM the number is attached to.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTE_NAMES } from '../../server/core/router.js';
import { LOG_FIELDS, RATE_RULES } from '../../server/core/limits.js';
import { DATENSCHUTZ } from '../../src/js/settings.js';

/** German numerals as the screen spells them — it writes words, not digits, and should. */
const DE_NUMERAL = Object.freeze({
  3: 'drei', 4: 'vier', 5: 'fünf', 23: 'dreiundzwanzig', 24: 'vierundzwanzig', 25: 'fünfundzwanzig',
});
const EN_NUMERAL = Object.freeze({
  3: 'three', 4: 'four', 5: 'five', 23: 'twenty-three', 24: 'twenty-four', 25: 'twenty-five',
});

const de = DATENSCHUTZ.de;
const en = DATENSCHUTZ.en;

describe('the Datenschutz screen agrees with the live server enums', () => {
  test('§1 · infer4 — the route enum\'s SIZE is the number on the screen, in both languages', () => {
    const n = ROUTE_NAMES.length;
    assert.equal(n, 24,
      `ROUTE_NAMES now holds ${n} verbs. That is not a defect — it is a REVIEW TRIGGER. Story 21.3 `
      + 'promises the screen names how precisely the relay can see what you did, so a new verb has '
      + 'to be looked at before this number is bumped: is it as telling as `renameSpace`? Then '
      + 'update DATENSCHUTZ.de.infer4 / .en.infer4, `docs/v2/server-metadata.md` §7.4, and the '
      + 'constant in `tests/tier2/e13-datenschutz.dom.js` §4b, in one commit.');
    assert.ok(de.infer4.includes(DE_NUMERAL[n]),
      `the German screen does not say „${DE_NUMERAL[n]}" fixed names: ${JSON.stringify(de.infer4)}`);
    assert.ok(en.infer4.includes(EN_NUMERAL[n]),
      `the English screen does not say "${EN_NUMERAL[n]}" fixed names: ${JSON.stringify(en.infer4)}`);
  });

  test('§2 · infer4 — the three fields that share ONE log line really do share one line', () => {
    // The screen's claim is not "the log has these fields", it is that the ACTION, the CIRCLE and
    // the DEVICE stand together — which is what makes „dass jemand etwas geändert hat, nicht was"
    // false. One line carrying all three is the whole mechanism.
    for (const f of ['route', 'spaceId', 'deviceShort']) {
      assert.ok(Object.prototype.hasOwnProperty.call(LOG_FIELDS, f),
        `LOG_FIELDS no longer admits "${f}". If a field was REMOVED the screen is now harsher than `
        + 'the server and should be softened — which is the good direction, and still a drift.');
    }
    assert.match(de.infer4, /Handlung, der Familienkreis und das Gerät in einer Zeile/,
      'the German no longer states that the three stand in ONE line');
    assert.match(en.infer4, /the action, the circle and the device in one line/,
      'the English no longer states it');
  });

  test('§3 · infer4 — `renameSpace` is real, and it is the example the screen chose', () => {
    // The sharpest of the 24 precisely because the relay stores no name: nothing is retained and
    // the event is still legible. If the verb goes, the example must go with it.
    assert.ok(ROUTE_NAMES.includes('renameSpace'),
      'the screen uses renaming as its worked example and the route no longer exists');
    assert.match(de.infer4, /Umbenennen/, 'the German example is gone');
    assert.match(en.infer4, /Renaming/, 'the English example is gone');
  });

  test('§4 · infer3 — exactly THREE rate rules are keyed to a member, and the screen says three', () => {
    const memberKeyed = Object.entries(RATE_RULES)
      .filter(([, r]) => r && r.identity === 'member')
      .map(([k]) => k)
      .sort();
    assert.deepEqual(memberKeyed, ['epochRotate', 'memberRemove', 'pairSession'],
      `the member-keyed rate rules are now ${JSON.stringify(memberKeyed)}. Each one is a row that `
      + 'says "this member did this" rather than "something came from this address", and each is '
      + 'kept for ever. Adding one is a real privacy change and DATENSCHUTZ.*.infer3 must name it.');
    // Case-insensitive: German capitalises a numeral that opens a sentence, and „Drei der Zeilen"
    // is exactly where this one sits.
    assert.ok(de.infer3.toLowerCase().includes(DE_NUMERAL[memberKeyed.length]),
      `the German screen does not say „${DE_NUMERAL[memberKeyed.length]}": ${JSON.stringify(de.infer3)}`);
    assert.ok(en.infer3.toLowerCase().includes(EN_NUMERAL[memberKeyed.length]),
      `the English screen does not say "${EN_NUMERAL[memberKeyed.length]}"`);
    // And the screen names all three ACTS, not merely the count — a count alone is not informed.
    assert.match(de.infer3, /entfernen[\s\S]{0,80}koppeln[\s\S]{0,80}Schlüssel/,
      'the German names fewer than the three acts: removing, pairing, rotating');
    assert.match(en.infer3, /removing a member[\s\S]{0,80}pairing a device[\s\S]{0,80}keys/,
      'the English names fewer than the three acts');
  });

  test('§5 · infer1 — the four admin tells the screen counts all still exist', () => {
    // „auf vier Wegen" — joinedAt ordering, Invite.createdBy, a member-identified removal row,
    // and the transfer in the request log. The first two are schema columns and are checked as
    // text because Prisma is not importable here; the last two are enum members and are checked
    // as enum members, which is the stronger check where it is available.
    assert.ok(ROUTE_NAMES.includes('transferAdmin'),
      'the screen counts the seat transfer as one of the four tells and the route is gone');
    assert.ok(RATE_RULES.memberRemove && RATE_RULES.memberRemove.identity === 'member',
      'the removal row is no longer made out to a member — then infer1 over-states, by one way');
    assert.match(de.infer1, /vier Wegen/, 'the German no longer counts four');
    assert.match(en.infer1, /four ways/, 'the English no longer counts four');
  });

  test('§6 · both languages carry all six disclosures, and neither is a stub', () => {
    for (const key of ['infer1', 'infer2', 'infer3', 'infer4', 'infer5', 'inferIp']) {
      for (const [lang, table] of [['de', de], ['en', en]]) {
        const v = table[key];
        assert.equal(typeof v, 'string', `${lang}.${key} is not a string`);
        assert.ok(v.length > 200,
          `${lang}.${key} is ${v.length} characters — a disclosure that short has lost its `
          + 'mechanism, and a disclosure without its mechanism is marketing with a minus sign');
      }
    }
  });

  test('§7 · F5(d) — the content claim is scoped to the ENTRY and the log is named beside it', () => {
    // The false sentence was „…lässt sich ablesen, DASS jemand etwas geändert hat — nicht, was."
    // full stop. It is false because `route` is a closed enum of 24 verbs riding in the same line
    // as `spaceId` and `deviceShort`: the relay knows exactly WHICH act it was. The repair has two
    // halves and both are load-bearing — narrowing the denial to the entry's CONTENT, and then
    // stating the thing that is not denied. Half a repair reads as a hedge.
    assert.match(de.seesNotBody, /nicht, was in dem Eintrag steht/,
      'the German content denial is unscoped again — it must be about what is IN THE ENTRY, because '
      + 'WHICH ACTION it was is recorded in full');
    assert.match(en.seesNotBody, /never what the entry says/,
      'the English content denial is unscoped again');

    // And the second half: the log, named, with the enum's own character stated.
    assert.match(de.seesNotBody, /Anfrageprotokoll[\s\S]{0,80}WELCHE Handlung es war/,
      'the German no longer names the request log as recording WHICH action it was');
    assert.match(en.seesNotBody, /request log[\s\S]{0,80}WHICH action it was/,
      'the English no longer names it');

    // The four worked examples are real routes, not illustrative invention.
    for (const r of ['removeMember', 'transferAdmin', 'renameSpace']) {
      assert.ok(ROUTE_NAMES.includes(r), `the screen's example "${r}" is not a route`);
    }
  });
});
