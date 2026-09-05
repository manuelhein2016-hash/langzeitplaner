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
  3: 'drei', 4: 'vier', 5: 'fünf', 6: 'sechs',
  23: 'dreiundzwanzig', 24: 'vierundzwanzig', 25: 'fünfundzwanzig',
  26: 'sechsundzwanzig', 27: 'siebenundzwanzig', 28: 'achtundzwanzig',
});
const EN_NUMERAL = Object.freeze({
  3: 'three', 4: 'four', 5: 'five', 6: 'six',
  23: 'twenty-three', 24: 'twenty-four', 25: 'twenty-five',
  26: 'twenty-six', 27: 'twenty-seven', 28: 'twenty-eight',
});

const de = DATENSCHUTZ.de;
const en = DATENSCHUTZ.en;

describe('the Datenschutz screen agrees with the live server enums', () => {
  test('§1 · infer4 — the route enum\'s SIZE is the number on the screen, in both languages', () => {
    // ─────────────────────────────────────────────────────────────────────────────────────────
    // ██ THE REVIEW TRIGGER FIRED, AND THIS IS THE REVIEW · 2026-09-05 · LZP-1009 second pass ██
    // ─────────────────────────────────────────────────────────────────────────────────────────
    //
    // The number below was 24. The message this row carries calls itself a REVIEW TRIGGER and
    // asks, of every new verb, "is it as telling as `renameSpace`?" — so it is answered here
    // rather than bumped, which is the whole difference between honouring the row and defeating
    // it. The three new verbs are the operator's reports routes:
    //
    //   · `reportsList`    GET  /api/v1/feedback
    //   · `reportsGet`     GET  /api/v1/feedback/:id
    //   · `reportsDelete`  POST /api/v1/feedback/:id/delete
    //
    // ARE THEY AS TELLING AS `renameSpace`? **No, and for a structural reason, not a careful one.**
    // `renameSpace` is telling because the log line carries `spaceId` and `deviceShort` beside the
    // verb: it says THIS member did THIS to THIS circle. None of the three above carries either.
    // They have no `spaceParam` (`router.js`), they are not in `SPACE_SCOPED`, and their rate
    // rules are `identity:'ip'` (`limits.js` E10-L4/E10-L5) — so the log line reads "somebody at
    // some address read the operator's inbox", and the only person who can produce one is the
    // holder of the private half of `LZP_REPORTS_ADMIN_PUB`, which is the operator himself.
    // Their presence in the enum widens the count; it does not widen what the enum can say about
    // a family.
    //
    // ⚠ WHAT IS GENUINELY NEW IS NOT IN THIS ROW. It is `Report.devicePub`: on a SIGNED report it
    // is byte-identical to `Device.sigPubRaw`, so a retained report joins to a circle and one join
    // names the member, her circle and her household. That is a sixth inference, it is stated in
    // `docs/v2/server-metadata.md` §7 and on the screen, and it is checked by §7 below. Bumping
    // this count without adding that disclosure would have been exactly the drift F12 found.
    const n = ROUTE_NAMES.length;
    assert.equal(n, 27,
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

  test('§6 · both languages carry all seven disclosures, and neither is a stub', () => {
    // Was six. `infer6` — the report/device join — is the seventh entry and the sixth INFERENCE;
    // `inferIp` has never been one of the numbered five and still is not.
    for (const key of ['infer1', 'infer2', 'infer3', 'infer4', 'infer5', 'infer6', 'inferIp']) {
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

  test('§8 · infer6 — the retained report joins to a circle, and BOTH halves are on the screen', () => {
    // ─────────────────────────────────────────────────────────────────────────────────────────
    // LZP-1009 SECOND PASS · 2026-09-05 · the SIXTH inference, and the reason §1's count moved.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    //
    // THE FACT: `Report.devicePub` on a SIGNED report is the raw uncompressed P-256 point — the
    // same bytes `Device.sigPubRaw` already holds for that device, because it has to be, or the
    // signature could not be checked. So `SELECT … FROM Report JOIN Device ON …` names the
    // member, and the member names the circle, and the circle names the household. Nothing is
    // decrypted and nothing is guessed.
    //
    // THIS ROW IS NOT A GREP FOR THE WORD „90". It requires both halves of the disclosure,
    // because half of it is a scare and the other half alone is a footnote:
    //   (a) the join — the same key, in two places, deliberately;
    //   (b) the limit — an UNSIGNED report carries no key at all, which is the honest shape of a
    //       solo send and the thing that makes (a) a bounded claim rather than a general one.
    //
    // ⚠ AND IT IS NOT DEFENDED AGAINST. The operator is the intended reader of the report; a
    // report he cannot attribute is a report he cannot answer. §5b of `e13-datenschutz.dom.js`
    // holds the register — no mitigation clause — and this row holds the content.
    assert.match(de.infer6, /unterschrieben/, 'the German no longer says a family report is signed');
    assert.match(de.infer6, /derselbe, den die[\s\S]{0,60}Vermittlungsstelle für dein Gerät ohnehin gespeichert hat/,
      'the German no longer states the JOIN — that the key is the same key the relay already holds');
    assert.match(de.infer6, /Ohne Familienkreis gibt es[\s\S]{0,40}keine Unterschrift/,
      'the German no longer states the limit: an unsigned report carries no key');
    assert.match(de.infer6, /90 Tagen/, 'the German no longer names the retention');

    assert.match(en.infer6, /signed/, 'the English no longer says a family report is signed');
    assert.match(en.infer6, /the very one the relay already stores[\s\S]{0,40}for your device/,
      'the English no longer states the join');
    assert.match(en.infer6, /Without a Familienkreis there is no[\s\S]{0,20}signature/,
      'the English no longer states the limit');
    assert.match(en.infer6, /90[\s\S]{0,10}days/, 'the English no longer names the retention');

    // The lead counts the inferences and must count them right — the old „fünf Dinge" would now
    // be a screen that names six and promises five.
    assert.match(de.inferLead, /sechs Dinge/, 'the German lead no longer counts six');
    assert.match(en.inferLead, /six things/, 'the English lead no longer counts six');
  });

  test('§9 · retention — the 90 days reach the copy, and the unbounded claim is SCOPED', () => {
    // `retentionBody` said, verbatim: „Ehrlich: unbefristet. Es gibt keine automatische Löschung."
    // `Report.expiresAt` and `store-interface.js#REPORT_RETENTION_DAYS = 90` make the second
    // sentence false. It is not softened and it is not deleted — the rate rows and the change
    // rows really are unbounded, and that is the harsher half. It is SCOPED, and the exception
    // carries its number.
    for (const [lang, body, unbounded, ninety, byHand] of [
      ['de', de.retentionBody, /für fast alles unbefristet/, /90 Tagen automatisch gelöscht/, /von Hand/],
      ['en', en.retentionBody, /for almost everything, indefinitely/, /automatically after\s+90 days/, /by hand/],
    ]) {
      assert.match(body, unbounded, `${lang}: the unbounded claim has been dropped rather than scoped`);
      assert.match(body, ninety, `${lang}: retentionBody does not name the 90-day expiry`);
      assert.match(body, byHand, `${lang}: the manual half of retention is no longer mentioned`);
      assert.equal(/Es gibt keine automatische Löschung|There is no automatic deletion/.test(body), false,
        `${lang}: the flat "there is no automatic deletion" sentence is back, and Report.expiresAt `
        + 'makes it false');
    }
    // …and the feedback paragraph says the report is KEPT, not merely readable in transit.
    assert.match(de.feedbackBody, /gespeichert[\s\S]{0,120}90 Tagen/,
      'the German feedback paragraph still describes only the journey, not the storage');
    assert.match(en.feedbackBody, /stored[\s\S]{0,120}90\s*\n?\s*days|stored[\s\S]{0,120}90 '\s*\+\s*'days/,
      'the English feedback paragraph still describes only the journey, not the storage');
    // …and the solo paragraph no longer claims „Senden" is off without a Familienkreis.
    assert.equal(/„Senden" ist\s+abgeschaltet|"Send" is switched off/.test(de.soloBody + en.soloBody), false,
      'the solo paragraph still says „Senden" is switched off — the PO reversed that on 2026-09-04');
  });
});
