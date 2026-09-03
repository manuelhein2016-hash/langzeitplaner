// src/js/feedback/report.js — the payload, and the promise that the preview is the payload.
// LZP-1009 · stories 21.1, 21.3, 21.4 · ADR 004.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ONE FUNCTION BUILDS BOTH THE SCREEN AND THE WIRE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The preview screen is the feature. Its promise is „genau dieser Text verlässt deinen Mac", and
// the only way to keep a promise like that is to make the two things the SAME OBJECT rather than
// two renderings of one source that a later edit can pull apart.
//
// So `buildReport()` returns `{ text, image, bytes }`, where:
//
//   · `text` is what the preview displays, verbatim, no re-formatting on the way to the screen;
//   · `bytes` is `TextEncoder().encode(text)` — the request body's text half, byte for byte;
//   · `image` is the redacted PNG, shown in an `<img>` on the same screen.
//
// `tests/tier1/feedback.test.js` §4 asserts the identity — that the string handed to the
// transport is `===` the string handed to the preview — because "we render the same data twice"
// is a claim two functions can stop honouring silently, and "it is the same string" is not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT CARRIES, AND THE ARGUMENT FOR EACH
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   her free text (REQUIRED)  — the only part that matters; without it there is no report
//   app version + build       — "it does that in 2.0.3" is the first question anyone asks
//   macOS version             — the second question
//   which screen              — Einstellungen, Familienkreis, the board itself
//   a ring buffer of STRUCTURAL events — see `events.js`; a token grammar, not a log
//   the redacted board PNG    — see `redact.js`; geometry, never glyphs
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT NEVER CARRIES — enumerated here because the list is the specification
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   entry text · note text · scratchpad text · category names (A3) · member display names ·
//   member colours · the identity key, the device key, the recovery key, any wrap · the raw
//   space id · the relay origin · anything that was not on the preview screen.
//
// ██ THE RAW SPACE ID IS THE SUBTLE ONE. ██ It is not secret in the sense a note is — the relay
// already stores it — but it is the FAMILY'S CORRELATION HANDLE: with it, a report and a row in
// the relay's database are the same family, and story 21.3's promise about what the operator can
// see stops holding. So what goes out is `spaceKind` — the word „Familienkreis" or „allein" —
// and nothing that could be joined on. `tests/tier1/feedback.test.js` §5 greps the assembled
// payload for the fixture space id in all three spellings.

import { c } from './copy.js';
import { readEvents, droppedCount, EVENT_KINDS } from './events.js';

const TE = new TextEncoder();

/**
 * Which screen the person was on. A closed set: „Bildschirm" is a field an over-helpful future
 * edit would happily fill with a sheet title, and sheet titles in this product include
 * „Eintrag bearbeiten — Zahnarzt".
 */
export const SCREENS = Object.freeze(['board', 'settings', 'family', 'firstrun', 'print', 'other']);

/** The kinds of space a report may name. Never an id. */
export const SPACE_KINDS = Object.freeze(['solo', 'personal', 'family']);

const SPACE_WORD = Object.freeze({
  de: { solo: 'allein (kein Familienkreis)', personal: 'eigene Geräte', family: 'Familienkreis' },
  en: { solo: 'solo (no family circle)', personal: 'own devices', family: 'family circle' },
});

