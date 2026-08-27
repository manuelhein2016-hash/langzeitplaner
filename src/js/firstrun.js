// LZP-106 — the first-run unlock screen (story 22.2, amendment A12, deliverable 27).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS, AND THE ONE THING IT CANNOT DO
// ─────────────────────────────────────────────────────────────────────────────
// PO decision D1 is SHIP UNSIGNED: no Apple Developer ID, no notarization. So on
// every Mac this product reaches, macOS refuses the first launch, and macOS 15
// removed the Control-click → Open bypass that v1's spec note relied on (A12).
// The only remaining path is Systemeinstellungen → Datenschutz & Sicherheit →
// „Dennoch öffnen". This file is the screen that walks a non-technical person
// through it.
//
// The honest caveat, stated once, loudly, because everything else here depends
// on it: **while macOS is blocking the app, the app is not running, so no HTML
// inside the app can be on screen.** A first-run screen physically cannot
// appear at the moment of the block. That is not a bug in this file; it is the
// shape of the problem. It follows that this screen has THREE delivery
// surfaces, and only the first one reaches the blocked moment:
//
//   1. `renderUnlockDocument()` — the same content, both languages, as one
//      self-contained HTML file with no script and no external asset. It is
//      meant to ride ON the DMG next to the app ("Bitte zuerst lesen.html"),
//      where a double-click opens it in Safari — which Gatekeeper does not
//      block. This is the copy Mom actually reads. Wiring it into the DMG
//      belongs to LZP-107; this file only produces it.
//   2. `openUnlockHelp()` — on demand, from Settings, forever. This is the
//      screen the PO points at over the phone, and the one the second Mac uses.
//   3. `maybeShowUnlock()` — automatic, at most once, and ONLY when the native
//      host reports positive evidence of a Gatekeeper block. See `probeHost`.
//
// DETECTION IS NOT GUESSWORK (brief: "Detect honestly — do not show it
// speculatively"). This module never infers a block from the platform, the user
// agent, the absence of a flag, or a first-ever launch. It asks the host one
// question and believes the answer. A host that does not implement the probe —
// a browser, today's Swift shell, today's Tauri shell — yields `supported:false`
// and the screen never auto-appears. The cost of that choice is that the
// automatic path is dark until LZP-107/108 implement `gatekeeper_status`; the
// benefit is that no healthy launch ever shows a security screen, which is the
// failure mode that would actually damage this product.
//
// CSP: `default-src 'self'`, no `script-src` override. Every illustration below
// is inline SVG built with `createElementNS` — no <img>, no data: sprite, no
// webfont, no network. Nothing in this file fetches anything.
// ─────────────────────────────────────────────────────────────────────────────

import { t, getLang, setLang } from './i18n.js';
import { el } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LS_KEY = 'langzeitplaner.unlock';

// Gradient/clip ids must be unique per document: `renderUnlockDocument()` can
// serialise two copies of the same illustration (DE and EN) into one file, and
// duplicate ids would make the second copy reference the first one's paint.
let uid = 0;
const nextId = (p) => `lzp-${p}-${++uid}`;

// ── tiny persistence ─────────────────────────────────────────────────────────
// Deliberately NOT in store.js / settings: this is host state about the app
// bundle, not board content, and store.js is off limits for this ticket. One
// localStorage key, defensive on both sides — a locked-down WebView that throws
// on `localStorage` must not take the screen down with it.

function readSeen() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return {
      launches: Number(v?.launches) || 0,
      dismissedAt: typeof v?.dismissedAt === 'string' ? v.dismissedAt : null,
    };
  } catch {
    return { launches: 0, dismissedAt: null };
  }
}

function writeSeen(next) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* private mode, full quota, a paranoid WebView — none of it is fatal here */
  }
}

