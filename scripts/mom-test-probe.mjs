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
//   --json          machine-readable rows on stdout, nothing else
//   --verbose       print every hazard row, not only the ones that fail
//   --simulate <j>  run the F1 coupling predicate over a supplied state and print its rows;
//                   reads nothing, asserts nothing about this tree. Used by
//                   tests/tier1/release-gate.test.js to drive mutants through the real predicate.
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
/**
 * ██ AUDIT F13 · THE SLOT, AND WHY IT IS SPELLED `.invalid` ██
 *
 * This used to be `const RELAY_ORIGIN = 'https://lzp-sync-po.vercel.app'`, and row M2 asserted
 * that the address lifted out of the shipped mail EQUALLED it. That made this probe — a gate
 * `docs/v2/RELEASE-CHECKLIST.md` §B lists per release — read backwards: **green meant "nobody
 * has substituted the address yet"**, and substituting the real one turned it red as if the
 * correct act were a regression.
 *
 * Two things changed, and they are separate:
 *
 *   · The SHAPE is asserted (M2): an origin came back at all, it is https, it is a bare
 *     `scheme://host[:port]`, it is not the DOWNLOAD host, and all four mails agree on it.
 *     Those rows are about the parser and the copy, and they must be green in every state.
 *   · The SUBSTITUTION is asserted separately (M2s), and it FAILS while the placeholder stands.
 *     Green now means somebody claimed a host and wrote it into the mail.
 *
 * The placeholder itself is `.invalid`, which RFC 2606 §2 reserves precisely so that it "is sure
 * to be invalid": no registry can delegate it, no resolver answers it. The name it replaced was
 * *claimable* — measured 2026-09-03, `https://lzp-sync-po.vercel.app/api/v1/meta` answered
 * HTTP 404 `x-vercel-error: DEPLOYMENT_NOT_FOUND`, so the host in four shipped invitations
 * belonged to nobody and anybody could take it.
 *
 * What that would have cost, stated exactly and not more (D9): an invitation carries an address
 * and a code and **no key material**, so a stranger's relay mints no epoch key and cannot read
 * one shared entry. But `deriveInvite(code)` is pure — `inviteId` and `proof` are HKDF of the
 * code with no salt, nonce, origin or timestamp — so a joiner's first request to the wrong host
 * hands over, in the clear, a token that redeems that invite against the REAL relay unchanged,
 * plus her device signing and KEX public keys and her IP. The damage is a burnt invitation, a
 * seat in the circle taken by somebody else, and a person told she joined a family that is not
 * there. It is not a way to read the family's calendar.
 */
export const RELAY_PLACEHOLDER = 'https://serveradresse-fehlt.invalid';

/** RFC 2606 §2. The one property that makes a placeholder safe to ship by accident. */
export const UNREGISTRABLE_TLD = '.invalid';

/**
 * Is this the address a family can actually be invited to? Pure, exported, and the single place
 * the probe's verdict lives — `tests/tier1/release-gate.test.js` §3 drives THIS function rather
 * than grepping this file, so "the gate fails on the placeholder" is a behaviour and not a
 * comment.
 *
 * @param {string|null} origin  what `parseInvitePaste` lifted out of the mail
 * @param {string} releaseUrl   the DMG download link, which is not a relay
 * @returns {{status:'PASS'|'FAIL', code:string, why:string}}
 */
export function relayVerdict(origin, releaseUrl = RELEASE_URL) {
  if (origin === null || origin === undefined || origin === '') {
    return { status: 'FAIL', code: 'none',
      why: 'no address at all. `submitJoin` refuses with circleNeedRelayForJoin — „In der '
        + 'Einladung stand auch eine Serveradresse. Füge sie mit ein oder trag sie unten ein." '
        + '— which is not true of this e-mail, and leaves her looking for a URL nobody sent her.' };
  }
  let u;
  try { u = new URL(origin); } catch {
    return { status: 'FAIL', code: 'not_an_origin', why: `${q(origin)} does not parse as a URL` };
  }
  if (u.protocol !== 'https:') {
    return { status: 'FAIL', code: 'not_https',
      why: `${q(origin)} is not https. The shells refuse a non-https pin locally `
        + '(origin_is_not_https) and never open a socket.' };
  }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash || u.username) {
    return { status: 'FAIL', code: 'not_an_origin',
      why: `${q(origin)} is not a bare scheme://host[:port]; the shells refuse it as `
        + 'origin_is_not_scheme_host_port.' };
  }
  let releaseHost = '';
  try { releaseHost = new URL(releaseUrl).host; } catch { /* fixture only */ }
  if (releaseHost && u.host === releaseHost) {
    return { status: 'FAIL', code: 'download_host',
      why: `origin = ${q(origin)}, which is the DOWNLOAD host, not the relay. The screen then `
        + 'says „Server aus der Einladung übernommen" and names a host that does not speak the '
        + 'protocol.' };
  }
  if (u.host === 'invalid' || u.host.endsWith(UNREGISTRABLE_TLD)) {
    return { status: 'FAIL', code: 'placeholder',
      why: `origin = ${q(origin)} — the reserved SLOT, not a relay. RFC 2606 §2 guarantees it `
        + 'never resolves, so nothing here can be claimed by a stranger and nothing here can be '
        + 'joined either. This row is red until the host is claimed and substituted in the four '
        + 'invitation files AND in SYNC_ORIGIN_BUILTIN in both shells — one act, held by '
        + 'tests/tier1/release-gate.test.js §1c.' };
  }
  return { status: 'PASS', code: 'ok', why: `origin = ${q(origin)} — a real, substituted relay` };
}

