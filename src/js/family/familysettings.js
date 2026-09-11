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
// WHAT THE SECTIONS ARE, AND THE ONE NAME THAT MAY NOT BE SHARED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   „Familienkreis"    F15 — `createjoin.js`'s create/join, `membersui.js`'s people and
//                      `adminpanel.js`'s F20 management. THE glossary term, and it belongs here.
//   „Server & eigene Geräte"
//                      the own-device opt-in — the relay's address, and the button that creates
//                      MY PRIVATE `psp_` space. Story 19.4, F19. Present only while there is no
//                      space.
//   „Meine Geräte"     `pairingui.js`'s doorway (deliverable 21, story 19.5).
//   „Abgleich"         `syncstatus.js`'s three states (deliverable 20, story 19.2/19.3).
//   „Schlüssel sichern" ADR 002 §7's recovery file. Present only once there IS a space.
//
// ⚠ THE SECOND SECTION WAS ALSO CALLED „Familienkreis", AND TWO SECTIONS CANNOT SHARE ONE NAME.
// It is not the Familienkreis: it is a relay address and a `psp_` space that is shared with
// nobody but this person's own Macs, and a person who read „Familienkreis" over a server field
// learned that the family feature IS an infrastructure setting — which is the belief F15 exists
// to prevent. Renamed to „Server & eigene Geräte" / "Server & my own devices", which is what the
// section actually contains, so the term the glossary defines is owned by the one section that
// means it. `tests/tier2/family-settings.dom.js` pins that the two titles differ and that only
// the F15 section carries the word.
//
// The order is the order a person meets them: you find the Familienkreis, you see who is in it
// and manage it, then this Mac's own plumbing — you opt in, you pair, you occasionally wonder
// whether it is working, and then you make the copy that survives the Mac.
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHERE A FAMILY-MODE STRING LIVES.  DECIDED, AND IT IS `{de, en}` IN THE MODULE.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Three flow packages landed family copy in two different places — `i18n.js` for `createjoin.js`
// and `pairingui.js`, module-local frozen `COPY` objects for `membersui.js` and `adminpanel.js`
// — and this file uses BOTH, which is how the split became visible. It is settled here because
// this is the family entry point and therefore the first file the next agent opens.
//
//   THE RULE: a string that only a family Mac can ever read lives in its own module, as a frozen
//   `{de, en}` pair, rendered through `say()`. `i18n.js` keeps v1's vocabulary — the strings a
//   solo board actually shows.
//
// PRINCIPLE 7 IS THE TIEBREAK, and it is not a stylistic preference: „nothing in solo mode gets
// heavier because family mode exists". `i18n.js` is in the BOOT GRAPH — `main.js` imports it on
// every launch, solo or not — and both language tables are evaluated in full at import. Every
// family sentence added there is bytes and objects on a Mac that will never be in a circle. A
// `{de, en}` pair in `family/…` is evaluated only behind the one dynamic door, which is the same
// gate ADR 003 §7 already puts the modules themselves behind.
//
// THE PRECEDENT WAS ALREADY THE HOUSE STYLE and predates the disagreement: `crypto/backup.js`'s
// `EXPORT_SHEET_COPY`, `crypto/probe.js`'s `unavailableMessage()` and `platform/net.js`'s
// `insecureOriginMessage()` are all `{de, en}` pairs behind the door, rendered through the same
// `say()` this file defines. `membersui.js` writes the argument out at length in its own header.
//
// THE OBJECTION, ANSWERED: "both languages in one file" is what „every string in both languages"
// is actually about, and a frozen pair keeps them side by side rather than 400 lines apart in two
// tables — which is where an untranslated leftover hides. The tier-2 suites walk the `COPY`
// objects and assert both halves exist and differ, exactly as they walk `i18n.js`.
//
// ⚠ WHAT IS NOT DONE, AND WHY IT IS ONE ATOMIC CHANGE RATHER THAN A DRIFT. The `sync*`, `family*`,
// `circle*` and `pair*` blocks still in `i18n.js` are NOT moved in this round, and no string is
// duplicated to make a point — two spellings of one sentence would be worse than either
// convention. Four of those keys are read by more than one module (`familyFailed` and
// `familyNeedRelay` by `createjoin.js` and `adminpanel.js`; `syncErrAuth` and `syncErrProtocol`
// by `createjoin.js`), so the move touches `i18n.js`, `createjoin.js`, `adminpanel.js`,
// `pairingui.js`, `syncstatus.js` and this file at once, and one owner has to hold all six. It is
// reported as a cross-file need rather than half-landed here.

import { el, toast, openSheet } from '../ui.js';
import { t, getLang } from '../i18n.js';
import { store } from '../store.js';
import { parseEntityKey } from '../core/entities.js';
import { MONTH_DE, MONTH_EN } from '../dates.js';
import { buildPairingSection } from './pairingui.js';
import { buildSyncSection } from './syncstatus.js';
import { buildFamilyCircleSection } from './createjoin.js';
import {
  buildMembersSection, membersUIState, membersRegisters, memberChipFor, memberNameFor,
  ensureMembersCss, MEMBERS_COPY,
} from './membersui.js';
import { buildAdminSection } from './adminpanel.js';
// 18.3 — the moderation driver. `publishedState` is imported rather than re-derived: "is anything
// published for this entity" has ONE owner, and a second reader here would be free to disagree
// with the one the button then acts through.
import { createUnshare, publishedState, UNSHARE, UNSHARE_COPY } from './unshare.js';
import { TXT as SHARING_TXT } from './sharing.js';
import { FAMILY_PREFS, CIRCLE_SPACE_PREF, CLIENT_VERSION } from './engine.js';
import { armGate3, disarmGate3 } from './gate3.js';
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
 *          recoveryMaterial?:(() => {identity:Object, spaces:Object})|null,
 *          unshare?:Object|null}} [hooks]
 *        `recoveryMaterial` is null on a Mac with no space — there is no membership to back up —
 *        and is supplied by `family/mount.js`, which is the only module holding the armed
 *        identity and the key ring. See `buildRecoverySection`.
 *        `unshare` is an already-built `family/unshare.js` driver. It is OPTIONAL and `mount.js`
 *        passes none: the default is `createUnshare()`, which reads the same `circleEngine()`
 *        handle `removal.js` reads, so there is no second transport and no second key ring. It
 *        exists so a test can drive the button without standing up a relay.
 */
