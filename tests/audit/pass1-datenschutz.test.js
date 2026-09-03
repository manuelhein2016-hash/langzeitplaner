// AUDIT · PASS 1 — the Datenschutz screen, sentence by sentence, against the code.
//
// READ-ONLY AUDIT ARTEFACT. This file fixes nothing and asks for nothing to be fixed. Every row
// below MEASURES a fact and names the sentence in `src/js/settings.js#DATENSCHUTZ` that the fact
// bears on. A green run here is not "the screen is fine"; it is "these measurements are what the
// verdict table cites, and you can re-run them".
//
// Run:  node --test --import ./tests/helpers/dev-flag.mjs "tests/audit/*.test.js"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DATENSCHUTZ } from '../../src/js/settings.js';
import { canSend, feedbackPort } from '../../src/js/feedback/port.js';
import { COPY_TABLES } from '../../src/js/feedback/copy.js';
import { LOG_FIELDS, LOG_ROUTES } from '../../server/core/limits.js';
import { ROUTE_NAMES } from '../../server/core/router.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const DE = DATENSCHUTZ.de;
const EN = DATENSCHUTZ.en;
const COPY_DE = COPY_TABLES.de;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §A · „Genau eine Ausnahme gibt es … die Rückmeldung unter ‚Hilfe‘."
//      The sentence is scoped to a Mac with no Familienkreis. On that Mac the exception cannot
//      happen: nothing binds the sender.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§A1 · the sentence exists and is scoped to a Mac with no Familienkreis', () => {
  assert.match(DE.soloBody, /Solange du keinen Familienkreis nutzt/);
  assert.match(DE.soloBody, /Genau eine Ausnahme gibt es, und sie geschieht nur, wenn du sie auslöst/);
  assert.match(DE.soloBody, /die Rückmeldung unter/);
  assert.match(EN.soloBody, /There is\s+exactly one exception, and it happens only when you trigger it/);
});

test('§A2 · MEASURED — a freshly imported feedback port cannot send. `canSend()` is false and there is no port', () => {
  // This is the state of the module on every launch before somebody calls `setFeedbackPort`.
  assert.equal(feedbackPort(), null);
  assert.equal(canSend(), false);
});

