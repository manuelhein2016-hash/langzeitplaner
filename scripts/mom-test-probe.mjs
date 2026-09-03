#!/usr/bin/env node
// scripts/mom-test-probe.mjs — the instrument for LZP-1006's join half.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT THIS IS, AND WHAT IT IS NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
// LZP-1006's acceptance criterion is a person: "clean Mac, real email with DMG + code,
// unassisted install & join". No script can be that person, and this one does not pretend to be.
//
// What it CAN do is take the one gesture the join screen is designed around — select the whole
// invitation e-mail, copy, paste into the big field — and run it through the SHIPPED parser
// (`src/js/family/createjoin.js#parseInvitePaste`) against the SHIPPED e-mail files
// (`docs/v2/email/*`). That gesture is deterministic. If it produces the wrong code or the wrong
// server address here, it will produce the wrong code and the wrong server address on Mom's Mac,
// and no amount of watching her do it will make that a surprise worth spending her afternoon on.
//
// So: run this BEFORE the Mom test, fix what it reports, and let the real test spend its one
// irreplaceable resource — a person who has never seen the app — on the things only she can find.
//
// Zero dependencies, no network, no DOM. `node scripts/mom-test-probe.mjs`.
//
// EXIT CODES
//   0  every row passed
//   1  at least one row FAILED — a stumble that is in the shipped artefacts today
//   2  the probe itself could not run (a file moved, an export was renamed)
//
// FLAGS
//   --json     machine-readable rows on stdout, nothing else
//   --verbose  print every hazard row, not only the ones that fail
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE ASSERTION THAT MATTERS, STATED SO IT CANNOT DRIFT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A paste is HONEST when it yields either (a) exactly the code that was minted, or (b) no
// complete code at all — `found: 'none'` or a short `'partial'` — because in case (b) the button
// stays disabled and `circleNeedCode` tells her in one German sentence what is missing.
//
// A paste is DISHONEST when it yields a COMPLETE TWELVE-CHARACTER CODE THAT IS NOT THE ONE THAT
// WAS MINTED. That is the only outcome the person in front of the screen cannot recover from by
// reading: the field looks right, the button lights up, and the relay answers `invite_invalid`,
// whose German sentence then tells her — untruthfully — that she probably mistyped something.
//
// Rows are FAILures only for the dishonest class. Honest-but-unhelpful outcomes are reported as
// NOTE rows, because they are real friction and they are not lies.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const ARGS = new Set(process.argv.slice(2));
const JSON_OUT = ARGS.has('--json');
const VERBOSE = ARGS.has('--verbose');

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fixture. Distinctive on purpose: every value below is recognisable in a failure message,
// and the two hosts are DIFFERENT hosts so that "which URL did the parser take" has an answer.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The code the PO actually minted. 12 Crockford characters, `XXXX-XXXX-XXXX`. */
const MINTED = 'J17Z-XSXN-7CSQ';
/** Where the DMG is downloaded from when the attachment is stripped. NOT the relay. */
const RELEASE_URL = 'https://github.com/OWNER/REPO/releases/latest';
/** The relay. This is the address the join screen needs and the e-mail must therefore carry. */
const RELAY_ORIGIN = 'https://lzp-sync-po.vercel.app';

const FILL = (s) => s
  .split('{{NAME}}').join('Mama')
  .split('{{RELEASE_URL}}').join(RELEASE_URL)
  .split('{{EINLADUNGSCODE}}').join(MINTED)
  .split('{{ABSENDER}}').join('Manuel')
  // Present in the HTML files only; a footnote listing the placeholder names.
  .split('{{PLACEHOLDERS}}').join('NAME, RELEASE_URL, EINLADUNGSCODE, ABSENDER');

/**
 * What a mail client hands the clipboard when somebody selects a whole HTML mail and copies it.
 * Not a renderer: tags become nothing, block-level tags become a newline, entities that appear
 * in these files are resolved. Deliberately crude — the parser's job is to survive crude.
 */
