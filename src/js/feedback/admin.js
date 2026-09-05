// src/js/feedback/admin.js — „Berichte": the other end of the pipe, on ONE Mac.  LZP-1009.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ PRINCIPLE 10 IS STRUCTURAL HERE, NOT REMEMBERED ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > The board is not a messenger — no reply path, ever.
//
// This file draws the screen on which the PO reads what his mother wrote. That is precisely the
// screen on which a reply box would seem obvious, helpful, and one commit away. So:
//
//   **THERE IS NO `textarea`, NO INPUT, NO CONTENTEDITABLE AND NO „antworten" IN THIS MODULE, AND
//   `tests/tier2/feedback-admin.dom.js` §P10 ASSERTS BOTH THE RENDERED DOM AND THE SOURCE.**
//
// A reply path would not be a small feature. It would make the relay a two-way messenger between
// two people who are already in a Familienkreis together — which is the one thing the whole
// visibility design says the product is not — and it would do it on the surface that carries her
// unredacted prose. The way out is the way in: he telephones his mother.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ WHY THIS IS UNREACHABLE BY ANY SEQUENCE OF CLICKS ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The section is gated on `store.state.settings.reportsAdmin === true`, and **nothing under
// `src/js/` ever writes that key.** It is edited by hand, once, in `board.json`, on his Mac.
// Two properties fall out of that for free, and neither is a promise:
//
//   1. `core/ops.js:254` makes `pref.set` a `local`-space op, so the flag can never sync to the
//      family. A member who somehow acquired it would still only have it on their own machine.
//   2. There is no settings switch, no menu item, no URL and no keystroke that sets it. A test
//      greps the whole shipped tree for a write of it (§ADMIN in the tier-2 file), so the claim
//      is measured on every run rather than reviewed once.
//
// The second gate is the relay's: `sync_status().originConfigured`. A build with nothing pinned
// draws the heading and one honest sentence, because a reports view with nowhere to read from is
// a screen that would fail on its first press and say nothing useful about why.
//
// The third gate is the operator credential, and it is the relay's alone: `LZP_REPORTS_ADMIN_PUB`
// is server configuration, like `feedbackSink`. This flag decides whether the SECTION IS DRAWN;
// it decides nothing about whether the relay answers. A Mac that turned it on by hand and holds
// the wrong key gets a 401 and a sentence.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ THE ⚙ DOT COSTS ZERO NETWORK REQUESTS ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `reportsKnown \ reportsSeen ≠ ∅` — two local prefs, and the predicate is a set difference over
// them. Nothing polls, nothing checks on launch, nothing runs on a timer.
//
// What it MEANS, said plainly so the dot cannot quietly come to mean something else:
//
//   **„the last time you looked, there were reports you had not opened."**
//
// That is what an unread dot means in a mail client before it syncs, and it is the strongest
// thing a pure function of local state can honestly say. `reportsKnown` is refreshed by one
// thing only: opening Einstellungen, which draws this section, which lists. It survives a
// relaunch because both halves are on disk.
//
// ⚠ A ONCE-PER-LAUNCH POLL WAS CONSIDERED AND IS NOT BUILT. It would make this the product's
// SECOND automatic originator — after the update check, which cost a disclosure gate, a switch,
// a Datenschutz paragraph and an amendment to story 21.5 to have at all. It would cost exactly
// the bound D10 exists to hold, in exchange for a dot that is one press fresher. Refused.
//
// P9: no count, no banner, no sound, and NEVER on the board. It reuses the updater's mechanism
// verbatim (`app.css`'s `.update-hint #btn-settings::after`, 17.5 / 19.3) — 5 px, the accent
// gradient, never red, because nothing is wrong.

import { store } from '../store.js';
import { getLang } from '../i18n.js';
import { el, confirmSheet, toast } from '../ui.js';
import { ub64 } from '../core/b64.js';
import { c } from './copy.js';
import { pngDataUrl } from './redact.js';
import { copyToClipboard } from './ui.js';
import { openReportsClient } from './relay.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The three prefs, named in one place
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `admin` is hand-edited and never written by this product. `known` and `seen` are written here
 * and nowhere else. All three are `pref.set` in the `local` space (`core/ops.js:254`), so none of
 * them can reach a Familienkreis.
 */
export const REPORTS_PREFS = Object.freeze({
  admin: 'reportsAdmin',
  known: 'reportsKnown',
  seen: 'reportsSeen',
});

/** How long the relay keeps a report. Displayed, never enforced here — see `expiryLine`. */
export const RETENTION_DAYS = 90;