// ── the host probe ───────────────────────────────────────────────────────────
/**
 * Ask the native shell whether macOS actually blocked this bundle.
 *
 * CONTRACT for LZP-107 (Swift shell) and LZP-108 (Tauri) — implement the
 * command `gatekeeper_status`, returning a JSON **string**, matching the
 * convention the updater bridge already uses:
 *
 *   { "supported": true,
 *     "blocked":   true|false,
 *     "reason":    "quarantine-block" | "staged-quarantine" | null }
 *
 * `blocked` must mean *evidence*, not suspicion. The signal available natively
 * is the `com.apple.quarantine` extended attribute on `Bundle.main.bundlePath`:
 * its leading flag word records whether the user has already approved the
 * bundle. Present-and-unapproved on a bundle that is nonetheless executing is
 * the "they got in some other way, or a copy of this app will be blocked"
 * case; `staged-quarantine` is the updater case — a staged bundle carrying
 * quarantine means the NEXT launch is the one that gets refused, and this is
 * the last moment the app can say so.
 *
 * Anything unimplemented, unreachable or malformed is `supported:false`, and
 * `supported:false` never shows the screen.
 *
 * @returns {Promise<{supported:boolean, blocked:boolean, reason:string|null}>}
 */
export async function probeHost() {
  const off = { supported: false, blocked: false, reason: null };
  try {
    const T = typeof window !== 'undefined' ? window.__TAURI__ : null;
    const invoke = T?.core?.invoke || T?.invoke;
    if (!invoke) return off;
    const raw = await invoke('gatekeeper_status', {});
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!v || v.supported !== true) return off;
    return {
      supported: true,
      blocked: v.blocked === true,
      reason: typeof v.reason === 'string' ? v.reason : null,
    };
  } catch {
    // An unknown command, a host that is not there, a reply that is not JSON —
    // all of it means "we do not know", and we do not guess.
    return off;
  }
}

/**
 * The whole auto-show decision, pure and separately testable.
 * @param {{supported:boolean, blocked:boolean}} host
 * @param {{launches:number, dismissedAt:string|null}} seen
 */
export function shouldAutoShow(host, seen) {
  if (!host || host.supported !== true || host.blocked !== true) return false;
  if (seen?.dismissedAt) return false;      // shown once, acknowledged, done
  if ((seen?.launches || 0) > 1) return false; // the app has opened fine before
  return true;
}

// ── illustrations ────────────────────────────────────────────────────────────
// Two drawings in the board's own language: one lilac hue family, hairlines,
// small type, no wizard chrome and no cartoon. They are schematic on purpose —
// a pixel-accurate fake of Systemeinstellungen would be a forgery that goes
// stale with every macOS release; a diagram that names the pane, the section
// and the button ages far better and survives being printed.

const svg = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  return n;
};

function svgText(x, y, str, { size = 7, fill = 'var(--ink-2)', weight = 400, anchor = 'start' } = {}) {
  const n = svg('text', {
    x, y, fill, 'font-size': size, 'font-weight': weight,
    'text-anchor': anchor, 'font-family': 'var(--font)',
  });
  n.textContent = str;
  return n;
}

function frame(viewBox, titleKey) {
  const root = svg('svg', { viewBox, class: 'unlock-fig', role: 'img' });
  const tid = nextId('t');
  const title = svg('title', { id: tid });
  title.textContent = t(titleKey);
  root.setAttribute('aria-labelledby', tid);
  root.appendChild(title);
  return root;
}