export function buildFamilySections(body, api, hooks = {}) {
  // ── F15 / F20 · the Familienkreis, first ──────────────────────────────────────────────────
  //
  // ORDER IS THE ARGUMENT HERE. „Familienkreis" is story 15.1's one explicit entry point, and a
  // person who opens ⚙ looking for family sharing must meet it before anything else, or the
  // first thing they read is 19.4's server address and they conclude the feature is an
  // infrastructure setting. All three of these draw NOTHING when this Mac is in no circle
  // (`buildFamilyCircleSection` draws its two buttons, and only those), so on a solo Mac this
  // reordering is invisible — which is the point of Principle 7.
  // LZP-1002 · ADR 003 §7 gate 3 — the shell's sync switch, pushed whenever this Mac has a space.
  // Fire-and-forget on purpose: it must not be able to delay or break drawing the sheet, and
  // there is nothing a person could do about any answer it gives. See `armShellSync`.
  armShellSync();

  buildFamilyCircleSection(body, api);   // 15.2 / 15.3 — create, join, and the D9 waiting line
  buildMembersSection(body, api);        // 15.4 / 15.6 — who is in it, my name and my colour
  buildAdminSection(body, api);          // F20 — rename, invites, and the three undoable things
  buildModerationSection(body, api, hooks); // 18.3 — and only for the Mac that holds the seat

  // ── F19 · this Mac's own plumbing ─────────────────────────────────────────────────────────
  buildOptInSection(body, api, hooks);   // 19.4 — „Server & eigene Geräte": the relay and `psp_`
  buildPairingSection(body, api);        // 19.5
  buildSyncSection(body, api);           // 19.3
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
 * „Server & eigene Geräte" — the one moment a solo install becomes a syncing one.
 *
 * DELIBERATELY NOT „Familienkreis", although this is what the section was called: it creates a
 * `psp_` space that only this person's own Macs ever join (story 19.4), and F15's Familienkreis
 * is three sections above it. See this file's header.
 *
 * It is a TEXT FIELD and a button rather than a switch, because there is no default relay: ADR
 * 003 §1 names `https://<vercel-app>.vercel.app` and no such app exists yet. A switch would
 * imply the address was already known; a field asks the question the product actually has.
 *
 * Once a space exists this section becomes two facts and no controls. Turning sync back OFF is
 * deliberately not here: it is `POST /members/leave`, story 20.3, and it belongs with the rest
 * of the lifecycle rather than behind a toggle that would look like a display preference.
 */
// ═════════════════════════════════════════════════════════════════════════════════════════════
// LZP-1002 · THE SHELL'S OWN SYNC SWITCH, AND THE ORIGIN IT PINS (ADR 003 §7 gate 3)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Two facts that only exist inside the shipped app, and that nothing in the web layer knew:
//
//   1. **`sync_request` refuses everything until `set_shell_pref: "sync_enabled"` is pushed.**
//      It defaults to FALSE, which is right — a fresh install is solo and solo makes zero
//      requests — but it means a build whose family opt-in never pushes the switch is a build
//      that refuses every sync **even with a relay configured and a circle joined**. Nothing
//      pushed it. That is not a hardening, it is a dead product, and it is fixed here.
//
//   2. **The origin is SHELL CONFIGURATION, not a text field.** `syncPreflight` pins it and
//      rebuilds every URL from the pin; there is no `args["origin"]`. So on a Mac running the
//      shell, „Familienkreis"'s free-text address is a second, disagreeing source of truth: type
//      anything the shell did not pin and every request comes back `url_is_not_the_pinned_origin`
//      — a refusal with no visible cause. The field is therefore replaced, in the shell only, by
//      the one address this Mac may talk to, read-only; and when the build pinned nothing, by the
//      shell's own sentence saying so.
//
// Both halves are best-effort and neither can throw into a settings sheet: `invoke` is absent in
// a browser (every tier-2 run outside a shell, and the dev server), and a shell that does not
// know the command is an older build. Absent means "browser", and a browser is `createFetchTransport`,
// where neither fact applies.

/**
 * The two sentences this file owns about the shell's pin. The shell owns the sentences about its
 * OWN state (`syncStatus()` returns `message.de/.en`, the precedent being `net.js`'s
 * `insecureOriginMessage()`: the module that owns the rule owns the sentence). What is left for
 * the settings sheet is the label for the address and the reason it cannot be typed here.
 */
const SHELL_SYNC_COPY = Object.freeze({
  pinnedLabel: Object.freeze({
    de: 'Sync-Server dieser Version',
    en: "This build's sync server",
  }),
  pinnedNote: Object.freeze({
    de: 'Diese Adresse gehört zur App und lässt sich hier nicht ändern. Dieser Mac spricht mit '
      + 'dieser einen Adresse und mit keiner anderen.',
    en: 'This address belongs to the app and cannot be changed here. This Mac talks to this one '
      + 'address and to no other.',
  }),
});

/** The shell bridge, or `null` in a browser. */
function shellInvoke() {
  const fn = globalThis.window?.__TAURI__?.core?.invoke;
  return typeof fn === 'function' ? fn : null;
}

/**
 * Ask the shell what it will and will not do. Never throws; `null` means "not in a shell, or a
 * shell too old to answer", which are the same thing to every caller.
 * @returns {Promise<null|{enabled:boolean, origin:string|null, originConfigured:boolean,
 *                        configured:string, reason:string|null, message?:{de:string,en:string}}>}
 */
export async function shellSyncStatus() {
  const invoke = shellInvoke();
  if (!invoke) return null;
  try {
    const o = await invoke('sync_status', {});
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * ADR 003 §7 gate 3's switch, pushed at the moment the switch is supposed to move.
 *
 * "A space exists" is the shell pref's whole meaning, so the condition is exactly the condition
 * `readFamilyConfig` / `readCircleConfig` use: this Mac is in a personal space, a family circle,
 * or both. It is idempotent, it is cheap, and it is deliberately called on every settings open as
 * well as at the opt-in click — a Mac that joined a circle on an older build, or whose `sync.json`
 * was lost, must not be permanently unable to sync because one click happened once.
 *
 * It never turns the switch OFF. Leaving a circle is `POST /members/leave` (story 20.3) and the
 * shell pref is not where that is decided; a settings sheet that could silently disarm sync would
 * be a display preference with a network consequence.
 *
 * ── THE FIRST CIRCLE COULD NOT BE CREATED, AND THIS GUARD IS WHY (LZP-1010) ─────────────────
 *
 * „A space exists" is the right condition for the call on every settings open. It is the WRONG
 * condition for the opt-in click, and as the only condition it deadlocked the product:
 *
 *   `optIn()` (mount.js:640) must POST /api/v1/spaces to create the space …
 *   … the shell refuses that POST, because `sync_enabled` is false (lib.rs:1077) …
 *   … and this function will not set `sync_enabled`, because no space exists yet.
 *
 * So „Familienkreis erstellen" answered „Das hat nicht geklappt: net: the shell reported blocked"
 * on every shipped shell, in both implementations, for every person who ever pressed it. The
 * tier-2 e2e did not catch it because it asserted this exact refusal and then set the pref
 * itself (`shell-family-e2e.dom.js` §2) — everything downstream of creation was proven against a
 * switch no product code path could have moved.
 *
 * `optIn: true` names the other moment. The click IS the opt-in — it is the person deciding to
 * stop being solo — and that is what this docblock already called "the moment the switch is
 * supposed to move". Gate 3 is not weakened: the switch still moves only on a deliberate,
 * explicit act, never on drawing a sheet, and `disarmShellSyncIfNoSpace` puts it back if the
 * creation the click authorised does not produce a space.
 *
 * @param {{optIn?: boolean}} [opts] `optIn` skips the space check for the opt-in click itself.
 * @returns {Promise<'armed'|'not-in-a-shell'|'no-space'|'failed'>} for tests; nothing reads it in
 *          the product, because there is nothing a person could do about any of the four.
 */
export async function armShellSync({ optIn = false } = {}) {
  const invoke = shellInvoke();
  if (!invoke) return 'not-in-a-shell';
  if (!optIn) {
    const st = store.state.settings || {};
    const hasSpace = Boolean(st[FAMILY_PREFS.space]) || Boolean(st[CIRCLE_SPACE_PREF]);
    if (!hasSpace) return 'no-space';
  }
  // Not a toast on failure. A person cannot act on it, and the visible symptom — sync that does
  // not run — already has its own honest sentence in „Server & eigene Geräte" (19.3).
  return armGate3();
}

/**
 * Put gate 3's switch back after an opt-in that armed it and then failed.
 *
 * This is the ONLY thing in the product that turns the switch off, and it is narrow on purpose.
 * `armShellSync`'s docblock says a settings sheet that could silently disarm sync would be a
 * display preference with a network consequence — that is still true, and this is not that. It
 * runs only on the failure path of the click that armed it, and only when no space came to exist,
 * so it cannot reach a Mac that is in a circle. Its effect is to restore the state the person was
 * in one second earlier: solo, and originating nothing.
 *
 * Silent for the same reason `armShellSync` is: the visible symptom already has its own sentence.
 *
 * @returns {Promise<'disarmed'|'not-in-a-shell'|'has-space'|'failed'>} for tests.
 */
export async function disarmShellSyncIfNoSpace() {
  const invoke = shellInvoke();
  if (!invoke) return 'not-in-a-shell';
  const st = store.state.settings || {};
  if (Boolean(st[FAMILY_PREFS.space]) || Boolean(st[CIRCLE_SPACE_PREF])) return 'has-space';
  return disarmGate3();
}

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

  // ── LZP-1002 · IN A SHELL, THE ADDRESS IS NOT A QUESTION ─────────────────────────────────
  //
  // Asynchronous because `sync_status` is a bridge call and this function is a DOM builder. The
  // field is drawn first and replaced if the answer says to, rather than the sheet waiting on
  // the bridge: in a browser the answer is `null` and nothing moves, which is every tier-2 run
  // and every dev-server session.
  refitOriginForShell(row, input);

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
    // ── GATE 3'S SWITCH, BEFORE THE REQUEST THAT NEEDS IT (LZP-1010) ────────────────────────
    //
    // This used to run AFTER `onOptIn`, on the reasoning that "the space now exists, so the
    // switch may move". The space does not exist until `onOptIn` RETURNS, and `onOptIn` cannot
    // return without POSTing /api/v1/spaces, which the shell refuses while the switch is off.
    // The order was the bug, and it made „Familienkreis erstellen" impossible in every shell
    // ever shipped.
    //
    // The click is the opt-in, so this is the moment — see `armShellSync`. Arming a shell that
    // then fails to create anything is why `disarmShellSyncIfNoSpace` exists below.
    const armedByThisClick = (await armShellSync({ optIn: true })) === 'armed';
    try {
      await hooks.onOptIn(origin);
      // Idempotent, and now the ordinary path: the space exists, so this is the plain form of the
      // call. Kept BEFORE the reload, because the reload is what arms the engine and the engine's
      // first push must not be refused.
      await armShellSync();
      // The space is created and the identity is durable, but this store was `init()`ed without
      // one — `usePersonalSpace()` refuses after `init()` for a reason ADR 006 §9.4 makes cheap:
      // `board.json` is the truth, so re-deriving costs nothing. A reload is the honest way to
      // say that, and it is the one place in this app that asks for one.
      toast(t('familyCreated'));
      api.close();
      location.reload();
    } catch (e) {
      // Creation failed, so this Mac is still solo — and must be solo in the shell too. Only
      // undoes what this click did, and only while no space exists.
      if (armedByThisClick) await disarmShellSyncIfNoSpace();
      go.disabled = false;
      toast(t('familyFailed', String((e && e.message) || e)));
    }
  });
  acts.appendChild(go);
  body.appendChild(acts);
  body.appendChild(el('p', 'hint', t('familySectionHint')));
}

