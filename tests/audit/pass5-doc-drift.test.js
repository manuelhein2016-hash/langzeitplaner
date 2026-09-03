// tests/audit/pass5-doc-drift.test.js — PASS 5, the release paperwork.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════
// A checklist that is ticked optimistically is worse than no checklist, because the next
// person reads it as evidence. `RELEASE-CHECKLIST.md` §F says so itself. The inverse is just
// as expensive and is what this file measures: a checklist that names as OPEN a thing that has
// been CLOSED, and a kit document that publishes red rows for defects that are green.
//
// Every row here asserts a DRIFT — the document says X, the tree says not-X — and each row
// goes red the day the document is corrected. Nothing under `docs/` is touched.
//
//   run:  node --test --import ./tests/helpers/dev-flag.mjs tests/audit/pass5-doc-drift.test.js
//
//   §1  RELEASE-CHECKLIST.md names two closed things as open, one of them ⛔ BLOCKING
//   §2  MOM-TEST.md §8 publishes four defects that are closed, and §5.3 a red probe that is green
//   §3  RUNBOOK.md §2.6 still owes a thing that has arrived; and one number disagrees with two
//       other documents
//   §4  RUNBOOK.md §3.3 is the operator's front door and it routes the epoch ladder to the
//       WRONG section — the one costly drift, because it ends in "wait" and the wait is for ever
//   §5  what the checklist does not mention at all, and a person receives it
// ═══════════════════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CHECKLIST = read('docs/v2/RELEASE-CHECKLIST.md');
const MOM = read('docs/v2/MOM-TEST.md');
const RUNBOOK = read('docs/v2/RUNBOOK.md');

// ── §1 · THE CHECKLIST ─────────────────────────────────────────────────────────────────────

