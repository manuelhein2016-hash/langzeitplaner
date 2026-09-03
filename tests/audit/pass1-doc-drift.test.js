// AUDIT · PASS 1 — prose against code. Where a document still asserts something the tree has
// stopped doing, or has quietly stopped asserting something the tree still does.
//
// READ-ONLY AUDIT ARTEFACT. Nothing here is a fix and nothing here asks for one. Each row is a
// measurement a reader can re-run; the verdict table cites the row number.
//
// Run:  node --test --import ./tests/helpers/dev-flag.mjs "tests/audit/*.test.js"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ROUTE_NAMES } from '../../server/core/router.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G · D10 — the 21.5 amendment, recorded in three places. Two agree; the machine-readable one
//      still carries the pre-amendment wording AND records the story as never amended.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const AMENDED = /makes zero \*unrequested\* network/;

test('§G1 · DESIGN-DECISIONS.md D10 carries the amended wording', () => {
  const dd = read('DESIGN-DECISIONS.md');
  assert.match(dd, /## D10 — story 21\.5 is amended/);
  assert.ok(AMENDED.test(dd), 'D10 no longer quotes the amended wording');
});

test('§G2 · ADR 003 §7.5 carries the amended wording', () => {
  const adr = read('docs/v2/adr/003-sync-protocol.md');
  assert.match(adr, /### 7\.5 .*THE AMENDMENT/);
  assert.ok(AMENDED.test(adr), 'ADR 003 §7.5 no longer quotes the amended wording');
});

test('§G3 · MEASURED — traceability.json still carries the PRE-amendment 21.5 and `amendedBy: []`', () => {
  const tr = JSON.parse(read('docs/v2/traceability.json'));
  const s = tr.stories.find((x) => x.id === '21.5');
  assert.ok(s, 'story 21.5 is missing from traceability.json');
  // the old wording, verbatim
  assert.match(s.text, /in solo mode the app makes zero network requests/);
  // and no trace of the amendment
  assert.equal(/unrequested/.test(s.text), false,
    'traceability.json has been updated — this row is stale and the finding is closed');
  assert.deepEqual(s.amendedBy, [],
    'traceability.json now records an amender — this row is stale');
  // 13.4, the story 21.5 supersedes, DOES carry its amender — so the field is used elsewhere.
  const v1 = tr.stories.find((x) => x.id === '13.4');
  assert.deepEqual(v1.amendedBy, ['A1']);
});

test('§G4 · MEASURED — the story table in V2-FINAL §9 also prints the pre-amendment 21.5', () => {
  const v2f = read('docs/v2/V2-FINAL.md');
  const row = v2f.split('\n').find((l) => l.startsWith('| 21.5 |'));
  assert.ok(row, 'no 21.5 row in V2-FINAL §9');
  assert.match(row, /in solo mode the app makes zero network requests/);
  assert.equal(/amended/.test(row), false, 'the row now says amended — this measurement is stale');
  // …while its neighbours 19.2 and 21.3 both print "(amended v2.1)", so the column can carry it.
  assert.match(v2f.split('\n').find((l) => l.startsWith('| 19.2 |')), /\(amended v2\.1\)/);
  assert.match(v2f.split('\n').find((l) => l.startsWith('| 21.3 |')), /\(amended v2\.1\)/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §H · LZP-1009. V2-FINAL's own §0 and §6 say the feedback path shipped; its ticket table §9
//      still says NOT BUILT, and carries no points for it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§H1 · MEASURED — the ticket table says NOT BUILT while the same file\'s §0 and §6 say it shipped', () => {
  const v2f = read('docs/v2/V2-FINAL.md');
  const row = v2f.split('\n').find((l) => l.startsWith('| LZP-1009 |'));
  assert.ok(row, 'no LZP-1009 row');
  assert.match(row, /\*\*NOT BUILT\*\*/);
  assert.match(row, /\| — \|/, 'the row also carries no points');
  // and the same document, three sections earlier:
  assert.match(v2f, /„Rückmeldung senden" is wired\*\*, end to end, on the real relay/);
  assert.match(v2f, /LZP-1009 gives a solo Mac an outbound path/);
});

test('§H2 · MEASURED — the artefacts exist: 8 client modules, 1 relay route, 1 binder', () => {
  const modules = [
    'src/js/feedback/copy.js', 'src/js/feedback/events.js', 'src/js/feedback/geometry.js',
    'src/js/feedback/png.js', 'src/js/feedback/port.js', 'src/js/feedback/redact.js',
    'src/js/feedback/report.js', 'src/js/feedback/ui.js',
  ];
  for (const m of modules) assert.ok(exists(m), `${m} is missing`);
  assert.ok(exists('server/core/handlers/feedback.js'));
  assert.ok(ROUTE_NAMES.includes('feedback'), 'the relay does not speak the feedback route');
  assert.match(read('src/js/family/mount.js'), /async function bindFeedback\(parts, spaceKind\)/);
  assert.match(read('src/js/settings.js'), /buildHelpSection\(body, api\);/);
});

test('§H3 · MEASURED — the table\'s own arithmetic: 69 rows, 68 marked built, 239 points', () => {
  const v2f = read('docs/v2/V2-FINAL.md');
  const sec = v2f.split('### Every ticket')[1].split('### v2 stories')[0];
  const rows = sec.split('\n').filter((l) => l.startsWith('| LZP-'));
  assert.equal(rows.length, 69);
  const built = rows.filter((r) => /\|\s*built\s*\|?\s*$/.test(r.trim()));
  assert.equal(built.length, 68);
  const pts = rows.reduce((a, r) => {
    const n = Number(r.split('|')[3].trim());
    return a + (Number.isFinite(n) ? n : 0);
  }, 0);
  assert.equal(pts, 239);
  assert.match(v2f, /\*\*68 of 69 tickets built · 239 points\.\*\*/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §I · E10-VERIFICATION.md — §3a carries a SUPERSEDED banner; the ticket table and §4 do not,
//      and both are now measurably false.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§I1 · MEASURED — §2 says „Frankfurt / Vercel / Prisma appear nowhere in src/"; all three do', () => {
  const e10 = read('docs/v2/E10-VERIFICATION.md');
  assert.ok(e10.includes('„Frankfurt", „Vercel" and „Prisma" appear **nowhere in `src/`**'),
    'the E10 row no longer makes that claim — this measurement is stale');
  const settings = read('src/js/settings.js');
  for (const word of ['Frankfurt', 'Vercel', 'Prisma']) {
    assert.ok(settings.includes(word), `${word} is not in settings.js — this row is stale`);
  }
  // and the row carries no superseded marker, while §3a's does
  assert.match(e10, /⚠ SUPERSEDED 2026-09-03 by LZP-1002/);
  const tableRow = e10.split('\n').find((l) => l.startsWith('| **LZP-1001**'));
  assert.equal(/SUPERSEDED|CLOSED|stale/.test(tableRow), false);
});

test('§I2 · MEASURED — §4\'s heading and its eight rows describe an absence that ended', () => {
  const e10 = read('docs/v2/E10-VERIFICATION.md');
  assert.match(e10, /## 4\. The feedback payload leaks nothing — because there is no feedback payload/);
  assert.match(e10, /\*\*It does not exist\.\*\*/);
  // the suite itself was inverted; the document was not.
  const suite = read('tests/attack/e10-network-scope.test.js');
  assert.match(suite, /§2 · the outbound path LZP-1009 adds — bounded, not absent/);
  assert.match(suite, /§2a · the feedback sender is CONFINED to src\/js\/feedback\//);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §J · The route count. `feedback` was the 24th route; two places still say 23.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§J1 · MEASURED — ROUTE_NAMES is 24; server-metadata §7 and vercel.js still say 23', () => {
  assert.equal(ROUTE_NAMES.length, 24);
  assert.ok(ROUTE_NAMES.includes('feedback'));
  const meta = read('docs/v2/server-metadata.md');
  assert.match(meta, /enum of 23 verbs/);
  assert.match(meta, /`LOG_ROUTES` is a closed enum of the 23 route names/);
  const vercel = read('server/adapters/vercel.js');
  assert.match(vercel, /There is no protocol logic here; the 23/);
  assert.match(vercel, /Build the `ctx` the 23 handlers need/);
  // V2-FINAL, by contrast, says 24 — so the three do not agree.
  assert.match(read('docs/v2/V2-FINAL.md'), /the same 24 handlers/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §K · ADR 003 §7 gate 2 — "in solo mode the modules are never evaluated, so there is no code
//      path to a request even under a bug elsewhere". Still exactly true, and it is the very
//      thing that makes §A's finding true: the binder is behind the same door.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§K1 · MEASURED — gate 2 is intact, and the feedback binder is inside it', () => {
  const adr = read('docs/v2/adr/003-sync-protocol.md');
  assert.match(adr, /In solo mode the modules are never evaluated, so there is no code path to a request even under\s+a bug elsewhere/);
  // the binder lives behind that door
  assert.match(read('src/js/family/mount.js'), /import \{ setFeedbackPort, FEEDBACK_PATH \} from '\.\.\/feedback\/port\.js';/);
  // and §7.5's own table says mount.js "may import the setter and can therefore bind but not originate"
  assert.match(adr, /may import the \*\*setter\*\* and can therefore bind but not originate/);
});

test('§K2 · MEASURED — D10 justifies the amendment by a solo tester who, as shipped, cannot send', () => {
  const dd = read('DESIGN-DECISIONS.md');
  assert.match(dd, /refuses the report from the\s*\n?\s*only tester who has no Familienkreis/);
  // …and port.js's own header states the shipped behaviour plainly.
  assert.match(read('src/js/feedback/port.js'),
    /A Mac with NO relay — solo — still binds nothing[\s\S]*?`canSend\(\)` is false,[\s\S]*?„Senden" is disabled/);
});