/**
 * ██ AUDIT F1 · THE COUPLING, AS ONE PURE FUNCTION ██
 *
 * F1 was not "the constant is empty". Empty is correct for a build with nowhere to sync to. F1
 * was that the checklist made the releaser substitute a relay address into four invitation mails
 * that **nothing reads**, while `SYNC_ORIGIN_BUILTIN` — the string every `sync_request` is
 * rebuilt against, byte for byte, in both shells — appeared **0 times** in
 * `docs/v2/RELEASE-CHECKLIST.md` and **0 times** in `docs/v2/V2-FINAL.md`. So the sheet could be
 * worked top to bottom, ticked honestly, and produce a build in which every family request is
 * refused locally (`no_origin_configured`), with the page unable to fall back because
 * `index.html`'s CSP is `connect-src 'self'`.
 *
 * The repair is to make the two substitutions ONE ACT and give that act a row. There are exactly
 * two coherent states and this function names them:
 *
 *   · UNSET  — both shells `""`, all four mails carrying the reserved `.invalid` slot. Nothing
 *              syncs, nobody is misdirected, and the mail says so by naming a host that RFC 2606
 *              guarantees never resolves. This is a shippable SOLO build.
 *   · SET    — both shells pinned to one https origin, all four mails naming that same origin.
 *
 * Everything else is a half-done release: the mail names a host the app will not talk to, or the
 * app syncs to a host nobody was told about, or the two name different hosts and the invitation
 * misdirects a stranger. `tests/tier1/release-gate.test.js` drives THIS function — over the real
 * tree, and over mutants through `--simulate` — so the mutants exercise the shipped predicate
 * rather than a copy of it.
 *
 * @param {{swift:string|null, rust:string|null, mails:Record<string,string|null>}} state
 * @returns {{id:string,what:string,status:'PASS'|'FAIL',detail:string}[]}
 */