/** `2026-09-03 14:22` — no seconds, no timezone name, no locale surprises. */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `hh:mm:ss` for one event line. */
function clockOf(ms) {
  if (!ms) return '  --:--  ';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * One event as one line. Built from the kind's own field table, so an event kind added to
 * `events.js` without a line format here prints its fields rather than nothing — and an event
 * that somehow held a field the table does not name prints nothing for it.
 */
function eventLine(e) {
  const spec = EVENT_KINDS[e.k];
  if (!spec) return null;
  const parts = [e.k];
  for (const name of Object.keys(spec.fields)) {
    if (e[name] === undefined) continue;
    parts.push(`${name}=${e[name]}`);
  }
  return `${clockOf(e.t)}  ${parts.join(' ')}`;
}

const RULE = '─'.repeat(66);

/**
 * Assemble the report.
 *
 * @param {Object} p
 * @param {string} p.text            her free text — REQUIRED, and the only free text in the payload
 * @param {'de'|'en'} p.lang
 * @param {string} p.appVersion      e.g. "2.0.0"
 * @param {string} p.build           e.g. "1041" or a short commit
 * @param {string} p.system          e.g. "macOS 15.2"
 * @param {string} p.screen          one of `SCREENS`
 * @param {string} p.spaceKind       one of `SPACE_KINDS`
 * @param {number} p.now             ms since epoch
 * @param {{bytes:Uint8Array,w:number,h:number,counts:Object}|null} [p.image]
 * @returns {{ text:string, bytes:Uint8Array, image:Uint8Array|null, imageMeta:Object|null,
 *            totalBytes:number }}
 */
export function buildReport(p) {
  const lang = p.lang === 'en' ? 'en' : 'de';
  const T = (k, ...a) => c(lang, k, ...a);
  const unknown = T('rUnknown');

  // Her text is the one field that may contain anything, and it is the one field she typed
  // herself and is reading back on the next screen. It is trimmed and nothing else: not
  // "sanitised", not escaped, not shortened. Changing what she wrote would break the promise as
  // surely as adding a field would.
  const her = String(p.text == null ? '' : p.text).trim();

  const screen = SCREENS.includes(p.screen) ? p.screen : 'other';
  const kind = SPACE_KINDS.includes(p.spaceKind) ? p.spaceKind : 'solo';

  const lines = [];
  lines.push(T('rHead'));
  lines.push(RULE);
  lines.push(pad(T('rVersion')) + `${safe(p.appVersion, unknown)} (${safe(p.build, unknown)})`);
  lines.push(pad(T('rSystem')) + safe(p.system, unknown));
  lines.push(pad(T('rScreen')) + `${screen} · ${SPACE_WORD[lang][kind]}`);
  lines.push(pad(T('rWhen')) + stamp(Number.isFinite(p.now) ? p.now : 0));
  lines.push('');
  lines.push(T('rText'));
  lines.push(RULE);
  lines.push(her);
  lines.push('');
  lines.push(T('rEvents'));
  lines.push(RULE);
  const evs = readEvents().map(eventLine).filter((l) => l !== null);
  if (evs.length === 0) lines.push(T('rEventsNone'));
  else lines.push(...evs);
  const more = droppedCount();
  if (more > 0) lines.push(T('rEventsMore', more));
  lines.push('');
  lines.push(T('rImage'));
  lines.push(RULE);
  const img = p.image && p.image.bytes ? p.image : null;
  if (img) {
    lines.push(T('rImageLine', img.w, img.h, Math.round(img.bytes.length / 1024),
      (img.counts && img.counts.redactions) || 0));
  } else {
    lines.push(T('rImageNone'));
  }
  lines.push('');

  const text = lines.join('\n');
  const bytes = TE.encode(text);
  return {
    text,
    bytes,
    image: img ? img.bytes : null,
    imageMeta: img ? { w: img.w, h: img.h, bytes: img.bytes.length, redactions: (img.counts || {}).redactions || 0 } : null,
    totalBytes: bytes.length + (img ? img.bytes.length : 0),
  };
}

function pad(label) { return (label + ':').padEnd(14, ' '); }

/**
 * A version-shaped or system-shaped value, or the word „unbekannt".
 *
 * Narrow on purpose. `appVersion`, `build` and `system` all arrive from the native shell, and a
 * shell that answered with an error string would otherwise put that string in the payload —
 * which is the whole category of accident this ticket exists to make impossible.
 */
function safe(v, fallback) {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/.test(v) ? v : fallback;
}

/**
 * The wire body. **There is no `to:` field and there cannot be one.**
 *
 * A payload-specified recipient is an open relay: anyone on the internet could POST here with
 * `to: <someone else>` and have this server deliver mail on their behalf. The destination is
 * server configuration (`server/core/handlers/feedback.js` CTX_EXTENSIONS `feedbackSink`), and
 * the server refuses a body that carries a recipient-shaped field rather than ignoring it — an
 * ignored field is a field somebody will start relying on.
 *
 * `report` and `image` are the two things the preview showed. `device` is the self-attested
 * signature: see the handler's `PROVES` / `PROVES_NOT`, which are the honest sentences about
 * what it is worth.
 *
 * @param {{text:string, image:Uint8Array|null}} built
 * @param {{pub:string, sig:string}|null} device
 * @returns {Object} the JSON body
 */
export function wireBody(built, device) {
  const body = { v: 1, report: built.text, image: built.image ? b64(built.image) : null };
  if (device && typeof device.pub === 'string' && typeof device.sig === 'string') {
    body.device = { pub: device.pub, sig: device.sig };
  }
  return body;
}

/** base64url, no padding — the spelling everything else in this protocol uses. */
export function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const std = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The bytes the device signature covers: the report text, then the image, with a domain prefix so
 * a signature over a feedback report can never be replayed as a signature over anything else this
 * product signs (`net.js` SIGNED_PREFIX is `lzp/v2\n`; this is a sibling, not the same string).
 *
 * @param {{bytes:Uint8Array, image:Uint8Array|null}} built @returns {Uint8Array}
 */
export function signedBytes(built) {
  const prefix = TE.encode('lzp/feedback/v1\n');
  const img = built.image || new Uint8Array(0);
  const out = new Uint8Array(prefix.length + built.bytes.length + 1 + img.length);
  out.set(prefix, 0);
  out.set(built.bytes, prefix.length);
  out[prefix.length + built.bytes.length] = 0x0a;
  out.set(img, prefix.length + built.bytes.length + 1);
  return out;
}