/** Step 1 — Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen". */
function figureSettings() {
  const s = frame('0 0 320 176', 'unlockStep1Title');

  const gid = nextId('g');
  const defs = svg('defs', {});
  const grad = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '0' });
  grad.appendChild(svg('stop', { offset: '0', 'stop-color': 'var(--accent-a)' }));
  grad.appendChild(svg('stop', { offset: '1', 'stop-color': 'var(--accent-b)' }));
  defs.appendChild(grad);
  s.appendChild(defs);

  // window
  s.appendChild(svg('rect', {
    x: 6, y: 6, width: 308, height: 164, rx: 8,
    fill: 'var(--surface)', stroke: 'var(--line-1)', 'stroke-width': 1,
  }));
  // titlebar
  s.appendChild(svg('path', {
    d: 'M6 14a8 8 0 0 1 8-8h292a8 8 0 0 1 8 8v10H6z',
    fill: 'var(--chrome)',
  }));
  s.appendChild(svg('line', { x1: 6, y1: 24, x2: 314, y2: 24, stroke: 'var(--line-1)' }));
  [['#FF5F57', 17], ['#FEBC2E', 26], ['#28C840', 35]].forEach(([c, cx]) => {
    s.appendChild(svg('circle', { cx, cy: 15, r: 3, fill: c }));
  });
  s.appendChild(svgText(160, 18, t('unlockUiSysprefs'), { size: 8.5, weight: 500, fill: 'var(--ink-2)', anchor: 'middle' }));

  // sidebar
  s.appendChild(svg('path', { d: 'M6 24h100v138a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8z', fill: 'var(--chrome)' }));
  s.appendChild(svg('line', { x1: 106, y1: 24, x2: 106, y2: 170, stroke: 'var(--line-1)' }));

  // three quiet sidebar rows above the highlighted one
  [36, 50, 64].forEach((y) => {
    s.appendChild(svg('rect', { x: 14, y, width: 9, height: 9, rx: 2, fill: 'var(--line-1)' }));
    s.appendChild(svg('rect', { x: 28, y: y + 3, width: 52, height: 3.5, rx: 1.75, fill: 'var(--line-1)' }));
  });

  // the row that matters
  s.appendChild(svg('rect', {
    x: 11, y: 78, width: 88, height: 26, rx: 6,
    fill: 'var(--chip)', stroke: 'var(--ink-4)', 'stroke-width': 1,
  }));
  s.appendChild(svg('rect', { x: 16, y: 86, width: 9, height: 9, rx: 2, fill: 'var(--ink-1)' }));
  s.appendChild(svgText(30, 89, t('unlockUiPaneL1'), { size: 8, weight: 600, fill: 'var(--ink-1)' }));
  s.appendChild(svgText(30, 98, t('unlockUiPaneL2'), { size: 8, weight: 600, fill: 'var(--ink-1)' }));

  [116, 130].forEach((y) => {
    s.appendChild(svg('rect', { x: 14, y, width: 9, height: 9, rx: 2, fill: 'var(--line-1)' }));
    s.appendChild(svg('rect', { x: 28, y: y + 3, width: 44, height: 3.5, rx: 1.75, fill: 'var(--line-1)' }));
  });

  // right pane: two dimmed groups, then the Sicherheit section at the bottom
  [[36, 150], [52, 96]].forEach(([y, w]) => {
    s.appendChild(svg('rect', { x: 118, y, width: w, height: 4, rx: 2, fill: 'var(--line-2)' }));
  });
  s.appendChild(svg('rect', { x: 118, y: 68, width: 128, height: 4, rx: 2, fill: 'var(--line-2)' }));

  // the "scroll to the bottom" cue — a hairline arrow, not an animation
  s.appendChild(svg('path', {
    d: 'M296 40v40m0 0l-4-5m4 5l4-5',
    stroke: 'var(--ink-4)', 'stroke-width': 1, fill: 'none', 'stroke-linecap': 'round',
  }));
  s.appendChild(svgText(292, 36, t('unlockUiScroll'), { size: 7, fill: 'var(--ink-4)', anchor: 'end' }));

  s.appendChild(svg('line', { x1: 118, y1: 88, x2: 302, y2: 88, stroke: 'var(--line-1)' }));
  s.appendChild(svgText(118, 102, t('unlockUiSecurity'), {
    size: 7, weight: 600, fill: 'var(--ink-3)',
  }));

  s.appendChild(svgText(118, 122, t('unlockUiBlocked1'), { size: 8, fill: 'var(--ink-1)' }));
  s.appendChild(svgText(118, 132, t('unlockUiBlocked2'), { size: 8, fill: 'var(--ink-1)' }));

  // the button, in the board's own accent — the single brightest thing here,
  // because it is the single thing the reader has to find on their own screen
  s.appendChild(svg('rect', {
    x: 118, y: 142, width: 78, height: 18, rx: 5, fill: `url(#${gid})`,
  }));
  s.appendChild(svg('rect', {
    x: 115.5, y: 139.5, width: 83, height: 23, rx: 7.5,
    fill: 'none', stroke: 'var(--ink-1)', 'stroke-width': 1.5,
  }));
  s.appendChild(svgText(157, 154, t('unlockUiOpenAnyway'), {
    size: 8.5, weight: 700, fill: 'var(--accent-ink)', anchor: 'middle',
  }));

  return s;
}