/**
 * Replace the free-text relay field with the shell's pinned address, or with the shell's own
 * sentence when the build pinned nothing.
 *
 * WHY THIS IS A REPLACEMENT AND NOT AN EXTRA HINT. In the shipped shell the address is not a
 * setting: `syncPreflight` pins it from build configuration, rebuilds every URL from the pin, and
 * refuses anything else with `url_is_not_the_pinned_origin`. A text field next to that is a
 * second source of truth for one fact, and the failure it produces — every request refused, with
 * a settings sheet showing the address the person typed — is unreadable. So in a shell the field
 * goes, and what stays is the one address this Mac may talk to.
 *
 * `store.setSettings` still writes `syncOrigin`, because `readFamilyConfig` requires it and
 * `circleTransport` builds URLs from it. So when the shell HAS pinned an origin and the stored
 * one disagrees, the stored one is corrected to the pin — the pin is what the transport will
 * enforce, and disagreeing with it can only produce refusals.
 *
 * Never throws into the sheet. A browser answers `null` and the field is left exactly as it was.
 *
 * @param {HTMLElement} row the „Server" field row, replaced wholesale
 * @param {HTMLInputElement} input the free-text field, so its value can be reconciled
 */
async function refitOriginForShell(row, input) {
  const st = await shellSyncStatus();
  if (!st || !row.isConnected) return;

  const replacement = el('div', 'field');
  if (st.originConfigured && typeof st.origin === 'string' && st.origin) {
    replacement.appendChild(el('label', null, say(SHELL_SYNC_COPY.pinnedLabel)));
    const ctl = el('div', 'ctl');
    ctl.appendChild(el('span', 'val-wide mono', st.origin));
    replacement.appendChild(ctl);
    row.replaceWith(replacement);
    replacement.after(prose(say(SHELL_SYNC_COPY.pinnedNote)));
    // One truth. `input` is gone from the document now; the STORE is what the transport reads.
    if ((store.state.settings[FAMILY_PREFS.origin] || '') !== st.origin) {
      store.setSettings({ [FAMILY_PREFS.origin]: st.origin });
    }
    input.value = st.origin;
    return;
  }
  // Nothing pinned — which is every build shipped so far (`SYNC_ORIGIN_BUILTIN = ""`). The
  // sentence is the SHELL's, in the shell's own words, and it is not phrased as an error,
  // because nothing has gone wrong: a build with nowhere to sync to is a calendar that runs
  // entirely on this Mac.
  const msg = st.message && typeof st.message === 'object' ? st.message : null;
  row.replaceWith(replacement);
  if (msg) replacement.replaceWith(prose(say({ de: msg.de || '', en: msg.en || '' })));
  else replacement.remove();
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
// „Einträge im Familienkreis" — STORY 18.3, AND THE CALLER `family/unshare.js` NEVER HAD
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > "As admin I can unshare any entry from the family space — it reverts to owner-private, it
//   >  is never deleted — so moderation is possible but non-destructive, and I still can't read
//   >  what was never shared."
//
// `family/unshare.js` is 588 lines of that story, complete, tested over 105 cells, and until this
// section existed **nothing in the product called it**. A moderation capability nobody can invoke
// is not a shipped capability; `tests/property/sync-domains.test.js` S5b measures exactly that,
// and its row for this module moves from absent to present with this file.
//
// ── WHY THE LIST IS HERE AND NOT ON THE ENTRY ────────────────────────────────────────────────
//
// `unshare.js`'s own hand-off note says the seam is `run(entityKey)` and that "the entity key is
// exactly what a foreign entry's popover already knows". That is the better affordance and it is
// still owed (`popover.js` / `board.js` are not this package's files). What a settings list adds,
// and what the popover could not, is the ANSWER TO "what is actually in the circle?" — which is
// the question an admin asks before she asks anything about one entry.
//
// It is NOT a browse-other-people's-entries surface, and the difference is structural rather than
// promised: every row is read from the FOLDED FAMILY REGISTERS, which hold exactly what the
// circle was told and no more. The list is a second rendering of this admin's own board. Nothing
// is fetched, nothing is asked of the relay, and there is no parameter anywhere below through
// which an unshared entry could enter — a Privat entry has no family entity key on this Mac.
//
// ── THE FOUR THINGS THE SCREEN HAS TO CARRY, AND WHERE EACH ONE IS ───────────────────────────
//
//  1. IT REVERTS, IT DOES NOT DELETE.  `MODERATION_COPY.reverts` + `.notDeleted`, in the
//     confirmation, above the button — not in a toast afterwards, where it would be a consolation
//     rather than a decision.
//  2. THE ADMIN CANNOT READ IT.  Structural, twice: `entryRow` reads `pub.text`/`pub.label` ONLY
//     at `geteilt` (see `sharedEntries`), so a Belegt row cannot render a text even if a hostile
//     peer wrote one into the register; and `MODERATION_COPY.onlyShared` says the limit out loud
//     next to the list rather than in a help page.
//  3. NOBODY IS NOTIFIED AND NOBODY IS SHAMED.  `MODERATION_COPY.noNotice` says so BEFORE the
//     act, so the admin knows this button is not a message, and there is nothing below that
//     writes a marker of any kind. Principle 9, and `unshare.js`'s "IT NOTIFIES NOBODY".
//  4. THE OWNER'S BOARD MUST NOT BE ABLE TO TELL.  ADR 004 §5.1's byte-identity property — the
//     owner's own „→ Privat" and this button produce the same wire bytes — has a UI half, and it
//     is a half this file keeps by DRAWING NOTHING on the owner's side. There is no „von der
//     Verwaltung entfernt" label anywhere in this product, and `tests/tier2/unshare-ui.dom.js` §5
//     renders the owner's board through both paths and diffs it.
//
// ── WHOSE ENTRIES ARE LISTED ─────────────────────────────────────────────────────────────────
//
// The others'. MY OWN shared entries are deliberately absent, and `MODERATION_COPY.notMine` says
// where their control is: the entry's own „Sichtbarkeit" cluster (`family/sharing.js`, A7). Two
// controls for one act would be two places to look for the one that did not work — and the
// owner's path also writes the `visibility` TRUTH register in the same transaction, which the
// admin path deliberately cannot do for somebody else (it arrives afterwards, as
// `adminUnshareFollowUp`, on the owner's Mac).
//
// A publication with `pub.alive === false` is absent too: ADR 004 §4.2 drops it before the board
// ever sees it, so it is on nobody's screen and "take it out of the circle" would be a button
// that changed nothing anybody could see.

/**
 * ADR 002 §7.4's voice, in this file because only a family Mac can read it (see the header's
 * „where a family-mode string lives"). German first, English complete.
 *
 * THREE STRINGS ARE BORROWED BY IDENTITY AND ARE NOT RE-TYPED HERE: `UNSHARE_COPY.honesty` (which
 * is itself `sharing.js:TXT.downgradeNote`, §7.4's required downgrade sentence), `SHARING_TXT.
 * privat` and `SHARING_TXT.belegt` (the glossary's level words, addendum §13). A second spelling
 * of a glossary term is a second term, and the confirmation below is precisely where a person has
 * to recognise the word they already know from their own entries.
 */
export const MODERATION_COPY = Object.freeze({
  title: { de: 'Einträge im Familienkreis', en: 'Entries in the family circle' },

  /** What this section is, in one sentence, in the admin's own voice. */
  lead: {
    de: 'Das steht gerade im Kreis. Du kannst einen Eintrag aus dem Kreis nehmen — er verschwindet '
      + 'dann von den anderen Boards und bleibt vollständig bei der Person, die ihn angelegt hat.',
    en: 'This is what is in the circle right now. You can take an entry out of the circle — it '
      + 'then leaves the other boards and stays, in full, with the person who created it.',
  },
  /**
   * 20.5's sentence one register to the left, and the reason the list is not a window: it can
   * only ever show what the circle was told. It must NOT be phrased as a reassurance about other
   * people's boards („niemand sieht…"), because that is a claim about a screen this Mac cannot
   * see; it is a claim about THIS list, which is a thing the reader can check.
   */
  onlyShared: {
    de: 'In dieser Liste steht nur, was jemand geteilt hat. Was nie geteilt wurde, steht hier '
      + 'nicht — auch nicht für die Verwaltung.',
    en: 'This list holds only what somebody shared. What was never shared is not here — not for '
      + 'the admin either.',
  },
  /** Where MY OWN entries are changed. Named, because their absence is otherwise a puzzle. */
  notMine: {
    de: (visibility) => `Deine eigenen Einträge stehen nicht in dieser Liste. Die änderst du am `
      + `Eintrag selbst, unter „${visibility}“.`,
    en: (visibility) => `Your own entries are not in this list. You change those on the entry `
      + `itself, under “${visibility}”.`,
  },

  /** The disclosure. Nothing is rendered until it is pressed — see `buildModerationSection`. */
  show: {
    de: (n) => (n === 1 ? '1 Eintrag anzeigen' : `${n} Einträge anzeigen`),
    en: (n) => (n === 1 ? 'Show 1 entry' : `Show ${n} entries`),
  },
  hide: { de: 'Liste schließen', en: 'Close the list' },
  /**
   * Nothing is in the circle. It says that about the CIRCLE and nothing about anybody's board:
   * „niemand hat etwas" would be a statement about other people's private entries, which is the
   * one thing this screen may never appear to know.
   */
  empty: {
    de: 'Von den anderen steht gerade nichts im Kreis.',
    en: 'Nothing from the others is in the circle right now.',
  },

  /** The row's own button, and the confirmation's. The same words, so one is plainly the other. */
  take: { de: 'Aus dem Kreis nehmen', en: 'Take out of the circle' },
  takeFor: {
    de: (who) => `Eintrag von ${who} aus dem Kreis nehmen`,
    en: (who) => `Take ${who}’s entry out of the circle`,
  },

  confirmTitle: {
    de: (who) => `Eintrag von ${who} aus dem Kreis nehmen?`,
    en: (who) => `Take ${who}’s entry out of the circle?`,
  },
  /** Claim 1, first, at full weight. `privat` is the glossary word, by identity. */
  reverts: {
    de: (who, privat) => `Ab dem nächsten Abgleich ist der Eintrag von den Boards der anderen weg. `
      + `Bei ${who} bleibt er stehen, vollständig, und steht dort wieder auf „${privat}“.`,
    en: (who, privat) => `From the next sync the entry is gone from the other boards. It stays on `
      + `${who}’s board, in full, and is back at “${privat}” there.`,
  },
  /** Claim 1's other half, said as its own sentence because it is the one people doubt. */
  notDeleted: {
    de: 'Es wird nichts weggeworfen. Die Person behält ihren Eintrag.',
    en: 'Nothing is thrown away. The person keeps their entry.',
  },
  /**
   * Principle 9, and the reason it is on the ADMIN's screen: without it she presses this thinking
   * it says something to somebody. The second half is the product's own answer to what to do
   * instead, and it is the same one the device-count sentence gives („frag nach").
   */
  noNotice: {
    de: (who) => `${who} bekommt davon keine Nachricht und sieht keinen Hinweis am Eintrag. Wenn `
      + 'es etwas zu klären gibt, klärt das ein Gespräch und nicht dieser Knopf.',
    en: (who) => `${who} gets no message about this and sees no marker on the entry. If there is `
      + 'something to sort out, a conversation sorts it out, not this button.',
  },

  /** The tag on a row the circle holds only the day for. Never a placeholder for missing text. */
  belegtHere: {
    de: 'Im Kreis steht zu diesem Eintrag nur der Tag.',
    en: 'The circle holds only the day for this entry.',
  },
  /** A Geteilt entry whose text is empty. It is not „kein Text" — there is nothing to report. */
  noText: { de: '—', en: '—' },

  /** One calm line for a driver that threw rather than answered. */
  failed: {
    de: 'Das hat gerade nicht geklappt. Es wurde nichts gesendet.',
    en: 'That did not work just now. Nothing was sent.',
  },
});

/** One folded family register value, or `undefined`. Reads only; never throws on a shape. */
function famCell(regs, entityKey, name) {
  if (!regs || typeof regs.get !== 'function') return undefined;
  let cells;
  try { cells = regs.get(entityKey); } catch { return undefined; }
  if (!cells || typeof cells.get !== 'function') return undefined;
  const cell = cells.get(name);
  return cell === undefined || cell === null ? undefined : cell.value;
}

const asText = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
const asDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * EVERYTHING THE FAMILY CURRENTLY HOLDS FROM SOMEBODY ELSE, as rows — pure over the register map,
 * so a test walks every shape without a relay and the section below has no second opinion.
 *
 * ⚠ THE TEXT IS READ **ONLY AT `geteilt`**, and that is the structural half of 18.3's "I still
 * can't read what was never shared". At Belegt `core/project.js` publishes `pub.text: null` by
 * construction — but this function does not depend on that: it never asks for the field. A peer
 * that hand-built a `pub.set` carrying `pub.level:'belegt'` **and** a `pub.text` would put a
 * string in this Mac's register map, and this list still cannot render it. One `if`, and the
 * difference between "the producer is careful" and "the reader cannot".
 *
 * ⚠ IT NEVER DISTINGUISHES „was shared once" FROM „was never shared", because `publishedState`
 * cannot (Principle 9 — a level history is exactly what §7.1 forbids). An entry that was
 * moderated an hour ago and one that was never shared are the same absence here.
 *
 * @param {Map} regs a RegisterMap — `store.registers()`, or the member port's
 * @param {{me?:string|null}} [opts] `me` is excluded: my own entries have their own control
 * @returns {Array<{entityKey:string, kind:string, owner:string, uuid:string, level:string,
 *                  text:string|null, from:string|null, to:string|null}>}
 */
export function sharedEntries(regs, opts = {}) {
  const me = opts && typeof opts.me === 'string' ? opts.me : null;
  const rows = [];
  const keys = regs && typeof regs.keys === 'function' ? [...regs.keys()] : [];
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const parsed = parseEntityKey(key);
    if (!parsed || (parsed.kind !== 'fnote' && parsed.kind !== 'fbar')) continue;
    if (me !== null && parsed.owner === me) continue;      // mine: see `MODERATION_COPY.notMine`
    // ONE reader of "is anything published here", and it is `unshare.js`'s — the same function
    // the driver's own plan calls, so the list and the button cannot disagree about a row.
    const state = publishedState(regs, key);
    if (!state.shared) continue;
    if (famCell(regs, key, 'pub.alive') === false) continue;  // on no board; nothing to take out
    const isNote = parsed.kind === 'fnote';
    rows.push({
      entityKey: key,
      kind: parsed.kind,
      owner: parsed.owner,
      uuid: parsed.id,
      level: state.level,
      text: state.level === 'geteilt'
        ? asText(famCell(regs, key, isNote ? 'pub.text' : 'pub.label'))
        : null,
      from: asDate(famCell(regs, key, isNote ? 'pub.date' : 'pub.startDate')),
      to: isNote ? null : asDate(famCell(regs, key, 'pub.endDate')),
    });
  }
  // By the DAY, which is the order the board is in and the order somebody scanning for „das Ding
  // im Mai" is already in. Never by when it was published: that would be an activity ordering,
  // and a list whose top row means „this person did something just now" is a presence indicator
  // with the pixels filed off (Principle 9, and `membersui.js`'s 17.5 refusal, one surface over).
  rows.sort((a, b) => {
    const ad = a.from || '9999-99-99';
    const bd = b.from || '9999-99-99';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.entityKey < b.entityKey ? -1 : a.entityKey > b.entityKey ? 1 : 0;
  });
  return rows;
}

