// src/js/update-ui.js — LZP-103. Stories 22.4 (the quiet hint) and 22.7 (the
// minimum-version notice). Deliverable 26.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────
//
// `platform/updater.js` decides everything: whether a check is due, what a
// manifest means, whether a build is newer, whether this client is below the
// declared minimum. It owns no strings and no pixels. This file owns the
// pixels and nothing else — it never parses a version, never compares two, and
// never decides what an update *is*. If you find yourself reaching for
// `compareVersions` in here, the logic belongs in the other file.
//
// ─────────────────────────────────────────────────────────────────────────────
// 22.4 — "ONLY as a quiet hint (app menu and settings), NEVER a modal"
// ─────────────────────────────────────────────────────────────────────────────
//
// The addendum's design note puts this in the quiet-signal family alongside the
// „neu" dot (17.5) and the sync states (19.3): *a dot, not a badge count*. v1's
// design language calls the same rule "silence is the design" (F11). So the
// entire vocabulary of this feature is:
//
//   1. an item in the native App menu — „Update verfügbar — neu starten" —
//      that simply does not exist when there is no update;
//   2. one line and one button inside the settings sheet, which the user has
//      to open on purpose;
//   3. a 5 px dot on the ⚙ button that opens that sheet.
//
// and that is all. No modal. No toast. No dock badge. No red circle with a
// number in it. No sound. Nothing on the board — not a strip, not a corner
// marker, not a colour change on a day. An update is the least urgent thing
// this product will ever have to say, and if the user never notices the hint,
// quitting the app applies the update anyway. That is the whole point: the
// hint is an *accelerator*, not a demand. The only reason it exists at all is
// so that someone who does want the new version today can have it in one click
// instead of learning that quitting is what does it.
//
// ── the ⚙ dot, stated as a judgment call ─────────────────────────────────────
// 22.4 says "app menu and settings". A dot on the button that opens settings is
// a reading, not a literal quotation, and it is the one place I deliberately
// went past the letter of the story. Two reasons: the native App menu does not
// exist in the browser preview or in any future non-macOS shell, so without the
// dot the hint has exactly one home and no visible surface at all; and the
// design note asks for *a dot*, which nothing else in this feature provides.
// It is one CSS class on one existing button (`body.update-hint`), so if the PO
// reads 22.4 more strictly than I did, deleting it is one line in app.css and
// one line below. Nothing else depends on it.
//
// ─────────────────────────────────────────────────────────────────────────────
// 22.7 — the minimum-version notice
// ─────────────────────────────────────────────────────────────────────────────
//
// "If a server protocol change ever requires a minimum client version, the
// update manifest enforces it and outdated clients say so in one plain sentence
// instead of failing quietly."
//
// Deliverable 26 calls this "the minimum-version screen". It is built here as a
// BAR under the toolbar rather than a screen, and that is deliberate: an
// outdated client's *board* is not broken. Every note, every bar, every
// scratchpad still works, still saves, still prints. What has stopped is sync.
// Taking the board away over a sync problem would be a bigger lie than saying
// nothing. So the sentence appears where a sentence about the app belongs —
// above the board, permanently, not dismissible, not animated — and the board
// underneath it carries on.
//
// It is gated on family mode because a solo install has no server to be too old
// for (21.5: solo mode talks to nothing). `familyMode` is injected; today
// nothing sets it and the bar is unreachable, which is correct — E3/WP-7 lands
// the flag.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TEST SEAM — dependency injection, not a switch
// ─────────────────────────────────────────────────────────────────────────────
//
// There is no real update server, so the states below have to be driven by a
// fake. The fake is injected the way every other collaborator in this app is:
// `initUpdateUI({updater, shell, familyMode, onChange})`, exactly like
// `initSettings`, `initFind`, `initLegend` and `initPrint`. A test builds a
// `createUpdater({port})` over its own port object — the updater module's own
// public API — and passes it in.
//
// What that buys, precisely: there is NO seam code in the shipped product. No
// `window.__lzpUpdater`, no `?fakeManifest=`, no `if (TEST)`, no build flag, no
// dead branch that a page script could reach. The shipped page has exactly one
// updater and it is built from the native bridge in `main.js`. A test replaces
// it by calling the same init the app calls, from inside the page, which is a
// thing only code already running in the page can do — and code already running
// in the page is code we wrote. `tests/tier2/update-ui.dom.js` asserts the
// absence of every hook shape listed above, so this claim stays true.