/** Step 2 — the warning comes back, and this time it has an „Öffnen" button. */
function figureAlert() {
  const s = frame('0 0 320 176', 'unlockStep2Title');

  const gid = nextId('g');
  const defs = svg('defs', {});
  const icon = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' });
  icon.appendChild(svg('stop', { offset: '0', 'stop-color': '#3B0B49' }));
  icon.appendChild(svg('stop', { offset: '0.55', 'stop-color': '#5C1268' }));
  icon.appendChild(svg('stop', { offset: '1', 'stop-color': '#A81E7E' }));
  defs.appendChild(icon);
  s.appendChild(defs);

  // the desktop behind it, kept almost invisible so the alert reads as "in front"
  s.appendChild(svg('rect', {
    x: 6, y: 6, width: 308, height: 164, rx: 8, fill: 'var(--bg-void)',
  }));

  // alert panel
  s.appendChild(svg('rect', {
    x: 40, y: 16, width: 240, height: 144, rx: 10,
    fill: 'var(--surface)', stroke: 'var(--line-1)', 'stroke-width': 1,
  }));

  // app icon
  s.appendChild(svg('rect', { x: 143, y: 30, width: 34, height: 34, rx: 8, fill: `url(#${gid})` }));
  s.appendChild(svg('rect', { x: 150, y: 40, width: 20, height: 3, rx: 1.5, fill: '#FFFFFF', opacity: 0.85 }));
  s.appendChild(svg('rect', { x: 150, y: 47, width: 20, height: 2, rx: 1, fill: '#FFFFFF', opacity: 0.45 }));
  s.appendChild(svg('rect', { x: 150, y: 52, width: 13, height: 2, rx: 1, fill: '#FFFFFF', opacity: 0.45 }));

  s.appendChild(svgText(160, 82, t('unlockUiAlert1'), { size: 8, weight: 600, fill: 'var(--ink-1)', anchor: 'middle' }));
  s.appendChild(svgText(160, 92, t('unlockUiAlert2'), { size: 8, weight: 600, fill: 'var(--ink-1)', anchor: 'middle' }));
  s.appendChild(svgText(160, 106, t('unlockUiAlert3'), { size: 7, fill: 'var(--ink-3)', anchor: 'middle' }));

  // buttons: the destructive one stays a plain outline, the safe one is marked
  s.appendChild(svg('rect', {
    x: 62, y: 126, width: 100, height: 21, rx: 5,
    fill: 'var(--surface)', stroke: 'var(--field-border)',
  }));
  s.appendChild(svgText(112, 140, t('unlockUiTrash'), { size: 8, fill: 'var(--ink-3)', anchor: 'middle' }));

  s.appendChild(svg('rect', { x: 190, y: 126, width: 68, height: 21, rx: 5, fill: 'var(--ink-1)' }));
  s.appendChild(svg('rect', {
    x: 187.5, y: 123.5, width: 73, height: 26, rx: 7.5,
    fill: 'none', stroke: 'var(--ink-1)', 'stroke-width': 1.5, opacity: 0.45,
  }));
  s.appendChild(svgText(224, 140, t('unlockUiOpen'), {
    size: 8.5, weight: 700, fill: '#FFFFFF', anchor: 'middle',
  }));

  return s;
}

// ── the screen ───────────────────────────────────────────────────────────────

function step(n, titleKey, bodyKey, figure) {
  const wrap = el('section', 'unlock-step');
  const head = el('div', 'unlock-step-head');
  head.appendChild(el('span', 'unlock-num', String(n)));
  head.appendChild(el('h2', null, t(titleKey)));
  wrap.appendChild(head);
  wrap.appendChild(el('p', null, t(bodyKey)));
  const fig = el('figure', 'unlock-figwrap');
  fig.appendChild(figure());
  wrap.appendChild(fig);
  return wrap;
}