/** `2026-05-14` → „14. Mai 2026" / “14 May 2026”. Absent stays absent — never „unbekannt". */
function dayText(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  const month = (getLang() === 'en' ? MONTH_EN : MONTH_DE)[Number(m) - 1] || m;
  return getLang() === 'en'
    ? `${Number(d)} ${month} ${y}`
    : `${Number(d)}. ${month} ${y}`;
}

/** The day, or the span. One node, so a row is one line at any width. */
const whenText = (row) => (row.to && row.to !== row.from
  ? `${dayText(row.from)} – ${dayText(row.to)}`
  : dayText(row.from));

/**
 * The driver, built fresh per press.
 *
 * FRESH, and not cached: `createUnshare` reads the LANGUAGE at construction, and a cached driver
 * would keep answering in the language the sheet was first opened in. It is a pure assembly of
 * ports the engine already holds — `circleEngine()`, the live store — so building one costs
 * nothing and reaching for a stale one costs a German sentence in an English app.
 */
function moderationDriver(hooks) {
  if (hooks && hooks.unshare) return hooks.unshare;
  return createUnshare({ lang: getLang() === 'en' ? 'en' : 'de' });
}

/**
 * 18.3 — the moderation console, and only on the Mac that holds the seat.
 *
 * ⚠ IT DRAWS NOTHING FOR A NON-ADMIN, rather than drawing a disabled button. A greyed control
 * teaches that the capability is one permission away and invites the "ask the admin" conversation
 * about somebody's entry; ADR 001 §4.3 stage 3a means a non-admin's identical op is rejected by
 * every honest device including her own, so there is nothing here for her to be prevented from.
 * The seat is read from `membersUIState()` — `store.familyAdmin().admin` through the member port —
 * and the DRIVER reads it again, independently, from the folded admin chain. Two readers is right
 * here and only here: this one decides what to DRAW, that one decides what may be SEALED, and it
 * is the second that is load-bearing.
 *
 * @param {HTMLElement} body @param {{rebuild:Function, close:Function}} api @param {Object} hooks
 */