import { t, getLang } from './i18n.js';
import { el } from './ui.js';

// ── injected collaborators ───────────────────────────────────────────────────

/** @type {{checkOnLaunch:Function, checkDaily:Function, checkNow:Function, getState:Function}|null} */
let updater = null;
/** @type {{status:Function, setEnabled:Function, setDisclosed:Function, restart:Function, setMenuHint:Function}|null} */
let shell = null;
let familyMode = () => false;
let notify = () => {};
/** Persist whatever the 700 ms save debounce is still holding, before the app
 *  goes away. 11.1's promise ("no save button anywhere") has to survive a
 *  restart the user asked for just as it survives ⌘Q. */
let flush = async () => {};

/** Last `port.status()` we saw. The updater's own `getState()` does not carry
 *  `enabled`/`disclosed` — those are shell preferences, not update state — and
 *  the settings switch has to render from something. */
let shellStatus = null;

/** True only while a *manual* check is in flight. Renders as the word
 *  „Wird geprüft …" on one button. Never a spinner, and never on the board:
 *  19.3's rule is not scoped to sync. */
let checking = false;

/** Set when the user asked for a restart, so a second click cannot fire two
 *  relaunches at a shell that is already on its way out. */
let restarting = false;

let dailyTimer = null;

/**
 * @param {{updater?:object|null, shell?:object|null,
 *          familyMode?:() => boolean, onChange?:() => void}} deps
 */
export function initUpdateUI({
  updater: u = null, shell: sh = null, familyMode: fm = null,
  onChange = null, flush: fl = null,
} = {}) {
  updater = u;
  shell = sh;
  familyMode = typeof fm === 'function' ? fm : () => false;
  notify = typeof onChange === 'function' ? onChange : () => {};
  flush = typeof fl === 'function' ? fl : async () => {};
  shellStatus = null;
  checking = false;
  restarting = false;
  // `lastMenuHint` is a de-duplicator for a shell we no longer hold. Forgetting
  // it here means the next shell is told the truth on the first refresh rather
  // than inheriting a belief about a different one.
  lastMenuHint = undefined;
  if (dailyTimer) { clearInterval(dailyTimer); dailyTimer = null; }
}

/** Present only inside a native shell. In the browser preview the whole feature
 *  is absent rather than broken — there is nothing there that could update. */
export const updatesSupported = () => !!updater;

// ── state, as the UI needs it ────────────────────────────────────────────────

/**
 * One frozen record the settings sheet, the menu hint and the 22.7 bar all
 * render from, so the three cannot disagree about what is true.
 *
 * @returns {Readonly<{supported:boolean, phase:string, enabled:boolean,
 *   disclosed:boolean, currentVersion:string|null, lastCheckAt:number|null,
 *   stagedVersion:string|null, availableVersion:string|null, hint:boolean,
 *   outdated:boolean, minimumVersion:string|null,
 *   message:{key:string,args:string[]}|null, error:string|null, checking:boolean}>}
 */