/**
 * Build the screen's content (everything inside the layer) as a detached node.
 * Shared by the in-app screen and by `renderUnlockDocument()`, so the copy can
 * never drift between the version on the DMG and the version in the app.
 * @param {{onClose?:Function, onLang?:Function, standalone?:boolean}} opts
 */
function buildContent(opts = {}) {
  const card = el('div', 'unlock-card');

  const top = el('header', 'unlock-top');
  const kicker = el('p', 'unlock-kicker', t('appName'));
  top.appendChild(kicker);
  if (!opts.standalone) {
    const lang = el('button', 'unlock-lang');
    lang.type = 'button';
    lang.textContent = getLang() === 'de' ? 'English' : 'Deutsch';
    lang.addEventListener('click', () => opts.onLang?.());
    top.appendChild(lang);
  }
  card.appendChild(top);

  card.appendChild(el('h1', 'unlock-title', t('unlockTitle')));
  card.appendChild(el('p', 'unlock-lead', t('unlockLead')));

  const steps = el('div', 'unlock-steps');
  steps.appendChild(step(1, 'unlockStep1Title', 'unlockStep1Body', figureSettings));
  steps.appendChild(step(2, 'unlockStep2Title', 'unlockStep2Body', figureAlert));
  card.appendChild(steps);

  const foot = el('div', 'unlock-foot');
  foot.appendChild(el('p', 'unlock-done', t('unlockDone')));
  foot.appendChild(el('p', 'unlock-note', t('unlockNote')));
  foot.appendChild(el('p', 'unlock-why', t('unlockWhy')));
  card.appendChild(foot);

  if (!opts.standalone) {
    const acts = el('div', 'unlock-acts');
    const ok = el('button', 'btn-primary unlock-ok', t('unlockGotIt'));
    ok.type = 'button';
    ok.addEventListener('click', () => opts.onClose?.());
    acts.appendChild(ok);
    card.appendChild(acts);
  }

  return card;
}

let layer = null;
let keyHandler = null;
let lastFocus = null;

/** Is the unlock screen on screen right now? */
export const unlockOpen = () => !!layer;

/**
 * Show the screen. Not a modal over the board: it is an opaque surface that
 * replaces the view, because a person who has just met a security warning
 * should not have to read it through a blurred calendar.
 * @param {{auto?:boolean}} opts
 */
export function openUnlockHelp(opts = {}) {
  if (layer) return layer;
  lastFocus = document.activeElement;

  layer = el('div', 'unlock');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.setAttribute('aria-label', t('unlockTitle'));
  layer.dataset.auto = opts.auto ? '1' : '0';

  const render = () => {
    layer.textContent = '';
    layer.appendChild(
      buildContent({
        onClose: closeUnlockHelp,
        onLang: () => { setLang(getLang() === 'de' ? 'en' : 'de'); render(); focusFirst(); },
      })
    );
  };
  const focusFirst = () => layer.querySelector('.unlock-ok')?.focus();

  render();
  document.body.appendChild(layer);
  document.body.classList.add('unlock-on');

  // Keyboard-dismissible, and captured before main.js's own Escape chain so a
  // single press cannot both close this screen and clear a board selection.
  keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeUnlockHelp();
      return;
    }
    if (e.key === 'Tab') {
      // One focusable control loop — nothing behind this surface is reachable.
      const f = [...layer.querySelectorAll('button')];
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      f[next].focus();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', keyHandler, true);
  focusFirst();
  return layer;
}

export function closeUnlockHelp() {
  if (!layer) return false;
  const wasAuto = layer.dataset.auto === '1';
  window.removeEventListener('keydown', keyHandler, true);
  keyHandler = null;
  layer.remove();
  layer = null;
  document.body.classList.remove('unlock-on');
  if (wasAuto) {
    const seen = readSeen();
    writeSeen({ ...seen, dismissedAt: new Date().toISOString() });
  }
  try { lastFocus?.focus?.(); } catch { /* the node may be gone */ }
  lastFocus = null;
  return true;
}

