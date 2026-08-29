// src/js/family/familysettings.js — the A10 mount point.  ADR 005 §1.5.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AT ALL, GIVEN THAT IT IS TWENTY LINES OF DELEGATION
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 005 §1.5 budgets `settings.js` "~25 lines" for the whole of family mode, and the two
// sections that fill them live in files that import `crypto/` (`pairingui.js` does not, but the
// flow behind it does) and `sync/`. `settings.js` is in the boot graph: it is imported by
// `main.js` on every launch, solo or not. So `settings.js` may know that a family section
// EXISTS, and may not know what is in it.
//
// This module is the seam. `settings.js` reaches it through the same dynamic `import()` gate
// `main.js` uses for the engine — one door, named, asserted by
// `tests/tier1/network-scope.test.js` §2 — and everything below that door is loaded only on a
// Mac that has actually opted in.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THE THREE SECTIONS ARE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   „Familienkreis"    the opt-in itself — the relay's address, and the button that creates the
//                      personal space. Story 19.4. Present only while there is no space.
//   „Meine Geräte"     `pairingui.js`'s doorway (deliverable 21, story 19.5).
//   „Synchronisation"  `syncstatus.js`'s three states (deliverable 20, story 19.2/19.3).
//   „Schlüssel sichern" ADR 002 §7's recovery file. Present only once there IS a space.
//
// The order is the order a person meets them: you opt in, then you pair, then you occasionally
// wonder whether it is working, and then — the one that was missing — you make the copy that
// survives the Mac.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THIS FILE ADDED IN WP-9, AND THE FINDINGS THEY CLOSE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// P-4 named seven shipped modules that no entry point reaches, and said the sharp half out loud:
// three of them are DEFENCES, so "reachable from the test suite" is the exact shape of the
// problem and deleting them would close the row while making the product worse. Two of the three
// are reached from HERE, because this file is the family entry point and both of them are things
// the family entry point is supposed to do:
//
//   · `crypto/probe.js` — `platform/net.js` said in so many words *"family features are gated on
//     probeCrypto()"* and NOTHING called it, so they were gated on nothing. `probe.js`'s own
//     header names the three moments it must run at — „Familienkreis erstellen", „Familienkreis
//     beitreten", „Gerät koppeln" — and `assertSuiteAvailable()` below is that gate for the
//     first. It runs ON THE CLICK and never at render: a probe at render time would fire on
//     every ⚙ of every solo Mac, which is Principle 7's whole objection.
//
//   · `crypto/backup.js` — ADR 002 §7's recovery file. The onboarding tells a person to keep
//     this file and there was NO ROUTE TO IT, so the honest answer to „mein Mac ist kaputt" was
//     that there is none. `buildRecoverySection` is the route, and it renders the module's own
//     `EXPORT_SHEET_COPY` rather than paraphrasing it, so PO decision D8's two buttons — sealed
//     under a passphrase, or the identity block OMITTED — stay the two arguments the module
//     actually takes.
//
// P-7 — `http://` was accepted for every host. The origin is a free-text field saved on every
// keystroke and it alone decides where the whole personal board is sent; the opt-in button's
// entire validation was `if (!origin)`. `normalizeOrigin` now refuses a non-loopback `http://`
// (see `platform/net.js`'s header for what it costs and why the content is not the point), and
// this sheet says so BEFORE the button is pressed rather than throwing a NetError at it.
//
// The third defence, `sync/chain.js`, is NOT reachable from here and must not be made so: it
// belongs in `sync/personal.js`'s pull path, and an import that only made the module reachable
// would close the S5 row while leaving `S4-diverged` exactly as undetectable as it is today.

import { el, toast } from '../ui.js';
import { t, getLang } from '../i18n.js';
import { store } from '../store.js';
import { buildPairingSection } from './pairingui.js';
import { buildSyncSection } from './syncstatus.js';
import { FAMILY_PREFS, CLIENT_VERSION } from './engine.js';
import { probeCrypto, isSuiteAvailable, unavailableMessage } from '../crypto/probe.js';
import { normalizeOrigin, insecureOriginMessage, NetError } from '../platform/net.js';
import { exportBackup, passphraseStrength, EXPORT_SHEET_COPY, README } from '../crypto/backup.js';