export function updateUIState() {
  if (!updater) {
    return Object.freeze({
      supported: false, phase: 'idle', enabled: false, disclosed: false,
      currentVersion: null, lastCheckAt: null, stagedVersion: null,
      availableVersion: null, hint: false, outdated: false, minimumVersion: null,
      message: null, error: null, checking: false,
    });
  }
  const s = updater.getState();
  const staged = s.stagedVersion ?? null;
  return Object.freeze({
    supported: true,
    phase: s.phase,
    enabled: shellStatus ? shellStatus.enabled === true : true,
    disclosed: shellStatus ? shellStatus.disclosed === true : false,
    currentVersion: s.currentVersion ?? (shellStatus ? shellStatus.currentVersion ?? null : null),
    lastCheckAt: s.lastCheckAt ?? (shellStatus ? shellStatus.lastCheckAt ?? null : null),
    stagedVersion: staged,
    availableVersion: s.available ? s.available.version : staged,
    // THE hint predicate, and the only one. A staged build is the only thing
    // that "one click restarts into the new version" can honestly promise —
    // an update that is merely *known about* has not been downloaded or
    // verified yet, so announcing it would offer a restart into the same
    // version the user already has.
    hint: staged != null,
    outdated: s.outdated === true,
    minimumVersion: s.minimumVersion ?? null,
    message: s.message ?? null,
    error: s.lastError ?? null,
    checking,
  });
}

/** The quiet dot's predicate, kept as one exported function so the ⚙ dot, the
 *  settings section and the native menu item cannot drift apart. */
export const updateHintActive = () => updateUIState().hint;

/** 22.7 — the bar exists only when the manifest declared a minimum this client
 *  is under AND a family space exists to be too old for. */
export const outdatedNoticeActive = () => {
  const s = updateUIState();
  return s.outdated && !!s.message && familyMode() === true;
};

// ── the cycle (22.3, driven from here so the UI can react to it) ─────────────

async function refreshShellStatus() {
  if (!shell || typeof shell.status !== 'function') return null;
  try {
    shellStatus = await shell.status();
  } catch {
    shellStatus = null;
  }
  return shellStatus;
}

async function afterCheck() {
  await refreshShellStatus();
  refreshUpdateChrome();
  notify();
}

/** 22.3 — the launch check. Silent: it neither blocks boot nor reports failure
 *  anywhere the user can see. A release host that is down is not the user's
 *  problem, and it is certainly not worth a dialog on startup. */
export async function runLaunchCheck() {
  if (!updater) return null;
  await refreshShellStatus();
  try {
    const r = await updater.checkOnLaunch();
    await afterCheck();
    return r;
  } catch {
    await afterCheck();
    return null;
  }
}

/**
 * 22.3 — "roughly daily". A half-hourly poll of a cheap predicate, rather than
 * one 24-hour `setTimeout`: a laptop that sleeps for eleven hours does not fire
 * a timer that was due at 03:00, and `dueForCheck` is the thing that actually
 * knows whether a check is owed. The poll costs one function call per 30 min
 * and makes no request unless the updater says one is due.
 */
export function startDailyTimer(intervalMs = 30 * 60 * 1000) {
  if (!updater) return null;
  if (dailyTimer) clearInterval(dailyTimer);
  dailyTimer = setInterval(() => {
    updater.checkDaily().then(afterCheck).catch(afterCheck);
  }, intervalMs);
  return dailyTimer;
}

export function stopDailyTimer() {
  if (dailyTimer) clearInterval(dailyTimer);
  dailyTimer = null;
}

/** „Auf Updates prüfen …" — the App-menu item and the settings button. The one
 *  path where a *result* is owed to the user, because they asked. */
export async function checkNow() {
  if (!updater || checking) return null;
  checking = true;
  refreshUpdateChrome();
  notify();
  // Asking for a check IS the disclosure: the user pressed a button labelled
  // „Jetzt suchen" sitting under the sentence that says what it does. Without
  // this the button would appear to work and then stop silently at the 21.5
  // gate inside the shell — the worst of both worlds.
  await discloseUpdateCheck();
  try {
    return await updater.checkNow();
  } catch {
    return null;
  } finally {
    checking = false;
    await afterCheck();
  }
}