/**
 * The boot hook. Records that a launch happened, asks the host once, and shows
 * the screen only on positive evidence. Never throws; a failure here must not
 * be able to keep the board from drawing.
 * @param {{probe?:Function}} [opts] — `probe` is the injection point for tests
 * @returns {Promise<boolean>} whether the screen was shown
 */
export async function maybeShowUnlock(opts = {}) {
  const seen = readSeen();
  writeSeen({ ...seen, launches: seen.launches + 1 });
  let host;
  try {
    host = await (opts.probe || probeHost)();
  } catch {
    return false;
  }
  if (!shouldAutoShow(host, seen)) return false;
  openUnlockHelp({ auto: true });
  return true;
}

// ── the standalone document (the copy that reaches the blocked moment) ───────
/**
 * The same two steps, both languages, as one self-contained HTML file: no
 * script, no external asset, no network. Intended to be written into the DMG
 * beside the app so a double-click opens it in Safari, which Gatekeeper does
 * not block. LZP-107 owns putting it there; this only produces the string.
 *
 * Requires a DOM to build (it reuses the exact nodes the in-app screen uses,
 * which is the point — one source of copy, not two).
 * @returns {string} a complete HTML document
 */
export function renderUnlockDocument() {
  const before = getLang();
  const parts = [];
  for (const lang of ['de', 'en']) {
    setLang(lang);
    const host = el('div', 'unlock');
    host.lang = lang;
    host.appendChild(buildContent({ standalone: true }));
    parts.push(host.outerHTML);
  }
  setLang(before);

  // The stylesheet is INLINED, not linked: this page is opened from a mounted
  // disk image where `src/css/app.css` does not exist. It is also not a second
  // hand-maintained copy of the rules — `collectStyles()` lifts the live rules
  // out of the already-loaded same-origin stylesheet, so the page on the DMG
  // cannot drift from the screen in the app.
  return [
    '<!doctype html>',
    '<html lang="de"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeText(t('unlockTitle'))}</title>`,
    `<style>${collectStyles()}</style>`,
    '</head><body class="unlock-standalone">',
    parts.join('<hr class="unlock-langrule">'),
    '</body></html>',
  ].join('\n');
}

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Every `:root` token block and every `.unlock*` rule from the app's own
 * stylesheets, plus the handful of shared primitives the card reuses. Reading
 * `cssRules` works because the sheet is same-origin — it is the app's own file.
 * A sheet that refuses to be read (it should not happen here) degrades to the
 * token fallback rather than throwing, because a slightly plain rescue page is
 * still a rescue page.
 */
function collectStyles() {
  const want = /(^|,|\s)(:root|\.unlock|\.btn-primary)/;
  const out = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules || [])) {
        const sel = r.selectorText || '';
        if (r.media && String(r.media.mediaText).includes('reduced-motion')) { out.push(r.cssText); continue; }
        if (sel && want.test(sel)) out.push(r.cssText);
      }
    }
  } catch { /* fall through to the token floor */ }
  out.push(
    'body.unlock-standalone{margin:0;background:var(--chrome);' +
    'font-family:var(--font);color:var(--ink-1)}',
    '.unlock-standalone .unlock{position:static;min-height:0;padding:32px 20px}',
    '.unlock-langrule{border:0;border-top:1px solid var(--line-1);margin:0}'
  );
  if (out.length <= 3) out.unshift(TOKEN_FLOOR);
  return out.join('\n');
}

const TOKEN_FLOOR =
  ":root{--ink-1:#3D2185;--ink-2:#6B5CA5;--ink-3:#8A7CB8;--ink-4:#A79ACC;" +
  "--surface:#FFF;--chrome:#FBFAFF;--chip:#EDE7FF;--line-1:#E4DFF3;--line-2:#EDE9F8;" +
  "--field-border:#D6CEF0;--bg-void:#FAF9FE;--accent-a:#A8E10C;--accent-b:#FFE01B;" +
  "--accent-ink:#3D2185;--font:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif}";

export default { openUnlockHelp, closeUnlockHelp, maybeShowUnlock, renderUnlockDocument };
