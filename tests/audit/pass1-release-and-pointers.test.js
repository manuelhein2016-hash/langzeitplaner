// AUDIT · PASS 1 — the release surface, and four pointers that lead a reader nowhere.
//
// READ-ONLY AUDIT ARTEFACT. Nothing here is a fix. Each row measures a fact the verdict table
// cites. The §L rows are the ones that decide whether the shipped binary can join a family at all.
//
// Run:  node --test --import ./tests/helpers/dev-flag.mjs tests/audit/pass1-release-and-pointers.test.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DATENSCHUTZ } from '../../src/js/settings.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §L · `SYNC_ORIGIN_BUILTIN` is `""` in BOTH shells, and no release gate names it.
//      A build made by working `RELEASE-CHECKLIST.md` §A top to bottom refuses every
//      `sync_request` locally, so no Familienkreis functions — and the SERVERADRESSE line the
//      same checklist makes the PO substitute is read by nothing.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§L1 · MEASURED — both shells ship an empty sync origin, and it is the ONLY source outside a headless run', () => {
  const swift = read('shell-macos/main.swift');
  assert.match(swift, /let SYNC_ORIGIN_BUILTIN = ""/);
  // the resolver: two headless-only overrides, then the constant. No production path.
  assert.match(swift, /func syncOriginSetting\(\) -> String \{[\s\S]*?return SYNC_ORIGIN_BUILTIN\s*\n\}/);
  assert.match(swift, /if isHeadless, let o = argValue\("--sync-origin"\) \{ return o \}/);
  assert.match(swift, /if isHeadless, let e = ProcessInfo\.processInfo\.environment\["LZP_SYNC_ORIGIN"\]/);

  const rust = read('src-tauri/src/lib.rs');
  assert.match(rust, /const SYNC_ORIGIN_BUILTIN: &str = "";/);
});

test('§L2 · MEASURED — RELEASE-CHECKLIST.md names UPDATE_MANIFEST_URL and NOT the sync origin', () => {
  const cl = read('docs/v2/RELEASE-CHECKLIST.md');
  assert.match(cl, /`shell-macos\/main\.swift`'s `UPDATE_MANIFEST_URL` no longer says `OWNER-PLACEHOLDER`/);
  assert.equal(/SYNC_ORIGIN/.test(cl), false,
    'the checklist now names SYNC_ORIGIN_BUILTIN — this measurement is stale and the gap is closed');
  // it does make the PO substitute the relay address into the four mails…
  assert.match(cl, /The relay address in the four invitation files is the REAL one/);
});

test('§L3 · MEASURED — V2-FINAL R-9b\'s "two deployment lines nobody can write from here" omits it', () => {
  const v2f = read('docs/v2/V2-FINAL.md');
  assert.match(v2f, /### R-9b · Two deployment lines nobody can write from here/);
  assert.match(v2f, /A production `feedbackSink`/);
  assert.match(v2f, /The real relay origin, substituted into the four invitation files/);
  assert.equal(/SYNC_ORIGIN/.test(v2f), false,
    'V2-FINAL now names SYNC_ORIGIN_BUILTIN — this measurement is stale');
});

test('§L4 · …while three other documents DO carry it as open, so the fact is known', () => {
  assert.match(read('docs/v2/SHELL-VERIFICATION.md'),
    /`SYNC_ORIGIN_BUILTIN` is still `""`, so every shipped build refuses locally/);
  assert.match(read('docs/v2/SHELL-VERIFICATION.md'), /\*\*`SYNC_ORIGIN_BUILTIN`\*\* — still `""`/);
  assert.match(read('docs/v2/STATUS.md'), /`SYNC_ORIGIN_BUILTIN` is still `""`/);
  assert.match(read('docs/v2/FINDINGS.md'), /\*\*`SYNC_ORIGIN_BUILTIN` is `""`\*\*/);
});

test('§L5 · the Datenschutz says the address is the one entered at join; the shell reads only build config', () => {
  assert.match(DATENSCHUTZ.de.familyBody,
    /mit einer einzigen Adresse — der Vermittlungsstelle, die beim\s+Beitreten eingetragen wurde/);
  assert.match(DATENSCHUTZ.en.familyBody, /a single address — the relay entered when you joined/);
  // and the shell's own note on where the origin comes from
  assert.match(read('shell-macos/main.swift'),
    /it is shell configuration, never a page parameter/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §M · A correction that landed in the document and not in the code comment it corrects.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§M1 · MEASURED — store.js still says "No shipped circle transfers the seat yet"; V2-FINAL R-1b says that is wrong', () => {
  const store = read('src/js/store.js');
  assert.match(store, /No shipped circle\s*\n\s*\* transfers the seat yet\./);
  const v2f = read('docs/v2/V2-FINAL.md');
  assert.match(v2f, /\*\*The previous issue of this list said „no shipped circle transfers the seat yet"\. That was\s+wrong:\*\*/);
  // and the two call sites the correction names are real
  assert.match(read('src/js/family/adminpanel.js'), /async transferAdmin\(memberId\) \{/);
  assert.match(read('src/js/family/leavedelete.js'), /await port\.transferAdmin\(member\.memberId\);/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §N · Two pointers that resolve to nothing.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§N1 · MEASURED — V2-FINAL §8 cites `tests/attack/attack-relay-ordering.test.js`; the file is under tests/server/', () => {
  assert.match(read('docs/v2/V2-FINAL.md'), /`tests\/attack\/attack-relay-ordering\.test\.js` §6/);
  assert.equal(exists('tests/attack/attack-relay-ordering.test.js'), false);
  assert.equal(exists('tests/server/attack-relay-ordering.test.js'), true);
});

test('§N2 · MEASURED — ADR 003 §6.2 names `tests/server/log-redaction.test.js`, which does not exist', () => {
  assert.match(read('docs/v2/adr/003-sync-protocol.md'),
    /`tests\/server\/log-redaction\.test\.js` greps the log\s+serialiser/);
  assert.equal(exists('tests/server/log-redaction.test.js'), false);
  // the property itself is held — one file over.
  assert.match(read('tests/server/blindness.test.js'),
    /import \{ LIMITS, createLog, LOG_FIELD_NAMES, LOG_FIELDS, LOG_ROUTES \} from '\.\.\/\.\.\/server\/core\/limits\.js';/);
  assert.match(read('tests/server/limits.test.js'), /LOG_FORBIDDEN/);
});

test('§N3 · and V2-FINAL\'s own §8 says that §6 is stale — measured: every claim now carries a witness', async () => {
  const { UNVERIFIED_CLAIMS } = await import('../../server/adapters/prisma.js');
  const without = UNVERIFIED_CLAIMS.filter((c) => !c.verifiedOn);
  assert.deepEqual(without.map((c) => c.tag), [],
    'a claim without a witness reappeared — §6\'s comment is true again');
  assert.match(read('tests/server/attack-relay-ordering.test.js'),
    /nothing in this repository can\s*\n?\s*\/\/ execute it/);
});