function htmlToText(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|h1|h2|h3|li|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8222;|&bdquo;/g, '„')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** @type {{id:string,what:string,status:'PASS'|'FAIL'|'NOTE',detail:string}[]} */
const rows = [];
const add = (id, what, status, detail) => rows.push({ id, what, status, detail });

const q = (v) => JSON.stringify(v);

/** True when a parse produced a complete code that is not the minted one. The dishonest class. */
const isWrongCompleteCode = (parsed) => parsed.found === 'code' && parsed.code !== MINTED;

async function main() {
  // ── load the shipped parser ────────────────────────────────────────────────────────────────
  const modPath = join(ROOT, 'src/js/family/createjoin.js');
  if (!existsSync(modPath)) {
    console.error(`mom-test-probe: cannot find ${modPath}`);
    process.exit(2);
  }
  let parseInvitePaste;
  let inviteCodeChars;
  let INVITE_UI;
  try {
    const m = await import(pathToFileURL(modPath).href);
    ({ parseInvitePaste, inviteCodeChars, INVITE_UI } = m);
    if (typeof parseInvitePaste !== 'function' || typeof inviteCodeChars !== 'function') {
      throw new Error('parseInvitePaste / inviteCodeChars are not both exported');
    }
  } catch (e) {
    console.error(`mom-test-probe: the shipped join parser could not be loaded — ${e && e.message}`);
    console.error('This probe asserts properties of that module, not of its line numbers. If it');
    console.error('moved, point PROBE at the new path; if the export was renamed, the rename is');
    console.error('the finding.');
    process.exit(2);
  }
  const CODE_CHARS = (INVITE_UI && INVITE_UI.codeChars) || 12;

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M1 · THE WHOLE INVITATION, PASTED — the gesture the screen was designed around
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const mails = [
    ['de.txt', 'docs/v2/email/invitation.de.txt', (s) => s],
    ['en.txt', 'docs/v2/email/invitation.en.txt', (s) => s],
    ['de.html', 'docs/v2/email/invitation.de.html', htmlToText],
    ['en.html', 'docs/v2/email/invitation.en.html', htmlToText],
  ];

  for (const [label, rel, toText] of mails) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      add(`M1-${label}`, `the whole ${label} invitation, pasted`, 'FAIL', `${rel} does not exist`);
      continue;
    }
    const text = toText(FILL(readFileSync(p, 'utf8')));
    const parsed = parseInvitePaste(text);

    if (parsed.code === MINTED) {
      add(`M1-${label}`, `the whole ${label} invitation, pasted`, 'PASS',
        `the field fills with ${q(MINTED)}`);
    } else if (isWrongCompleteCode(parsed)) {
      add(`M1-${label}`, `the whole ${label} invitation, pasted`, 'FAIL',
        `the field fills with ${q(parsed.code)} — a COMPLETE code that was never minted. The `
        + `button lights up, the relay answers invite_invalid, and circleErrInviteInvalid then `
        + `tells her she probably mistyped a character she never typed. Minted: ${q(MINTED)}.`);
    } else {
      add(`M1-${label}`, `the whole ${label} invitation, pasted`, 'NOTE',
        `no complete code (found=${parsed.found}, code=${q(parsed.code)}). Honest — the button `
        + `stays disabled and circleNeedCode says why — but the one designed gesture did not `
        + `work, so she has to find the code block and copy it on its own.`);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // M2 · THE SERVER ADDRESS. `submitJoin` refuses without one (`circleNeedRelayForJoin`), and
    // that sentence says "In der Einladung stand auch eine Serveradresse" — so the e-mail has to
    // carry one, and the parser has to lift THAT one rather than the download host.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    if (parsed.origin === RELAY_ORIGIN) {
      add(`M2-${label}`, `the server address lifted out of ${label}`, 'PASS',
        `origin = ${q(parsed.origin)} — the relay`);
    } else if (parsed.origin === null) {
      add(`M2-${label}`, `the server address lifted out of ${label}`, 'FAIL',
        'no address at all. `submitJoin` refuses with circleNeedRelayForJoin — „In der Einladung '
        + 'stand auch eine Serveradresse. Füge sie mit ein oder trag sie unten ein." — which is '
        + 'not true of this e-mail, and leaves her looking for a URL nobody sent her.');
    } else {
      add(`M2-${label}`, `the server address lifted out of ${label}`, 'FAIL',
        `origin = ${q(parsed.origin)}, which is the DOWNLOAD host, not the relay `
        + `(${q(RELAY_ORIGIN)}). The screen then says „Server aus der Einladung übernommen" and `
        + `names a host that does not speak the protocol.`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M3 · THE CODE BLOCK ON ITS OWN — the fallback gesture, and the one that must never fail
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  {
    const parsed = parseInvitePaste(`\n    ${MINTED}\n`);
    add('M3', 'the code block copied on its own', parsed.code === MINTED ? 'PASS' : 'FAIL',
      parsed.code === MINTED ? `${q(parsed.code)}` : `got ${q(parsed.code)} (found=${parsed.found})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M4 · PASTE HAZARDS — what survives the trip through a mail client, a phone, a WhatsApp
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Every row is the SAME minted code, damaged one way. The damage is not hypothetical: each
  // line names the thing that does it.
  const hazards = [
    ['H01', 'a trailing space (double-click select)', MINTED + ' '],
    ['H02', 'leading and trailing whitespace', `   ${MINTED}   `],
    ['H03', 'a trailing newline (triple-click select)', MINTED + '\n'],
    ['H04', 'typed in lower case', MINTED.toLowerCase()],
    ['H05', 'spaces instead of hyphens', MINTED.split('-').join(' ')],
    ['H06', 'non-breaking spaces (HTML mail)', MINTED.split('-').join(' ')],
    ['H07', 'German quotation marks around it (Mail)', `„${MINTED}“`],
    ['H08', 'typed O for 0 and I for 1', MINTED.split('0').join('O').split('1').join('I')],
    ['H09', 'en-dashes instead of hyphens (text substitution)', MINTED.split('-').join('–')],
    ['H10', 'em-dashes instead of hyphens', MINTED.split('-').join('—')],
    ['H11', 'a soft hyphen from a line wrap', MINTED.slice(0, 9) + '­' + MINTED.slice(9)],
    ['H12', 'a zero-width space from an HTML mail', MINTED.slice(0, 9) + '​' + MINTED.slice(9)],
    ['H13', 'one character too many', MINTED + 'P'],
    ['H14', 'a U typed for a V (U is not in the alphabet)', MINTED.slice(0, -1) + 'U'],
    ['H15', 'the code inside a forwarded sentence', `Hier nochmal der Code: ${MINTED} — viel Erfolg!`],
    ['H16', 'the code with the relay beside it', `${RELAY_ORIGIN} und der Code ${MINTED}`],
  ];

  for (const [id, what, raw] of hazards) {
    let parsed;
    try {
      parsed = parseInvitePaste(raw);
    } catch (e) {
      add(id, what, 'FAIL', `parseInvitePaste threw: ${e && e.message}`);
      continue;
    }
    if (parsed.code === MINTED) {
      add(id, what, 'PASS', 'recovered');
    } else if (isWrongCompleteCode(parsed)) {
      add(id, what, 'FAIL',
        `silently became ${q(parsed.code)} — a complete code nobody minted. She presses `
        + '„Beitreten" and is told the code does not match.');
    } else {
      const n = inviteCodeChars(parsed.code).length;
      add(id, what, 'NOTE',
        `no complete code (found=${parsed.found}, ${n}/${CODE_CHARS} characters). Honest: the `
        + 'button stays disabled and circleNeedCode names the shortfall. She still has to work '
        + 'out what to do about it.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M6 · HOW THE RELAY ADDRESS MUST BE WRITTEN — because punctuation is part of the address
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // `parseInvitePaste` finds a URL with `/https?:\/\/[^\s"'<>]+/i` and hands the match to
  // `new URL(...)`. That character class stops at whitespace, ASCII quotes and angle brackets and
  // at NOTHING ELSE — so a full stop, a comma or a German closing quote at the end of the
  // sentence is part of the host.
  //
  // The consequence is not a parse error, which is what makes it worth a row: `new URL` accepts
  // the damaged host, `normalizeOrigin` accepts it too (it is https, it has no path, no query),
  // and the join screen says „Server aus der Einladung übernommen" and names it. The failure
  // arrives one screen later as circleErrOffline — „Keine Verbindung zum Server" — which is the
  // sentence for a server that is down, not for one that was never spelled right.
  //
  // These rows do not ask the parser to change and they never FAIL: they are the reference table
  // for whoever writes the address into the invitation. The assertion about the shipped e-mail is
  // M2's, above — this is the table that says how to make M2 green. The rule it produces: the
  // address stands alone on its own line, or inside <angle brackets>, and never ends a German
  // sentence.
  const relayForms = [
    ['R01', 'on its own line, bare', `Server:\n${RELAY_ORIGIN}\n`],
    ['R02', 'with a trailing slash', `Server: ${RELAY_ORIGIN}/`],
    ['R03', 'inside <angle brackets>', `Server: <${RELAY_ORIGIN}>`],
    ['R04', 'ending a sentence with a full stop', `Der Server ist ${RELAY_ORIGIN}.`],
    ['R05', 'followed by a comma', `${RELAY_ORIGIN}, und der Code folgt.`],
    ['R06', 'inside German quotation marks', `Server: „${RELAY_ORIGIN}“`],
  ];
  for (const [id, what, raw] of relayForms) {
    const got = parseInvitePaste(raw).origin;
    if (got === RELAY_ORIGIN) {
      add(id, `relay address ${what}`, 'PASS', 'survives — safe to write it this way');
    } else if (got === null) {
      add(id, `relay address ${what}`, 'NOTE', 'no address found — visibly nothing, and honest');
    } else {
      add(id, `relay address ${what}`, 'NOTE',
        `DO NOT WRITE IT THIS WAY: becomes ${q(got)}. Accepted by normalizeOrigin, shown to her `
        + 'as the server taken from the invitation, and it resolves to nothing — she meets '
        + 'circleErrOffline, which blames the connection.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M5 · A REAL CODE MUST NEVER BE COMMITTED — the e-mail files carry placeholders only
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // `.github/scripts/check-email-copy.mjs` already asserts the four placeholders are PRESENT.
  // This row asserts the complementary half: that no twelve-character code is sitting in the
  // files beside them. A committed invite is a membership anybody with the repository can redeem.
  for (const [label, rel] of mails.map(([l, r]) => [l, r])) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const suspects = (src.match(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g) || [])
      .filter((s) => !s.includes('XXXX'));
    add(`M5-${label}`, `no live invite code committed in ${label}`,
      suspects.length === 0 ? 'PASS' : 'FAIL',
      suspects.length === 0 ? 'placeholders only' : `found ${q(suspects.join(', '))}`);
  }

  // ── report ────────────────────────────────────────────────────────────────────────────────
  const failed = rows.filter((r) => r.status === 'FAIL');
  const noted = rows.filter((r) => r.status === 'NOTE');

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ minted: MINTED, rows }, null, 2) + '\n');
    process.exit(failed.length ? 1 : 0);
  }

  console.log('LangzeitPlaner · Mom-test probe (LZP-1006, the join half)');
  console.log(`the minted code for this run: ${MINTED}`);
  console.log('');
  for (const r of rows) {
    if (r.status === 'PASS' && !VERBOSE) continue;
    const mark = r.status === 'FAIL' ? 'FAIL' : r.status === 'NOTE' ? 'note' : ' ok ';
    console.log(`  ${mark}  ${r.id}  ${r.what}`);
    console.log(`        ${r.detail}`);
  }
  console.log('');
  console.log(`  ${rows.length} rows · ${rows.length - failed.length - noted.length} pass · `
    + `${noted.length} note · ${failed.length} FAIL`);
  if (failed.length) {
    console.log('');
    console.log('  A FAIL is a stumble that is in the shipped artefacts today. Fix it before the');
    console.log('  Mom test — it will happen on her Mac too, and it will look like her mistake.');
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('mom-test-probe: unexpected failure —', e && e.stack ? e.stack : e);
  process.exit(2);
});