export function couplingRows(state) {
  const out = [];
  const push = (id, what, status, detail) => out.push({ id, what, status, detail });
  const { swift, rust, mails } = state;
  const mailEntries = Object.entries(mails || {});

  // S1 · one contract, two shells. `net.js` §6 publishes `sync_request` once; if the two shells
  // pin different origins, the demonstrated build and the shipped build talk to different hosts.
  if (swift === null || rust === null) {
    push('S1', 'both shells declare a pinned origin', 'FAIL',
      `SYNC_ORIGIN_BUILTIN could not be read from ${swift === null ? 'shell-macos/main.swift' : ''}`
      + `${swift === null && rust === null ? ' and ' : ''}${rust === null ? 'src-tauri/src/lib.rs' : ''}`
      + ' — the declaration moved, and this gate cannot see it any more.');
  } else if (swift === rust) {
    push('S1', 'both shells pin the same origin', 'PASS',
      swift === '' ? 'both are "" — no relay pinned, every sync_request refused locally'
        : `both are ${q(swift)}`);
  } else {
    push('S1', 'both shells pin the same origin', 'FAIL',
      `main.swift pins ${q(swift)} and lib.rs pins ${q(rust)}. One contract, two shells `
      + '(net.js §6): a build on the other shell would sync somewhere the demonstrated one does '
      + 'not, and the SSRF table in docs/v2/SHELL-VERIFICATION.md would stop describing it.');
  }

  // S2 · THE ONE ACT.
  const shell = swift === rust ? swift : null;
  const distinct = [...new Set(mailEntries.map(([, o]) => o))];
  const mailOrigin = distinct.length === 1 ? distinct[0] : null;
  const mailIsSlot = typeof mailOrigin === 'string' && relayVerdict(mailOrigin).code === 'placeholder';

  if (distinct.length !== 1) {
    push('S2', 'the pinned origin and the invitation address are one act', 'FAIL',
      `the four invitations do not agree on an address (${mailEntries.map(([l, o]) => `${l}=${q(o)}`).join(', ')}), `
      + 'so there is no single address to hold the shells to. Substitute with the `sed` over '
      + '`docs/v2/email/invitation.*`, which is written to touch all four at once.');
  } else if (shell === null) {
    push('S2', 'the pinned origin and the invitation address are one act', 'FAIL',
      'the two shells disagree (S1), so there is no single pinned origin to compare the '
      + 'invitation against.');
  } else if (shell === '' && mailIsSlot) {
    push('S2', 'the pinned origin and the invitation address are one act', 'PASS',
      `UNSET, coherently: SYNC_ORIGIN_BUILTIN is "" in both shells and all four invitations `
      + `carry the reserved slot ${q(mailOrigin)}. Nothing syncs and nobody is misdirected — a `
      + 'shippable SOLO build. The Familienkreis is not shippable in this state, which is what '
      + 'row M2s says.');
  } else if (shell !== '' && shell === mailOrigin) {
    push('S2', 'the pinned origin and the invitation address are one act', 'PASS',
      `SET, coherently: both shells pin ${q(shell)} and all four invitations name it.`);
  } else if (shell === '' && !mailIsSlot) {
    push('S2', 'the pinned origin and the invitation address are one act', 'FAIL',
      `HALF DONE — the mail was substituted and the shells were not. The invitation tells her `
      + `${q(mailOrigin)}, the app pins "" , and every sync_request is refused locally with `
      + '`no_origin_configured` before a socket exists. She joins a family that never syncs, and '
      + 'nothing on her screen says why. Set SYNC_ORIGIN_BUILTIN in shell-macos/main.swift AND '
      + 'src-tauri/src/lib.rs to the same string.');
  } else if (shell !== '' && mailIsSlot) {
    push('S2', 'the pinned origin and the invitation address are one act', 'FAIL',
      `HALF DONE the other way — the shells were substituted (${q(shell)}) and the mail was not. `
      + `The invitation still names the reserved slot ${q(mailOrigin)}, which cannot resolve, so `
      + 'the join screen accepts an address that reaches nothing and she meets circleErrOffline '
      + '— the sentence for a server that is down, not for one that was never written in.');
  } else {
    push('S2', 'the pinned origin and the invitation address are one act', 'FAIL',
      `TWO DIFFERENT HOSTS — the shells pin ${q(shell)} and the invitations name ${q(mailOrigin)}. `
      + 'This is the worst of the three: the app refuses every request as `url_is_not_the_pinned_'
      + 'origin`, and the address a stranger was sent belongs to somebody else. deriveInvite is '
      + 'pure, so her first request hands that host a token redeemable against the real relay.');
  }
  return out;
}

/**
 * `SYNC_ORIGIN_BUILTIN` as each shell declares it, or `null` if the declaration moved. Two
 * spellings, one string — Swift `let X = "…"`, Rust `const X: &str = "…";`.
 * @returns {{swift:string|null, rust:string|null}}
 */
export function readShellPinnedOrigins() {
  const one = (rel, re) => {
    const f = join(ROOT, rel);
    if (!existsSync(f)) return null;
    const m = readFileSync(f, 'utf8').match(re);
    return m ? m[1] : null;
  };
  return {
    swift: one('shell-macos/main.swift', /^let SYNC_ORIGIN_BUILTIN = "([^"]*)"/m),
    rust: one('src-tauri/src/lib.rs', /^const SYNC_ORIGIN_BUILTIN: &str = "([^"]*)";/m),
  };
}

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

/**
 * `--simulate '<json>'` — run ONLY `couplingRows` over a supplied state and print its rows as
 * JSON. It reads no file and asserts nothing about this tree.
 *
 * This exists so `tests/tier1/release-gate.test.js` can drive MUTANTS through the shipped
 * predicate instead of a copy of it: tier-1 test files may import only `node:`, `src/js/**` and
 * `tests/helpers/**` (`suite-integrity.test.js`), so a subprocess is the honest way for a tier-1
 * row to reach this function. Exit 1 if any simulated row FAILs, 0 otherwise.
 */