const settings = () => (store.state && store.state.settings) || {};
const lang = () => (getLang() === 'en' ? 'en' : 'de');
const T = (k, ...a) => c(lang(), k, ...a);

/** A pref that must be an array of short id strings, however the file on disk turned out. */
function idList(key) {
  const v = settings()[key];
  if (!Array.isArray(v)) return [];
  return v.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 64);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The gate, and the dot
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Whether this Mac has been told, by hand, that it is the one that reads reports. */
export const reportsAdminEnabled = () => settings()[REPORTS_PREFS.admin] === true;

/**
 * The dot's predicate, and the ONLY one — kept as one exported function for
 * `update-ui.js#updateHintActive`'s reason: the ⚙ and any future second surface must not be able
 * to drift apart about what the dot means.
 *
 * Pure. Reads two prefs, makes no call, opens nothing.
 */
export function reportsHintActive() {
  if (!reportsAdminEnabled()) return false;
  const seen = new Set(idList(REPORTS_PREFS.seen));
  return idList(REPORTS_PREFS.known).some((id) => !seen.has(id));
}

/**
 * Push the predicate to the one surface that shows it. Idempotent and cheap.
 *
 * Called from `settings.js#applySettingsToBody`, which `main.js` already runs at boot and on
 * every language change — so the dot survives a relaunch without this file needing a caller in
 * `main.js` and without anything running at startup that was not already running.
 */
export function refreshReportsChrome() {
  document.body.classList.toggle('reports-hint', reportsHintActive());
}

/**
 * Record the ids the relay just named. This is what makes the dot mean „the last time you
 * looked" — the set is replaced wholesale, so a report he deleted, or one the 90-day sweep took,
 * stops being able to light it.
 * @param {string[]} ids
 */
export function noteReportsKnown(ids) {
  const known = (Array.isArray(ids) ? ids : []).filter((s) => typeof s === 'string' && s);
  const seen = idList(REPORTS_PREFS.seen).filter((id) => known.includes(id));
  store.setSettings({ [REPORTS_PREFS.known]: known, [REPORTS_PREFS.seen]: seen });
  refreshReportsChrome();
}

