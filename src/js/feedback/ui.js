// src/js/feedback/ui.js — „Rückmeldung senden": two screens, one promise.  LZP-1009.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PRINCIPLE 10 — THE BOARD IS NOT A MESSENGER
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This is reachable from **Einstellungen → Hilfe** and from nowhere else. There is no floating
// button on the board, no „?" bubble in a corner, no badge, no toast that offers to collect a
// report after an error. Two reasons, and the second is the one that would be forgotten:
//
//   1. The board is the one screen this product is about. A permanent widget on it is clutter on
//      the only surface that must stay quiet.
//   2. **A button that is always visible makes the tester permanently aware she is being
//      studied.** The PO's mother is using a calendar, not participating in a beta. She should be
//      able to forget the report exists until the moment she wants it.
//
// Nothing here is sent to a family member and nothing here reaches a board: a report goes out of
// band to the developer or it does not go at all.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PRINCIPLE 9 — NO SURVEILLANCE MECHANICS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Nothing in this file runs on a timer, on boot, on a crash, on a version change, or on a count
// of anything. There is no „Wie gefällt dir …", no rating, no smiley, no „möchtest du uns
// helfen". One button, pressed by a human, or nothing happens — and the preview between the
// button and the wire is a screen she can leave.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO SCREENS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. **Schreiben.** One textarea. Her text is required: „ohne Text wird nichts verschickt."
//      A report with no sentence in it is a bundle of diagnostics about nothing, which is exactly
//      the telemetry this product refuses.
//   2. **Vorschau.** The whole payload, as text, in a monospaced box she can scroll and select;
//      the redacted image below it; the „was nie mitgeht" list beside it; and then Senden.
//      **The preview is not a summary of the payload. It is the payload** — see `report.js`.
//
// The fallbacks („Kopieren", „Als Datei sichern") are on the preview screen from the start and
// not only after a failure, because the relay being unreachable is itself worth reporting and a
// person whose Mac cannot reach anything should not have to fail once to discover the way out.

import { el, openSheet, toast } from '../ui.js';
import { getLang } from '../i18n.js';
import { c } from './copy.js';
import { buildReport, wireBody, signedBytes, b64, SCREENS } from './report.js';
import { renderRedactedBoard, pngDataUrl } from './redact.js';
import { installErrorTap, noteEvent, clearEvents } from './events.js';
import { feedbackPort, canSend } from './port.js';

/** Injected once at module init by `settings.js`. Everything here is optional. */
let env = {};

/**
 * @param {Object} [e]
 * @param {() => Element|null} [e.board]     how to find the board element
 * @param {() => string} [e.screen]          which screen the person is on, one of `SCREENS`
 * @param {() => number} [e.now]
 * @param {(name:string, data:Uint8Array|string) => Promise<boolean>} [e.saveFile]
 * @param {(text:string) => Promise<boolean>} [e.copyText]
 */
export function initFeedback(e) {
  env = e || {};
  installErrorTap();
}

const now = () => (typeof env.now === 'function' ? env.now() : Date.now());
const lang = () => (getLang() === 'en' ? 'en' : 'de');

/** macOS version out of the UA string, or „unbekannt". Never the whole UA — it is a fingerprint. */
function systemName() {
  try {
    const m = String(navigator.userAgent).match(/Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/);
    if (!m) return null;
    return `macOS ${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}`;
  } catch { return null; }
}

function screenName() {
  try {
    const s = typeof env.screen === 'function' ? env.screen() : 'settings';
    return SCREENS.includes(s) ? s : 'other';
  } catch { return 'other'; }
}