export function buildModerationSection(body, api, hooks = {}) {
  const view = membersUIState();
  if (!view.supported) return;                       // solo mode: the section does not exist
  if (!view.me || !view.adminId || view.adminId !== view.me) return;   // not my seat, not my list

  const rows = sharedEntries(membersRegisters(), { me: view.me });
  ensureMembersCss();
  ensureModerationCss();

  body.appendChild(el('div', 'section-title', say(MODERATION_COPY.title)));
  body.appendChild(prose(say(MODERATION_COPY.lead)));

  if (rows.length === 0) {
    body.appendChild(prose(say(MODERATION_COPY.empty)));
    return;
  }

  // THE LIST IS BEHIND A PRESS, AND THE ROWS ARE NOT BUILT UNTIL IT IS PRESSED. Principle 7's
  // cost argument applies to the admin's own ⚙ too: a circle with two hundred shared entries
  // would otherwise build two hundred rows, two hundred chips and two hundred listeners every
  // time anybody opened settings for any reason. `hidden` alone would not have done that — the
  // nodes would still exist — so `fill()` is the deferral and `list.hidden` is only the state.
  //
  // `moderationOpen` is MODULE state rather than a node's, so `api.rebuild()` after a moderation
  // comes back to the open list rather than to a closed disclosure.
  const list = el('div', 'mod-list');
  list.hidden = !moderationOpen;
  const fill = () => {
    if (list.firstChild) return;
    for (const row of rows) list.appendChild(entryRow(row, view, api, hooks));
  };
  if (moderationOpen) fill();

  const toggle = el('button', 'btn-ghost mod-toggle',
    moderationOpen ? say(MODERATION_COPY.hide) : say(MODERATION_COPY.show)(rows.length));
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(moderationOpen));
  toggle.addEventListener('click', () => {
    moderationOpen = !moderationOpen;
    if (moderationOpen) fill();
    list.hidden = !moderationOpen;
    toggle.setAttribute('aria-expanded', String(moderationOpen));
    toggle.textContent = moderationOpen ? say(MODERATION_COPY.hide) : say(MODERATION_COPY.show)(rows.length);
  });
  const acts = el('div', 'acts');
  acts.appendChild(toggle);
  body.appendChild(acts);
  body.appendChild(list);

  body.appendChild(prose(say(MODERATION_COPY.onlyShared)));
  body.appendChild(prose(say(MODERATION_COPY.notMine)(say(SHARING_TXT.visibility))));
}