/** Expanding a report is reading it. There is no other way to mark one, and no „alle gelesen". */
export function markReportSeen(id) {
  if (typeof id !== 'string' || !id) return;
  const seen = idList(REPORTS_PREFS.seen);
  if (seen.includes(id)) return;
  store.setSettings({ [REPORTS_PREFS.seen]: [...seen, id] });
  refreshReportsChrome();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The credential seam — the same shape as `port.js`, for the same reason
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The operator's device key, injected.
 *
 * This module may not import it: the private half is `identity.devSig.privateKey`, which lives
 * behind ADR 003 §7 gate 2's one dynamic door, and `settings.js` — which imports this file
 * statically on every launch, solo included — must stay on the near side of that door.
 *
 * So the direction is inverted exactly as `feedback/port.js` inverts it: `family/mount.js` binds
 * this beside `bindFeedback`, and until it does the section renders `aNoKey` and lists nothing.
 * That is not a stub; it is what every Mac but his correctly shows.
 *
 * @type {null|import('./relay.js').AdminCredential}
 */
let credential = null;

/** The injected bridge, or nothing — see `initReportsAdmin` below. @type {{invoke?:Function}} */
let env = {};

/** Called by `family/mount.js`. There is no other caller and there must not be. */
export function setReportsCredential(cred) {
  if (cred == null) { credential = null; return; }
  if (typeof cred.sign !== 'function' || typeof cred.devicePub !== 'string') {
    throw new TypeError('reports: a credential carries devicePub and sign(bytes)');
  }
  credential = cred;
}

/** @returns {null|import('./relay.js').AdminCredential} */
export function reportsCredential() { return credential; }

/**
 * The bridge, injectable — `feedback/ui.js#initFeedback`'s seam, for the same reason.
 *
 * In the product nothing calls this and `relay.js` finds `window.__TAURI__` itself. It exists so
 * that `tests/tier2/feedback-admin.dom.js` can drive the WHOLE path — the signature, the path
 * construction, `net.js`'s own `buildRequest`, the reply checks — against a bridge that answers
 * `sync_request` locally instead of over a socket. A tier-2 file that reached the deployed relay
 * would be a test that fails when the internet does, and one that mocked `openReportsClient`
 * would prove nothing about the two things most likely to be wrong: the signed string and the
 * path.
 *
 * @param {{invoke?:(cmd:string, args?:object)=>Promise<any>}} [e]
 */
export function initReportsAdmin(e) { env = e || {}; resetReportsCache(); }

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3b. ██ ONE OPEN OF EINSTELLUNGEN, ONE REQUEST ██ — and why this cache is not an optimisation
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// MEASURED AT THE LZP-1009 SECOND-PASS INTEGRATION (2026-09-05): opening ⚙ made **two** identical
// `GET /api/v1/feedback` calls, not one. The loop is short and entirely reasonable at every step:
//
//   build → `buildReportsSection` → `loadReports` → GET → `noteReportsKnown` → `store.setSettings`
//        → the store notifies → `main.js:262`'s `onChange` → `rebuildSettings()` → `api.rebuild()`
//        → build AGAIN → `buildReportsSection` → `loadReports` → GET
//
// It terminated only because the SECOND write of `reportsKnown` was value-identical and the store
// did not notify again. That is a coincidence of this data, not a property: a relay that returned
// the list in a different order, or a report arriving between the two calls, and the second write
// differs and the cycle runs again. **A render path that writes state which triggers a render is
// a loop with a lucky base case**, and this one has a network request inside it.
//
// So the render path stops asking. Rows fetched during ONE open of Einstellungen are kept, and a
// rebuild — of which there are many, every switch on the sheet causes one — redraws from them.
// `openSettings()` clears it, so re-opening the sheet is a fresh list, which is what a person
// pressing ⚙ to see whether anything arrived expects.
//
// ⚠ THIS IS NOT A PERFORMANCE PATCH AND MUST NOT BE READ AS ONE. The bound it restores is the one
// story 21.5 as amended is about: opening a screen originates ONE request, on one human press.
// `tests/tier2/lzp1009-dot.dom.js` §1 counts it and §2 proves the dot adds none.

/** Rows already fetched during this open of Einstellungen, or `null` before the first fetch. */
let cachedRows = null;
/** The reader they came from, so a rebuild can still fetch a picture without re-listing. */
let cachedClient = null;

/**
 * Forget what this open of Einstellungen fetched. Called by `settings.js#openSettings` — a NEW
 * open must see a new list — and by `initReportsAdmin`, so a test that swaps the bridge does not
 * inherit the previous one's rows.
 */
export function resetReportsCache() { cachedRows = null; cachedClient = null; }

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The section
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Draw „Berichte" into the settings sheet, after the Hilfe section.
 *
 * Synchronous, like every other section builder: the heading, the key and the placeholder are
 * drawn immediately and the list replaces the placeholder when the relay answers. A settings
 * sheet that waited on a bridge call would be a sheet that opens late on his Mac and on time on
 * everyone else's.
 *
 * @param {HTMLElement} body
 * @param {Object} [api] the sheet api; unused today, taken for the shape every other section has
 */
export function buildReportsSection(body, api) {
  if (!reportsAdminEnabled()) return;

  const head = el('div', 'section-title', T('aSectionTitle'));
  if (reportsHintActive()) head.appendChild(el('span', 'quiet-dot'));
  body.appendChild(head);
  body.appendChild(el('p', 'hint', T('aSectionHint')));

  // ── his own public key, and the reason it is on this screen ──────────────────────────────
  // It is the ENROLMENT PATH: `LZP_REPORTS_ADMIN_PUB` on the relay is this string. Without a
  // copy button the only way to get it out of a Mac is a debugger, which is how a release step
  // ends up being done wrong once and then never again the same way.
  const cred = reportsCredential();
  const keyRow = el('div', 'field');
  keyRow.appendChild(el('label', null, T('aMyKey')));
  const keyCtl = el('div', 'ctl');
  if (cred) {
    keyCtl.appendChild(el('span', 'val-wide mono rp-key', cred.devicePub));
    const copy = el('button', 'btn-ghost rp-copy', T('aCopyKey'));
    copy.style.cssText = 'height:22px;padding:0 9px;margin-left:8px';
    copy.addEventListener('click', async () => {
      const ok = await copyToClipboard(cred.devicePub);
      toast(ok ? T('aCopied') : T('aCopyFailed'));
    });
    keyCtl.appendChild(copy);
  } else {
    keyCtl.appendChild(el('span', 'val-wide', '—'));
  }
  keyRow.appendChild(keyCtl);
  body.appendChild(keyRow);
  body.appendChild(el('p', 'hint', cred ? T('aMyKeyHint') : T('aNoKey')));

  // ── the list ─────────────────────────────────────────────────────────────────────────────
  const listBox = el('div', 'rp-list');
  listBox.appendChild(el('p', 'hint rp-status', T('aLoading')));
  body.appendChild(listBox);
  body.appendChild(el('p', 'hint', T('aRetention', RETENTION_DAYS)));
  // P10, on the screen and not only in this file's header: the person reading is told, in the
  // place where he might look for one, that there is no reply box and why.
  body.appendChild(el('p', 'hint rp-noreply', T('aNoReply')));

  loadReports(listBox);
}

/**
 * Ask the relay for the list and render it.
 *
 * ⚠ THIS IS REACHED BY OPENING EINSTELLUNGEN AND BY NOTHING ELSE. There is no timer, no launch
 * hook and no retry. `openSettings()` is a ⌘, or a click on the ⚙ — a human gesture — and the
 * enclosing gesture is what makes this an originator a person pulled the trigger on. The request
 * itself is made in `relay.js#dispatch`; this module holds no transport.
 */
async function loadReports(box) {
  const status = box.querySelector('.rp-status');
  // ── THE REBUILD PATH. ── See §3b: a rebuild redraws, it does not re-ask. `cachedRows` is null
  // on the first draw after `openSettings()` and on nothing else, so this branch is taken exactly
  // by the redraws — the ones a person caused by flipping a switch three sections up.
  if (cachedRows && cachedClient) { renderReports(box, cachedRows, cachedClient); return; }
  let client;
  try {
    client = await openReportsClient({ credential: reportsCredential(), invoke: env.invoke });
  } catch (e) {
    console.warn('[reports] the reader could not be opened:', e);
    client = null;
  }
  if (!client) {
    // Not an error, and it must not read like one: no shell, no pinned origin, or no credential.
    if (status) status.textContent = reportsCredential() ? T('aNoOrigin') : T('aNoKey');
    return;
  }
  let res;
  try {
    res = await client.list();
  } catch (e) {
    if (status) status.textContent = `${T('aFailed')} (${(e && e.kind) || 'transport'})`;
    return;
  }
  const rows = res && res.status === 200 && res.body && Array.isArray(res.body.reports)
    ? res.body.reports
    : null;
  if (!rows) {
    if (status) status.textContent = `${T('aFailed')} (${statusWord(res)})`;
    return;
  }
  // Newest first, decided HERE rather than trusted from the wire: the order a reader reads in is
  // a property of the screen, and a relay that returned them in insertion order would silently
  // put the report he is waiting for at the bottom.
  const sorted = [...rows].sort((a, b) => (Number(b.receivedAt) || 0) - (Number(a.receivedAt) || 0));
  cachedRows = sorted;
  cachedClient = client;
  // ⚠ ORDER MATTERS HERE. The cache is filled BEFORE the prefs are written, because writing them
  // is what triggers the rebuild (§3b) — and a rebuild that arrives before the cache exists asks
  // the relay a second time, which is the defect this whole section is about.
  noteReportsKnown(sorted.map((r) => r.id).filter((id) => typeof id === 'string'));
  renderReports(box, sorted, client);
}

/** Draw a list that is already in hand. No await, no request, no pref write. */
function renderReports(box, sorted, client) {
  box.textContent = '';
  if (sorted.length === 0) {
    box.appendChild(el('p', 'hint rp-status', T('aNone')));
    return;
  }
  for (const r of sorted) box.appendChild(reportCard(r, client, box));
}

/** `404` / `401` / `429` as a word a person can repeat over the telephone. */
function statusWord(res) {
  const s = res && typeof res.status === 'number' ? res.status : 0;
  const code = res && res.body && typeof res.body.error === 'string' ? res.body.error : null;
  return code || String(s);
}

/**
 * One report, collapsed. Expanding it is what marks it read — there is no „als gelesen
 * markieren" and no bulk action, because both are ways to clear a dot without reading anything.
 */
function reportCard(r, client, box) {
  const card = el('div', 'rp-card');
  const seen = new Set(idList(REPORTS_PREFS.seen));
  const isNew = typeof r.id === 'string' && !seen.has(r.id);
  if (isNew) card.classList.add('rp-new');

  const head = el('button', 'rp-head');
  head.type = 'button';
  head.appendChild(el('span', 'rp-when', stamp(r.receivedAt)));
  head.appendChild(el('span', 'rp-expiry', expiryLine(r)));
  head.appendChild(el('span', 'rp-thread', threadLine(r)));
  card.appendChild(head);

  const bodyBox = el('div', 'rp-body');
  bodyBox.hidden = true;
  card.appendChild(bodyBox);

  let built = false;
  head.addEventListener('click', () => {
    bodyBox.hidden = !bodyBox.hidden;
    if (bodyBox.hidden) return;
    markReportSeen(r.id);
    card.classList.remove('rp-new');
    if (built) return;
    built = true;
    buildCard(bodyBox, r, client, box);
  });
  return card;
}

/**
 * HER PROSE, VERBATIM AND MONOSPACED — the same presentation `ui.js#previewScreen` gives it on
 * the other end of the pipe. That symmetry is the point: what she read before pressing „Senden"
 * and what he reads after are the same characters in the same face, so a question about a
 * character (an umlaut mangled, a line that wrapped) is answerable rather than a guess.
 *
 * `textContent`, never `innerHTML`: this is untrusted text that arrived over a network from a
 * route that accepts an anonymous POST from anyone who can reach it.
 */
function buildCard(bodyBox, r, client, box) {
  const pre = el('pre', 'rp-prose');
  pre.textContent = typeof r.prose === 'string' ? r.prose : '';
  bodyBox.appendChild(pre);

  // THE PICTURE, LAZILY. A list of thirty reports is thirty redacted PNGs; fetching them all to
  // draw a list nobody has expanded would be the one place this screen could become expensive,
  // and it would do it on his Mac's only link to the relay.
  const shot = el('div', 'rp-shot');
  bodyBox.appendChild(shot);
  if (r.hasImage === true) {
    const load = el('button', 'btn-ghost rp-img', T('aImageLoad'));
    load.type = 'button';
    load.addEventListener('click', async () => {
      load.disabled = true;
      const img = await imageFor(client, r.id);
      if (!img) { load.disabled = false; load.textContent = T('aFailed'); return; }
      load.remove();
      shot.appendChild(img);
    });
    shot.appendChild(load);
  } else {
    shot.appendChild(el('p', 'hint', T('aImageNone')));
  }

  const acts = el('div', 'rp-acts');
  const del = el('button', 'btn-ghost rp-delete', T('aDelete'));
  del.type = 'button';
  del.addEventListener('click', () => {
    confirmSheet({
      title: T('aDeleteTitle'),
      body: T('aDeleteBody'),
      confirmLabel: T('aDelete'),
      danger: true,
      onConfirm: async () => {
        let res;
        try { res = await client.remove(r.id); } catch { res = null; }
        if (res && res.status >= 200 && res.status < 300) {
          toast(T('aDeleted'));
          loadReports(box);
        } else {
          toast(`${T('aFailed')} (${statusWord(res)})`);
        }
      },
    });
  });
  acts.appendChild(del);
  bodyBox.appendChild(acts);
}

/** @returns {Promise<HTMLImageElement|null>} */
async function imageFor(client, id) {
  let res;
  try { res = await client.one(id); } catch { return null; }
  const b64 = res && res.status === 200 && res.body && res.body.report
    ? res.body.report.image
    : null;
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  let bytes;
  try { bytes = ub64(b64); } catch { return null; }
  const img = document.createElement('img');
  img.className = 'rp-png';
  img.alt = '';
  img.src = pngDataUrl(bytes);
  return img;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. The three lines on a collapsed card
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `2026-09-05 14:22` — `report.js#stamp`'s format, so both ends of the pipe read alike. */
function stamp(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `2026-12-04` — a date, not a countdown: a countdown is a thing that has to keep ticking. */
function day(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * „verfällt am 2026-12-04".
 *
 * SAID RATHER THAN IMPLIED, and that is the whole reason this line exists. The 90 days are
 * enforced by a sweep on the relay; a screen that showed only an arrival date would leave the
 * operator to work out that the thing he is looking at is going to disappear. The Datenschutz
 * copy tells the SENDER about the 90 days; this tells the READER, in the one place where it
 * changes what he does about it.
 */
function expiryLine(r) {
  const d = day(r.expiresAt);
  return d ? T('aExpires', d) : '';
}

/**
 * „signiert · A7b3Kq2p" or „ohne Signatur".
 *
 * The first eight characters of `devicePub` are a THREAD HANDLE and nothing else. What it buys is
 * exactly what `handlers/feedback.js#PROVES.device_continuity` says it buys: three reports from
 * one Mac read as one story instead of three strangers. `PROVES_NOT` is the other half and it is
 * not softened here — the key is self-minted, never enrolled, and a fresh one costs one keypair,
 * so the handle identifies a key and never a person.
 */
function threadLine(r) {
  if (r.signed !== true || typeof r.devicePub !== 'string' || r.devicePub.length < 8) {
    return T('aUnsigned');
  }
  return T('aSigned', r.devicePub.slice(0, 8));
}
