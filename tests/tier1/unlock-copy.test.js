// ─────────────────────────────────────────────────────────────────────────────
// LZP-106 / LZP-107 — THE TWO SENTENCES THAT DECIDE WHETHER SHE GETS IN
//
// The unlock screen (src/js/firstrun.js, strings in src/js/i18n.js) is the only
// thing standing between a non-technical reader and an app macOS has just
// refused. Every other row about that screen tests its behaviour — that it is a
// screen and not a dialog, that Escape closes it, that focus is trapped. Those
// live in tests/tier2/firstrun-unlock.dom.js because they need a DOM.
//
// These two rows are different: they are about the WORDS, and the words carry
// two facts that were measured on a real artifact on 2026-09-04 (macOS 26.6.2,
// the ad-hoc-signed bundle decision D1 ships). Neither fact is guessable from
// reading the code, so neither survives an innocent copy edit unless something
// asserts it.
//
// ── §1 · THE ORDERING TRAP ───────────────────────────────────────────────────
// Measured: quarantine rides on the .dmg FILE, not on its contents.
//
//   xattr -p com.apple.quarantine  LangzeitPlaner.dmg        0083;…;Safari;<uuid>
//   …the same attribute on the MOUNTED volume root           (none)
//   …on the .app on the mounted image                        (none)
//   …on every file inside that .app (recursive find)         (none)
//   …on the copy after `cp -R` off the image                 0283;…;;<same uuid>
//
// So the app on the DMG and the app in Programme are two different objects as
// far as Gatekeeper is concerned. Somebody who opens it from the DMG window can
// see it work, drag it across afterwards, and meet the wall a second time on a
// copy she believes she has already unlocked — at which point the screen she was
// told would appear "once" has appeared twice and the instructions look wrong.
// One sentence in the lead prevents that.
//
// ── §2 · THE WORD „beschädigt“ ───────────────────────────────────────────────
// Under D1 the bundle is ad-hoc signed. Measured on the shipped .app:
//
//   codesign --verify              valid on disk, satisfies its Designated Requirement
//   codesign -dv                   Signature=adhoc, flags=0x2(adhoc)
//   spctl --assess --type execute  rejected  (rc=3)
//   syspolicy_check distribution   "Adhoc Signed App — Severity: Warning"
//                                  "Notary Ticket Missing — Severity: Fatal"
//
// A quarantined ad-hoc bundle can present as „ist beschädigt und kann nicht
// geöffnet werden“ — with a Papierkorb button, and sometimes with no „Dennoch
// öffnen“ at all. That exact wording could NOT be reproduced here (see the
// integration report: the launch path on this machine is exempted by its
// responsible process, so no local launch measures what her Mac would do). It is
// therefore an unverified possibility, not a known behaviour — but the asymmetry
// is total: one sentence against her trashing the app. The rows below keep the
// sentence, and this comment keeps it honest about why it is there.
//
// TIER: 1. Pure string assertions over the real i18n table; no DOM needed.
// ─────────────────────────────────────────────────────────────────────────────

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { t, setLang } from '../../src/js/i18n.js';

/** Read one key in one language without leaking the language into later rows. */
const inLang = (lang, key) => {
  setLang(lang);
  const v = t(key);
  setLang('de');
  return v;
};

describe('LZP-106 · the unlock copy carries what was measured', () => {
  // ── §1 · the ordering trap ─────────────────────────────────────────────────
  test('§1a · DE — the lead names the ORDER: into Programme first, open second', () => {
    const lead = inLang('de', 'unlockLead');
    assert.match(lead, /Reihenfolge/,
      'the lead must say that the order matters at all — without the word, the two clauses '
      + 'below read as description rather than instruction');
    assert.match(lead, /Programme/,
      'it must name the destination folder she is meant to drag into');
    assert.ok(/erst\b/.test(lead) && /dann\b/.test(lead),
      'and it must be sequenced ("erst … dann"), because the whole finding is that doing these '
      + `two things in the other order costs her a second unlock. Got: ${JSON.stringify(lead)}`);
  });

  test('§1b · EN — the same order, in the same place', () => {
    const lead = inLang('en', 'unlockLead');
    assert.match(lead, /order/i, 'the English lead must name the order too');
    assert.match(lead, /Applications/,
      'and the English destination folder is "Applications", not "Programme" — macOS localises '
      + 'that folder name itself, so the copy has to follow it');
    assert.ok(/first/i.test(lead) && /then/i.test(lead),
      `sequenced in English as well. Got: ${JSON.stringify(lead)}`);
  });

  // ── §2 · the word „beschädigt“ ─────────────────────────────────────────────
  test('§2a · DE — the note names „beschädigt“ AND tells her not to trash it', () => {
    const note = inLang('de', 'unlockNote');
    assert.match(note, /beschädigt/,
      'the note must name the other wording macOS can use for this same block. If it only ever '
      + 'names the "Apple konnte nicht überprüfen" alert, a reader who meets „beschädigt“ has '
      + 'been told her situation is not covered here.');
    assert.match(note, /Papierkorb/,
      'and it must name the Papierkorb explicitly — that is the button she would otherwise press, '
      + 'and pressing it is the one unrecoverable outcome on this screen');
    // The pre-existing recovery sentence must survive the addition. tier-2's
    // "the recovery for the missing button" row asserts this too; duplicated
    // here so that an edit made in this file cannot quietly drop it.
    assert.match(note, /Dennoch öffnen/,
      'the original "no Open Anyway button" recovery must still be in the note');
  });

  test('§2b · EN — the twin says "damaged" and "Trash"', () => {
    const note = inLang('en', 'unlockNote');
    assert.match(note, /damaged/i, 'the English note names the other wording');
    assert.match(note, /Trash/i, 'and names the button not to press');
    assert.match(note, /Open Anyway/, 'and keeps the original recovery sentence');
  });

  // ── §3 · both languages, one shape ─────────────────────────────────────────
  // German-first, both languages: a fix landed in one table and forgotten in the
  // other is the failure mode this project has hit before.
  test('§3 · neither sentence exists in only one language', () => {
    for (const key of ['unlockLead', 'unlockNote']) {
      const de = inLang('de', key);
      const en = inLang('en', key);
      assert.notEqual(de, en, `${key} is untranslated — the English table still holds the German`);
      assert.ok(de.length > 80 && en.length > 80,
        `${key} is too short in one language to carry what was added (de ${de.length}, en ${en.length})`);
    }
  });
});