/** Whether the list is open. Module-level, so a rebuild after a moderation does not collapse it. */
let moderationOpen = false;

/**
 * A `.hint` that explains a SECTION rather than a control — `membersui.js`'s `prose()`, verbatim,
 * including the class that overrides `app.css:496`'s 178 px control-column indent.
 */
const prose = (text) => el('p', 'hint member-prose', text);

/**
 * One row: whose it is, when it is, and — only where the circle actually holds one — what it says.
 *
 * THE ROW IS THE SAME VOCABULARY AS THE BOARD. The chip is `membersui.js`'s chip, which is 17.2's
 * chip, which is the legend's chip; there is no second geometry and no second colour lookup.
 */
function entryRow(row, view, api, hooks) {
  const node = el('div', 'mod-row');
  node.dataset.entityKey = row.entityKey;
  node.dataset.level = row.level;
  node.appendChild(memberChipFor(row.owner, view));

  const who = memberNameFor(row.owner, view);
  node.appendChild(el('span', 'mod-who', who || say(MEMBERS_COPY.waitingNoName)));
  node.appendChild(el('span', 'mod-when', whenText(row)));

  // AT BELEGT THERE IS NO TEXT NODE AT ALL — not an empty one, not a placeholder, not „(kein
  // Text)". The tag says what the circle holds; a greyed placeholder would say what it does not,
  // which is a sentence about somebody's private entry.
  if (row.level === 'geteilt') {
    node.appendChild(el('span', 'mod-what', row.text || say(MODERATION_COPY.noText)));
  } else {
    // The tag sits INSIDE the same elastic cell the text would have used, so the button lands in
    // the same column on every row. It is the quiet `.member-tag` „du"/„Verwaltung" wear, not a
    // warning: a Belegt block is the normal state of half a family board.
    const cell = el('span', 'mod-what');
    const tag = el('span', 'member-tag mod-belegt', say(SHARING_TXT.belegt));
    tag.title = say(MODERATION_COPY.belegtHere);
    cell.appendChild(tag);
    node.appendChild(cell);
  }

  const take = el('button', 'btn-ghost mod-take', say(MODERATION_COPY.take));
  take.type = 'button';
  take.title = say(MODERATION_COPY.takeFor)(who || say(MEMBERS_COPY.waitingNoName));
  take.setAttribute('aria-label', take.title);
  take.addEventListener('click', () => confirmUnshare(row, who, api, hooks));
  node.appendChild(take);
  return node;
}