/** Whichever of a `{de, en}` pair the sheet is currently speaking. */
const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);

/**
 * Mount every family section into the open settings sheet.
 *
 * @param {HTMLElement} body the sheet body
 * @param {{rebuild:Function, close:Function}} api the same `{rebuild, close}` every section takes
 * @param {{onOptIn:(origin:string) => Promise<void>,
 *          recoveryMaterial?:(() => {identity:Object, spaces:Object})|null}} [hooks]
 *        `recoveryMaterial` is null on a Mac with no space — there is no membership to back up —
 *        and is supplied by `family/mount.js`, which is the only module holding the armed
 *        identity and the key ring. See `buildRecoverySection`.
 */
export function buildFamilySections(body, api, hooks = {}) {
  buildOptInSection(body, api, hooks);
  buildPairingSection(body, api);
  buildSyncSection(body, api);
  buildRecoverySection(body, api, hooks);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CAPABILITY GATE — finding P-4, `crypto/probe.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The probe, run ONCE per session and only ever from a click.
 *
 * Memoised on the PROMISE rather than the result, so two fast clicks cannot start two probes;
 * a failure is not memoised, because the reason a probe fails ("insecure context") is exactly
 * the kind of thing a reload fixes.
 */
let probePromise = null;

/**
 * @returns {Promise<boolean>} true when this engine can run `LZP-CRYPTO-1`. On false the caller
 *          has already been told; there is nothing for it to add.
 */
async function assertSuiteAvailable() {
  if (!probePromise) probePromise = probeCrypto();
  let result;
  try {
    result = await probePromise;
  } catch (e) {
    probePromise = null;
    console.warn('[family] the crypto probe itself failed', e);
    return false;
  }
  if (isSuiteAvailable(result)) return true;
  // ADR 002 §1: "the family entry point stays disabled with one plain German sentence; solo mode
  // is completely unaffected". The sentence is the module's, not this file's — it deliberately
  // names no algorithm, because a person cannot act on „ECDH fehlt".
  toast(say(unavailableMessage(result)));
  return false;
}

/**
 * „Familienkreis" — the one moment a solo install becomes a syncing one.
 *
 * It is a TEXT FIELD and a button rather than a switch, because there is no default relay: ADR
 * 003 §1 names `https://<vercel-app>.vercel.app` and no such app exists yet. A switch would
 * imply the address was already known; a field asks the question the product actually has.
 *
 * Once a space exists this section becomes two facts and no controls. Turning sync back OFF is
 * deliberately not here: it is `POST /members/leave`, story 20.3, and it belongs with the rest
 * of the lifecycle rather than behind a toggle that would look like a display preference.
 */
function buildOptInSection(body, api, hooks) {
  const s = store.state.settings;
  body.appendChild(el('div', 'section-title', t('familySectionTitle')));

  const spaceId = s[FAMILY_PREFS.space];
  if (spaceId) {
    const row = el('div', 'field');
    row.appendChild(el('label', null, t('familyRelay')));
    const ctl = el('div', 'ctl');
    ctl.appendChild(el('span', 'val-wide', s[FAMILY_PREFS.origin] || '—'));
    row.appendChild(ctl);
    body.appendChild(row);

    const idRow = el('div', 'field');
    idRow.appendChild(el('label', null, t('familySpace')));
    const idCtl = el('div', 'ctl');
    idCtl.appendChild(el('span', 'val-wide mono', spaceId));
    idRow.appendChild(idCtl);
    body.appendChild(idRow);

    const d = store.diagnostics();
    body.appendChild(el('p', 'hint', t('familyThisMac', d.identity?.deviceShort || '—')));
    return;
  }

  const row = el('div', 'field');
  row.appendChild(el('label', null, t('familyRelay')));
  const ctl = el('div', 'ctl');
  const input = el('input');
  input.type = 'text';
  input.className = 'txt';
  input.placeholder = 'https://…';
  input.value = s[FAMILY_PREFS.origin] || '';
  input.spellcheck = false;
  input.autocomplete = 'off';
  // SAVED AS IT IS TYPED, and that is not a convenience. „Ich habe einen Code" one section down
  // needs this address and nothing else — the joiner has no identity and no space (ADR 002 §6.3
  // steps 4-6 are anonymous) — so a value that only existed inside this DOM node would make the
  // second Mac unable to reach the relay at all. `syncOrigin` alone does NOT arm family mode:
  // `readFamilyConfig` requires a `psp_…` too, so writing it early is inert until a space exists.
  const save = () => {
    const v = input.value.trim();
    if (v !== (store.state.settings[FAMILY_PREFS.origin] || '')) {
      store.setSettings({ [FAMILY_PREFS.origin]: v });
    }
  };
  input.addEventListener('input', save);
  input.addEventListener('change', save);
  ctl.appendChild(input);
  row.appendChild(ctl);
  body.appendChild(row);

  const acts = el('div', 'acts');
  const go = el('button', 'btn-primary', t('familyCreate'));
  go.type = 'button';
  go.addEventListener('click', async () => {
    save();
    const origin = input.value.trim();
    if (!origin) { toast(t('familyNeedRelay')); return; }
    // ── FINDING P-7 · THE SCHEME, CHECKED BEFORE ANYTHING IS MINTED ────────────────────────
    //
    // `normalizeOrigin` is the rule and this is not a second copy of it: the button asks the ONE
    // function that decides, and only chooses which sentence to show. A scheme mistake gets
    // `insecureOriginMessage()` — which explains what would be readable rather than saying
    // „ungültig" at an address the user can see nothing wrong with; anything else falls back to
    // the generic „keine Adresse" line, because a `ftp://` or a half-typed host is a typo and
    // not a security decision the person is making.
    //
    // It runs before the button is disabled on purpose: a refused address must leave the button
    // usable, since fixing the address is the very next thing that happens.
    try {
      normalizeOrigin(origin);
    } catch (e) {
      const insecure = e instanceof NetError && schemeOf(origin) === 'http:';
      toast(insecure ? say(insecureOriginMessage()) : t('familyNeedRelay'));
      return;
    }
    // ── FINDING P-4 · THE CAPABILITY GATE (ADR 002 §1, `crypto/probe.js`'s own header) ─────
    //
    // „Familienkreis erstellen" is the first of the three moments the probe exists for, and this
    // is the first time in the product's life that anything calls it. Before the identity is
    // minted, before the space key, before the relay is addressed: an engine that cannot do ECDH
    // must meet one sentence, not a TypeError four steps in.
    if (!(await assertSuiteAvailable())) return;
    go.disabled = true;
    try {
      await hooks.onOptIn(origin);
      // The space is created and the identity is durable, but this store was `init()`ed without
      // one — `usePersonalSpace()` refuses after `init()` for a reason ADR 006 §9.4 makes cheap:
      // `board.json` is the truth, so re-deriving costs nothing. A reload is the honest way to
      // say that, and it is the one place in this app that asks for one.
      toast(t('familyCreated'));
      api.close();
      location.reload();
    } catch (e) {
      go.disabled = false;
      toast(t('familyFailed', String((e && e.message) || e)));
    }
  });
  acts.appendChild(go);
  body.appendChild(acts);
  body.appendChild(el('p', 'hint', t('familySectionHint')));
}

/** The scheme a person actually typed, or `''` when what they typed is not a URL at all. */
function schemeOf(raw) {
  try {
    return new URL(String(raw)).protocol;
  } catch {
    return '';
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// „Schlüssel sichern" — ADR 002 §7's recovery file.  FINDING P-4, `crypto/backup.js`.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT WAS WRONG. `crypto/backup.js` is 2 000 lines of the artifact ADR 002 §7 describes, tested
// in tier 1, with `EXPORT_SHEET_COPY` written down to the last sentence — and no entry point in
// the product reached it. §8.12 records that a recovery key has no revocation and no leak
// detection, which is why D8 made the passphrase design load-bearing; a design that load-bearing
// with no door is a design nobody can be protected by.
//
// WHY IT IS HERE AND NOT IN `backup.js`. `src/js/backup.js` owns the v1 board export (⌘⇧E) and
// is in the BOOT GRAPH: `main.js` imports it on every launch, solo or not. Reaching
// `crypto/backup.js` from there would put PBKDF2, HKDF and the whole suite into a solo Mac's
// static import graph and redden `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate and
// `network-scope.test.js` §2 with it. This sheet is already behind the one dynamic door, and the
// thing being backed up — the membership, the recovery pair, the epoch ring — is family mode's.
//
// WHAT IT COSTS, MEASURED RATHER THAN ASSUMED. Two more modules are evaluated the moment a SOLO
// user opens ⚙ once (finding P-3's cost, which was five crypto modules and is now seven). No
// request, no keygen, no probe: `probeCrypto` runs on a click and `exportBackup` on a click, and
// `tests/attack/privacy-e5-silence.test.js` §5 pins both numbers so the next increase is a
// decision.
//
// THE ONE THING THIS FILE CANNOT REACH, AND THEREFORE ASKS FOR. The recovery pair is
// `armStore`'s `recovery`, and the epoch ring is `startEngine`'s `keyring`; both live in the
// handle `family/mount.js` holds and neither is in `store`. `mount.js` passes it as
// `hooks.recoveryMaterial`. On a Mac with no space there is nothing to back up and the section
// is not drawn at all — which is also what a solo ⚙ sees.

/**
 * @param {HTMLElement} body
 * @param {{rebuild:Function, close:Function}} api
 * @param {{recoveryMaterial?:(() => {identity:Object, spaces:Object})|null}} hooks
 */
function buildRecoverySection(body, api, hooks) {
  void api;
  const spaceId = store.state.settings[FAMILY_PREFS.space];
  if (!spaceId) return;                        // no membership, nothing to recover
  const material = typeof hooks.recoveryMaterial === 'function' ? hooks.recoveryMaterial : null;
  if (!material) return;                       // not armed this launch — see the note above

  body.appendChild(el('div', 'section-title', say(EXPORT_SHEET_COPY.title)));

  // D8's two outcomes, said out loud, under the one button that produces each. The copy is the
  // module's; this file chooses the language and nothing else. `sealsEntriesToo` and
  // `entriesNotSealed` are the line that distinguishes the two files' GUARANTEES, and S3 of the
  // ticket requires them under their own button rather than in a shared paragraph.
  const withPw = EXPORT_SHEET_COPY.withPassword;
  const boardOnly = EXPORT_SHEET_COPY.boardOnly;
  body.appendChild(el('p', 'hint', say(withPw.gain)));
  body.appendChild(el('p', 'hint', say(withPw.sealsEntriesToo)));
  body.appendChild(el('p', 'hint', say(withPw.lose)));

  // S7 — the requirement is shown BEFORE anything is typed. A rule that only ever appears as a
  // rejection is a rule the user argues with.
  const pwRow = el('div', 'field');
  pwRow.appendChild(el('label', null, say(withPw.label)));
  const pwCtl = el('div', 'ctl');
  const pw = el('input');
  pw.type = 'password';
  pw.className = 'txt';
  pw.spellcheck = false;
  pw.autocomplete = 'new-password';
  pwCtl.appendChild(pw);
  pwRow.appendChild(pwCtl);
  body.appendChild(pwRow);

  const hint = el('p', 'hint', say(EXPORT_SHEET_COPY.passphrase.hint));
  body.appendChild(hint);
  body.appendChild(el('p', 'hint', say(EXPORT_SHEET_COPY.notAnAccount)));
  body.appendChild(el('p', 'hint', say(EXPORT_SHEET_COPY.singlePointOfFailure)));

  const acts = el('div', 'acts');
  const sealed = el('button', 'btn-primary', say(withPw.label));
  sealed.type = 'button';
  const plain = el('button', 'btn-ghost', say(boardOnly.label));
  plain.type = 'button';
  acts.appendChild(sealed);
  acts.appendChild(plain);
  body.appendChild(acts);

  // The other button's honest half, next to it and not hidden behind it.
  body.appendChild(el('p', 'hint', say(boardOnly.lose)));
  body.appendChild(el('p', 'hint', say(boardOnly.entriesNotSealed)));

  // A WARNING, NOT A WALL (`PASSPHRASE_FLOOR.hard === false`, and §5a says why at length). The
  // label of the confirm button changes to „Trotzdem so sichern" so the user decides rather than
  // is told; `exportBackup`'s `onWeakPassphrase` is the belt to this braces and fires from
  // inside the seal, so „the sheet forgot to ask" is a testable condition.
  const weak = el('p', 'hint');
  weak.hidden = true;
  body.insertBefore(weak, hint);
  const measure = () => {
    const s = passphraseStrength(pw.value);
    const show = pw.value.length > 0 && s.weak && s.say;
    weak.hidden = !show;
    weak.textContent = show ? say(s.say) : '';
    sealed.textContent = show
      ? say(EXPORT_SHEET_COPY.passphrase.weakAnyway)
      : say(withPw.label);
  };
  pw.addEventListener('input', measure);

  const run = async (passphrase, button) => {
    // The probe again, and for the same reason as the opt-in: this is the third of the moments
    // `crypto/probe.js` names, and a sealed export on an engine with no PBKDF2 must be one
    // sentence rather than a rejected promise from four frames down. The board-only path is
    // deliberately NOT gated — §9's seam step 1 says so in so many words, because a board-only
    // file needs no crypto at all and must stay available on an engine that has none.
    if (passphrase !== null && !(await assertSuiteAvailable())) return;
    button.disabled = true;
    try {
      const { identity, spaces } = material();
      const file = await exportBackup(store.state, identity, spaces, passphrase, {
        exportedAt: new Date().toISOString().slice(0, 10),
        app: CLIENT_VERSION,
        // The belt to the braces above: if the sheet ever stops asking, this still fires.
        onWeakPassphrase: (s) => console.warn('[backup] weak passphrase accepted:', s.reasons.join(', ')),
      });
      await saveJson(file, recoveryFilename(file.exportedAt, passphrase !== null));
      // NEVER SILENT — the file's own README says which of the two things the user is holding,
      // and it is the same sentence that is inside the file they just saved.
      toast(say(passphrase !== null ? README.withIdentity : README.boardOnly));
    } catch (e) {
      toast(t('familyFailed', String((e && e.message) || e)));
    } finally {
      button.disabled = false;
      pw.value = '';
      measure();
    }
  };

  sealed.addEventListener('click', () => {
    // An EMPTY field is not the board-only choice — that is the other button, and D8's whole
    // point is that there is no default and no third option. `exportBackup` would refuse this
    // with `passphrase-empty`; asking again is the kinder shape of the same refusal.
    if (pw.value.length === 0) {
      toast(say(EXPORT_SHEET_COPY.passphrase.hint));
      pw.focus();
      return;
    }
    run(pw.value, sealed);
  });
  plain.addEventListener('click', () => run(null, plain));
}

/** `langzeitplaner-schluessel-2026-08-29.json`. The module deliberately does not pick one. */
function recoveryFilename(exportedAt, sealedIdentity) {
  return `langzeitplaner-${sealedIdentity ? 'schluessel' : 'eintraege'}-${exportedAt}.json`;
}

/**
 * Hand a JSON object to whatever this runtime uses to save a file. The native dialog when there
 * is a shell, an `<a download>` when there is not — the same two paths `src/js/backup.js` has
 * used since 11.2, kept here rather than imported because that module is in the BOOT GRAPH and
 * an import of it from this side of the door would be a second static edge for no gain.
 */
async function saveJson(obj, name) {
  const json = JSON.stringify(obj, null, 2);
  const invoke = globalThis.window?.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      await invoke('export_board', { contents: json, suggestedName: name });
      return;
    } catch (e) {
      console.warn('[backup] the native save dialog failed, falling back', e);
    }
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