/** The board element, or null. A null board is a report without a picture, not a failure. */
function boardEl() {
  try {
    if (typeof env.board === 'function') return env.board();
    return document.querySelector('#board') || document.querySelector('.rows') || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open „Rückmeldung senden". The ONLY exported way in, and it is called from exactly one place:
 * the Hilfe section of Einstellungen.
 */
export function openFeedback() {
  const L = lang();
  const T = (k, ...a) => c(L, k, ...a);

  // The image is rendered ONCE, here, at the moment she opens the screen — before she has typed
  // anything and while the board still looks the way it looked when the bug happened. It is
  // rendered from the board that is behind the sheet, which is why this runs before `openSheet`.
  let image = null;
  const root = boardEl();
  if (root) {
    try { image = renderRedactedBoard(root); }
    catch (err) { image = null; noteEvent('error', { name: err && err.constructor && err.constructor.name }, now()); }
  }

  let her = '';
  let stage = 'write';
  let built = null;
  let sending = false;

  const api = openSheet({
    title: T('sheetTitle'),
    build: (body, a) => (stage === 'write' ? writeScreen(body, a) : previewScreen(body, a)),
    onClose: () => { clearEvents(); },
  });

  function rebuild() { api.rebuild(); }

  // ── screen 1 ────────────────────────────────────────────────────────────────────────────────
  function writeScreen(body) {
    body.appendChild(el('div', 'section-title', T('whatHappened')));
    const ta = document.createElement('textarea');
    ta.className = 'fb-text';
    ta.rows = 7;
    ta.placeholder = T('placeholder');
    ta.value = her;
    ta.style.cssText = 'width:100%;box-sizing:border-box;font:400 12.5px/1.55 var(--font);'
      + 'padding:8px 10px;border:1px solid var(--rule);border-radius:6px;resize:vertical;'
      + 'background:var(--paper);color:var(--ink)';
    ta.addEventListener('input', () => { her = ta.value; hint.hidden = ta.value.trim().length > 0; });
    body.appendChild(ta);

    const hint = el('p', 'hint', T('required'));
    hint.hidden = her.trim().length > 0;
    body.appendChild(hint);

    const foot = el('div', 'ctl');
    foot.style.cssText = 'margin-top:12px;display:flex;gap:8px;justify-content:flex-end';
    const next = el('button', 'btn-primary', T('next'));
    next.addEventListener('click', () => {
      her = ta.value;
      if (her.trim().length === 0) { hint.hidden = false; ta.focus(); return; }
      built = assemble();
      stage = 'preview';
      rebuild();
    });
    foot.appendChild(next);
    body.appendChild(foot);
    setTimeout(() => ta.focus(), 0);
  }

  function assemble() {
    const port = feedbackPort() || {};
    return buildReport({
      text: her,
      lang: L,
      appVersion: port.appVersion || env.appVersion,
      build: port.build || env.build,
      system: systemName(),
      screen: screenName(),
      spaceKind: port.spaceKind || 'solo',
      now: now(),
      image,
    });
  }

  // ── screen 2 — THE FEATURE ──────────────────────────────────────────────────────────────────
  function previewScreen(body) {
    body.appendChild(el('div', 'section-title', T('previewTitle')));
    body.appendChild(lead(T('previewLead')));

    // THE PAYLOAD, VERBATIM. `textContent` of the exact string that `wireBody` will carry — not a
    // re-render of the same data. Monospaced and selectable: she can read it, and she can copy a
    // line out of it if she wants to ask about one.
    const pre = el('pre', 'fb-payload');
    pre.textContent = built.text;
    pre.style.cssText = 'margin:8px 0 0;padding:10px 12px;max-height:230px;overflow:auto;'
      + 'font:400 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;'
      + 'word-break:break-word;background:var(--paper-2,#f7f7f4);border:1px solid var(--rule);'
      + 'border-radius:6px;color:var(--ink)';
    body.appendChild(pre);

    // THE PICTURE.
    body.appendChild(el('div', 'section-title', T('imageTitle')));
    body.appendChild(lead(T('imageLead')));
    if (built.image) {
      const img = document.createElement('img');
      img.className = 'fb-shot';
      img.alt = '';
      img.src = pngDataUrl(built.image);
      img.style.cssText = 'display:block;max-width:100%;margin-top:8px;border:1px solid var(--rule);'
        + 'border-radius:6px;background:#fff';
      body.appendChild(img);
    } else {
      body.appendChild(el('p', 'hint', T('imageNone')));
    }

    // WHAT NEVER GOES. Written out rather than implied, because "we do not send your entries" is
    // only believable next to the thing that IS being sent.
    body.appendChild(el('div', 'section-title', T('neverTitle')));
    const ul = el('ul', 'fb-never');
    ul.style.cssText = 'margin:6px 0 0;padding-left:18px;font:400 12px/1.7 var(--font);color:var(--ink-2)';
    for (const line of c(L, 'never')) ul.appendChild(el('li', null, line));
    body.appendChild(ul);

    // THE ACTIONS. Copy and save are always here — see the header.
    const foot = el('div', 'ctl');
    foot.style.cssText = 'margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center';

    const back = el('button', 'btn-ghost', T('back'));
    back.addEventListener('click', () => { stage = 'write'; rebuild(); });
    foot.appendChild(back);

    const copy = el('button', 'btn-ghost', T('copy'));
    copy.addEventListener('click', async () => {
      const ok = await copyToClipboard(built.text);
      toast(ok ? T('copied') : T('failedTitle'));
    });
    foot.appendChild(copy);

    const save = el('button', 'btn-ghost', T('save'));
    save.addEventListener('click', async () => {
      const ok = await saveToFile(built);
      toast(ok ? T('saved') : T('failedTitle'));
    });
    foot.appendChild(save);

    const spacer = el('span');
    spacer.style.cssText = 'flex:1';
    foot.appendChild(spacer);

    const send = el('button', 'btn-primary', T('send'));
    send.disabled = !canSend() || sending;
    send.addEventListener('click', () => doSend(send, status));
    foot.appendChild(send);
    body.appendChild(foot);

    const status = el('p', 'hint');
    status.style.cssText = 'margin-top:8px';
    if (!canSend()) status.textContent = T('noRelay');
    body.appendChild(status);
  }

  async function doSend(button, status) {
    const port = feedbackPort();
    if (!port || sending) return;
    sending = true;
    button.disabled = true;
    button.textContent = T('sending');
    status.textContent = '';
    try {
      let device = null;
      if (typeof port.sign === 'function' && typeof port.devicePub === 'string') {
        device = { pub: port.devicePub, sig: b64(await port.sign(signedBytes(built))) };
      }
      const res = await port.send(wireBody(built, device));
      const st = res && typeof res.status === 'number' ? res.status : 0;
      if (st >= 200 && st < 300) {
        stage = 'sent';
        api.close();
        sentSheet();
        return;
      }
      const code = res && res.body && res.body.error;
      status.textContent = st === 413
        ? T('tooLarge', Math.ceil(built.totalBytes / 1024), Math.ceil(((res.body || {}).max || 0) / 1024))
        : st === 429 ? T('rateLimited')
          : `${T('failedTitle')} ${T('failedBody')}${code ? ` (${code})` : ''}`;
    } catch (err) {
      noteEvent('error', { name: err && err.constructor && err.constructor.name }, now());
      status.textContent = `${T('failedTitle')} ${T('failedBody')}`;
    } finally {
      sending = false;
      button.disabled = false;
      button.textContent = T('send');
    }
  }

  function sentSheet() {
    openSheet({
      title: T('sentTitle'),
      narrow: true,
      build: (b) => { b.appendChild(lead(T('sentBody'))); },
      actions: [{ label: c(L, 'cancel') === 'Abbrechen' ? 'Schließen' : 'Close', kind: 'primary', run: (x) => x.close() }],
    });
  }

  function lead(text) {
    const p = el('p', null, text);
    p.style.cssText = 'margin:4px 0 0;font:400 12.5px/1.6 var(--font);color:var(--ink-2)';
    return p;
  }

  return api;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FALLBACKS — a report that cannot be sent must still be salvageable by hand
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** @param {string} text @returns {Promise<boolean>} */
export async function copyToClipboard(text) {
  try {
    if (typeof env.copyText === 'function') return !!(await env.copyText(text));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea trick, which works without permission */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

/**
 * Save the report beside the app's own data, as one `.txt` and one `.png`.
 *
 * The file half matters more than the clipboard half: the clipboard cannot hold the picture, and
 * the picture is the part a person could not reconstruct by hand.
 * @param {{text:string, image:Uint8Array|null}} built @returns {Promise<boolean>}
 */
export async function saveToFile(built) {
  const base = `LangzeitPlaner-Rueckmeldung-${new Date(now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  try {
    if (typeof env.saveFile === 'function') {
      const a = await env.saveFile(`${base}.txt`, built.text);
      const b = built.image ? await env.saveFile(`${base}.png`, built.image) : true;
      return !!(a && b);
    }
  } catch { return false; }
  // The browser-preview path. In the shipped shell `env.saveFile` is the native one.
  try {
    downloadBlob(`${base}.txt`, new Blob([built.text], { type: 'text/plain;charset=utf-8' }));
    if (built.image) downloadBlob(`${base}.png`, new Blob([built.image], { type: 'image/png' }));
    return true;
  } catch { return false; }
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * The Hilfe section of Einstellungen. `settings.js` calls this and knows nothing else about this
 * tree — the same shape as the family seam one section above it.
 * @param {HTMLElement} body @param {Object} api the sheet api, so the button can close it first
 */
export function buildHelpSection(body, api) {
  const L = lang();
  body.appendChild(el('div', 'section-title', c(L, 'sectionTitle')));
  const btn = el('button', 'btn-ghost', c(L, 'openButton'));
  btn.className = 'btn-ghost fb-open';
  btn.addEventListener('click', () => { api?.close?.(); openFeedback(); });
  body.appendChild(btn);
  body.appendChild(el('p', 'hint', c(L, 'sectionHint')));
}