/**
 * The confirmation — `leavedelete.js`'s shape, and deliberately NOT its `danger` button.
 *
 * A red button means "this cannot be undone" and this is the one family action that reverses
 * itself the moment the owner shares again. What it is instead is IRREVOCABLE IN THE OTHER
 * DIRECTION — what the other Macs already pulled, they already have — and that is exactly what
 * `UNSHARE_COPY.honesty` says, in ADR 002 §7.4's own required words, as the last line before the
 * button. So: three claims, then the honesty, then a primary button.
 */
function confirmUnshare(row, who, api, hooks) {
  const name = who || say(MEMBERS_COPY.waitingNoName);
  let btn = null;

  const sheet = openSheet({
    title: say(MODERATION_COPY.confirmTitle)(name),
    narrow: true,
    build: (b) => {
      const lead = el('p', null, say(MODERATION_COPY.reverts)(name, say(SHARING_TXT.privat)));
      lead.style.cssText = 'margin:0 0 10px;font:400 12.5px/1.6 var(--font);color:var(--ink-1)';
      b.appendChild(lead);
      for (const s of [
        say(MODERATION_COPY.notDeleted),
        say(MODERATION_COPY.noNotice)(name),
        // ⚠ §7.4's REQUIRED downgrade sentence, by identity from `unshare.js` (which takes it by
        // identity from `sharing.js`). Three surfaces, one string, and a paste in any of them
        // reddens `tests/tier1/unshare.test.js`'s identity assertion rather than passing review.
        say(UNSHARE_COPY.honesty),
      ]) {
        const p = el('p', null, s);
        p.style.cssText = 'margin:0 0 8px;font:400 11.5px/1.6 var(--font);color:var(--ink-3)';
        b.appendChild(p);
      }
    },
    actions: [
      { label: t('cancel'), run: (a) => a.close() },
      {
        label: say(MODERATION_COPY.take),
        kind: 'primary',
        run: async (a) => {
          if (btn) btn.disabled = true;
          let res = null;
          try {
            // ONE ARGUMENT, AND IT IS THE ENTITY KEY. `run()` takes nothing else — no level, no
            // patch, no text — so there is nothing this screen could pass that would change what
            // is published. See `core/project.js:adminUnshareOp`'s "arity 2 and content-blind".
            res = await moderationDriver(hooks).run(row.entityKey);
          } catch (e) {
            if (btn) btn.disabled = false;
            console.warn('[unshare] the moderation driver threw', e);
            toast(say(MODERATION_COPY.failed));
            return;
          }
          a.close();
          // THE DRIVER'S OWN SENTENCES, never this file's. `res.say` is ADR 002 §7.4's copy for
          // the verdict that actually happened — including the downgrade honesty on every landed
          // outcome — and a screen that summarised it („Erledigt!") would be the one place the
          // contract is not what the person reads.
          const lines = Array.isArray(res && res.say) ? res.say.filter(Boolean) : [];
          if (lines.length) toast(lines.join(' '));
          if (res && res.verdict === UNSHARE.DONE) api.rebuild();
          else if (res && res.verdict === UNSHARE.PARTIAL) api.rebuild();
        },
      },
    ],
  });

  // `openSheet` builds its own footer and hands back no handles — `leavedelete.js`'s note, and
  // the same solution: the confirm button is the last child of the foot.
  const foot = sheet.body.parentElement?.querySelector('.sheet-foot');
  btn = foot ? foot.lastElementChild : null;
  return sheet;
}