/** 22.4 — "one click restarts into the new version". The shell quits and
 *  relaunches; the staged build is swapped in at that launch, before a window
 *  exists (see `applyStagedUpdateAtLaunch` in shell-macos/main.swift). Nothing
 *  here installs anything, and nothing here can: the whole port is four
 *  methods plus this one, and none of them can reach a board. */
export async function restartToUpdate() {
  if (!shell || typeof shell.restart !== 'function' || restarting) return null;
  if (!updateUIState().hint) return null; // nothing staged — nothing to restart into
  restarting = true;
  try {
    // 11.1 — the board is never explicitly saved, so a restart the user asked
    // for must not be the one way to lose the last thirty seconds of typing.
    // Both shells also flush on their own before quitting; doing it here means
    // the guarantee does not depend on which shell is running.
    await flush();
  } catch { /* a failed flush must not become a stuck button */ }
  try {
    return await shell.restart();
  } catch {
    restarting = false;
    return null;
  }
}

/** The settings switch. Turning it off stops the REQUEST, not just the hint —
 *  the shell re-checks the same flag (21.5), so this is a real off. */
export async function setAutoUpdate(on) {
  if (!shell || typeof shell.setEnabled !== 'function') return null;
  try {
    shellStatus = await shell.setEnabled(!!on);
  } catch {
    /* leave the cached status alone; the next status() call resyncs it */
  }
  // Turning the switch ON is an explicit act performed directly beneath the
  // sentence that describes the request (`updateCheckHint`). That is
  // disclosure, and it is the path an EXISTING install takes — one whose
  // `seenFirstRun` was set long before this feature existed, so the welcome
  // card will never be shown to it again.
  if (on) await discloseUpdateCheck();
  refreshUpdateChrome();
  return shellStatus;
}

/**
 * 21.5's consent gate — the half that was missing.
 *
 * INTEGRATION FIX (E1 review). Both shells implement `update_set_disclosed`,
 * both default `disclosed` to false, and both refuse to fetch a manifest or
 * download a byte until it is true. Nothing in the JavaScript ever called it.
 * The consequence was not cosmetic: `disclosed` stayed false forever, so the
 * launch check and the daily check stopped at the gate on every machine and
 * 22.3 / 22.5 ("nobody ever downloads anything manually again", "the whole
 * family converges automatically") were dead in the shipped app.
 *
 * The flag records one thing: that a human has been shown the sentence saying
 * the app asks a release host, once a day, whether a newer version exists.
 * It is therefore set from the three places where that sentence is on screen
 * and the user has just acted on it — never from a timer, never from boot.
 *
 * LZP-106's unlock screen is deliberately NOT one of them: it appears only on
 * a launch macOS actually refused, so most installs would never reach it and
 * the check would never run — exactly the bug this function exists to close.
 */
export async function discloseUpdateCheck() {
  if (!shell || typeof shell.setDisclosed !== 'function') return null;
  if (shellStatus && shellStatus.disclosed === true) return shellStatus; // already told
  try {
    shellStatus = await shell.setDisclosed(true);
  } catch {
    /* a shell that cannot record consent simply keeps refusing to check */
  }
  return shellStatus;
}

/** True once the user has been shown what the daily check does. Exported so a
 *  test can assert the gate rather than infer it. */
export const updateCheckDisclosed = () => updateUIState().disclosed;

// ── chrome: the dot, the menu item, the 22.7 bar ─────────────────────────────

/**
 * Push the current hint state to the three surfaces that show it. Idempotent
 * and cheap; safe to call from any redraw.
 */
export function refreshUpdateChrome() {
  const s = updateUIState();

  // 1 · the ⚙ dot. One class on <body>; app.css does the rest.
  document.body.classList.toggle('update-hint', s.hint);

  // 2 · the native App-menu item, via the existing shell-preference channel.
  //     `null` removes the item; a version string adds it. The shell rebuilds
  //     its menu, which is also how 13.7's language switch already works.
  if (shell && typeof shell.setMenuHint === 'function') {
    const want = s.hint ? s.stagedVersion : null;
    if (want !== lastMenuHint) {
      lastMenuHint = want;
      try { shell.setMenuHint(want); } catch { /* a menu is not worth a throw */ }
    }
  }

  // 3 · the 22.7 bar.
  renderOutdatedNotice();
}