test('§1a · ⛔ "server/prisma/migrations/ … It does not exist" — it exists, and it is tracked',
  () => {
    assert.match(CHECKLIST, /`server\/prisma\/migrations\/` generated and committed[\s\S]{0,120}It does not\s+exist\./,
      'FIXED: the checklist no longer says the migrations are missing.');
    // The tree.
    const dir = join(ROOT, 'server/prisma/migrations');
    assert.ok(existsSync(dir), 'the migrations directory exists');
    const versions = readdirSync(dir).filter((n) => /^\d{14}_/.test(n));
    assert.ok(versions.length >= 1, `expected a timestamped migration, saw ${readdirSync(dir)}`);
    assert.ok(existsSync(join(dir, versions[0], 'migration.sql')));
    // And git agrees it is committed.
    const tracked = execFileSync('git', ['ls-files', 'server/prisma/migrations'],
      { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    assert.ok(tracked.some((f) => f.endsWith('migration.sql')), `git ls-files: ${tracked}`);
    // COST: the sentence that follows it in the checklist is "Without it the first deploy
    // creates no tables and every query fails." An operator reading a ⛔ blocker that has been
    // done either stops, or regenerates a migration over one that has already been applied.
    // `RUNBOOK.md` §2.6 records the same item as CLOSED, which is the correct state.
    assert.match(RUNBOOK, /~~`server\/prisma\/migrations\/`~~/);
  });

test('§1b · §G "Frankfurt, Vercel, Prisma appear nowhere in src/" — all three are in src/', () => {
  assert.match(CHECKLIST,
    /the 21\.3 Datenschutz section is not in the product \(`Frankfurt`, `Vercel`, `Prisma` appear nowhere in `src\/`\)/,
    'FIXED: §G no longer claims the Datenschutz section is absent.');
  const settings = read('src/js/settings.js');
  for (const word of ['Frankfurt', 'Vercel', 'Prisma']) {
    assert.ok(settings.includes(word), `src/js/settings.js does not name ${word}`);
  }
  // Both languages, as LZP-1001 required.
  assert.match(settings, /Region Frankfurt/);
  assert.match(settings, /Frankfurt region/);
  // RUNBOOK §2.6 already records this as closed and says the old claim is "no longer true".
  assert.match(RUNBOOK, /the claim in the previous edition of this table[\s\S]{0,80}no longer true/);
});

test('§1c · §B "mom-test-probe.mjs → exit 0 (fails today)" — it exits 0 today', () => {
  assert.match(CHECKLIST, /mom-test-probe\.mjs` → exit 0 \*\(fails today: `MOM-TEST\.md` §2\.3\)\*/,
    'FIXED: the checklist no longer says the probe fails.');
  const out = execFileSync('node', [join(ROOT, 'scripts/mom-test-probe.mjs')],
    { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /0 FAIL/);
});

test('§1d · the two things the checklist says are open ARE open — measured, not assumed', () => {
  // The pre-flight, strict, is the gate release.yml runs. It fails, so no tag can be cut.
  let code = 0;
  try {
    execFileSync('node', [join(ROOT, '.github/scripts/check-release-config.mjs'), '--strict'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; }
  assert.equal(code, 1, 'FIXED: the strict pre-flight passes — the updater key is real now.');
  assert.match(read('src-tauri/tauri.conf.json'), /REPLACE_ME__run_cargo_tauri_signer_generate/);
  assert.match(read('src-tauri/tauri.conf.json'), /github\.com\/OWNER\/REPO\//);
  assert.match(read('shell-macos/main.swift'), /OWNER-PLACEHOLDER/);
  // And the deployed relay would answer 501 on feedback, exactly as §A says.
  assert.ok(!read('server/adapters/vercel.js').includes('feedbackSink'));
  assert.match(read('server/dev-server.mjs'), /feedbackSink: async \(r\) =>/);
  // And the tree really is local-only: no remote, so no workflow has ever run.
  const remotes = execFileSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(remotes, '', 'FIXED: an origin exists now — §A row 1 can be ticked.');
});

// ── §2 · THE MOM-TEST KIT ──────────────────────────────────────────────────────────────────

test('§2a · §8 "what the test is not for" lists four items that are no longer true', () => {
  // (i) and (ii): the two e-mail defects, both closed in the parser.
  assert.match(MOM, /the German mail's „Mail-Anbieter" collision/,
    'FIXED: §8 no longer lists E-1.');
  assert.match(MOM, /the mail carries no relay address/, 'FIXED: §8 no longer lists E-2.');
  // The tree: the word is still in the mail (a CI gate REQUIRES it — see §5b below) and the
  // address is now in all four files, and the probe is green over both.
  assert.match(read('docs/v2/email/invitation.de.txt'), /Mail-Anbieter/);
  assert.match(read('docs/v2/email/invitation.de.txt'), /https:\/\/lzp-sync-po\.vercel\.app/);
  // (iii): the migrations — same drift as §1a.
  assert.match(MOM, /`server\/prisma\/migrations\/` does not exist/);
  assert.ok(existsSync(join(ROOT, 'server/prisma/migrations')));
  // (iv): the Datenschutz text — same drift as §1b.
  assert.match(MOM, /„Frankfurt", „Vercel" and „Prisma" appear nowhere in `src\/`/);
  assert.ok(read('src/js/settings.js').includes('Frankfurt'));
});

test('§2b · §2.3 E-3 publishes a punctuation table the parser no longer behaves like', () => {
  // The document's table says a trailing full stop / comma / German quote produces a broken
  // origin and „Keine Verbindung zum Server".
  assert.match(MOM, /ending a sentence: `… ist https:\/\/…vercel\.app\.`/);
  assert.match(MOM, /vercel\.xn--app-5o0a/);
  // The parser now trims exactly that class before `new URL`.
  const src = read('src/js/family/createjoin.js');
  assert.match(src, /const URL_TAIL_RE = \/\[\.,;:!\?/);
  assert.match(src, /m\[0\]\.replace\(URL_TAIL_RE, ''\)/);
  // And the probe's own reference rows R04–R06, which §2.3 calls "the reference table", now pass.
  const verbose = execFileSync('node',
    [join(ROOT, 'scripts/mom-test-probe.mjs'), '--json'], { cwd: ROOT, encoding: 'utf8' });
  const rows = JSON.parse(verbose).rows || JSON.parse(verbose);
  const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r.status]));
  for (const id of ['R04', 'R05', 'R06']) {
    if (byId.has(id)) assert.equal(byId.get(id), 'PASS', `${id} is ${byId.get(id)}`);
  }
  // COST is small and real: §2.3 is the section RUNBOOK §3.3 cites when a family reports
  // „Keine Verbindung zum Server", and it now over-explains a cause that has been removed.
});

test('§2c · §5.3 publishes the probe output as 6 FAIL; the probe reads 0 FAIL', () => {
  assert.match(MOM, /6 FAIL:\s+M1-de\.txt/, 'FIXED: §5.3 was re-measured.');
  assert.match(MOM, /8 note:/);
  const out = execFileSync('node', [join(ROOT, 'scripts/mom-test-probe.mjs')],
    { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /35 rows · 33 pass · 2 note · 0 FAIL/);
});

test('§2d · §4.2\'s last row still tells the PO the whole-mail paste is broken', () => {
  assert.match(MOM, /pastes the \*\*whole shipped German e-mail\*\*[\s\S]{0,120}MA11-ANB1-ETER/,
    'FIXED: §4.2 was re-measured.');
  // §6.1 step 1 of the day-of script says "if the probe is not green, repair the e-mail first".
  // With §4.2 and §5.3 stale, a PO who reads the kit and not the probe repairs nothing and
  // believes the join half is broken.
  assert.match(MOM, /`node scripts\/mom-test-probe\.mjs` läuft grün/);
});

// ── §3 · THE RUNBOOK ───────────────────────────────────────────────────────────────────────

test('§3a · §2.6 still owes "the relay address in the invitation e-mail" — it is in all four',
  () => {
    assert.match(RUNBOOK, /\| the relay address in the invitation e-mail \| `MOM-TEST\.md` §2\.3 E-2/,
      'FIXED: §2.6 moved that row to the closed table.');
    for (const f of ['docs/v2/email/invitation.de.txt', 'docs/v2/email/invitation.en.txt',
      'docs/v2/email/invitation.de.html', 'docs/v2/email/invitation.en.html']) {
      assert.match(read(f), /https:\/\/lzp-sync-po\.vercel\.app/);
    }
    // The row is not simply stale: what is owed changed shape. The mail now carries AN address;
    // what is owed is that it carry a REAL one. See tests/audit/pass5-first-run.test.js §2–§3.
  });

test('§3b · one contract-run number, three documents, two values', () => {
  assert.match(RUNBOOK, /\*\*65 of 66 cases against PostgreSQL 17\.10\*\*/);
  assert.match(CHECKLIST, /\*\*done 2026-09-03 against PostgreSQL 17\.10: 66 of 66 contract cases/);
  assert.match(read('docs/v2/V2-FINAL.md'), /\*\*66 of 66 contract cases,\n1069 rows, 0 fail, 0 skip\*\*/);
  // Not adjudicable from here: there is no reachable Postgres, so `LZP_CONTRACT_DATABASE_URL`
  // cannot be set and the run cannot be repeated. Reported as a contradiction, not a verdict.
  // The runbook is the copy an operator reads, and it is the one holding the minority value.
});

test('§4 · §3.3 routes the family\'s only sentence to §5.2, and §5.2\'s own test sends the '
  + 'epoch-ladder case back out as "an ordinary joiner waiting"', () => {
  // The front door: the one sentence a family reads out that reaches either residual.
  assert.match(RUNBOOK,
    /„Dieser Mac hat die Schlüssel des Kreises noch nicht vollständig" \| `noRing` \| §5\.2 — read that section before answering/);
  // §5.2's stated way to tell it apart from a benign wait:
  assert.match(RUNBOOK,
    /A joiner waiting is \*one\* member\s+saying `noRing` while everybody else is fine and entries flow normally/);
  // …and §5.1 — the OTHER residual — produces exactly that presentation:
  assert.match(RUNBOOK, /\*no new member can be\s+delivered keys\*/);
  // FINDING. A family past the epoch wall that has just invited somebody presents as: one
  // member says noRing, everybody else is fine, entries flow normally. §5.2's test classifies
  // that as D9's designed wait, whose advice is to wait — and the wait never ends, because
  // rotation is unperformable. Nothing in §3.3 or §5.2 points at §5.1 from that sentence.
  // The only two doors into §5.1 are §3.4 ("the one worth recognising on sight is the epoch
  // budget") and a `413 payload_too_large` in the relay's own log — and the client never shows
  // a status number, which §3.3 says in its own first line:
  assert.match(RUNBOOK, /The client never shows a status number\./);
  assert.ok(!/§5\.1/.test(RUNBOOK.slice(RUNBOOK.indexOf('### 3.3'), RUNBOOK.indexOf('### 3.4'))),
    'FIXED: §3.3 now cross-references §5.1.');
});

// ── §5 · WHAT THE CHECKLIST DOES NOT MENTION ───────────────────────────────────────────────

test('§5a · nothing tells the PO to rebuild build/email/ before he sends the invitation', () => {
  // The four files he is told to paste from live in build/email/, produced by
  // scripts/build-release-assets.sh §3b, because that is where the <img src> resolves.
  assert.match(read('scripts/build-release-assets.sh'),
    /open\s*\n?#\s*build\/email\/invitation\.de\.html in a browser, select all, copy, paste into Mail/);
  assert.match(read('docs/v2/email/invitation.de.html'),
    /open this file in a browser, Cmd-A, Cmd-C, paste into a new mail/);
  // But build/ is gitignored and generated, and no checklist row regenerates it.
  assert.match(read('.gitignore'), /^build\/$/m);
  assert.ok(!/build-release-assets/.test(CHECKLIST),
    'FIXED: the checklist now names the asset build.');
  assert.ok(!/build\/email/.test(CHECKLIST),
    'FIXED: the checklist now names the mail he actually sends.');
  // MEASURED 2026-09-04: before this audit rebuilt it, build/email/invitation.de.txt was
  // 4021 bytes dated Aug 27 while docs/v2/email/invitation.de.txt was 4316 bytes dated Sep 3 —
  // i.e. the copy on disk was the edition WITHOUT the relay address, the exact defect
  // MOM-TEST §2.3 E-2 describes. A stale build/ is a silent way to send last week's mail.
});

test('§5b · the decoy word the parser was hardened against is PINNED by a CI gate', () => {
  const gate = read('.github/scripts/check-email-copy.mjs');
  assert.match(gate, /\['mail-anbieter', '\.dmg'\]/);
  // So MOM-TEST §2.3's recommended repair — "The fix is one word in the e-mail
  // (Mail-Programme, E-Mail-Anbieter …)" — would now FAIL check-email-copy.mjs. The chosen
  // repair was the parser instead, which is the better one; the document still recommends the
  // other, and the gate would refuse it.
  assert.match(MOM, /\*\*The fix is one word in the e-mail\*\* \(`Mail-Programme`, `E-Mail-Anbieter`/);
});

test('§5c · check-email-copy.mjs is a CI gate, not a release gate', () => {
  assert.match(read('.github/workflows/ci.yml'), /check-email-copy\.mjs/);
  assert.ok(!read('.github/workflows/release.yml').includes('check-email-copy'),
    'FIXED: release.yml runs the copy gate too.');
  // Not itself a defect — the mail is not a build artefact and §B lists the command by hand —
  // but it means the four files a person actually receives are gated only by whatever ran on
  // the last push, and today no workflow has ever run at all (§1d).
});
