// tests/audit/synthesis-reconciliation.test.js — THE SYNTHESIS PASS'S OWN ADJUDICATIONS.
//
// Five audit passes reported independently and disagreed in four places. This file pins the
// facts I measured to settle those disagreements, plus the load-bearing claims I re-verified
// rather than inherited. It is the evidence behind `docs/v2/AUDIT.md`.
//
// EVERY ROW HERE IS WRITTEN TO GO **RED THE DAY THE FINDING IS FIXED**. A green run means the
// defects below are all still present. That is deliberate and it is the same convention the
// pass-1 and pass-5 files use: an audit row asserts what IS, so that a repair is visible as a
// change in this file rather than as a silent drift in prose.
//
// It fixes NOTHING and it edits nothing. Read-only over the tree at 92545df.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const has = (p) => existsSync(join(REPO, p));

// ═══════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE RELEASE BLOCKER NO GATE NAMES
//
// `syncOriginSetting()` has three sources; two are `isHeadless`-only, so a SHIPPED build reads
// `SYNC_ORIGIN_BUILTIN` and nothing else. It is the empty string in both shells, and the empty
// string cannot normalise to an https origin — so `sync_request` refuses every call locally and
// no Familienkreis can sync. The two documents a releaser actually works from never name it.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · SYNC_ORIGIN_BUILTIN — empty in both shells, named by no release gate', () => {
  test('§1a · both shells ship an empty built-in sync origin', () => {
    assert.match(read('shell-macos/main.swift'), /let SYNC_ORIGIN_BUILTIN = ""/,
      'the Swift shell no longer ships an empty origin — re-check §1c');
    assert.match(read('src-tauri/src/lib.rs'), /const SYNC_ORIGIN_BUILTIN: &str = "";/,
      'the Rust shell no longer ships an empty origin — re-check §1c');
  });

  test('§1b · the two headless overrides cannot help a shipped build', () => {
    const swift = read('shell-macos/main.swift');
    const fn = swift.slice(swift.indexOf('func syncOriginSetting()'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // Both overrides are gated on `isHeadless`. A production launch is not headless.
    const overrides = body.match(/if isHeadless/g) || [];
    assert.equal(overrides.length, 2,
      'syncOriginSetting no longer has exactly two isHeadless-gated overrides');
    assert.match(body, /return SYNC_ORIGIN_BUILTIN/,
      'the non-headless fall-through is no longer the built-in constant');
  });

  test('§1c · BLOCKING · no release gate names the constant a releaser must substitute', () => {
    for (const doc of ['docs/v2/RELEASE-CHECKLIST.md', 'docs/v2/V2-FINAL.md']) {
      assert.equal(read(doc).includes('SYNC_ORIGIN_BUILTIN'), false,
        `${doc} now names SYNC_ORIGIN_BUILTIN — the blocker in AUDIT.md §F1 is fixed, `
        + 'delete this row');
    }
    // …while it does force the PO to substitute the relay address the page will never read.
    assert.match(read('docs/v2/RELEASE-CHECKLIST.md'), /SERVERADRESSE|relay|Vermittlungsstelle/i,
      'the checklist no longer mentions a relay address at all');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE DATENSCHUTZ SCREEN — THREE FALSE SENTENCES, ONE SCREEN
//
// 21.3's entire job is that trust is informed rather than marketed. Measured against the code
// the same repository ships, three of its sentences are false and two of them contradict copy
// in OTHER shipped modules — so the product states both the true and the false version.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · the Datenschutz screen contradicts the product', () => {
  const settings = () => read('src/js/settings.js');

  test('§2a · the solo Mac is promised an exception it cannot take', () => {
    assert.match(settings(), /Genau eine Ausnahme gibt es/,
      'soloBody no longer promises exactly one exception');
    // The exception is the feedback sender. Its port is armed from exactly one module…
    const callers = ['src/js/family/mount.js', 'src/js/feedback/port.js'];
    for (const f of callers) assert.ok(has(f), `${f} is gone`);
    assert.match(read('src/js/family/mount.js'), /setFeedbackPort\(\{/,
      'family/mount.js no longer arms the feedback port');
    // …and that module is behind a door a solo Mac never opens.
    assert.match(read('src/js/main.js'), /if \(!hasPersonal && !hasCircle\) return;/,
      'the family door gate changed shape — re-verify that a solo Mac still never mounts it');
  });

  test('§2b · the product ships the TRUE version of the same sentence, one module over', () => {
    assert.match(read('src/js/feedback/copy.js'),
      /gibt es \s*'\s*\+\s*'keinen Server, an den etwas gehen könnte|keinen Server, an den etwas gehen könnte/,
      'feedback/copy.js#noRelay no longer says a solo Mac knows no relay');
  });

  test('§2c · „nicht, was" — but the application log names the verb', async () => {
    const { ROUTE_NAMES } = await import('../../server/core/router.js');
    const { LOG_FIELDS } = await import('../../server/core/limits.js');
    assert.match(settings(), /lässt sich ablesen, DASS jemand etwas geändert hat — nicht, was/,
      'seesNotBody no longer makes the „not what" claim');
    // route + spaceId + deviceShort are allowed in the SAME log line…
    for (const f of ['route', 'spaceId', 'deviceShort']) {
      assert.ok(Object.hasOwn(LOG_FIELDS, f), `LOG_FIELDS no longer allows ${f}`);
    }
    // …and `route` is a closed enum of verbs that name the act.
    for (const verb of ['removeMember', 'transferAdmin', 'renameSpace', 'deleteSpace']) {
      assert.ok(ROUTE_NAMES.includes(verb), `${verb} is no longer a route name`);
    }
  });

  test('§2d · a board-only backup DOES restore the board — lossBody says it cannot', () => {
    assert.match(settings(), /du keine Sicherung mit Passwort hast, kann niemand deine Daten/,
      'lossBody no longer conditions recovery on a PASSWORD-protected backup');
    // The README written INSIDE the passphrase-less export says the opposite, in the product.
    assert.match(read('src/js/crypto/backup.js'), /Sie stellt dein Board \s*'\s*\+\s*'wieder her|Sie stellt dein Board wieder her/,
      'README.boardOnly.de no longer promises the board is restored');
  });

  test('§2e · „Von allein sendet dieses Programm nichts" — boot arms a bare interval', () => {
    assert.match(settings(), /Von allein sendet dieses Programm nichts/,
      'soloBody no longer claims the program sends nothing of its own accord');
    const main = read('src/js/main.js');
    assert.match(main, /runLaunchCheck\(\);\s*\n\s*startDailyTimer\(\);/,
      'boot() no longer starts the launch check and the daily timer unconditionally');
    assert.match(read('src/js/update-ui.js'), /dailyTimer = setInterval\(/,
      'startDailyTimer is no longer a bare setInterval');
    // And the shell's own comment concedes the point the screen denies.
    assert.match(read('shell-macos/main.swift'),
      /The one network request in the whole product's solo mode/,
      'the shell no longer describes an update request in solo mode');
  });

  test('§2f · the 21.5 consent gates are checked BEFORE the placeholder refusal', () => {
    const swift = read('shell-macos/main.swift');
    const fn = swift.slice(swift.indexOf('func updaterFetchManifest('));
    const gate = fn.indexOf('prefs.disclosed, prefs.enabled');
    const placeholder = fn.indexOf('OWNER-PLACEHOLDER');
    assert.ok(gate > -1 && placeholder > -1, 'updaterFetchManifest changed shape');
    assert.ok(gate < placeholder,
      'the ordering changed — 21.5 is no longer vacuously true only because F22 is unconfigured');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE RECORD DISAGREES WITH THE TREE
//
// Four documentation claims a ship decision leans on, each measured against the code.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · release-record drift', () => {
  test('§3a · V2-FINAL §9 marks LZP-1009 NOT BUILT; the same file says it ships', () => {
    const v2 = read('docs/v2/V2-FINAL.md');
    assert.match(v2, /\| LZP-1009 \|.*\*\*NOT BUILT\*\* \|/,
      'the LZP-1009 row is no longer marked NOT BUILT');
    assert.match(v2, /LZP-1009 gives a solo Mac an outbound path/,
      'the contradicting sentence is gone');
    assert.ok(has('server/core/handlers/feedback.js'), 'the feedback handler is gone');
    assert.match(read('src/js/family/mount.js'), /bindFeedback|setFeedbackPort/,
      'the client half of LZP-1009 is gone');
  });

  test('§3b · R-7b says no join has crossed the bridge; a shipped-app row asserts one has', () => {
    assert.match(read('docs/v2/V2-FINAL.md'), /no join has ever run over the\n?`sync_request` bridge/,
      'R-7b no longer claims the join has never crossed the bridge');
    const e2e = read('tests/tier2/shell-family-e2e.dom.js');
    assert.match(e2e, /joins the circle by pasting the code — through the bridge/,
      'the join-over-bridge row is gone');
    assert.match(e2e, /invites\/redeem'\)\)/,
      'the row no longer asserts /invites/redeem crossed sync_request');
  });

  test('§3c · the route count is 24; three shipped comments and the metadata doc say 23', async () => {
    const { ROUTE_NAMES } = await import('../../server/core/router.js');
    assert.equal(ROUTE_NAMES.length, 24, 'the route count moved — re-check every "23" below');
    assert.ok(ROUTE_NAMES.includes('feedback'), 'feedback is no longer a route');
    assert.match(read('docs/v2/server-metadata.md'), /closed\n?\s*enum of 23 verbs/,
      'server-metadata.md no longer says 23 verbs');
  });

  test('§3d · the v1 oracle records filesChanged 0; git records three', () => {
    assert.match(read('docs/v2/traceability.json'), /"filesChanged": 0/,
      'the v1Oracle record no longer claims filesChanged 0');
    const changed = execFileSync('git', [
      'diff', '--name-only', '328c683', 'HEAD', '--',
      'tests/tier1/store-persistence.test.js', 'tests/tier2/dom-rendering.dom.js',
      'tests/tier1/storage.test.js',
    ], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert.equal(changed.length, 3,
      `expected the three known-edited oracle files, got ${JSON.stringify(changed)}`);
  });

  test('§3e · two documents still say the Datenschutz text is not in the product', () => {
    // It is: settings.js names Frankfurt, Vercel and Prisma in both languages.
    const s = read('src/js/settings.js');
    for (const w of ['Frankfurt', 'Vercel', 'Prisma']) {
      assert.ok(s.includes(w), `settings.js no longer names ${w}`);
    }
    assert.match(read('docs/v2/RELEASE-CHECKLIST.md'), /appear nowhere in `src\/`/,
      'the checklist row was corrected');
    assert.match(read('docs/v2/E10-VERIFICATION.md'), /appear \*\*nowhere in `src\/`\*\*/,
      'the E10 ticket-table row was corrected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE COMPACTION CLASS — WHY 5,612 GREEN ROWS CANNOT SEE IT
//
// Pass 2 found four defects that appear only after a quit-and-open. Pass 4 marked the same
// stories PASS. Both are right about what they ran: the rigs that own those stories never
// relaunch, and the shipped-app acceptance battery has no co-edit phase at all. This section
// pins the coverage hole rather than re-measuring the defects (compaction-sweep.test.js does).
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · the coverage hole that hid the compaction class', () => {
  const RIGS = [
    'e9-attack-coedit', 'e9-attack-moderation', 'e9-attack-restore', 'e6-removal',
    'e6-gate-removal', 'e6-attack-removed', 'e6-gate-privat', 'e10-fleet-board',
  ];

  test('§4a · every co-editor and removal rig builds a first install and never reopens it', () => {
    for (const rig of RIGS) {
      const p = `tests/fleet/${rig}.test.js`;
      assert.ok(has(p), `${p} is gone`);
      const src = read(p);
      assert.equal(/relaunch|quitAndOpen/.test(src), false,
        `${rig} now relaunches — the compaction class may be covered there; re-check AUDIT.md §F2`);
    }
  });

  test('§4b · the shipped-app acceptance battery has no co-edit phase', () => {
    const driver = read('scripts/shell-family-e2e.mjs');
    assert.equal(/applyCoEdit|coEdit/.test(driver), false,
      'the 27-launch driver now exercises co-editing — Finding A may be reachable there');
  });

  test('§4c · the genesis-only admin repair is still genesis-only (R-1b)', () => {
    const store = read('src/js/store.js');
    assert.match(store, /if \(cell\.author !== cell\.value\) return \[\];/,
      '_absorbedChainOps no longer restricts itself to genesis-shaped links');
    // And the seam still carries the sentence V2-FINAL R-1b retracted.
    assert.match(store, /No shipped circle\n?\s*\*? ?transfers the seat yet\./,
      'the retracted comment at the seam was corrected');
    assert.match(read('docs/v2/V2-FINAL.md'), /The previous issue said no circle transfers the seat\. It was wrong\./,
      'V2-FINAL no longer retracts it');
  });

  test('§4d · a co-edit refusal is terminal — noCoEdit is in neither recovery set', () => {
    const store = read('src/js/store.js');
    const curable = store.slice(store.indexOf('const CURABLE_REFUSALS'));
    const line = curable.slice(0, curable.indexOf('\n'));
    assert.equal(/NO_COEDIT|NOT_OWNER/.test(line), false,
      'noCoEdit / notOwner became curable — Findings A and C may now self-heal');
    assert.match(line, /NOT_MY_DEVICE.*UNATTESTED_DEVICE/,
      'CURABLE_REFUSALS changed membership');
  });

  test('§4e · 17.5 has no producer for the hooks its renderer needs', () => {
    const store = read('src/js/store.js');
    const proj = store.slice(store.indexOf('_project({ settings = false } = {})'));
    const call = proj.slice(0, proj.indexOf('});'));
    for (const hook of ['seqOf', 'isNew', 'lastSeenSeq', 'levelDecreased']) {
      assert.equal(call.includes(`${hook}:`), false,
        `_project() now supplies ${hook} — 17.5 may render; re-check AUDIT.md §F6`);
    }
    assert.match(read('src/js/core/materialize.js'), /isNew: isNewOf\(ctx, key, fields\.alive\)/,
      'materialize no longer calls isNewOf');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// §5 · WHAT IS GENUINELY GOOD — the structural guarantees, re-verified rather than inherited
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · the guarantees that hold', () => {
  test('§5a · zero runtime and dev dependencies AT THE ROOT, and the scope is stated', () => {
    const p = JSON.parse(read('package.json'));
    assert.deepEqual(p.dependencies ?? {}, {}, 'the root grew a runtime dependency');
    assert.deepEqual(Object.keys(p.devDependencies ?? {}), ['@tauri-apps/cli'],
      'the root devDependency set changed');
    // The scope matters: the relay is a separate package and it is NOT dependency-free.
    const s = JSON.parse(read('server/package.json'));
    assert.ok(Object.hasOwn(s.dependencies ?? {}, '@prisma/client'),
      'server/ no longer declares @prisma/client — the scope caveat can be dropped');
    assert.match(read('docs/v2/RELEASE-CHECKLIST.md'), /at the repository root/,
      'the checklist no longer states the scope of the zero-dependency claim');
  });

  // NOTE ON METHOD, and it is the reason this row is written the long way. My first draft of
  // this check grepped the raw file and went RED on two files — both times on a COMMENT that
  // states the guarantee (`core/ops.js:243` quotes ADR 004 §7 "There is no op kind for a read
  // receipt…"; `schema.prisma:38` records `Invite.wrappedKeys` as removed by D9). The code was
  // clean and the assertion was wrong. A conformance grep that cannot tell a prohibition from
  // its violation manufactures findings, so this one strips comments and string literals first.
  const codeOnly = (p) => read(p)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/^\s*\/\/.*$/gm, ' ')          // whole-line comments
    .replace(/([^:])\/\/.*$/gm, '$1')       // trailing comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")    // single-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');   // double-quoted strings

  test('§5b · P9 — no op kind exists for a notice, a receipt or a presence signal', () => {
    assert.match(read('src/js/core/visibility.js'), /NO_SNITCH_CONTRACT/,
      'the no-snitch contract is gone');
    // The enforcement is an ABSENCE, so the check is that nothing reintroduced the vocabulary
    // as CODE — an identifier, a field name, an op kind — rather than as prose about it.
    const banned = /\b(readReceipt|seenBy|lastSeenBy|typingIndicator|viewedAt|presenceOf)\b/;
    for (const f of ['src/js/core/ops.js', 'src/js/core/registers.js', 'src/js/core/visibility.js']) {
      assert.equal(banned.test(codeOnly(f)), false, `${f} grew surveillance vocabulary in CODE`);
    }
  });

  test('§5c · P10 — the one conflict surface cannot become a conversation', () => {
    const conflict = read('src/js/family/conflict.js');
    assert.match(conflict, /pointer-events:\s*none/,
      'the conflict notice became clickable — P10 needs re-auditing');
  });

  test('§5d · D9 — no invite carries key material, and the schema records the removal', () => {
    const schema = read('server/prisma/schema.prisma');
    // The only mention is the comment recording D9's removal. No MODEL declares the field.
    const models = schema.replace(/^\s*\/\/.*$/gm, ' ');
    assert.equal(/wrappedKeys/.test(models), false,
      'a wrappedKeys field appeared in an actual model on the invite path');
    assert.match(schema, /`Invite\.wrappedKeys`, removed by PO decision D9/,
      'the schema no longer records why the field is absent');
  });
});