/** What the shell was last told, so a redraw does not rebuild the native menu
 *  60 times a minute. Declared with the rest of the module state above in
 *  spirit; kept here next to its only reader. */
let lastMenuHint;

/**
 * 22.7 — one plain sentence, above the board, in family mode only.
 *
 * The sentence itself comes from the updater's `{key, args}` message, not from
 * anything decided here, so the wording that ships is the wording tier 1 tests.
 */
export function renderOutdatedNotice(host = document.querySelector('.app')) {
  const existing = document.getElementById('update-bar');
  if (!outdatedNoticeActive() || !host) {
    if (existing) existing.remove();
    return null;
  }

  const s = updateUIState();
  const sentence = t(s.message.key, ...(s.message.args || []));

  // Re-render in place rather than replace, so an open board does not flicker
  // and the node keeps its position in the flex column.
  const bar = existing || el('div', 'update-bar');
  bar.id = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.textContent = '';

  bar.appendChild(el('span', 'ub-dot'));
  bar.appendChild(el('span', 'ub-text', sentence));

  // Only offer the button that is actually true. If nothing is staged the app
  // is already downloading it (or will at the next check) and there is nothing
  // to click; saying "restart" then would restart into the same old version.
  if (s.hint && shell && typeof shell.restart === 'function') {
    const b = el('button', 'ub-act', t('updateRestart'));
    b.addEventListener('click', () => { restartToUpdate(); });
    bar.appendChild(b);
  }

  if (!existing) {
    // Directly under the toolbar, above the board — the app's chrome band.
    const toolbar = host.querySelector('.toolbar');
    if (toolbar && toolbar.nextSibling) host.insertBefore(bar, toolbar.nextSibling);
    else host.appendChild(bar);
  }
  return bar;
}

// ── the settings section (22.4's second home) ────────────────────────────────

/**
 * Appended to the settings sheet by `settings.js`. Everything the feature has
 * to say lives here: the installed version, the switch, when it last looked,
 * a manual check, and — when there is one — the update itself with its button.
 *
 * @param {HTMLElement} body   the sheet body
 * @param {{rebuild:Function, close:Function}} api
 */