export const MODERATION_CSS_ID = 'lzp-moderation-css';

/**
 * Shipped by the module, like `membersui.js`'s and `syncstatus.js`'s, and for the same reason:
 * `src/css/app.css` is loaded by every launch including a solo one, and every rule here is for a
 * surface only the admin of a Familienkreis ever draws.
 */
export const MODERATION_CSS = `
.mod-list {
  display: flex; flex-direction: column; gap: 2px;
  margin: 2px 0 8px; max-height: 280px; overflow-y: auto;
}
.mod-list[hidden] { display: none; }
.mod-row {
  display: flex; align-items: center; gap: 8px; min-height: 24px;
  padding: 2px 4px; border-radius: 5px;
}
.mod-row + .mod-row { border-top: 1px solid var(--line-1); }
.mod-who { font: 500 12px var(--font); color: var(--ink-1); flex: none; }
.mod-when { font: 400 11px var(--font); color: var(--ink-3); flex: none; white-space: nowrap; }
/* The text is the elastic column: a long entry truncates and nothing else in the row moves. It is
   the only cell whose content came from another person, so it is the only one that can be any
   width at all. */
.mod-what {
  font: 400 12px var(--font); color: var(--ink-2);
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mod-take { flex: none; font-size: 11px; padding: 2px 8px; }
.mod-toggle { font-size: 11px; }
`;

function ensureModerationCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MODERATION_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = MODERATION_CSS_ID;
  s.textContent = MODERATION_CSS;
  document.head.appendChild(s);
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