test('§A3 · MEASURED — exactly ONE shipped module calls `setFeedbackPort`, and it is family/mount.js', () => {
  const hits = [];
  for (const f of shippedJs()) {
    if (/\bsetFeedbackPort\s*\(/.test(stripComments(f.src))) hits.push(f.rel);
  }
  // port.js declares it; mount.js calls it.
  assert.deepEqual(hits.sort(), ['src/js/family/mount.js', 'src/js/feedback/port.js']);
});

test('§A4 · MEASURED — family/mount.js is behind main.js\'s ONE dynamic door, and both gates require a space', () => {
  const main = read('src/js/main.js');
  const doors = [...main.matchAll(/import\(\s*['"]\.\/family\/mount\.js['"]\s*\)/g)];
  assert.equal(doors.length, 1, 'main.js should hold exactly one dynamic import of family/mount.js');

  // No other shipped module imports family/mount.js at all.
  const importers = shippedJs()
    .filter((f) => f.rel !== 'src/js/main.js' && /family\/mount\.js/.test(stripComments(f.src)))
    .map((f) => f.rel);
  assert.deepEqual(importers, [], `family/mount.js is reachable from ${importers.join(', ')}`);

  // GATE 1 (`armFamilyMode`): personal space required.
  assert.match(main, /const hasPersonal = !!\(settings\.syncEnabled && settings\.personalSpaceId\);/);
  assert.match(main, /const hasCircle = typeof settings\.familySpaceId === 'string' && settings\.familySpaceId\.startsWith\('fsp_'\);/);
  assert.match(main, /if \(!hasPersonal && !hasCircle\) return;/);

  // GATE 2 (`mountCircleIfMember`): family space required.
  assert.match(main, /if \(!s \|\| typeof s\.familySpaceId !== 'string' \|\| !s\.familySpaceId\.startsWith\('fsp_'\)\) return;/);
});

test('§A5 · MEASURED — the binder is called only after a transport exists, never on a bare solo boot', () => {
  const mount = stripComments(read('src/js/family/mount.js'));
  const calls = [...mount.matchAll(/bindFeedback\s*\(/g)];
  // one declaration + two call sites
  assert.ok(calls.length >= 3, `expected a declaration and two call sites, saw ${calls.length}`);
  assert.match(mount, /bindFeedback\(handle\.parts, 'personal'\)/);
  assert.match(mount, /bindFeedback\(circleParts, 'family'\)/);
  // and the binder itself returns early without a transport
  assert.match(mount, /if \(!transport \|\| typeof transport\.request !== 'function'\) return;/);
});

test('§A6 · THE CONTRADICTION — the product ships a sentence that says the opposite, and it is the true one', () => {
  // `feedback/copy.js#noRelay` is what the Rückmeldung screen actually shows a solo Mac.
  assert.match(COPY_DE.noRelay, /Solange du keinen Familienkreis nutzt, gibt es keinen Server, an den etwas gehen könnte/);
  // The Datenschutz screen, on the same Mac, says an exception exists and is hers to trigger.
  assert.match(DE.soloBody, /Genau eine Ausnahme gibt es/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §B · „Etwa einmal täglich fragt die App-Hülle … bei GitHub nach."
//      Not in this tree: the manifest URL is a placeholder and the shell refuses on it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§B1 · MEASURED — the shipped shell refuses the update fetch on the placeholder, before any DNS', () => {
  const swift = read('shell-macos/main.swift');
  assert.match(swift, /let UPDATE_MANIFEST_URL\s*=\s*\n?\s*"https:\/\/github\.com\/OWNER-PLACEHOLDER\//);
  assert.match(swift, /guard !urlString\.contains\("OWNER-PLACEHOLDER"\) else \{/);
  // and no artefact could be installed even if it did resolve
  assert.match(swift, /let UPDATER_PUBLIC_KEY_B64 = ""/);
  // the sentence on the screen
  assert.match(DE.updateBody, /Etwa einmal täglich fragt die App-Hülle/);
  assert.match(DE.updateBody, /bei GitHub nach/);
});

test('§B2 · the same screen names two counterparts while the solo paragraph says there is exactly one exception', () => {
  assert.match(DE.soloBody, /Genau eine Ausnahme gibt es/);
  assert.match(DE.updateTitle, /Die zweite Gegenstelle/);
  // and the family paragraph says "one address and no other" three blocks before it
  assert.match(DE.familyBody, /mit einer einzigen Adresse .* und mit keiner weiteren/s);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §C · „ohne Passwort lesbar, auch bei einer Sicherung MIT Passwort."  — VERIFIED, and the
//      correcting sentence exists ONLY here; the file's own README does not carry it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§C1 · MEASURED on the bytes — `board` is plaintext on BOTH export paths', async () => {
  const { file: withPw, needle } = await exportedFile('audit-passphrase-12345');
  const { file: boardOnly } = await exportedFile(null);
  assert.ok(JSON.stringify(withPw).includes(needle), 'a WITH-password backup does not carry the entry in the clear');
  assert.ok(JSON.stringify(boardOnly).includes(needle), 'a board-only backup does not carry the entry in the clear');
  assert.ok(withPw.identity, 'the with-password file should carry a sealed identity block');
  assert.equal(boardOnly.identity, undefined);
  // the screen says exactly this
  assert.match(DE.backupBody, /ohne Passwort lesbar, auch bei einer Sicherung MIT Passwort/);
});

test('§C2 · the file\'s own README never says it, and the export sheet says the entries are „versiegelt"', async () => {
  const mod = await import('../../src/js/crypto/backup.js');
  const readmeDe = mod.README.withIdentity.de;
  assert.match(readmeDe, /DIES IST DEIN SCHLÜSSEL\. Wer diese Datei und dein Passwort hat, ist du\./);
  assert.equal(/lesbar|Klartext|im Klartext/.test(readmeDe), false,
    'the README inside the file now says the entries are readable — this row is stale');
  // the export sheet's own sentence, which a reader takes for encryption
  assert.match(mod.LIMITS.board.withIdentity.de, /Auch die Einträge in dieser Datei sind versiegelt/);
  assert.match(mod.LIMITS.board.withIdentity.de, /kann sie danach nicht mehr öffnen/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §D · „…und du keine Sicherung MIT Passwort hast, kann niemand deine Daten wiederherstellen."
//      A board-only backup restores the board. Measured through the real import.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§D1 · MEASURED — a board-only backup restores the entries, so the loss sentence over-states', async () => {
  const mod = await import('../../src/js/crypto/backup.js');
  const { memKeyStore } = await import('../../src/js/platform/keystore.js');
  const { file, needle } = await exportedFile(null);
  const out = await mod.importBackup(JSON.parse(JSON.stringify(file)), null, memKeyStore(), {
    app: '2.0.0', iterations: 1000,
  });
  const board = out && (out.board || (out.result && out.result.board));
  const text = JSON.stringify(board ?? out);
  assert.ok(text.includes(needle), 'the board-only import did not bring the entry back');
  // the sentence
  assert.match(DE.lossBody, /keine Sicherung mit Passwort hast, kann niemand deine Daten\s+wiederherstellen/);
  // and the product's own board-only README says the opposite, in the same tree
  assert.match(mod.README.boardOnly.de, /Sie stellt dein Board\s+wieder her/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §E · „Aus den Zeitpunkten und den gerundeten Größen lässt sich ablesen, DASS jemand etwas
//      geändert hat — nicht, was."  The relay's OWN application log records which verb.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§E1 · MEASURED — the log allowlist carries `route`, and `route` is a closed enum of named acts', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(LOG_FIELDS, 'route'));
  assert.ok(Object.prototype.hasOwnProperty.call(LOG_FIELDS, 'spaceId'));
  assert.ok(Object.prototype.hasOwnProperty.call(LOG_FIELDS, 'deviceShort'));
  for (const verb of ['renameSpace', 'removeMember', 'transferAdmin', 'createInvite', 'leaveSpace', 'deleteSpace']) {
    assert.ok(LOG_ROUTES.includes(verb), `${verb} is not a loggable route name any more`);
  }
  // (route, spaceId, deviceShort) at a timestamp is therefore "this machine did THIS".
  assert.equal(ROUTE_NAMES.length, 24);
  assert.match(DE.seesNotBody, /DASS jemand etwas geändert hat — nicht, was/);
});

test('§E2 · MEASURED — the deployed adapter binds that log to the platform console by default', () => {
  const vercel = read('server/adapters/vercel.js');
  assert.match(vercel, /log: createLog\(sink \|\| \(\(line\) => console\.log\(line\)\)\)/);
});

test('§E3 · MEASURED — the retention paragraph names only the IP half of `RateBucket.key`', () => {
  assert.match(DE.retentionBody, /Die Zeilen, mit denen\s+Missbrauch gebremst wird, enthalten eine IP-Adresse/);
  // but the limiter table also keys rules on a MEMBER, and those rows name the actor and the act.
  const limits = read('server/core/limits.js');
  assert.match(limits, /identity: 'member'/);
  assert.match(limits, /memberRemovePerMemberHour/);
  // and nothing on the screen says a member-keyed row exists.
  const whole = JSON.stringify(DE);
  assert.equal(/Mitglied.*gespeichert.*welche Handlung/s.test(whole), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §F · What `docs/v2/server-metadata.md` §7 says a Datenschutz page written only from the column
//      tables would miss — and which of those five the shipped page carries. Answer: none.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§F1 · MEASURED — none of server-metadata §7\'s five dump-level disclosures is on the screen', () => {
  const meta = read('docs/v2/server-metadata.md');
  assert.match(meta, /Five things the tables above imply and never say out loud/);
  assert.match(meta, /a Datenschutz page written only from the column\s+tables would miss every one of them/);
  assert.match(meta, /The relay can tell which member is admin/);

  const screen = `${JSON.stringify(DE)}\n${JSON.stringify(EN)}`;
  const missing = [];
  if (!/[Aa]dmin/.test(screen)) missing.push('1 · which member is admin');
  if (!/Zeitzone|time zone/i.test(screen)) missing.push('2 · time-zone inference from the activity window');
  if (!/welche Handlung|which action|per-member action/i.test(screen)) missing.push('3 · member-keyed limiter rows name the actor');
  if (!/Ereignis|event feed|Vorgang/i.test(screen)) missing.push('4 · the application log names the act');
  if (!/beide Kreise|cross-space|zwei Kreise|two circles/i.test(screen)) missing.push('5 · cross-space correlation to one person');
  assert.deepEqual(missing.length, 5,
    `expected all five absent; the ones actually absent were:\n  ${missing.join('\n  ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every `.js` the product ships to a WebView. */
function shippedJs(root = 'src/js') {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push({ rel, src: read(rel) });
    }
  };
  walk(root);
  return out;
}

/** Blank line and block comments so a name in prose is not a call site. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** A real export through the shipped `exportBackup`, with one recognisable German entry in it. */
async function exportedFile(passphrase) {
  const backup = await import('../../src/js/crypto/backup.js');
  const identity = await import('../../src/js/crypto/identity.js');
  const { memKeyStore } = await import('../../src/js/platform/keystore.js');
  const ids = await import('../../src/js/core/ids.js');
  const S = globalThis.crypto.subtle;
  const DAY = '2026-08-27';

  const ks = memKeyStore();
  const memberId = ids.memberId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const minted = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, {
    deviceId: ids.deviceId(), createdAt: DAY,
  });
  const id = { ...minted.identity, recSig: rec.recSig, recKex: rec.recKex };
  const aes = () => S.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const spaces = {
    personal: { id: ids.spaceId('personal'), epochs: new Map([[1, await aes()]]) },
  };

  const needle = 'Scheidungsanwältin Dr. Kübler 14:30';
  const board = {
    schemaVersion: 2,
    notes: [{
      id: 'n1', date: '2026-09-01', text: needle, categoryId: 'c1',
      repeatsYearly: false, visibility: 'privat', coEdit: false,
      uuid: 'n1', entityKey: 'note:n1', ownerId: memberId, isForeign: false,
    }],
    bars: [],
    categories: [{ id: 'c1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true }],
    scratchpads: {},
    settings: { bundesland: 'BY', language: 'de', rowHeight: 22 },
    _v2: { lineageId: 'lin_audit', gen: 1 },
  };

  const file = await backup.exportBackup(board, id, spaces, passphrase, {
    exportedAt: DAY, app: '2.0.0', iterations: 1000,
  });
  return { file, needle, memberId };
}