export function buildUpdateSection(body, api) {
  const lang = getLang();
  const s = updateUIState();

  const title = el('div', 'section-title', t('updates'));
  // The dot, second home. Same predicate as the ⚙ and the menu item.
  if (s.hint) title.appendChild(el('span', 'quiet-dot'));
  body.appendChild(title);

  if (!s.supported) {
    // Browser preview, or any shell without the updater bridge. Absent, not
    // broken — and honest about why.
    body.appendChild(el('p', 'hint', t('updateUnsupported')));
    return;
  }

  // installed version — a fact, always shown, never a signal
  const ver = el('div', 'field');
  ver.appendChild(el('label', null, t('updateCurrentVersion')));
  const vc = el('div', 'ctl');
  vc.appendChild(el('span', 'val-wide', s.currentVersion || '—'));
  ver.appendChild(vc);
  body.appendChild(ver);

  // ── the update itself, when there is one (22.4) ────────────────────────────
  if (s.hint) {
    const row = el('div', 'update-row');
    const txt = el('div', 'ur-text');
    txt.appendChild(el('strong', null, `${t('updateAvailable')} — ${s.stagedVersion}`));
    txt.appendChild(el('span', null, t('updateStaged')));
    row.appendChild(txt);
    const b = el('button', 'btn-primary', t('updateRestart'));
    b.addEventListener('click', () => { restartToUpdate(); });
    row.appendChild(b);
    body.appendChild(row);
    // The half of 22.4 that is easy to forget: doing nothing also works.
    body.appendChild(el('p', 'hint', t('updateRestartHint')));
  }

  // ── the switch (21.5) ──────────────────────────────────────────────────────
  const sw = el('label', 'switch');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = s.enabled;
  cb.addEventListener('change', async () => {
    await setAutoUpdate(cb.checked);
    api.rebuild();
  });
  sw.appendChild(cb);
  sw.appendChild(document.createTextNode(t('updateAuto')));
  const swf = el('div', 'field');
  swf.appendChild(el('label', null, ''));
  const swc = el('div', 'ctl');
  swc.appendChild(sw);
  swf.appendChild(swc);
  body.appendChild(swf);
  body.appendChild(el('p', 'hint', s.enabled ? t('updateCheckHint') : t('updateOffHint')));

  // ── last check + manual check ──────────────────────────────────────────────
  const chk = el('div', 'field');
  chk.appendChild(el('label', null, t('updateCheckLabel')));
  const cc = el('div', 'ctl');
  const btn = el('button', 'btn-ghost', s.checking ? t('updateChecking') : t('updateCheckNow'));
  btn.disabled = s.checking;
  btn.addEventListener('click', async () => {
    // The button reports its own state rather than waiting for a rebuild, so
    // "I pressed it and nothing happened" cannot occur on a slow host. This is
    // a word changing on one button — not a spinner, and nothing on the board.
    btn.disabled = true;
    btn.textContent = t('updateChecking');
    await checkNow();
    api.rebuild();
  });
  cc.appendChild(btn);
  cc.appendChild(el('span', 'when',
    s.lastCheckAt ? t('updateLastChecked', formatWhen(s.lastCheckAt, lang)) : t('updateNeverChecked')));
  chk.appendChild(cc);
  body.appendChild(chk);

  // ── what went wrong, if anything (22.6) ────────────────────────────────────
  // A signature failure is the one update event that is genuinely worth a
  // user's attention, and it still does not get a modal — it gets the same
  // warning box the Ferien placeholder data gets. Nothing was installed.
  if (s.error === 'signature-or-download') {
    body.appendChild(el('p', 'warn', t('updateSignatureFailed')));
  } else if (s.error && !s.checking) {
    body.appendChild(el('p', 'hint', t('updateCheckFailed')));
  }

  // ── 22.7, restated where the user is already looking ───────────────────────
  if (s.outdated && s.message) {
    body.appendChild(el('p', 'warn', t(s.message.key, ...(s.message.args || []))));
  }
}

function formatWhen(ms, lang) {
  try {
    return new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(ms);
  }
}

// ── the bridge-backed shell port ─────────────────────────────────────────────
//
// The four UI-side commands, kept next to their only caller. `invoke` is
// injected so this module — like `platform/updater.js` — never reads `window`
// on its own, which is what lets the tier-1 and tier-2 fakes exist at all.

/** @param {(cmd:string, args?:object) => Promise<any>} invoke */
export function shellPort(invoke) {
  const json = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  };
  return {
    async status() {
      return json(await invoke('update_status', {}));
    },
    async setEnabled(on) {
      return json(await invoke('update_set_enabled', { value: !!on }));
    },
    async setDisclosed(on) {
      return json(await invoke('update_set_disclosed', { value: !!on }));
    },
    async restart() {
      return json(await invoke('update_restart', {}));
    },
    setMenuHint(version) {
      // Its own command rather than a `set_shell_pref` key, because that command
      // carries a BOOLEAN in both shells and this carries a version string.
      // Widening it would have made every existing preference stringly typed to
      // save one command name. `''` means "no hint" — JSON `null` and an absent
      // argument are not distinguishable across both bridges.
      // A menu label is never worth an unhandled rejection, so failure is
      // swallowed here rather than surfacing as a page error.
      return Promise.resolve(invoke('update_menu_hint', { version: version ?? '' }))
        .catch(() => null);
    },
  };
}