function simulate(raw) {
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    console.error(`mom-test-probe --simulate: not JSON — ${e && e.message}`);
    process.exit(2);
  }
  const simRows = couplingRows({
    swift: state.swift ?? null, rust: state.rust ?? null, mails: state.mails ?? {},
  });
  // `relay: [...]` additionally runs `relayVerdict` over each supplied address and reports it as
  // a row `V0`, `V1`, … — so a caller can prove what the substitution row DOES without having to
  // put this tree into the state it is asking about.
  if (Array.isArray(state.relay)) {
    state.relay.forEach((origin, i) => {
      const v = relayVerdict(origin);
      simRows.push({ id: `V${i}`, what: `relayVerdict(${q(origin)})`, status: v.status,
        detail: `${v.code} — ${v.why}` });
    });
  }
  process.stdout.write(JSON.stringify({ rows: simRows }, null, 2) + '\n');
  process.exit(simRows.some((r) => r.status === 'FAIL') ? 1 : 0);
}

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

  /** @type {[string, string|null][]} what the parser lifted out of each of the four files. */
  const liftedOrigins = [];

  for (const [label, rel, toText] of mails) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) {
      add(`M1-${label}`, `the whole ${label} invitation, pasted`, 'FAIL', `${rel} does not exist`);
      liftedOrigins.push([label, null]);
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
    // M2 · THE SERVER ADDRESS — THE SHAPE. `submitJoin` refuses without one
    // (`circleNeedRelayForJoin`), and that sentence says "In der Einladung stand auch eine
    // Serveradresse" — so the e-mail has to carry one, and the parser has to lift THAT one
    // rather than the download host. This row is about the parser and the copy: it must be
    // green whether or not the host has been claimed yet.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const v = relayVerdict(parsed.origin);
    const shapeOk = v.status === 'PASS' || v.code === 'placeholder';
    add(`M2-${label}`, `the server address lifted out of ${label}`, shapeOk ? 'PASS' : 'FAIL',
      shapeOk
        ? `origin = ${q(parsed.origin)} — one bare https origin, and not the download host`
        : v.why);
    liftedOrigins.push([label, parsed.origin]);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M2a · THE FOUR MAILS AGREE. Four files, one address: a de/en split here sends half a family
  // to a host the other half never heard of, and the `sed` in the HTML head comments is written
  // over `invitation.*` precisely so this cannot happen by hand.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  {
    const distinct = [...new Set(liftedOrigins.map(([, o]) => o))];
    add('M2a', 'all four invitations name the same server address',
      distinct.length === 1 ? 'PASS' : 'FAIL',
      distinct.length === 1
        ? `${q(distinct[0])}, four times over`
        : `the four mails disagree: ${liftedOrigins.map(([l, o]) => `${l}=${q(o)}`).join(', ')}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M2s · THE SUBSTITUTION. ██ THE ROW THAT IS RED UNTIL THE WORK IS DONE ██
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AUDIT F13: the old row asserted the placeholder, so a green probe meant nobody had
  // substituted anything. This one is its inverse, and it is the reason this probe exits 1 in a
  // tree whose relay host is unclaimed. It is not a bug in the mail — it is the Familienkreis
  // not being shippable yet, said by a gate instead of by a paragraph.
  {
    const v = relayVerdict(liftedOrigins.length ? liftedOrigins[0][1] : null);
    add('M2s', 'the relay address is a claimed host, not the reserved slot',
      v.status, v.why);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M2u · THE SLOT CANNOT BE CLAIMED — the honest-path control for M2s.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // M2s being red is only tolerable because a mail sent in this state names NOBODY. RFC 2606 §2
  // reserves `.invalid` so no registry can delegate it; the previous placeholder was a live
  // `*.vercel.app` name that answered 404 and was free for a stranger to register.
  {
    const host = (() => { try { return new URL(RELAY_PLACEHOLDER).host; } catch { return ''; } })();
    const unclaimable = host.endsWith(UNREGISTRABLE_TLD);
    add('M2u', 'the placeholder is in a TLD that cannot be delegated',
      unclaimable ? 'PASS' : 'FAIL',
      unclaimable
        ? `${q(RELAY_PLACEHOLDER)} — RFC 2606 §2 reserves ${UNREGISTRABLE_TLD}, so an `
          + 'unsubstituted mail names nobody rather than whoever registered the name first'
        : `${q(RELAY_PLACEHOLDER)} is a REGISTRABLE name. Whoever claims it receives, in the `
          + 'clear, a redeemable invite token from every reader of an unsubstituted invitation.');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // S · ██ THE ONE ACT ██ — the address in the mail and the origin the app will actually talk to
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AUDIT F1. Everything above asks "does the paste gesture produce an address". These ask the
  // question that was missing: "is it the address the app is pinned to?" A mail that hands her a
  // perfectly parseable origin the shell then refuses is not a working invitation, and it is the
  // state a releaser reaches by working the sheet exactly as written.
  {
    const { swift, rust } = readShellPinnedOrigins();
    const mailsByLabel = Object.fromEntries(liftedOrigins);
    for (const r of couplingRows({ swift, rust, mails: mailsByLabel })) {
      add(r.id, r.what, r.status, r.detail);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // S3 · THE RELEASE SHEET NAMES BOTH HALVES, IN ONE ITEM
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The measured shape of F1: `SYNC_ORIGIN_BUILTIN` appeared 0 times in RELEASE-CHECKLIST.md
  // while the sheet DID force the invitation substitution. Two items would still let a releaser
  // do one and not the other; one item is the repair, so that is what this row asserts.
  {
    const rel = 'docs/v2/RELEASE-CHECKLIST.md';
    const f = join(ROOT, rel);
    if (!existsSync(f)) {
      add('S3', 'the release sheet names both halves of the substitution', 'FAIL',
        `${rel} does not exist`);
    } else {
      const sheet = readFileSync(f, 'utf8');
      // Checklist items are `- [ ]` / `- [x]` blocks; an item runs to the next one.
      const items = sheet.split(/\n(?=\s*- \[[ x]\])/);
      const paired = items.filter((it) =>
        it.includes('SYNC_ORIGIN_BUILTIN') && /invitation\.\{de,en\}|invitation\.(de|en)\./.test(it));
      add('S3', 'the release sheet names both halves of the substitution, in ONE item',
        paired.length >= 1 ? 'PASS' : 'FAIL',
        paired.length >= 1
          ? `${rel} carries ${paired.length} item(s) naming SYNC_ORIGIN_BUILTIN and the four `
            + 'invitation files together, so the two cannot be ticked apart'
          : sheet.includes('SYNC_ORIGIN_BUILTIN')
            ? `${rel} names SYNC_ORIGIN_BUILTIN, but not in the same checklist item as the `
              + 'invitation address — two items are two acts, and F1 is what happens when one '
              + 'of them is done and the other is not.'
            : `${rel} does not name SYNC_ORIGIN_BUILTIN at all. That is AUDIT F1 verbatim: the `
              + 'sheet forces the invitation substitution and never mentions the string every '
              + 'sync_request is rebuilt against.');
    }
  }

  /**
   * The address the shipped German mail carries TODAY — the placeholder before the substitution,
   * the real host after it. The punctuation table below is a reference for whoever writes that
   * address in, so it has to be written over the address they are actually writing, not over a
   * constant that drifts away from it the moment they do the work.
   */
  const SHIPPED_RELAY = (liftedOrigins.find(([, o]) => o) || [, RELAY_PLACEHOLDER])[1];

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
    ['H16', 'the code with the relay beside it', `${SHIPPED_RELAY} und der Code ${MINTED}`],
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
    ['R01', 'on its own line, bare', `Server:\n${SHIPPED_RELAY}\n`],
    ['R02', 'with a trailing slash', `Server: ${SHIPPED_RELAY}/`],
    ['R03', 'inside <angle brackets>', `Server: <${SHIPPED_RELAY}>`],
    ['R04', 'ending a sentence with a full stop', `Der Server ist ${SHIPPED_RELAY}.`],
    ['R05', 'followed by a comma', `${SHIPPED_RELAY}, und der Code folgt.`],
    ['R06', 'inside German quotation marks', `Server: „${SHIPPED_RELAY}“`],
  ];
  for (const [id, what, raw] of relayForms) {
    const got = parseInvitePaste(raw).origin;
    if (got === SHIPPED_RELAY) {
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

/**
 * Run only when this file IS the program. `tests/tier1/release-gate.test.js` §3 imports
 * `relayVerdict` and `RELAY_PLACEHOLDER` from here to prove the gate's verdict behaviourally
 * rather than by grepping this source, and an import that exited the process would take the
 * whole tier-1 run with it.
 */
const RUN_DIRECTLY = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

const SIMULATE_AT = process.argv.indexOf('--simulate');

if (RUN_DIRECTLY && SIMULATE_AT >= 0) {
  simulate(process.argv[SIMULATE_AT + 1] ?? '');
} else if (RUN_DIRECTLY) {
  main().catch((e) => {
    console.error('mom-test-probe: unexpected failure —', e && e.stack ? e.stack : e);
    process.exit(2);
  });
}
