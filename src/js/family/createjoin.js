// src/js/family/createjoin.js — LZP-601 / LZP-602. Deliverables 14 and 15.
// Stories 15.1, 15.2, 15.3, 15.4, 20.5, 20.6 · ADR 002 §7.1 · PO decision D9.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO SCREENS, AND WHICH ONE THE EPIC IS JUDGED ON
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// CREATE (15.2, 20.6) is a form: a name, my name, my colour, and a code comes back. It is the
// admin's screen and it is met once.
//
// JOIN (15.3) is the product's first impression for somebody who was told "it's just a
// calendar". The addendum's design note is unusually specific about it — *"design it for her:
// one screen, huge paste field, name + colour picker, done"* — so this file spends its budget
// there: one surface, one field she pastes into, two choices, one button. No email, no password,
// no registration form, and nothing that has to be read twice.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE WAITING STATE IS PART OF THE JOIN SCREEN. IT IS NOT AN ERROR PATH.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// PO decision D9: an invite carries NO key material. `server/core/handlers/invites.js` is built
// around that and computes `pendingKeys` rather than asserting it, so the fact this screen
// branches on is the relay's own key-ring state.
//
// What that means at the keyboard is that Mom's join SUCCEEDS and her board stays empty for a
// while. `DESIGN-DECISIONS.md` § D9 lists four required behaviours and this screen owes all
// four; each one is a line of code here, marked D9-1 … D9-4:
//
//   D9-1  she is IMMEDIATELY a member — the redemption returns the member list and this screen
//         renders it, so "am I in?" is answered on screen and not by waiting.
//   D9-2  an explicit, calm waiting state, ONE German-first line, no spinner. `renderJoined()`
//         has no timer, no progress element and no `busy` styling; 19.3's "silence is the
//         design" governs here too.
//   D9-3  it resolves itself. The copy says the entries arrive when ANY other Mac in the circle
//         next syncs — not the admin's, per ADR 002 §7.1 step 4 and D9's 2026-08-27 correction —
//         and it never tells her to go and ask somebody to open a laptop. `WAITING_COPY` is
//         asserted against that sentence in `tests/tier2/family-createjoin.dom.js` §5.
//   D9-4  it is never an error. The panel's title is „Du bist dabei.", there is no retry button,
//         nothing on it is red, and the word „Fehler" does not appear. The one control is
//         „Fertig".
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// 15.1 — THIS FILE IS BEHIND THE ONE DOOR, AND IT MUST STAY THERE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Principle 7: *"Nothing in solo mode gets heavier, slower, or more networked because family
// mode exists."* `family/mount.js` is the only dynamic `import()` out of the boot graph
// (`tests/tier1/network-scope.test.js` §2) and this module is reached from
// `family/familysettings.js`, i.e. from behind it. Two consequences that constrain what may be
// imported here:
//
//   · every `crypto/` module this file names must ALREADY be in the set
//     `tests/attack/privacy-e5-silence.test.js` §5 pins for a solo ⚙ — backup, envelope,
//     identity, pairing, probe, spacekeys, suite. `identity.js`, `spacekeys.js`, `probe.js` and
//     `suite.js` are the four used below and all four are in it, so the measured cost of this
//     epic to a solo user who opens the settings sheet is ZERO new modules.
//   · nothing here runs at render time. `probeCrypto()` runs on a click, key generation runs on
//     a click, and the transport is built on a click. Drawing the section costs one `<div>` and
//     two buttons.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.5 — THE ADMIN MANAGES THE SPACE, NEVER THE PEOPLE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// *"Even as admin, I structurally cannot see other members' private entries … enforced by
// encryption, not by policy."* The create screen says that out loud (`circleAdminFraming`),
// because the moment somebody is told "you are the admin" is the moment they form a belief
// about what that means. No copy in this file implies otherwise, and there is no control here
// that reads another member's anything: the only member data this module ever holds is the
// pseudonymous roster the relay publishes — ids, palette indices and public keys. Names live in
// the encrypted op stream (ADR 003 §5.1) and this file cannot read them, which is why the join
// panel says the names arrive with the entries instead of showing blanks.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS OWED BY OTHER OWNERS — read this before concluding the feature is broken
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. `familysettings.js` must call `buildFamilyCircleSection()`. Until it does, this module is
//      unreachable from the UI and 15.1 is satisfied trivially. One import, one line.
//   2. `Device.deviceShort` is GLOBALLY unique on the relay (server finding E2-203-1), so a Mac
//      that already has a personal space cannot create or join a family one. This module refuses
//      that case with a named, calm sentence (`circleErrDeviceRegistered`) rather than a 400 the
//      user cannot act on — but the fix is the server's.
//   3. Family-space ops. `store.js` has `_familySpaceId` and no `useFamilySpace()`, so the
//      display name and the circle's name are persisted LOCALLY here and do not yet enter the
//      op stream as `member.set`. 15.4's names and 15.6's propagation land with that.
//   4. The board's own one-line waiting state (19.3's chrome) is `syncstatus.js`'s to draw.
//      `familyWaitingState()` below is the fact and the sentence it needs; this file draws it on
//      its own screen and never on the board.
//
// CSS OWNERSHIP. `src/css/app.css` is the v1 DOM layer's and this package does not own it, so
// the styles are injected once as a `<style id="lzp-circle-css">`, exactly as `pairingui.js`
// does and for the same reason. Every token used is one `app.css` already defines. When the CSS
// owner next opens that file, `CIRCLE_CSS` moves there verbatim and `ensureCss()` is deleted.

import { el, toast } from '../ui.js';
import { t, getLang, setLang } from '../i18n.js';
import { store } from '../store.js';
import { PALETTE, colorOf, paletteName } from '../palette.js';
import { b64u, crockNormalize, crock32, CROCKFORD_ALPHABET } from '../core/b64.js';
import { spaceId as mintSpaceId } from '../core/ids.js';
import { chooseTransport, normalizeOrigin, insecureOriginMessage, NetError } from '../platform/net.js';
import { chooseKeyStore } from '../platform/keystore.js';
import { openDeviceIdentity, selfAttest, IdentityUnavailableError } from '../platform/device-identity.js';
import { exportRawPublic, signBytes, importKexPublic } from '../crypto/identity.js';
import { createSpaceKey, wrapSpaceKey, encodeWrap } from '../crypto/spacekeys.js';
import { hkdf, INFO, NO_SALT, KDF, HASH } from '../crypto/suite.js';
import { probeCrypto, isSuiteAvailable, unavailableMessage } from '../crypto/probe.js';
import { armGate3, disarmGate3 } from './gate3.js';

const TE = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Parameters
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ADR 002 §7.1's invite row, as display and generation parameters.
 *
 * `codeChars` is 12 Crockford characters = 60 bits, shown `XXXX-XXXX-XXXX`. `ttlDays` is the
 * relay's (`INVITE_TTL_MS` in `server/core/handlers/invites.js`) and is shown, never enforced
 * here: two clocks that both enforce a TTL disagree, and the one that matters is the server's.
 */
export const INVITE_UI = Object.freeze({
  codeChars: 12,
  codeGroup: 4,
  ttlDays: 7,
  /** 15.2's name and 15.3's display name. Bounded so a name cannot become a payload. */
  maxCircleName: 40,
  maxDisplayName: 24,
});

/** The protocol version string the relay sees in `X-LZP-Client`, mirroring `engine.js`. */
const CLIENT_V = '2.0.0';

/**
 * The settings keys one Familienkreis occupies. `pref.set` is a LOCAL-space op and settings are
 * never synced (store.js rule U6), so these are per-Mac facts and not shared state.
 *
 * They are deliberately NOT merged into `engine.js`'s `FAMILY_PREFS`: that triple
 * (`syncEnabled` / `syncOrigin` / `personalSpaceId`) arms the PERSONAL space at boot, and a
 * family space id written into `personalSpaceId` would arm the engine into a space whose ops it
 * has no key for. The origin is shared, because there is one relay.
 */
export const CIRCLE_PREFS = Object.freeze({
  origin: 'syncOrigin',
  space: 'familySpaceId',
  name: 'familyName',
  role: 'familyRole',
  member: 'familyMemberId',
  display: 'familyDisplayName',
  color: 'familyColorRef',
  pending: 'familyKeysPending',
  joinedAt: 'familyJoinedAt',
});

/** The two roles 20.1 knows. There is exactly one admin at a time and the role is transferable. */
export const CIRCLE_ROLE = Object.freeze({ admin: 'admin', member: 'member' });

/** The screens this file draws. `null` when neither is open. */
export const CIRCLE_SCREEN = Object.freeze({ create: 'create', join: 'join' });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The ports — everything that is not a pixel
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Clock, randomness, the key store and the transport, injectable so
 * `tests/tier2/family-createjoin.dom.js` can drive the whole flow against a fake relay in a real
 * engine. The defaults are the product's.
 *
 * `transport(origin, deviceShort, sign)` returns something with
 * `request(method, path, query, body) => {status, json}` — `platform/net.js`'s Transport port,
 * and the only shape this file knows about the network.
 */
const DEFAULT_PORTS = Object.freeze({
  now: () => Date.now(),
  today: () => new Date().toISOString().slice(0, 10),
  random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  subtle: () => globalThis.crypto.subtle,
  schedule: (ms, fn) => setTimeout(fn, ms),
  unschedule: (h) => clearTimeout(h),
  invoke: () => globalThis.window?.__TAURI__?.core?.invoke,
  // ── LZP-1002 · THE SHELL IS THE TRANSPORT HERE TOO ────────────────────────────────────────
  //
  // This port used to call `createFetchTransport` UNCONDITIONALLY, and that made every circle
  // operation this file owns — create, join, redeem, and everything `circleTransport()` hands to
  // `adminpanel.js` / `leavedelete.js` — reach for `fetch` inside the shipped shell, where
  // `default-src 'self'` blocks it (`tests/tier2/shell-bridge.dom.js`: "an outbound fetch is
  // actually blocked, not merely discouraged"). `engine.js` asked `chooseTransport`; this file
  // did not, so the conformance finding had a second half: even with `sync_request` implemented,
  // **creating a Familienkreis in the shipped app could not work.**
  //
  // `chooseTransport` is the ONE decision, made in `net.js` and made once. `invoke` is read
  // through `ports.invoke()` so an injected port (tier 1 and tier 2 both inject one) still
  // chooses the same way a real shell does.
  transport: (origin, deviceShort, sign) => {
    const picked = chooseTransport({
      origin,
      deviceShort,
      sign,
      clientVersion: CLIENT_V,
      now: () => Date.now(),
      schedule: (ms, fn) => setTimeout(fn, ms),
      unschedule: (h) => clearTimeout(h),
      invoke: ports.invoke(),
    });
    lastTransportKind = picked.kind;
    return picked.transport;
  },
  /** The durable device identity, minted on the click and never at render. */
  openIdentity: async (today, invoke) => {
    const { store: ks, kind: custody } = chooseKeyStore({ invoke });
    const opened = await openDeviceIdentity(ks, { today, custody, allowMemoryCustody: false });
    const mine = await selfAttest(ks, opened.forStore, opened.recovery.recSig.privateKey, { createdAt: today });
    return { ...opened, blob: mine.blob, attestation: mine.attestation };
  },
  /** `board.json` is the truth and this store was `init()`ed without a space — ADR 006 §9.4. */
  reload: () => globalThis.location?.reload?.(),
  clipboard: (text) => globalThis.navigator?.clipboard?.writeText?.(text),
});

let ports = { ...DEFAULT_PORTS };

/**
 * Which transport the LAST circle operation actually used — `'bridge'` or `'fetch'`.
 *
 * `chooseTransport`'s own docblock says it: *"a caller that reads `'fetch'` in the shipped shell
 * has found a bug in gate 3."* This getter is how a test in a REAL shell reads it, rather than
 * inferring it from the absence of a `fetch` call. `null` until something has been transported.
 * @returns {'bridge'|'fetch'|null}
 */
export function lastCircleTransportKind() {
  return lastTransportKind;
}

let lastTransportKind = null;

/**
 * Mount (or, with no arguments, reset) the create/join flows.
 *
 * @param {Partial<typeof DEFAULT_PORTS>} [deps]
 */
export function initCreateJoin(deps = {}) {
  closeCircleScreen({ silent: true });
  probePromise = null;
  ports = { ...DEFAULT_PORTS, ...deps };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The persisted circle — 20.6's "at most ONE"
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What this Mac knows about its Familienkreis, or `null`.
 *
 * 20.6 is enforced here rather than at the relay, and that is the honest place for it: the
 * server has no notion of "this person", only of members and spaces, so "one circle per user" is
 * a statement about one installation. Both entry points ask this function first, so neither
 * screen can be opened onto a second circle.
 *
 * @returns {{spaceId:string, name:string, role:string, memberId:string|null,
 *            displayName:string, colorRef:string, keysPending:boolean,
 *            origin:string, joinedAt:string|null}|null}
 */
export function familyCircle() {
  const s = (store.state && store.state.settings) || {};
  const spaceId = s[CIRCLE_PREFS.space];
  if (typeof spaceId !== 'string' || !spaceId.startsWith('fsp_')) return null;
  return Object.freeze({
    spaceId,
    name: typeof s[CIRCLE_PREFS.name] === 'string' ? s[CIRCLE_PREFS.name] : '',
    role: s[CIRCLE_PREFS.role] === CIRCLE_ROLE.admin ? CIRCLE_ROLE.admin : CIRCLE_ROLE.member,
    memberId: typeof s[CIRCLE_PREFS.member] === 'string' ? s[CIRCLE_PREFS.member] : null,
    displayName: typeof s[CIRCLE_PREFS.display] === 'string' ? s[CIRCLE_PREFS.display] : '',
    colorRef: typeof s[CIRCLE_PREFS.color] === 'string' ? s[CIRCLE_PREFS.color] : PALETTE[0].ref,
    keysPending: s[CIRCLE_PREFS.pending] === true,
    origin: typeof s[CIRCLE_PREFS.origin] === 'string' ? s[CIRCLE_PREFS.origin] : '',
    joinedAt: typeof s[CIRCLE_PREFS.joinedAt] === 'string' ? s[CIRCLE_PREFS.joinedAt] : null,
  });
}

/**
 * D9's waiting state as a FACT plus the sentence that states it, so `syncstatus.js` can render
 * one calm line on the board without owning the copy or re-deriving the condition.
 *
 * `pending` is `false` on a Mac with no circle, which is the answer solo mode needs: a board
 * that has never joined anything has nothing to wait for and must show nothing.
 *
 * @returns {{pending:boolean, line:string, calm:string}}
 */
export function familyWaitingState() {
  const c = familyCircle();
  return Object.freeze({
    pending: !!(c && c.keysPending),
    line: t('circleWaiting'),
    calm: t('circleWaitingCalm'),
  });
}

/** Write the circle to `board.json`, then flush — this is a fact a relaunch must not lose. */
/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE CIRCLE, ADOPTED INTO THE LOG — and this is the step whose absence made E6 a membership
 * feature with no content in it.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything above this point is the RELAY's half: a space row, a member row, a device row, a
 * wrap, an invite. None of it is board content and none of it makes a single op admissible. Four
 * calls do, and until this function existed not one of them had a caller anywhere in `src/js/`.
 *
 *   1. **`store.useIdentity()`** — the identity `armForRelay` just minted is the one the relay
 *      now holds a device row for. Without adopting it the store keeps its EPHEMERAL per-process
 *      identity, so `op.act` is not this member, `store._short` is not the short the relay
 *      registered, and `sealOp` §5.2.2 checks 4 and 5 refuse every op this Mac authors. It is
 *      skipped when the store already runs on a durable identity (a Mac that had opted into
 *      19.4 first, or a second circle screen in one session): the store refuses to be re-pointed
 *      and it is right to.
 *   2. **`store.useFamilySpace()`** — `core/ops.js:spaceFor` refuses to build a `member.set` or a
 *      `space.set` without it, and `core/materialize.js:791` (`if (!familySpaceId) break;`) means
 *      a peer's entry could not RENDER even once its op had folded.
 *   3. **`claimAdmin` — THE CREATOR ONLY, AND IT IS THE ROOT OF EVERYTHING ELSE.** ADR 001 §4.1's
 *      genesis link. Until it exists `adminAtIn` answers `null` for every stamp, so on a circle
 *      created by this build **20.1's rename and 20.2's removal were inadmissible from everybody,
 *      the creator included** — and `family/removal.js` reported it as `NO_ADMIN_CHAIN` on every
 *      removal. The joiner must NOT emit it: a second genesis link is not a correction, it is a
 *      rival root, and `resolveChain` would settle the seat by longest-chain-then-stamp.
 *   4. **`attestMyDevice`** — ADR 001 §4.0. Without it `core/authz.js` stage 0b answers
 *      `unattestedDevice` for every op this Mac sends and every op it receives.
 *   5. **`setMyProfile`** — 15.6. The name and colour the human typed on THIS screen, published
 *      into the log where every other member can read them. Before this, every member row on
 *      every Mac read „Name noch nicht angekommen" — including my own, because writing my own
 *      name was the same missing op (finding E6-1).
 *
 * **NOTHING HERE THROWS OUT OF THE FLOW.** The relay has already accepted the membership when
 * this runs; a Mac that is a member but could not author its first ops still has its board, its
 * member list and the calm D9 sentence, and `startFamilyEngine` re-publishes the attestation on
 * every launch. So each call is reported and none of them unwinds a join that has happened.
 *
 * @param {Object} id what `armForRelay` returned
 * @param {{spaceId:string, admin:boolean, displayName:string, colorRef:string}} circle
 */
async function adoptCircleIntoLog(id, circle) {
  const step = (what, fn) => {
    try { fn(); } catch (e) {
      console.warn(`[circle] ${what} could not be authored into the family log:`, e.message);
    }
  };
  if (typeof store.hasDurableIdentity === 'function' && !store.hasDurableIdentity()) {
    step('this Mac\'s identity', () => store.useIdentity({ ...id.forStore }));
  }
  step('the Familienkreis', () => store.useFamilySpace(circle.spaceId));
  if (circle.admin) step('the admin seat (ADR 001 §4.1 genesis link)', () => store.apply('claimAdmin', {}));
  step('this device\'s attestation (ADR 001 §4.0)', () => store.apply('attestMyDevice', {
    deviceShort: id.forStore.deviceShort,
    blob: id.blob,
  }));
  step('your name and colour (15.6)', () => store.apply('setMyProfile', {
    displayName: circle.displayName,
    colorRef: circle.colorRef,
  }));
  if (typeof store.persistNow === 'function') await store.persistNow().catch(() => {});
}

async function rememberCircle(patch) {
  store.setSettings(patch);
  if (typeof store.persistNow === 'function') await store.persistNow();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. The code — display, parsing, generation, derivation
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ── 4.0 the damage a code survives on the way here, and the damage that hides a word ─────────
//
// LZP-1006 measured the join path by running THIS parser over the e-mail the product actually
// sends (`docs/v2/email/*`, `scripts/mom-test-probe.mjs`). Three defects came back, and all
// three had the same cause: the parser guessed. Every rule below exists to stop it guessing,
// and the rule it is replaced with is written next to it.
//
// D9 is untouched by all of this. An invitation carries an address and a code; neither is key
// material, nothing here reads or derives any, and no sentence this file produces says whether
// a code was ever minted. Refusals talk about the PASTE — the text on screen — and nothing else.

/**
 * Characters that get INSIDE a code without being visible: a soft hyphen from a line wrap, the
 * zero-width space an HTML mail uses to allow a break, a BOM from a copied text file.
 *
 * They are DROPPED rather than treated as separators, because a line wrap inserts them in the
 * middle of a group as readily as between two. Measured as probe rows H11 and H12, both of which
 * were „no code found, no visible reason" — the honest failure that a person cannot act on,
 * because the thing that broke it does not exist on her screen.
 */
const CODE_INVISIBLE = /[\u00AD\u200B\u200C\u200D\u2060\uFEFF]/g;

/**
 * Everything a mail client, a phone keyboard or macOS text substitution puts where the hyphen
 * was: the en dash, the em dash, the non-breaking hyphen, the minus sign. Folded TO a hyphen.
 *
 * This is not a guess about intent. Crockford's alphabet contains no dash of any kind
 * (`CROCKFORD_ALPHABET` is `0-9` and `A-Z` less I, L, O and U), so a dash inside a code can only
 * ever have been a separator. Probe rows H09 and H10.
 */
const CODE_DASHLIKE = /[\u2010-\u2015\u2043\u2212]/g;

/** Spaces `crockNormalize` does not know about — thin, narrow no-break, ideographic. */
const CODE_ODD_SPACE = /[\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The three foldings above, applied in one place so that the shape test, the token scanner and
 * `formatInviteCode` cannot disagree about what a separator is. Two answers to "what did she
 * type" is the bug `deriveInvite` warns about three functions down.
 *
 * @param {*} s @returns {string}
 */
function foldPasteDamage(s) {
  return String(s ?? '')
    .replace(CODE_INVISIBLE, '')
    .replace(CODE_DASHLIKE, '-')
    .replace(CODE_ODD_SPACE, ' ');
}

/**
 * A token in the paste: letters, digits and hyphens, plus the damage above so a broken code
 * arrives here in one piece instead of as three fragments.
 */
const TOKEN_RE = /[0-9A-Za-z\-\u2010-\u2015\u2043\u2212\u00AD\u200B-\u200D\u2060\uFEFF]+/g;

/**
 * THE SHAPE A MINTED CODE HAS, derived from `INVITE_UI` so it cannot drift away from
 * `newInviteCode`: three groups of four, hyphen-separated. `XXXX-XXXX-XXXX`.
 *
 * This one regular expression is the whole of defect E-1's fix, and it is worth saying why it
 * works when the check it joins does not. `codeToken` asks "does this token normalise to twelve
 * Crockford characters", and its comment argues that prose therefore cannot win. A German
 * hyphenated compound can:
 *
 *     „Mail-Anbieter"  →  crockNormalize  →  MA11ANB1ETER   — twelve, all legal, one hyphen
 *
 * and it stands in the shipped German invitation ABOVE the code, in the sentence about mail
 * providers stripping .dmg files. First match won, so a stranger who pasted the whole e-mail got
 * `MA11-ANB1-ETER` in the field, an enabled button, and then — from the relay — a sentence
 * blaming her for mistyping a character she never typed.
 *
 * What separates the word from the code is not the alphabet, it is the GROUPING: „Mail-Anbieter"
 * is four and eight, and a minted code is four and four and four. So a token in the canonical
 * grouping is a STRONG candidate and may win a sentence; anything else that merely normalises to
 * twelve is a WEAK candidate and may not, because „Installation" (1NSTA11AT10N) and
 * „Applications" (APP11CAT10NS) are twelve legal characters too, and both are in these e-mails.
 */
const CANONICAL_CODE_RE = (() => {
  const g = INVITE_UI.codeGroup;
  const groups = INVITE_UI.codeChars / g;
  return new RegExp(`^[0-9A-Za-z]{${g}}(?:-[0-9A-Za-z]{${g}}){${groups - 1}}$`);
})();

/**
 * DEFECT E-1b — THE GROUPING RULE HAD A DOOR IN IT, AND THE DECOYS WALKED THROUGH.
 *
 * `CANONICAL_CODE_RE` above governed the multi-token path only. Step 0 — *"the field holds
 * nothing but the code"* — asked `codeToken` alone, i.e. "does the whole field normalise to
 * twelve Crockford characters", and the docblock two functions down asserted that a
 * twelve-character WORD therefore *"cannot reach here with a complete code, because step 0 would
 * have taken it if it were alone in the field."* That sentence is the defect, written down as
 * though it were the fix. Measured against the shipped German invitation, alone in the field:
 *
 *     „Mail-Anbieter"   → MA11-ANB1-ETER      found:'code'     — E-1, still winning
 *     „Installation"    → 1NST-A11A-T10N      found:'code'     — a decoy this file NAMES
 *     „Applications"    → APP1-1CAT-10NS      found:'code'     — the other one it names
 *     „Familie Weber"   → FAM1-11EW-EBER      found:'code'     — a circle NAME, on the wrong screen
 *
 * Every one of those is the dishonest class: a complete twelve-character code nobody minted, an
 * enabled „Beitreten", one spent redemption attempt, and then `circleErrInviteInvalid` telling
 * her she has probably mistyped a character she never typed.
 *
 * THE RULE THAT REPLACES IT. The evidence that separates a code alone in a field from a word
 * alone in a field is the same evidence `CANONICAL_CODE_RE` uses on every other path — the
 * SEPARATORS — so step 0 asks for it too. Exactly three spellings are a code standing on its own,
 * and each of them is a thing a person or a mail client actually produces:
 *
 *     XXXX-XXXX-XXXX   as minted, as `formatInviteCode` writes it, as the e-mail prints it
 *     XXXX XXXX XXXX   the same grouping with spaces — a phone keyboard, a re-typed code
 *     XXXXXXXXXXXX     no separators at all — typed straight through
 *
 * „Mail-Anbieter" is four-and-eight, „Familie Weber" is seven-and-five, and neither is any of
 * the three. They are refused, by name, with the sentence that says which line to copy.
 *
 * The three shapes are derived from `INVITE_UI` for `CANONICAL_CODE_RE`'s reason: two answers to
 * "how is a code written" is the drift `newInviteCode` and this file must never have.
 */
const WHOLE_CODE_SHAPES = (() => {
  const g = INVITE_UI.codeGroup;
  const n = INVITE_UI.codeChars / g;
  const grp = `[0-9A-Za-z]{${g}}`;
  return Object.freeze({
    /** A separator every `codeGroup` characters. The grouping IS the evidence. */
    grouped: Object.freeze([
      new RegExp(`^${grp}(?:-${grp}){${n - 1}}$`),
      new RegExp(`^${grp}(?: ${grp}){${n - 1}}$`),
    ]),
    /** No separator anywhere. See `wholeFieldCode` — this one has to pay for itself. */
    unbroken: new RegExp(`^[0-9A-Za-z]{${INVITE_UI.codeChars}}$`),
  });
})();

/**
 * True when every character is ALREADY one `crock32` emits — no substitution needed.
 *
 * `crockNormalize` maps I and L to 1 and O to 0, which is the right forgiveness for somebody
 * RETYPING a code off a screen (probe row H08) and the wrong basis for deciding that a word is a
 * code. A minted code contains no I, L, O or U, because `CROCKFORD_ALPHABET` does not: those
 * four are excluded exactly so they cannot be confused with 1, 1, 0 and V.
 *
 * @param {string} s @returns {boolean}
 */
const isAlreadyCrockford = (s) => s.length > 0
  && [...s.toUpperCase()].every((ch) => CROCKFORD_ALPHABET.includes(ch));

/**
 * The whole field, read as a code — or `null`, which is a refusal and not a shrug.
 *
 * Two normalisations run before the shape test, and both are evidence rather than guesswork:
 *
 *   · ` ` and TAB become ordinary spaces. `crockNormalize` already strips both, so without
 *     this the space-grouped shape would be true of a code from a plain-text mail and false of
 *     the same code out of an HTML one (probe row H06), which is a difference nobody can see.
 *
 *   · **A SEPARATOR THE MAIL CLIENT BROKE A LINE AT is put back together.** Crockford's alphabet
 *     holds no hyphen (`CROCKFORD_ALPHABET` is `0-9` and `A-Z` less I, L, O and U), so a hyphen
 *     with whitespace on one side of it can only ever have been a separator that a 72-column
 *     wrap split. `J17Z-XSXN-⏎7CSQ` is therefore read; `J17Z-XS⏎XN-7CSQ`, where the break fell
 *     INSIDE a group and there is no separator to prove anything, is refused. That asymmetry is
 *     the whole difference between reading evidence and guessing, and it is why the second one
 *     stays refused even though a person can see what she meant.
 *
 * `codeToken` still has the last word on the alphabet, so `U` — which `crockNormalize`
 * deliberately does not map — falls out here and reaches the caller as an unfinished code rather
 * than as a wrong complete one (probe row H14).
 *
 * ── THE UNBROKEN SHAPE HAS TO PAY FOR ITSELF ────────────────────────────────────────────────
 *
 * `XXXXXXXXXXXX` carries NO separator evidence at all, and twelve unbroken letters is what an
 * ordinary word is. Two of them stand in the shipped invitation and this file already names them
 * as decoys — and both were still winning after the grouping rule landed:
 *
 *     „Installation"  → 1NSTA11AT10N   twelve, legal after substitution, found:'code'
 *     „Applications"  → APP11CAT10NS   twelve, legal after substitution, found:'code'
 *
 * Both had to be SUBSTITUTED to get there: I and L became 1, O became 0. A minted code needs no
 * substitution, because `crock32` never emits I, L, O or U in the first place. So the unbroken
 * shape is admitted only when the characters are already the ones `crock32` writes — which
 * `J17ZXSXN7CSQ` is and `INSTALLATION` is not — and the forgiveness for a retyped O or I stays
 * where there is separator evidence to carry it (H08 is `JI7Z-XSXN-7CSQ`, grouped).
 *
 * @param {string} raw @returns {string|null} the 12 canonical characters, or null
 */
function wholeFieldCode(raw) {
  const folded = foldPasteDamage(raw)
    .replace(/[\u00A0\t]/g, ' ')
    .replace(/-\s+/g, '-')
    .replace(/\s+-/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
  if (!WHOLE_CODE_SHAPES.grouped.some((re) => re.test(folded))) {
    if (!WHOLE_CODE_SHAPES.unbroken.test(folded)) return null;
    if (!isAlreadyCrockford(folded)) return null;
  }
  return codeToken(folded);
}

/**
 * The words an invitation uses to introduce the code, German first. A candidate that follows one
 * of these within `LABEL_WINDOW` characters is ANCHORED and beats everything else, including a
 * canonical-shaped decoy — because the sender said, in words, which one it is.
 *
 * ⚠ `\bcode\b` MATCHES THE BARE WORD „Code", WHICH THE SHIPPED GERMAN COPY USES TWICE („den
 * Code einsetzen"). That is intentional and it is also why step 1 admits only candidates that
 * already carry shape evidence: a label this broad, applied to any twelve-legal-character word
 * behind it, promoted „Installation" and „Mail-Anbieter" into codes. See defect E-1d at step 1.
 *
 * This is what makes the shipped e-mail work without editing the e-mail: its code sits under the
 * heading „DEIN EINLADUNGSCODE" / „YOUR INVITATION CODE".
 */
const CODE_LABEL_RE = /(einladungs-?code|beitrittscode|invitations?-?code|invite[\s-]*code|\bcode\b)/gi;

/** The words an invitation uses to introduce the relay. Same job, for the address. */
const ORIGIN_LABEL_RE = /(serveradresse|sync-?adresse|\bserver\b|\brelay\b)/gi;

/** How far after a label a value may stand and still count as introduced by it. */
const LABEL_WINDOW = 120;

/**
 * `XXXX-XXXX-XXXX` from anything a human has typed or pasted so far.
 *
 * `crockNormalize` is imported rather than re-implemented for the reason `pairingui.js` gives at
 * length: it folds case and maps I/L → 1 and O → 0 and deliberately does NOT map `U`, and two
 * spellings of "what did the user type" would be two answers the derivation cannot both accept.
 * `foldPasteDamage` runs FIRST and is additive: it removes characters Crockford has no opinion
 * about, and it never invents one.
 *
 * @param {string} raw @returns {string}
 */
export function formatInviteCode(raw) {
  let norm;
  try {
    norm = crockNormalize(foldPasteDamage(raw));
  } catch {
    return '';
  }
  let kept = '';
  for (const ch of norm) {
    if (CROCKFORD_ALPHABET.includes(ch)) kept += ch;
    if (kept.length === INVITE_UI.codeChars) break;
  }
  const g = INVITE_UI.codeGroup;
  const parts = [];
  for (let i = 0; i < kept.length; i += g) parts.push(kept.slice(i, i + g));
  return parts.join('-');
}

/** The 12 characters with the separators removed — the ONE form the derivation ever sees. */
export const inviteCodeChars = (formatted) => String(formatted ?? '').split('-').join('');

/**
 * One token's canonical 12 characters, or `null` if it is not a code at all.
 *
 * The alphabet check is applied to the WHOLE token rather than used as a filter: a filter turns
 * „Du bist eingeladen" into `DB1STE1NGE1A`, which is twelve perfectly valid Crockford
 * characters and a code nobody minted. A token either is a code or it is a word.
 */
function codeToken(raw) {
  let norm;
  try {
    norm = crockNormalize(foldPasteDamage(raw));
  } catch {
    return null;
  }
  if (norm.length !== INVITE_UI.codeChars) return null;
  for (const ch of norm) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return norm;
}

/** True when `at` follows an occurrence of `label` closely enough to have been introduced by it. */
function isAnchored(text, labelRe, at) {
  labelRe.lastIndex = 0;
  for (const m of text.matchAll(labelRe)) {
    const end = m.index + m[0].length;
    if (at > end && at - end <= LABEL_WINDOW) return true;
  }
  return false;
}

/** Trailing punctuation that ends a sentence rather than an address. Defect E-3. */
const URL_TAIL_RE = /[.,;:!?\u2026)\]}>"'\u00AB\u00BB\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u2039\u203A]+$/;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Every URL in the paste, and — for each — whether it is an ADDRESS or a LINK TO SOMETHING.
 *
 * DEFECT E-2, AND THE RULE THAT REPLACES THE GUESS. The parser used to take the first URL it
 * found. The shipped invitation contains exactly one URL and it is the GitHub Releases fallback
 * for providers that strip `.dmg`, so a stranger who pasted the whole e-mail was told, in a
 * reassuring green sentence, „Server aus der Einladung übernommen: https://github.com". A join
 * flow that silently points at the wrong host is the worst failure available here, because it
 * looks like it worked, and the refusal arrives one screen later wearing „Keine Verbindung zum
 * Server" — which blames the network for a host nobody ever sent.
 *
 * The rule: **a relay address is a bare origin.** Scheme, host, optional port, and nothing
 * after it. That is what `invitationText` writes, it is what `normalizeOrigin` will accept
 * downstream, and it is what the release link is NOT — `https://github.com/OWNER/REPO/releases/…`
 * carries a path, and `new URL(...).origin` used to throw that path away, destroying the only
 * evidence that this was a download link and not a server.
 *
 * DEFECT E-3 is the tail trim. `[^\s"'<>]+` stops at whitespace, ASCII quotes and angle brackets
 * and at NOTHING ELSE, so a German sentence ending in the address yielded a host with a full stop
 * welded on — accepted by `new URL`, accepted by `normalizeOrigin`, and resolving to nothing.
 * A German closing quote was worse: it went through IDNA and became `vercel.xn--app-5o0a`.
 *
 * @param {string} text
 * @returns {{origin:string|null, issue:null|'not_an_address'|'ambiguous', spans:{from:number,to:number}[]}}
 */
function readPastedOrigin(text) {
  const spans = [];
  const bare = [];
  let sawUrl = false;
  for (const m of text.matchAll(URL_RE)) {
    spans.push({ from: m.index, to: m.index + m[0].length });
    sawUrl = true;
    const trimmed = m[0].replace(URL_TAIL_RE, '');
    let u;
    try {
      u = new URL(trimmed);
    } catch {
      continue;
    }
    // Everything below is "is this an address", not "is this reachable". `normalizeOrigin` in
    // `platform/net.js` still gets the last word, including the http:// sentence.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (u.username || u.password) continue;
    if (u.search || u.hash) continue;
    if (u.pathname && u.pathname !== '/') continue;
    bare.push({ origin: u.origin, at: m.index });
  }
  const distinct = [...new Set(bare.map((b) => b.origin))];
  if (distinct.length === 1) return { origin: distinct[0], issue: null, spans };
  if (distinct.length > 1) {
    // Two addresses and no way to tell which is the relay — unless one of them was introduced by
    // the word „Server". Refuse rather than take the first, which is the habit that produced E-2.
    const anchored = bare.filter((b) => isAnchored(text, ORIGIN_LABEL_RE, b.at));
    const anchoredDistinct = [...new Set(anchored.map((b) => b.origin))];
    if (anchoredDistinct.length === 1) return { origin: anchoredDistinct[0], issue: null, spans };
    return { origin: null, issue: 'ambiguous', spans };
  }
  return { origin: null, issue: sawUrl ? 'not_an_address' : null, spans };
}

/**
 * Read a whole pasted invitation, not just a code.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT SCOPE CREEP. The relay has no default address (ADR 003 §1
 * names `https://<vercel-app>.vercel.app` and no such app exists), so a code alone is not enough
 * to reach anything. Story 15.3 promises Mom is in "within a minute" with "no registration
 * form", and asking her to find and type a URL is the registration form wearing a hat. So the
 * one big field accepts the whole thing she was sent — the address and the code, in any order,
 * with any words around them — and fills both fields out of it.
 *
 * Open question 4 in the addendum ("code only, or also a `langzeitplaner://` invite link?") is
 * NOT answered here: no scheme is invented and no link is registered. This reads plain text, and
 * a bare code still works exactly as specified when the address is already known.
 *
 * D9 is untouched: an invitation carries an address and a code, and neither is key material.
 *
 * THE ORDER, AND WHY EACH STEP IS ALLOWED TO WIN. Every step below either has direct evidence or
 * refuses; none of them takes the first thing that fits, which is what the three measured
 * defects all were.
 *
 *   0. THE FIELD HOLDS NOTHING BUT A CODE, WRITTEN AS A CODE IS WRITTEN — `XXXX-XXXX-XXXX`,
 *      `XXXX XXXX XXXX` or twelve characters unbroken. Whatever case, dashes of any kind, and a
 *      line the mail client wrapped AT a separator. „Mail-Anbieter" is four-and-eight and is not
 *      one of the three (`wholeFieldCode`, defect E-1b).
 *   1. A CANDIDATE THE SENDER LABELLED. „Dein Einladungscode" and then the code. The words are
 *      the evidence, and they beat a decoy of the right shape standing somewhere else.
 *   2. EXACTLY ONE CANDIDATE IN THE CANONICAL GROUPING. `XXXX-XXXX-XXXX` — a shape German prose
 *      does not accidentally produce, unlike „Mail-Anbieter" (4-8) or „Installation" (12).
 *   3. SEVERAL, DISAGREEING → REFUSE, and say so. `found: 'ambiguous'`.
 *   4. A CODE BEING TYPED — one token, ALONE in the field, and STRICTLY SHORTER than twelve.
 *      Passed through the formatter so the groups appear as she types, and NOT discarded.
 *   5. Prose with nothing in it that is a code. `found: 'none'`, and the caller must leave the
 *      text she pasted exactly where it is.
 *
 * THE INVARIANT, AND IT IS THE WHOLE OF E-1. **This function never answers with twelve
 * characters unless one of three things is true of the text**: the field was shaped like a code
 * (step 0), the sender labelled it in words (step 1), or it stood in the canonical grouping
 * (step 2). Each of those is evidence somebody wrote on purpose. Nothing gets twelve characters
 * out of an alphabet coincidence — not alone in the field, not truncated from a longer word, and
 * not as a `'partial'`, which the caller reads as permission to rewrite what she pasted.
 *
 * Everything else is refused out loud, with a sentence that names the line of the e-mail to
 * copy, because the Mom test's premise is one e-mail and nobody to ask.
 *
 * `found` is what the caller needs to decide whether it may rewrite the field:
 * `'code'` a whole code was recognised · `'partial'` one unfinished token · `'ambiguous'` more
 * than one thing that could be a code · `'none'` prose, and the text must be left alone.
 * `codeIssue` and `originIssue` say WHY a refusal happened, so the screen can name the line she
 * should copy instead of shrugging.
 *
 * @param {string} raw
 * @returns {{code:string, origin:string|null, found:'code'|'partial'|'none'|'ambiguous',
 *            codeIssue:null|'ambiguous'|'absent', originIssue:null|'not_an_address'|'ambiguous'}}
 */
export function parseInvitePaste(raw) {
  const text = String(raw ?? '');
  const originRead = readPastedOrigin(text);
  const origin = originRead.origin;
  const originIssue = originRead.issue;

  // The code is read from what is left after EVERY URL — not just the first one, as before — so
  // a `https://…/ABCDEFGHJKMN` path segment can never be mistaken for the code.
  let rest = text;
  for (const s of [...originRead.spans].sort((a, b) => b.from - a.from)) {
    rest = rest.slice(0, s.from) + ' ' + rest.slice(s.to);
  }

  const done = (c, found = 'code') => ({
    code: formatInviteCode(c), origin, found, codeIssue: null, originIssue,
  });
  const refuse = (found, codeIssue) => ({ code: '', origin, found, codeIssue, originIssue });

  // Step 0 — the field holds nothing but the code, WRITTEN THE WAY A CODE IS WRITTEN.
  //
  // `wholeFieldCode` and not `codeToken`: asking only "does the whole field normalise to twelve
  // Crockford characters" is what let „Mail-Anbieter", „Installation", „Applications" and
  // „Familie Weber" each become a complete code nobody minted (defect E-1b, in that function's
  // docblock). The separators are the evidence, and this is where they are read.
  const whole = wholeFieldCode(rest);
  if (whole) return done(whole);

  /** @type {{code:string, strong:boolean, plain:boolean, at:number}[]} */
  const candidates = [];
  let tokenCount = 0;
  let firstToken = '';
  for (const m of rest.matchAll(TOKEN_RE)) {
    tokenCount += 1;
    if (tokenCount === 1) firstToken = m[0];
    const c = codeToken(m[0]);
    if (!c) continue;
    const folded = foldPasteDamage(m[0]);
    candidates.push({
      code: c,
      strong: CANONICAL_CODE_RE.test(folded),
      // The unbroken tier, and the same bargain `wholeFieldCode` strikes: no separators means
      // the alphabet has to carry it, so the characters must already be ones `crock32` emits.
      plain: !folded.includes('-') && isAlreadyCrockford(folded),
      at: m.index,
    });
  }

  // Step 1 — THE SENDER SAID WHICH ONE IT IS. A label picks BETWEEN candidates; it may not
  // manufacture one out of prose.
  //
  // DEFECT E-1d, found by generating pastes out of the invitation's own vocabulary rather than
  // by naming decoys. `isAnchored` was applied to every candidate, so any twelve-legal-character
  // word standing within `LABEL_WINDOW` of „Einladungscode" — or of the bare word „Code", which
  // `CODE_LABEL_RE` also matches and which the shipped German copy uses twice — was promoted on
  // the strength of the label alone. It broke in both directions:
  //
  //     „Dein Einladungscode steht bei der Installation"   → 1NST-A11A-T10N, complete and wrong
  //     „…EINLADUNGSCODE\n J17Z-XSXN-7CSQ\n musst Mail-Anbieter" → 'ambiguous', and the REAL
  //                                                               code is thrown away with it
  //
  // The second is the worse one: a decoy standing after the code, inside the window, makes the
  // correct paste refuse itself. So an anchored candidate must carry its own shape evidence —
  // the canonical grouping, or an unbroken run that needed no substitution — exactly as steps 0
  // and 2 require. What the label then decides is WHICH of them, which is all it ever knew.
  const anchored = candidates.filter((c) => (c.strong || c.plain)
    && isAnchored(rest, CODE_LABEL_RE, c.at));
  const anchoredCodes = [...new Set(anchored.map((c) => c.code))];
  if (anchoredCodes.length === 1) return done(anchoredCodes[0]);
  if (anchoredCodes.length > 1) return refuse('ambiguous', 'ambiguous');

  // Step 2 and 3 — the canonical grouping, and only when it is unanimous.
  const strong = [...new Set(candidates.filter((c) => c.strong).map((c) => c.code))];
  if (strong.length === 1) return done(strong[0]);
  if (strong.length > 1) return refuse('ambiguous', 'ambiguous');

  // Step 4 — ONE TOKEN, ALONE IN THE FIELD, AND NOT FINISHED YET. Passed through the formatter
  // so the groups appear as she types, and never discarded.
  //
  // DEFECT E-1c — `'partial'` IS THE CALLER'S PERMISSION TO REWRITE THE FIELD, AND `submitJoin`
  // ASKS ONLY HOW LONG THE CODE IS. So a `'partial'` that is twelve characters long is a
  // complete code wearing a different label: the field is rewritten, „Beitreten" lights up, and
  // the relay is asked to redeem a word. Measured, alone in the field:
  //
  //     „Sicherheitsmeldung"  → S1CH-ERHE-1TSM   found:'partial', 12 characters, button enabled
  //     „Systemeinstellungen" → SYST-EME1-NSTE   the same
  //     „Serveradresse"       → SERV-ERAD-RESS   the same, from the line ABOVE the address
  //
  // in each case because `formatInviteCode` stops at twelve and throws the rest of the word
  // away. Truncating is a guess about WHICH characters were spurious, and the guess is invisible
  // to the person: `J177Z-XSXN-7CSQ` — one doubled character in the first group — truncates to
  // `J177-ZXSX-N7CS`, a complete, wrong, confidently-shown code. A partial may therefore never
  // reach the full length; anything that does had to come through the shape gate, the label, or
  // the canonical grouping, all of which are evidence.
  //
  // AND THE FIELD MUST HOLD NOTHING ELSE. `rest` has had every URL blanked out of it by the
  // time it is scanned, so `tokenCount <= 1` was true of „Server: https://…" — one leftover
  // word — and the screen answered a pasted SERVER LINE by replacing it with `SERV-ER`. The
  // paste held two things, so it was never one unfinished code; `spans.length` is the half of
  // "alone in the field" that the blanking had hidden.
  if (tokenCount === 1 && originRead.spans.length === 0) {
    const partial = formatInviteCode(firstToken);
    if (partial && inviteCodeChars(partial).length < INVITE_UI.codeChars) {
      return { code: partial, origin, found: 'partial', codeIssue: null, originIssue };
    }
    // A word, or a code with a character too many. Either way there is no evidence for twelve
    // particular characters, and the refusal names the line of the e-mail to copy. Reporting
    // `partial` with an empty code here used to make the join screen BLANK what she had just
    // pasted, because `'partial'` is the caller's permission to rewrite the field.
    return refuse('none', 'absent');
  }

  // Step 5 — prose with no code in it. The truthful answer is "no code", and the caller must
  // leave the text on screen alone.
  //
  // `'ambiguous'` only when it is TRUE. Its sentence says „mehr als eine Zeichenfolge, die wie
  // ein Code aussieht", and the commonest paste that lands here — the „Manche Mail-Anbieter
  // filtern .dmg-Dateien heraus" line — carries exactly one decoy. Telling her there are several
  // sends her looking for a second thing that is not there; `'absent'` names the line to copy.
  const weak = [...new Set(candidates.map((c) => c.code))];
  return refuse('none', weak.length > 1 ? 'ambiguous' : 'absent');
}

/**
 * What to say when the paste was refused — German first, and it names the line to copy.
 *
 * The Mom test's premise is a stranger, one e-mail and nobody to ask. „Der Code ist noch nicht
 * vollständig" is true and useless in that room: it describes the field, not the next move. Each
 * sentence below ends with something she can do with the e-mail she is holding.
 *
 * These sentences deliberately live here and not in `i18n.js`: they are refusals about the TEXT
 * IN THE FIELD, they are new with this fix, and `say()` is the same local pattern
 * `insecureOriginMessage` already uses two sections down. Promoting them into the table is a
 * strict improvement and belongs to whoever owns that file.
 *
 * D9: not one of them says whether a code exists, existed, or expired. They are about the paste.
 *
 * @param {{found:string, codeIssue:string|null, originIssue:string|null}} parsed
 * @returns {string|null}
 */
export function pasteRefusalSentence(parsed) {
  if (!parsed) return null;
  if (parsed.found === 'ambiguous' || parsed.codeIssue === 'ambiguous') {
    return say({
      de: 'In dem eingefügten Text steht mehr als eine Zeichenfolge, die wie ein Code aussieht — '
        + 'geraten wird hier nichts. Kopiere bitte nur die eine Zeile unter „Dein '
        + 'Einladungscode": vier Zeichen, Bindestrich, vier Zeichen, Bindestrich, vier Zeichen.',
      en: 'The pasted text holds more than one thing that could be a code, and this screen does '
        + 'not guess. Copy just the single line under "Your invitation code": four characters, '
        + 'a hyphen, four characters, a hyphen, four characters.',
    });
  }
  if (parsed.found === 'none' && parsed.codeIssue === 'absent') {
    return say({
      de: 'In dem eingefügten Text ist kein Einladungscode zu finden. In der E-Mail steht er '
        + 'unter „Dein Einladungscode" — eine eigene Zeile aus zwölf Zeichen, in drei Vierer'
        + 'gruppen. Kopiere bitte genau diese Zeile.',
      en: 'There is no invitation code in the pasted text. In the e-mail it is under "Your '
        + 'invitation code" — one line of twelve characters in three groups of four. Copy that '
        + 'line.',
    });
  }
  return null;
}

/**
 * What to say when the paste carried a URL and it was not an address. Kept apart from the code
 * sentence because they can be true at the same time and she should not read a paragraph.
 *
 * @param {{originIssue:string|null}} parsed
 * @returns {string|null}
 */
export function pasteOriginSentence(parsed) {
  if (!parsed) return null;
  if (parsed.originIssue === 'not_an_address') {
    return say({
      de: 'Der Link in der Einladung führt zum Herunterladen der App, nicht zum Server. Eine '
        + 'Serveradresse ist kurz und hat nichts hinter dem Namen — falls in der E-Mail keine '
        + 'steht, frag kurz nach und trag sie unten ein.',
      en: 'The link in the invitation points at the app download, not at the server. A server '
        + 'address is short and has nothing after the host name — if the e-mail carries none, '
        + 'ask for it and put it in the field below.',
    });
  }
  if (parsed.originIssue === 'ambiguous') {
    return say({
      de: 'In der Einladung stehen mehrere Adressen. Welche davon der Server ist, kann dieser '
        + 'Bildschirm nicht raten — trag die Serveradresse bitte unten ein.',
      en: 'The invitation carries several addresses, and this screen will not guess which one is '
        + 'the server. Put the server address in the field below.',
    });
  }
  return null;
}

/**
 * A fresh invite code: 12 Crockford characters, 60 bits, uniform.
 *
 * `crock32` over 10 random bytes yields 16 characters of which the first 12 are taken — every
 * character is 5 bits of `getRandomValues` output, so there is no modulo bias and no rejection
 * loop to get wrong. The code NEVER leaves this Mac except into the human's clipboard: the relay
 * is told `inviteId` and `verifier`, and can reconstruct neither.
 *
 * @returns {string} formatted `XXXX-XXXX-XXXX`
 */
export function newInviteCode() {
  return formatInviteCode(crock32(ports.random(10)).slice(0, INVITE_UI.codeChars));
}

/**
 * ADR 002 §7.1's two derived values, from the 12 canonical characters.
 *
 *   inviteId = b64u(HKDF(code, '', 'lzp/v2/invite/id', 16))        → 22 b64url chars
 *   proof    = HKDF(code, '', 'lzp/v2/invite/verify', 32)          → PRESENTED at redemption
 *   verifier = SHA-256(proof)                                       → STORED by the relay
 *
 * The raw code never reaches the server and the stored verifier is not sufficient to redeem — a
 * database dump yields `SHA-256(proof)`, and inverting it is the whole point.
 *
 * **The input is the normalised, separator-free, upper-case form and nothing else.** Two
 * spellings of the input are two different keys, and the symptom three layers away is „der Code
 * passt nicht" on a correctly typed code. `inviteCodeChars(formatInviteCode(x))` is the only way
 * in, on both sides, and it is applied here rather than trusted from the caller.
 *
 * @param {string} anyForm @returns {Promise<{code:string, inviteId:string, proof:string, verifier:string}>}
 */
export async function deriveInvite(anyForm) {
  const code = inviteCodeChars(formatInviteCode(anyForm));
  if (code.length !== INVITE_UI.codeChars) {
    throw new NetError('config', `deriveInvite: a code is ${INVITE_UI.codeChars} Crockford characters`);
  }
  const subtle = ports.subtle();
  const ikm = await subtle.importKey('raw', TE.encode(code), KDF.name, false, ['deriveBits']);
  const idBits = await subtle.deriveBits(hkdf(NO_SALT, INFO.inviteId), ikm, 16 * 8);
  const proofBits = await subtle.deriveBits(hkdf(NO_SALT, INFO.inviteVerify), ikm, 32 * 8);
  const proof = new Uint8Array(proofBits);
  const verifier = new Uint8Array(await subtle.digest(HASH, proof));
  // Two labels, and there is no place for a third: `suite.hkdf` refuses any string outside
  // `INFO`, and it throws BY NAME on the retired `lzp/v2/invite/wrap`. That is D9's structural
  // guard rather than a convention — a future agent who reintroduces the seven-day read window
  // meets an exception here, in this function, rather than shipping it.
  return { code, inviteId: b64u(new Uint8Array(idBits)), proof: b64u(proof), verifier: b64u(verifier) };
}

/**
 * The clipboard artifact the admin hands over. Two lines, no ceremony, and NO KEY MATERIAL —
 * an address and a code, which is exactly what §7.1 permits an invitation to carry.
 *
 * @param {{origin:string, code:string, name:string}} spec @returns {string}
 */
export function invitationText({ origin, code, name }) {
  return [
    t('circleInviteLine1', name || t('circleSectionTitle')),
    '',
    code,
    origin,
    '',
    t('circleInviteLine2'),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. Member colours — the same ten tones, a separate namespace (F15 design note)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which palette refs the circle's members already hold.
 *
 * The roster is the pseudonymous one the relay publishes — `colorRef` is the ONE deliberately
 * readable string a client may write (ADR 003 §5.2) — so this works before any key has arrived,
 * which is precisely the moment the join screen needs it.
 *
 * A REMOVED member does not hold a colour: `Member.removedAt` is set and `colorFree` on the
 * relay agrees, so a colour freed by 20.2 becomes available again rather than being retired.
 *
 * @param {Array<{colorRef?:string, removedAt?:string|null}>} members
 * @returns {string[]} sorted, unique
 */
export function takenColorRefs(members) {
  const out = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.colorRef !== 'string') continue;
    if (m.removedAt !== null && m.removedAt !== undefined) continue;
    out.add(m.colorRef);
  }
  return [...out].sort();
}

/**
 * The first tone nobody in the circle holds. Falls back to the first tone rather than to `null`
 * so the picker always has a selection — with ten tones and at most eight members (§9's fixed
 * constraint) the fallback is unreachable, and a picker with nothing selected is worse than one
 * showing a colour the server will refuse and this screen will then re-offer.
 *
 * @param {string[]} taken @returns {string}
 */
export function firstFreeColorRef(taken) {
  const used = new Set(taken || []);
  return (PALETTE.find((p) => !used.has(p.ref)) || PALETTE[0]).ref;
}

/**
 * 15.4's initial. The first grapheme of the display name, upper-cased — „M" for Mama, and the
 * right character for a name that starts with an emoji or a combining mark, which `name[0]`
 * would cut in half.
 *
 * @param {string} name @returns {string}
 */
export function memberInitial(name) {
  const first = [...String(name ?? '').trim()][0];
  return first ? first.toLocaleUpperCase() : '·';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. The capability gate — `crypto/probe.js`, on the click and never at render
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `probe.js`'s own header names three moments it must run at: „Familienkreis erstellen",
// „Familienkreis beitreten" and „Gerät koppeln". The first two are THIS FILE, and until now the
// second had no call site anywhere in the product. Memoised on the PROMISE so two fast clicks
// cannot start two probes; a failure is not memoised, because "insecure context" is exactly the
// kind of thing a reload fixes.

let probePromise = null;

/** @returns {Promise<boolean>} false means the caller has already been told. */
async function assertSuiteAvailable() {
  if (!probePromise) probePromise = probeCrypto();
  let result;
  try {
    result = await probePromise;
  } catch (e) {
    probePromise = null;
    console.warn('[circle] the crypto probe itself failed', e);
    return false;
  }
  if (isSuiteAvailable(result)) return true;
  // ADR 002 §1: one plain sentence, and it is the module's rather than this file's — a person
  // cannot act on „ECDH fehlt".
  toast(say(unavailableMessage(result)));
  return false;
}

/** Whichever of a `{de, en}` pair the screen is currently speaking. */
const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. The relay calls
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Open this Mac's durable identity and build a transport signed by it.
 *
 * Both flows need exactly this and they need it at the same point — after the human has pressed
 * the button and before anything is sent — so it is one function. `openIdentity` is where key
 * generation happens, which ADR 002 §2.4 restricts to "the family opt-in moment and nowhere
 * else": a click on „Familienkreis erstellen" or on „Beitreten" IS that moment.
 *
 * @param {string} origin @returns {Promise<{id:Object, transport:Object}>}
 */
async function armForRelay(origin) {
  const id = await ports.openIdentity(ports.today(), ports.invoke());
  const transport = ports.transport(
    origin,
    id.forStore.deviceShort,
    (bytes) => signBytes(id.identity.devSig.privateKey, bytes),
  );
  return { id, transport };
}

/**
 * The transport half of `armForRelay`, for the modules that manage a circle that already exists.
 *
 * `adminpanel.js` needs a signed transport and nothing else — no `selfAttest`, no device body, no
 * keygen — and had open-coded the same three steps. Two spellings of "open this Mac's identity
 * and sign with it" is the failure mode `suite.js` §4 names for the HKDF labels: they agree until
 * one of them is edited. So the identity is opened HERE, once, and the lifecycle modules borrow
 * the result.
 *
 * Note this still goes through `ports.openIdentity`, so a test that injected an identity into
 * `initCreateJoin` reaches the admin panel's calls too — which is the second reason to share it.
 *
 * @param {string} origin @returns {Promise<{request:Function}>}
 */
export async function circleTransport(origin) {
  const { transport } = await armForRelay(origin);
  return transport;
}

/** The device block both `POST /spaces` and `POST /invites/redeem` read. */
async function deviceBody(id) {
  return {
    deviceId: id.forStore.deviceId,
    deviceShort: id.forStore.deviceShort,
    sigPubRaw: b64u(await exportRawPublic(id.identity.devSig.publicKey)),
    kexPubRaw: b64u(await exportRawPublic(id.identity.devKex.publicKey)),
    // THE RAW BLOB STRING, not base64url of it. `readAttestedDevice` (finding E2E3-7) verifies
    // P2 + S1 + S2 over `b64u(payload).b64u(sig)` on BOTH endpoints now; a base64url wrapping
    // of the same value is refused with `attestation/bad_shape`.
    attestation: id.blob,
  };
}

/** The member block: the two recovery public keys, which is all the relay may ever hold. */
async function memberBody(id) {
  return {
    memberId: id.forStore.memberId,
    recoveryPubSig: b64u(await exportRawPublic(id.recovery.recSig.publicKey)),
    recoveryPubKex: b64u(await exportRawPublic(id.recovery.recKex.publicKey)),
  };
}

/**
 * LZP-601 — create the family space, become its first member, and mint the first invite.
 *
 * The order is a dependency order and the settings write is LAST, exactly as `mount.js` argues
 * for the personal opt-in: the settings are the flag a relaunch reads, so writing them before
 * the relay has accepted the space would leave a Mac configured into a circle nobody has heard
 * of.
 *
 *   1. epoch-1 space key, drawn (barrier 1 — no parent key, no KDF)
 *   2. `POST /spaces { kind: 'FAMILY' }` with the epoch-1 wrap to my own device
 *   3. the key ring to disk, so the next launch can read what this one writes
 *   4. `POST /invites` with the derived id and verifier — the code stays here
 *   5. the settings
 *
 * **The wrap set is the device only.** `requiredRecipients(…, 'FAMILY')` deliberately does NOT
 * require `rec_<memberId>` (server finding E2E3-8): `recoveryPubKex` is unsigned, so a relay
 * that swapped it would be handed the family key silently. Permitted, not required, and this
 * client does not send it until the attestation binds it.
 *
 * @returns {Promise<{spaceId:string, code:string, memberId:string}>}
 */
async function createCircleOnRelay(origin, colorRef) {
  const spaceId = mintSpaceId('family', ports.random);
  const { id, transport } = await armForRelay(origin);

  const spaceKey = await createSpaceKey({ subtle: ports.subtle(), random: ports.random });
  const wrapped = await wrapSpaceKey(
    spaceKey,
    id.identity.devKex.privateKey,
    await importKexPublic(await exportRawPublic(id.identity.devKex.publicKey)),
    { spaceId, epoch: 1, subtle: ports.subtle(), random: ports.random },
  );

  const created = await transport.request('POST', '/api/v1/spaces', undefined, {
    spaceId,
    kind: 'FAMILY',
    colorRef,
    member: await memberBody(id),
    device: await deviceBody(id),
    wraps: [{ recipientId: id.forStore.deviceId, epoch: 1, wrapped: encodeWrap(wrapped) }],
  });
  if (created.status !== 200) throw relayError(created, 'POST /spaces');

  saveRing(spaceId, 1, b64u(new Uint8Array(await ports.subtle().exportKey('raw', spaceKey))));

  const code = newInviteCode();
  const invite = await deriveInvite(code);
  const minted = await transport.request('POST', '/api/v1/invites', undefined, {
    spaceId, inviteId: invite.inviteId, verifier: invite.verifier,
  });
  // A circle with no invite is still a circle: the code can be re-minted from the section. So a
  // failure here is reported and does NOT unwind the space, which cannot be undone anyway.
  if (minted.status !== 200) console.warn('[circle] the space exists but the first invite failed', minted.json);

  return { spaceId, code: minted.status === 200 ? code : '', memberId: id.forStore.memberId, id };
}

/**
 * LZP-602 — redeem an invite and become a member. Returns no key material, by design (D9).
 *
 * A `colorRef` the relay refuses as taken rolls the WHOLE redemption back — `invites.js` places
 * the colour check inside the transaction for exactly this reason — so the same code may be
 * presented again with a different colour. That is the one retry this screen performs, and it is
 * not an error path: see `renderJoinForm`'s colour handling.
 *
 * @returns {Promise<{spaceId:string, memberId:string, members:Array<Object>, keysPending:boolean}>}
 */
async function redeemOnRelay(origin, anyCodeForm, colorRef) {
  const invite = await deriveInvite(anyCodeForm);
  const { id, transport } = await armForRelay(origin);
  const res = await transport.request('POST', '/api/v1/invites/redeem', undefined, {
    inviteId: invite.inviteId,
    proof: invite.proof,
    colorRef,
    member: await memberBody(id),
    device: await deviceBody(id),
  });
  if (res.status !== 200) throw relayError(res, 'POST /invites/redeem');
  const body = res.json || {};
  return {
    spaceId: body.spaceId,
    memberId: id.forStore.memberId,
    members: Array.isArray(body.members) ? body.members : [],
    // D9's designed waiting state, driven by the relay's own key-ring state rather than by an
    // assumption this client makes about it.
    keysPending: body.pendingKeys !== false,
    id,
  };
}

/** Mint one more invite for a circle that already exists — 15.5's "the admin can invite". */
async function mintInviteOnRelay(origin, spaceId) {
  const { transport } = await armForRelay(origin);
  const code = newInviteCode();
  const invite = await deriveInvite(code);
  const res = await transport.request('POST', '/api/v1/invites', undefined, {
    spaceId, inviteId: invite.inviteId, verifier: invite.verifier,
  });
  if (res.status !== 200) throw relayError(res, 'POST /invites');
  return code;
}

/**
 * The key ring, per space, exactly where `family/engine.js` keeps the personal one. **Owed to
 * `storage.js`'s owner**, with the same note `engine.js` already carries: three named slots, so
 * a Tauri build writes them beside `board.json` instead of into the WebView's storage.
 */
function saveRing(spaceId, epoch, rawB64u) {
  const key = `langzeitplaner.ring.${spaceId}`;
  try {
    const cur = JSON.parse(localStorage.getItem(key) || '{}');
    cur[String(epoch)] = rawB64u;
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    // A full disk is not a crash. The space exists on the relay and the key can be re-wrapped;
    // a thrown exception here would leave the user looking at a failure that already succeeded.
    console.warn('[circle] the epoch key could not be written to local storage');
  }
}

/**
 * Turn a relay refusal into something a person can act on.
 *
 * The `code` is what the screens branch on; `message` is only ever a fallback. Two of these are
 * named because they are the ones a real family will actually meet:
 * `invite_used` (15.5's single use, and the difference between "you were too late" and "you
 * typed it wrong") and `device_registered` (server finding E2-203-1 — a Mac that already has a
 * personal space on this relay).
 */
function relayError(res, where) {
  // `server/core/errors.js`'s `toResponse` is the ONLY function that builds a failure body, and
  // its shape is `{ error: <code>, ...extra }` — flat, with `field` and `reason` at the top
  // level. Reading a nested `detail` would be reading a shape this relay does not have.
  const body = (res && res.json) || {};
  const reason = body.reason || '';
  const field = body.field || '';
  let code = body.error || `http_${res.status}`;
  if (field === 'colorRef' && reason === 'taken') code = 'color_taken';
  // `deviceId` AND `deviceShort`: the relay refuses on whichever it checks first, and E6's
  // end-to-end run met the `deviceId` spelling, not the `deviceShort` one this line originally
  // matched. Both are the same event for the person in front of it — this Mac is already known
  // to this relay — so both get the same sentence rather than one of them falling through to a
  // raw 400 body. The second spelling was found by LEAVING a circle and trying to create
  // another: the device row survives the leave (revoked, not deleted) and its id is globally
  // unique, so the Mac is refused. See FINDINGS E6-3.
  if (/device(Id|Short)$/.test(String(field)) && reason === 'registered') code = 'device_registered';
  if (String(field).endsWith('memberId') && reason === 'exists') code = 'member_exists';
  const err = new Error(`${where} → ${res.status} ${JSON.stringify(body)}`);
  err.code = code;
  err.status = res.status;
  return err;
}

/** The sentence for a failure, chosen by code. Never a stack trace, never a status number alone. */
function sentenceFor(e) {
  const code = (e && e.code) || '';
  if (code === 'invite_invalid') return t('circleErrInviteInvalid');
  if (code === 'invite_used') return t('circleErrInviteUsed');
  if (code === 'rate_limited' || e?.status === 429) return t('circleErrTooMany');
  if (code === 'device_registered') return t('circleErrDeviceRegistered');
  if (code === 'member_exists') return t('circleErrMemberExists');
  // `platform/net.js`'s own vocabulary — `transport`, `timeout`, `blocked` — rather than a
  // guess at one. `blocked` is the CSP refusing the origin, which from the user's chair is the
  // same event as no connection and needs the same sentence.
  if (code === 'transport' || code === 'timeout' || code === 'blocked') return t('circleErrOffline');
  // Two cases the sync section already has the right words for. Reusing them is not laziness:
  // one product should not have two sentences for "this Mac may no longer talk to the relay".
  if (code === 'bad_auth' || code === 'not_a_member' || code === 'device_revoked') return t('syncErrAuth');
  if (code === 'protocol_too_old') return t('syncErrProtocol');
  if (e instanceof IdentityUnavailableError) return t('circleErrNoKeystore');
  return t('familyFailed', String((e && e.message) || e));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 8. The surface
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// NOT a sheet, for `pairingui.js`'s reason: `closeTopSheet()` (which `main.js` binds to Escape)
// removes the scrim without calling `spec.onClose`, and a join flow that vanished on Escape
// while a redemption was in flight would leave a member on the relay and no record of it on this
// Mac. This is an opaque surface with its own captured key handler, and it is also the right
// register — deliverables 14 and 15 say "flow" and "screen", and the join screen is the one
// moment this product gets to introduce itself to somebody who did not choose it.

let layer = null;
let keyHandler = null;
let lastFocus = null;

/** Everything the open screen holds. Replaced wholesale on every transition. */
let view = null;

export const circleScreenOpen = () => (layer ? layer.dataset.screen : null);

/** Exported for the DOM test: what the screen believes, without reading the DOM. */
export function circleScreenState() {
  if (!view) return null;
  return Object.freeze({
    screen: view.screen,
    step: view.step,
    busy: view.busy,
    code: view.code,
    origin: view.origin,
    circleName: view.circleName,
    displayName: view.displayName,
    colorRef: view.colorRef,
    taken: [...view.taken],
    members: view.members.length,
    keysPending: view.keysPending,
    notice: view.notice,
    problem: view.problem,
    rawPaste: view.rawPaste,
    pasteIssue: view.pasteIssue ? { ...view.pasteIssue } : null,
  });
}

/**
 * Open one of the two screens.
 *
 * 20.6 is checked HERE and not only in the section, because the section is not the only possible
 * caller and "one Familienkreis per user" must not depend on which button a future menu item is
 * wired to.
 *
 * @param {{screen:'create'|'join'}} spec
 */
export function openCircleScreen({ screen } = {}) {
  if (layer) return layer;
  if (screen !== CIRCLE_SCREEN.create && screen !== CIRCLE_SCREEN.join) {
    throw new Error(`openCircleScreen: screen must be 'create' or 'join', got ${JSON.stringify(screen)}`);
  }
  if (familyCircle()) { toast(t('circleErrAlready')); return null; }

  ensureCss();
  lastFocus = document.activeElement;
  const s = (store.state && store.state.settings) || {};
  view = {
    screen,
    step: 'form',
    busy: false,
    origin: typeof s[CIRCLE_PREFS.origin] === 'string' ? s[CIRCLE_PREFS.origin] : '',
    originFromPaste: false,
    code: '',
    /** The text of a paste this screen refused to read, kept so a re-render cannot delete it. */
    rawPaste: '',
    /** What the last parse refused and why — `{code, origin, found}`, all null on a clean read. */
    pasteIssue: { code: null, origin: null, found: 'none' },
    circleName: '',
    displayName: '',
    colorRef: PALETTE[0].ref,
    taken: new Set(),
    members: [],
    keysPending: true,
    spaceId: null,
    notice: null,       // calm, expected, not a failure — e.g. a colour somebody else holds
    problem: null,      // an actual refusal, said in one sentence
  };

  layer = el('div', 'circle');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-modal', 'true');
  layer.dataset.screen = screen;

  keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      // Escape closes and nothing else. There is no protocol session to refuse here — unlike
      // pairing — so leaving is exactly as consequential as not having started.
      closeCircleScreen();
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
      f[next].focus();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', keyHandler, true);

  document.body.appendChild(layer);
  document.body.classList.add('circle-on');
  render();
  return layer;
}

/** @param {{silent?:boolean}} [opts] */
export function closeCircleScreen(opts = {}) {
  if (!layer) return false;
  if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
  keyHandler = null;
  layer.remove();
  layer = null;
  document.body.classList.remove('circle-on');
  const finished = view && view.step === 'done';
  view = null;
  try { lastFocus?.focus?.(); } catch { /* the node may be gone */ }
  lastFocus = null;
  // A completed create or join needs the store re-derived into the space it now belongs to.
  // `useFamilySpace()` MAY be called after `init()` and `adoptCircleIntoLog` already did — there
  // is no family placeholder, so nothing can have been stamped wrongly. What may NOT is
  // `useIdentity()`: the spine is minted from `board.json` at `init()` under whatever identity is
  // current, so this session's history is still authored by the temporary one and the store says
  // so in a warning. `board.json` is the truth (ADR 006 §9.4), so re-deriving costs nothing. It
  // is the one place in this flow that asks for a reload, and it never happens on a screen
  // somebody merely closed.
  if (finished && !opts.silent) ports.reload();
  return true;
}

const focusables = () => (layer
  ? [...layer.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]:not([disabled])')]
  : []);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 9. Rendering
// ─────────────────────────────────────────────────────────────────────────────────────────────

function render() {
  if (!layer || !view) return null;
  const keep = document.activeElement?.id || null;
  const caret = document.activeElement?.selectionStart ?? null;
  layer.textContent = '';
  const card = el('div', 'circle-card');
  card.appendChild(head());
  card.appendChild(body());
  layer.appendChild(card);
  layer.setAttribute('aria-label', titleText());
  restoreFocus(keep, caret);
  return layer;
}

/**
 * Re-rendering must not steal the caret out of the field somebody is typing into. Fields carry
 * stable ids for exactly this; a control that has gone away simply does not get focus back.
 */
function restoreFocus(id, caret) {
  if (!id) {
    const first = focusables()[0];
    try { first?.focus?.(); } catch { /* nothing focusable yet */ }
    return;
  }
  const node = layer.querySelector(`#${CSS.escape(id)}`);
  if (!node) return;
  try {
    node.focus();
    if (caret != null && typeof node.setSelectionRange === 'function') node.setSelectionRange(caret, caret);
  } catch { /* a disabled control is not focusable */ }
}

function titleText() {
  if (view.step === 'done') {
    return view.screen === CIRCLE_SCREEN.create ? t('circleCreatedTitle', view.circleName) : t('circleJoinedTitle');
  }
  return view.screen === CIRCLE_SCREEN.create ? t('circleCreateTitle') : t('circleJoinTitle');
}

function head() {
  const top = el('header', 'circle-top');
  top.appendChild(el('p', 'circle-kicker', t('circleKicker')));
  const acts = el('div', 'circle-top-acts');
  // 13.7 — the toggle travels with the screen. A reader who cannot read this screen cannot
  // reach Settings to change the language, which is the whole argument.
  const lang = el('button', 'circle-lang');
  lang.type = 'button';
  lang.id = 'circle-lang';
  lang.textContent = getLang() === 'de' ? 'English' : 'Deutsch';
  lang.addEventListener('click', () => { setLang(getLang() === 'de' ? 'en' : 'de'); render(); });
  acts.appendChild(lang);
  const x = el('button', 'circle-x', '✕');
  x.type = 'button';
  x.id = 'circle-x';
  x.title = t('close');
  x.setAttribute('aria-label', t('close'));
  x.addEventListener('click', () => closeCircleScreen());
  acts.appendChild(x);
  top.appendChild(acts);
  return top;
}

function body() {
  if (view.step === 'done') {
    return view.screen === CIRCLE_SCREEN.create ? renderCreated() : renderJoined();
  }
  return view.screen === CIRCLE_SCREEN.create ? renderCreateForm() : renderJoinForm();
}

// ── 9.1 shared bits ──────────────────────────────────────────────────────────────────────────

function labelled(id, labelText, node, hint) {
  const f = el('div', 'circle-field');
  const l = el('label', null, labelText);
  l.htmlFor = id;
  f.appendChild(l);
  f.appendChild(node);
  if (hint) f.appendChild(el('p', 'circle-hint', hint));
  return f;
}

function textField(id, value, placeholder, maxLength, onInput) {
  const i = el('input');
  i.type = 'text';
  i.id = id;
  i.className = 'circle-input';
  i.value = value;
  i.placeholder = placeholder;
  i.maxLength = maxLength;
  i.autocomplete = 'off';
  i.spellcheck = false;
  i.addEventListener('input', () => onInput(i.value));
  return i;
}

/**
 * The colour picker — F15's design note: *"the join flow prevents picking a colour already taken
 * by another member"*.
 *
 * WHAT "PREVENTS" CAN HONESTLY MEAN HERE, AND WHY IT IS TWO MECHANISMS. A joiner is not yet a
 * member, and `GET /spaces/:id/members` requires an active membership, so before redemption
 * there is no way to learn the roster — the relay is right to refuse it, and any endpoint that
 * did not would turn an invite id into a roster oracle. So:
 *
 *   · a tone known to be taken is DISABLED here, not merely marked: it cannot be chosen at all,
 *     which is what the note asks for;
 *   · knowledge comes from the redemption itself. `invites.js` puts the colour check inside the
 *     transaction and rolls the whole redemption back, so a collision costs one round trip, the
 *     code still works, and the tone joins `view.taken` — after which it is disabled like any
 *     other. The create screen has the same picker with an empty `taken` set, because the
 *     founder is the first member.
 *
 * The refusal is rendered as a NOTICE and not as a problem: somebody else liking green is not a
 * failure, and calling it one would be the join flow's first impression.
 */
function colorPicker(selected, taken, onPick) {
  const row = el('div', 'circle-colors');
  row.setAttribute('role', 'radiogroup');
  row.setAttribute('aria-label', t('circleColorLabel'));
  for (const tone of PALETTE) {
    const isTaken = taken.has(tone.ref);
    const chosen = tone.ref === selected;
    const b = el('button', 'circle-color' + (chosen ? ' on' : '') + (isTaken ? ' taken' : ''));
    b.type = 'button';
    b.id = `circle-color-${tone.ref}`;
    b.dataset.ref = tone.ref;
    b.style.setProperty('--tone', colorOf(tone.ref));
    b.disabled = isTaken;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(chosen));
    const name = paletteName(tone.ref, getLang());
    b.setAttribute('aria-label', isTaken ? `${name} — ${t('circleColorTaken')}` : name);
    b.title = b.getAttribute('aria-label');
    // HUE IS NEVER THE ONLY CHANNEL — `palette.js` says so about the board and it is true here
    // too. The chosen tone carries a tick and the taken ones a stroke, so the two states survive
    // a colour-blind reader, a bad monitor and a screenshot in grey.
    if (chosen) b.appendChild(el('span', 'circle-color-mark', '✓'));
    else if (isTaken) b.appendChild(el('span', 'circle-color-mark', '╱'));
    if (!isTaken) b.addEventListener('click', () => onPick(tone.ref));
    row.appendChild(b);
  }
  return row;
}

/**
 * The relay address, shown ONLY when there is not one already.
 *
 * On the join screen it is usually absent, because `parseInvitePaste` lifts it out of whatever
 * Mom pasted. That is the difference between "one screen" and "one screen plus a URL she has to
 * find", and it is the whole reason the paste field parses rather than filters.
 */
function originField() {
  if (view.origin && !view.originFromPaste) return null;
  const node = textField('circle-origin', view.origin, 'https://…', 200, (v) => {
    view.origin = v.trim();
    view.originFromPaste = false;
  });
  // An address lifted out of the invitation still gets a field, so a typo in the invitation is
  // fixable — but not the long explanation, because the line above the field has just said
  // where the value came from and two sentences about one field is where a form starts to feel
  // like a form.
  return labelled('circle-origin', t('circleRelayLabel'), node,
    view.originFromPaste ? null : t('circleRelayHint'));
}

function notices(parent) {
  if (view.notice) parent.appendChild(el('p', 'circle-notice', view.notice));
  if (view.problem) {
    const p = el('p', 'circle-problem');
    p.setAttribute('role', 'alert');
    p.textContent = view.problem;
    parent.appendChild(p);
  }
}

function submitRow(id, label, onClick) {
  const acts = el('div', 'circle-acts');
  const b = el('button', 'circle-go', view.busy ? t('circleWorking') : label);
  b.type = 'button';
  b.id = id;
  b.disabled = view.busy;
  b.addEventListener('click', onClick);
  acts.appendChild(b);
  return acts;
}

// ── 9.2 create — LZP-601, deliverable 14 ─────────────────────────────────────────────────────

function renderCreateForm() {
  const b = el('div', 'circle-body');
  b.appendChild(el('h1', 'circle-title', t('circleCreateTitle')));
  b.appendChild(el('p', 'circle-lead', t('circleCreateLead')));

  // 20.5 and 20.6, at the moment somebody is told they are the admin — which is the moment a
  // belief about what "admin" means gets formed. Said as a plain fact, not as a disclaimer.
  const framing = el('p', 'circle-framing', t('circleAdminFraming'));
  b.appendChild(framing);

  const originRow = originField();
  if (originRow) b.appendChild(originRow);

  b.appendChild(labelled(
    'circle-name',
    t('circleNameLabel'),
    textField('circle-name', view.circleName, t('circleNamePlaceholder'), INVITE_UI.maxCircleName,
      (v) => { view.circleName = v; }),
  ));

  b.appendChild(labelled(
    'circle-display',
    t('circleYourNameLabel'),
    textField('circle-display', view.displayName, t('circleYourNamePlaceholder'), INVITE_UI.maxDisplayName,
      (v) => { view.displayName = v; }),
  ));

  b.appendChild(labelled(
    `circle-color-${view.colorRef}`,
    t('circleColorLabel'),
    colorPicker(view.colorRef, view.taken, (ref) => { view.colorRef = ref; render(); }),
  ));

  notices(b);
  b.appendChild(submitRow('circle-create-go', t('circleCreateSubmit'), submitCreate));
  b.appendChild(el('p', 'circle-foot', t('circleCreateFoot')));
  return b;
}

async function submitCreate() {
  if (view.busy) return;
  view.problem = null;
  view.notice = null;
  const name = view.circleName.trim();
  const display = view.displayName.trim();
  if (!view.origin) { fail(t('familyNeedRelay')); return; }
  try {
    normalizeOrigin(view.origin);
  } catch (e) {
    fail(e instanceof NetError && schemeOf(view.origin) === 'http:'
      ? say(insecureOriginMessage())
      : t('familyNeedRelay'));
    return;
  }
  if (!name) { fail(t('circleNeedName')); return; }
  if (!display) { fail(t('circleNeedYourName')); return; }
  // The probe, before the identity is minted and before the relay is addressed: an engine that
  // cannot do ECDH must meet one sentence, not a TypeError four steps in.
  if (!(await assertSuiteAvailable())) return;

  view.busy = true;
  render();
  // ── GATE 3'S SWITCH, BEFORE THE FIRST REQUEST (LZP-1010) ──────────────────────────────────
  //
  // This file had no reference to gate 3 at all, and `createCircleOnRelay` below is the first
  // request the product ever makes. In a shell the switch is false until something sets it, and
  // the only thing that ever did — `familysettings.js#armShellSync` — required a space to exist
  // already. So the shell refused `POST /api/v1/spaces`, `sentenceFor(e)` said
  // „net: the shell reported blocked", and the circle could not be created at all.
  //
  // Pressing „Familienkreis erstellen" after typing a name, a display name and a colour is as
  // explicit as an opt-in gets, so this is the moment the switch is supposed to move.
  const armedByThisSubmit = (await armGate3()) === 'armed';
  try {
    const out = await createCircleOnRelay(view.origin, view.colorRef);
    await rememberCircle({
      [CIRCLE_PREFS.origin]: view.origin,
      [CIRCLE_PREFS.space]: out.spaceId,
      [CIRCLE_PREFS.name]: name,
      [CIRCLE_PREFS.role]: CIRCLE_ROLE.admin,
      [CIRCLE_PREFS.member]: out.memberId,
      [CIRCLE_PREFS.display]: display,
      [CIRCLE_PREFS.color]: view.colorRef,
      // The founder holds epoch 1 already — there is nothing to wait for, which is the shape of
      // D9 seen from the other side.
      [CIRCLE_PREFS.pending]: false,
      [CIRCLE_PREFS.joinedAt]: ports.today(),
    });
    // AFTER the prefs and never before: `useFamilySpace` re-projects the board, and a board
    // re-projected into a circle whose id has not reached `board.json` would be re-projected
    // back out of it on the next launch. See `adoptCircleIntoLog`.
    await adoptCircleIntoLog(out.id, {
      spaceId: out.spaceId, admin: true, displayName: display, colorRef: view.colorRef,
    });
    view.busy = false;
    view.circleName = name;
    view.displayName = display;
    view.spaceId = out.spaceId;
    view.code = out.code;
    view.step = 'done';
    render();
  } catch (e) {
    // No circle came of it, so this Mac is still solo and the shell must say so too. Conditional
    // on `familyCircle()` because a retry after a PARTIAL failure — prefs written, adoption not —
    // must not disarm a Mac that is now in a circle.
    if (armedByThisSubmit && !familyCircle()) await disarmGate3();
    view.busy = false;
    fail(sentenceFor(e));
    console.warn('[circle] create failed', e);
  }
}

function renderCreated() {
  const b = el('div', 'circle-body');
  b.appendChild(el('h1', 'circle-title', t('circleCreatedTitle', view.circleName)));
  b.appendChild(el('p', 'circle-lead', t('circleCreatedLead')));

  // The one member there is, so deliverable 25's "fresh Familienkreis with one member" is a
  // designed state rather than an empty list.
  b.appendChild(memberStrip([{ me: true, colorRef: view.colorRef, name: view.displayName }]));

  if (view.code) {
    b.appendChild(el('p', 'circle-label', t('circleCodeLabel')));
    const code = el('p', 'circle-code', view.code);
    code.id = 'circle-code';
    b.appendChild(code);
    b.appendChild(el('p', 'circle-hint', t('circleCodeTtl', INVITE_UI.ttlDays)));
    b.appendChild(el('p', 'circle-hint', t('circleCodeShare')));
  } else {
    b.appendChild(el('p', 'circle-notice', t('circleNoCodeYet')));
  }

  notices(b);

  const acts = el('div', 'circle-acts');
  if (view.code) {
    const copy = el('button', 'circle-ghost', t('circleCopyInvite'));
    copy.type = 'button';
    copy.id = 'circle-copy';
    copy.addEventListener('click', async () => {
      try {
        await ports.clipboard(invitationText({
          origin: view.origin, code: view.code, name: view.circleName,
        }));
        toast(t('circleCopied'));
      } catch {
        // Not a failure worth a red line: the code is on screen and can be read out loud.
        toast(t('circleCopyFailed'));
      }
    });
    acts.appendChild(copy);
  }
  const done = el('button', 'circle-go', t('circleDone'));
  done.type = 'button';
  done.id = 'circle-done';
  done.addEventListener('click', () => closeCircleScreen());
  acts.appendChild(done);
  b.appendChild(acts);

  // D9 from the admin's side: nothing is asked of him, and nothing will be.
  b.appendChild(el('p', 'circle-foot', t('circleCreatedD9')));
  return b;
}

// ── 9.3 join — LZP-602, deliverable 15. The screen this epic is judged on. ────────────────────

function renderJoinForm() {
  const b = el('div', 'circle-body');
  b.appendChild(el('h1', 'circle-title', t('circleJoinTitle')));
  b.appendChild(el('p', 'circle-lead', t('circleJoinLead')));

  // THE HUGE PASTE FIELD. One field, and it takes whatever she was sent: a bare code, a code
  // with dashes, a code inside a sentence, or the whole invitation with the address in it.
  const paste = el('input');
  paste.type = 'text';
  paste.id = 'circle-code-in';
  paste.className = 'circle-paste';
  // `view.code` when the parse understood something, and otherwise the text she actually pasted
  // — which is the evidence the refusal sentence asks her to look at. Never blank.
  paste.value = view.code || view.rawPaste || '';
  paste.placeholder = t('circleCodePlaceholder');
  paste.autocomplete = 'off';
  paste.spellcheck = false;
  paste.setAttribute('aria-label', t('circleCodeInputLabel'));
  // ⚠ THE FIELD IS AN `<input>`, AND AN `<input>` STRIPS NEWLINES — it does not turn them into
  // spaces, it deletes them (HTML "value sanitization algorithm"). So the ONE gesture this screen
  // is designed around — select the whole invitation mail, paste — arrives here as
  // „…diesen Code ein:J17Z-XSXN-7CSQServer: http://…", with the code welded to the next word.
  // `parseInvitePaste` then correctly reports NO CODE, because a 20-character token is not a
  // code and it refuses to go fishing inside one (see its own case 1b comment: a filter would
  // read twelve valid characters out of „Du bist eingeladen").
  //
  // The function was right and the plumbing was wrong, so the fix is in the plumbing: on a real
  // paste the ORIGINAL string is still intact on the clipboard event, before the field ever
  // sanitises it. Parse that. `input` stays as it is for typing, where there are no newlines to
  // lose. Found by pasting a whole invitation into the real field in a real browser; the tier-2
  // test exercised the pure function, which passes either way.
  //
  // REFUSING OUT LOUD (LZP-1006). A parser that guesses produced all three measured defects, so
  // this one refuses — and a silent refusal is only half the repair. `deliberate` is true for the
  // `paste` event, which is a gesture somebody made on purpose and therefore a moment where a
  // sentence is wanted; it is false while she is TYPING, where a red line under a half-finished
  // code would be a lie about a code that is simply not finished yet.
  const readFrom = (raw, deliberate = false) => {
    const parsed = parseInvitePaste(raw);
    const changedOrigin = parsed.origin && parsed.origin !== view.origin;
    view.code = parsed.code;
    if (parsed.origin) {
      view.origin = parsed.origin;
      view.originFromPaste = true;
    }
    // What the parse refused and why, kept for `submitJoin`: the button is pressed one or two
    // moves later, and „Der Code ist noch nicht vollständig" is the wrong sentence for a paste
    // that held three things shaped like a code.
    view.pasteIssue = { code: parsed.codeIssue, origin: parsed.originIssue, found: parsed.found };
    // NORMALISE IN PLACE — but never take away text this function did not understand. `found`
    // is exactly that permission: a whole code becomes the code, an unfinished token gets its
    // groups, and prose is left as it was written. Silently emptying a field somebody is typing
    // into is the worst thing a "helpful" input can do. `'ambiguous'` joins `'none'` on the
    // leave-it-alone side for the same reason: the text she pasted is the evidence she needs in
    // order to act on the sentence she is about to read.
    const mayRewrite = parsed.found === 'code' || parsed.found === 'partial';
    // Her text, kept on `view` and not only in the DOM node. A refusal re-renders, `render()`
    // rebuilds this input from `view`, and a field that is rebuilt from `view.code` alone would
    // DELETE the paste at the exact moment a sentence appears asking her to look at it.
    view.rawPaste = mayRewrite ? '' : String(raw ?? '');
    if (mayRewrite) paste.value = parsed.code;
    else if (!paste.value) paste.value = view.rawPaste;
    let loud = false;
    if (deliberate) {
      const sentence = pasteRefusalSentence(parsed) || pasteOriginSentence(parsed);
      if (sentence) { view.problem = sentence; loud = true; }
      else if (view.problem) { view.problem = null; loud = true; }
    }
    // Re-render only when something structural changed, so the caret does not jump while she is
    // still typing the last group.
    if (changedOrigin || loud) {
      render();
      const again = document.getElementById('circle-code-in');
      if (again) again.focus();
    }
  };
  const readPaste = () => readFrom(paste.value);
  paste.addEventListener('input', readPaste);
  paste.addEventListener('paste', (e) => {
    const raw = e.clipboardData && e.clipboardData.getData('text');
    if (!raw) { setTimeout(() => readFrom(paste.value, true), 0); return; }  // no clipboard access
    e.preventDefault();                                // we are writing the field ourselves
    readFrom(raw, true);
  });
  b.appendChild(labelled('circle-code-in', t('circleCodeInputLabel'), paste,
    view.originFromPaste ? t('circleCodeFromPaste', view.origin) : null));

  const originRow = originField();
  if (originRow) b.appendChild(originRow);

  b.appendChild(labelled(
    'circle-display',
    t('circleYourNameLabel'),
    textField('circle-display', view.displayName, t('circleJoinNamePlaceholder'), INVITE_UI.maxDisplayName,
      (v) => { view.displayName = v; }),
  ));

  b.appendChild(labelled(
    `circle-color-${view.colorRef}`,
    t('circleColorLabel'),
    colorPicker(view.colorRef, view.taken, (ref) => { view.colorRef = ref; render(); }),
  ));

  notices(b);
  b.appendChild(submitRow('circle-join-go', t('circleJoinSubmit'), submitJoin));
  b.appendChild(el('p', 'circle-foot', t('circleJoinFoot')));
  return b;
}

async function submitJoin() {
  if (view.busy) return;
  view.problem = null;
  const display = view.displayName.trim();
  // THE REFUSAL SENTENCE IS THE PRODUCT HERE (LZP-1006). `circleNeedCode` — „Der Code ist noch
  // nicht vollständig — es sind zwölf Zeichen" — is true of a code being typed and useless to a
  // stranger who has just pasted a whole e-mail: it describes the field and not the next move.
  // When the parse REFUSED, say what it refused and which line of the e-mail to copy instead.
  // None of these sentences says whether a code exists or ever existed (D9).
  if (inviteCodeChars(view.code).length !== INVITE_UI.codeChars) {
    fail(pasteRefusalSentence(view.pasteIssue && {
      found: view.pasteIssue.found, codeIssue: view.pasteIssue.code, originIssue: null,
    }) || t('circleNeedCode'));
    return;
  }
  if (!view.origin) {
    fail(pasteOriginSentence(view.pasteIssue && { originIssue: view.pasteIssue.origin })
      || t('circleNeedRelayForJoin'));
    return;
  }
  try {
    normalizeOrigin(view.origin);
  } catch (e) {
    fail(e instanceof NetError && schemeOf(view.origin) === 'http:'
      ? say(insecureOriginMessage())
      : t('circleNeedRelayForJoin'));
    return;
  }
  if (!display) { fail(t('circleNeedYourName')); return; }
  if (!(await assertSuiteAvailable())) return;

  view.busy = true;
  view.notice = null;
  render();
  // Gate 3, before `redeemOnRelay` — the joiner's first request, and the joiner has no space
  // either. Same finding as `submitCreate`; see LZP-1010 there and in `gate3.js`.
  const armedByThisSubmit = (await armGate3()) === 'armed';
  try {
    const out = await redeemOnRelay(view.origin, view.code, view.colorRef);
    await rememberCircle({
      [CIRCLE_PREFS.origin]: view.origin,
      [CIRCLE_PREFS.space]: out.spaceId,
      // The circle's name lives in the encrypted stream, which this Mac cannot read yet. An
      // empty string is the truthful value; the section shows „Familienkreis" until the name
      // arrives, rather than inventing one.
      [CIRCLE_PREFS.name]: '',
      [CIRCLE_PREFS.role]: CIRCLE_ROLE.member,
      [CIRCLE_PREFS.member]: out.memberId,
      [CIRCLE_PREFS.display]: display,
      [CIRCLE_PREFS.color]: view.colorRef,
      [CIRCLE_PREFS.pending]: out.keysPending,
      [CIRCLE_PREFS.joinedAt]: ports.today(),
    });
    // `admin: false` — ADR 001 §4.1's genesis link belongs to the creator alone. A joiner that
    // emitted one would be a RIVAL ROOT, and `resolveChain` settles rival roots by
    // longest-chain-then-stamp: the later root wins, so every joiner would take the seat from
    // the founder in turn. See `adoptCircleIntoLog`.
    await adoptCircleIntoLog(out.id, {
      spaceId: out.spaceId, admin: false, displayName: display, colorRef: view.colorRef,
    });
    view.busy = false;
    view.displayName = display;
    view.spaceId = out.spaceId;
    view.members = out.members;
    view.keysPending = out.keysPending;
    view.step = 'done';
    render();
  } catch (e) {
    // Still solo, including on the `color_taken` path below — that leaves the invite usable and
    // the person on this screen, and the next press arms the switch again.
    if (armedByThisSubmit && !familyCircle()) await disarmGate3();
    view.busy = false;
    if (e && e.code === 'color_taken') {
      // NOT A FAILURE, and it must not read as one. The invite was rolled back, so the same
      // code still works; the tone is now known to be taken, the picker disables it, and a free
      // one is offered by name. One extra click at worst.
      view.taken.add(view.colorRef);
      const next = firstFreeColorRef([...view.taken]);
      view.colorRef = next;
      view.notice = t('circleColorTakenSwap', paletteName(next, getLang()));
      view.problem = null;
      render();
      return;
    }
    fail(sentenceFor(e));
    console.warn('[circle] join failed', e);
  }
}

/**
 * D9's designed screen. Read the four marked lines against `DESIGN-DECISIONS.md` § D9.
 *
 * There is no timer here, no progress element, no polling and no retry control. The panel is
 * the same whether the keys arrive in four seconds or tomorrow morning, because from Mom's chair
 * those are the same event: something that happens without her.
 */
function renderJoined() {
  const b = el('div', 'circle-body');
  // D9-4 — the title of the waiting state is an arrival, not a wait.
  b.appendChild(el('h1', 'circle-title', t('circleJoinedTitle')));
  b.appendChild(el('p', 'circle-lead', t('circleJoinedLead')));

  // D9-1 — she is IMMEDIATELY a member, and the member list says so (15.4). The roster is
  // pseudonymous until the keys arrive, so it shows what it honestly has: how many people are in
  // the circle, in their colours, with her own marked. Inventing names would be worse than
  // saying when the names come.
  const rows = [{ me: true, colorRef: view.colorRef, name: view.displayName }];
  for (const m of view.members) {
    if (!m || m.memberId === (familyCircle()?.memberId)) continue;
    if (m.removedAt) continue;
    rows.push({ me: false, colorRef: typeof m.colorRef === 'string' ? m.colorRef : PALETTE[9].ref, name: '' });
  }
  b.appendChild(memberStrip(rows));
  b.appendChild(el('p', 'circle-hint', t('circleJoinedMembers', rows.length)));

  if (view.keysPending) {
    const wait = el('div', 'circle-wait');
    // D9-2 — ONE calm German-first line. No spinner, nothing animated, nothing red.
    const line = el('p', 'circle-wait-line', t('circleWaiting'));
    line.id = 'circle-waiting';
    wait.appendChild(line);
    // D9-3 — it resolves itself, and nobody is asked to do anything about it.
    wait.appendChild(el('p', 'circle-hint', t('circleWaitingCalm')));
    b.appendChild(wait);
  } else {
    b.appendChild(el('p', 'circle-wait-line', t('circleKeysHere')));
  }

  const acts = el('div', 'circle-acts');
  const done = el('button', 'circle-go', t('circleDone'));
  done.type = 'button';
  done.id = 'circle-done';
  done.addEventListener('click', () => closeCircleScreen());
  acts.appendChild(done);
  b.appendChild(acts);

  // 20.5 / principle 8, said once at the moment it matters most: joining changed nothing about
  // what anybody can see of her.
  b.appendChild(el('p', 'circle-foot', t('circleJoinedPrivacy')));
  return b;
}

/** The member list of 15.4: colour, initial, name — and no more than the roster actually holds. */
function memberStrip(rows) {
  const strip = el('div', 'circle-members');
  strip.id = 'circle-members';
  for (const r of rows) {
    const chip = el('div', 'circle-member' + (r.me ? ' me' : ''));
    const dot = el('span', 'circle-dot', r.name ? memberInitial(r.name) : '');
    dot.style.setProperty('--tone', colorOf(r.colorRef));
    chip.appendChild(dot);
    chip.appendChild(el('span', 'circle-member-name', r.name || t('circleMemberUnnamed')));
    if (r.me) chip.appendChild(el('span', 'circle-you', t('circleYou')));
    strip.appendChild(chip);
  }
  return strip;
}

/** One sentence, in the problem slot, and a re-render. Never a toast for something on screen. */
function fail(sentence) {
  view.problem = sentence;
  render();
}

/** The scheme a person actually typed, or `''` when what they typed is not a URL at all. */
function schemeOf(raw) {
  try {
    return new URL(String(raw)).protocol;
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 10. The settings entry point — story 15.1
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * „Familienkreis" — the ONLY place in the product where family sharing exists before somebody
 * asks for it.
 *
 * Story 15.1: *"the family features exist only behind an explicit 'Familienkreis erstellen /
 * beitreten' entry point in settings."* This is that entry point, and it is two buttons and a
 * sentence. Nothing is probed, no key is minted and no request is made by drawing it — see
 * `assertSuiteAvailable`, which runs on the click.
 *
 * Once a circle exists the section becomes facts and one control: 20.6 means there is no second
 * circle to create and none to join, so both buttons are gone rather than disabled. Leaving
 * (20.3), removal (20.2), rename and delete (20.1/20.4) are LZP-603…607 and belong to the admin
 * panel, not here.
 *
 * @param {HTMLElement} body the settings sheet body
 * @param {{rebuild:Function, close:Function}} api
 */
export function buildFamilyCircleSection(body, api) {
  body.appendChild(el('div', 'section-title', t('circleSectionTitle')));
  const circle = familyCircle();

  if (circle) {
    body.appendChild(el('p', 'hint', circle.name
      ? t('circleMemberOf', circle.name)
      : t('circleMemberOfUnnamed')));
    body.appendChild(el('p', 'hint', circle.role === CIRCLE_ROLE.admin
      ? t('circleYouAdmin')
      : t('circleYouMember')));
    body.appendChild(memberStrip([{ me: true, colorRef: circle.colorRef, name: circle.displayName }]));
    if (circle.keysPending) {
      // The same calm line the join screen showed, in the place somebody goes looking when they
      // wonder. Still not an error, still nothing to do.
      body.appendChild(el('p', 'hint', t('circleWaiting')));
    }
    if (circle.role === CIRCLE_ROLE.admin) {
      const acts = el('div', 'circle-row');
      const invite = el('button', 'btn-ghost', t('circleNewInvite'));
      invite.type = 'button';
      invite.addEventListener('click', async () => {
        if (!(await assertSuiteAvailable())) return;
        invite.disabled = true;
        try {
          const code = await mintInviteOnRelay(circle.origin, circle.spaceId);
          await ports.clipboard(invitationText({ origin: circle.origin, code, name: circle.name }));
          toast(t('circleNewInviteCopied', code));
        } catch (e) {
          toast(sentenceFor(e));
        } finally {
          invite.disabled = false;
        }
      });
      acts.appendChild(invite);
      body.appendChild(acts);
    }
    body.appendChild(el('p', 'hint', t('circleOneOnly')));
    return;
  }

  const row = el('div', 'circle-row');
  const open = (screen) => {
    // The sheet must go: the screen replaces the view, and a scrim behind it would be visible
    // through nothing at all.
    try { api?.close?.(); } catch { /* an already-closed sheet is fine */ }
    openCircleScreen({ screen });
  };
  const create = el('button', 'btn-primary', t('circleCreateBtn'));
  create.type = 'button';
  create.addEventListener('click', () => open(CIRCLE_SCREEN.create));
  const join = el('button', 'btn-ghost', t('circleJoinBtn'));
  join.type = 'button';
  join.addEventListener('click', () => open(CIRCLE_SCREEN.join));
  row.appendChild(create);
  row.appendChild(join);
  body.appendChild(row);
  body.appendChild(el('p', 'hint', t('circleSectionHint')));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 11. The styles — see the file header on why they live here for now
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The `<style>` id, exported so a test can assert exactly one of them exists. */
export const CIRCLE_CSS_ID = 'lzp-circle-css';

/**
 * Every token here is one `app.css` already defines. The screens borrow the unlock screen's and
 * the pairing screen's material — `--chrome` ground, `--surface` cards, the ink hierarchy, no
 * shadow, no motion — because they are the same kind of moment: rare, consequential, met once.
 *
 * The paste field is the largest input in the product. That is the point: it is the one thing on
 * Mom's screen she has to do, and it should be impossible to miss and impossible to mis-hit.
 */
export const CIRCLE_CSS = `
.circle {
  position: fixed; inset: 0; z-index: 86; overflow-y: auto;
  background: var(--chrome); padding: 40px 24px 56px;
  -webkit-font-smoothing: antialiased;
}
body.circle-on { overflow: hidden; }
.circle-card { width: 100%; max-width: 640px; margin: 0 auto; }

.circle-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
.circle-kicker { margin: 0; font: 500 10px var(--font); letter-spacing: .8px; text-transform: uppercase; color: var(--ink-4); }
.circle-top-acts { display: flex; align-items: center; gap: 8px; }
.circle-lang {
  font: 500 11px var(--font); color: var(--ink-2); border: 1px solid var(--field-border);
  border-radius: 5px; background: var(--surface); height: 22px; padding: 0 9px;
}
.circle-lang:hover { background: var(--hover); color: var(--ink-1); }
.circle-x { font: 400 13px var(--font); color: var(--ink-3); height: 22px; width: 22px; border-radius: 5px; }
.circle-x:hover { background: var(--hover); color: var(--ink-1); }

.circle-title { margin: 0 0 8px; font: 600 21px/1.3 var(--font); color: var(--ink-1); letter-spacing: -.2px; }
.circle-lead { margin: 0 0 20px; font: 400 13.5px/1.65 var(--font); color: var(--ink-2); max-width: 58ch; }
.circle-hint { margin: 6px 0 0; font: 400 11.5px/1.6 var(--font); color: var(--ink-3); max-width: 58ch; }
.circle-foot { margin: 22px 0 0; font: 400 11.5px/1.6 var(--font); color: var(--ink-3); max-width: 58ch; }
.circle-label { margin: 18px 0 6px; font: 500 11px var(--font); letter-spacing: .5px; text-transform: uppercase; color: var(--ink-4); }

/* 20.5 — the admin framing. A quiet rule, not a warning box: it is a fact about the product,
   and a coloured panel would make it read as a caveat. */
.circle-framing {
  margin: 0 0 22px; padding-left: 11px; border-left: 2px solid var(--line-1);
  font: 400 12px/1.65 var(--font); color: var(--ink-2); max-width: 58ch;
}

.circle-field { margin: 0 0 16px; }
.circle-field > label { display: block; margin: 0 0 6px; font: 500 11.5px var(--font); color: var(--ink-2); }
.circle-input {
  width: 100%; height: 38px; padding: 0 11px;
  border: 1px solid var(--field-border); border-radius: 7px; background: var(--surface);
  font: 400 13.5px var(--font); color: var(--ink-1);
}
.circle-input::placeholder { color: var(--ink-4); }
.circle-input:focus { outline: 2px solid var(--ink-1); outline-offset: 1px; border-color: var(--ink-1); }

/* THE HUGE PASTE FIELD (15.3). Deliberately the largest input in the product. */
.circle-paste {
  width: 100%; height: 68px; padding: 0 16px;
  border: 1.5px solid var(--field-border); border-radius: 10px; background: var(--surface);
  font: 600 26px/1 var(--mono); letter-spacing: 3px; color: var(--ink-1); text-align: center;
}
.circle-paste::placeholder { color: var(--ink-4); font-weight: 400; letter-spacing: 3px; }
.circle-paste:focus { outline: 2px solid var(--ink-1); outline-offset: 1px; border-color: var(--ink-1); }

/* the code the admin hands over — read across a room, typed on the other Mac */
.circle-code {
  font: 600 32px/1.2 var(--mono); letter-spacing: 3px; color: var(--ink-1);
  background: var(--surface); border: 1px solid var(--line-1); border-radius: 9px;
  padding: 18px 20px; text-align: center; margin: 0; user-select: all;
}

/* the ten tones — the same palette as categories, a separate namespace (F15) */
.circle-colors { display: flex; flex-wrap: wrap; gap: 10px; }
.circle-color {
  width: 32px; height: 32px; border-radius: 50%; background: var(--tone);
  border: 0; display: flex; align-items: center; justify-content: center;
  color: #fff; font: 600 14px/1 var(--font);
}
/* The selection ring sits OUTSIDE the tone, so the tone itself is never altered by being
   chosen — which is the whole point of a colour picker. */
.circle-color.on { box-shadow: 0 0 0 2.5px var(--chrome), 0 0 0 4.5px var(--ink-1); }
.circle-color.taken { cursor: default; opacity: .3; }
.circle-color.taken .circle-color-mark { font-weight: 400; }
.circle-color:focus-visible { outline: 2px solid var(--ink-1); outline-offset: 4px; }

/* 15.4 — colour, initial, name */
.circle-members { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 0; }
.circle-member {
  display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 11px 0 4px;
  border: 1px solid var(--line-1); border-radius: 15px; background: var(--surface);
  font: 400 12px var(--font); color: var(--ink-2);
}
.circle-member.me { border-color: var(--field-border); }
.circle-dot {
  width: 22px; height: 22px; border-radius: 50%; background: var(--tone); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font: 600 11px var(--font);
}
.circle-you { color: var(--ink-4); font-size: 11px; }

/* D9 — the waiting state. A quiet panel, no border colour, no icon, nothing that moves. */
.circle-wait { margin: 20px 0 0; padding: 14px 16px; background: var(--hover); border-radius: 9px; }
.circle-wait-line { margin: 0; font: 400 13px/1.65 var(--font); color: var(--ink-1); max-width: 58ch; }
.circle-wait .circle-hint { margin-top: 7px; }

/* An expected outcome someone else caused — a colour already taken. Not red, not an alert. */
.circle-notice { margin: 14px 0 0; font: 400 12.5px/1.6 var(--font); color: var(--ink-2); max-width: 58ch; }
/* An actual refusal. One sentence, in the product's own restrained red. */
.circle-problem { margin: 14px 0 0; font: 400 12.5px/1.6 var(--font); color: #A03A12; max-width: 58ch; }

.circle-acts { margin-top: 22px; display: flex; gap: 10px; align-items: center; }
.circle-go { height: 40px; padding: 0 22px; border-radius: 8px; border: 0; background: var(--ink-1); color: #fff; font: 600 13px var(--font); }
.circle-go:hover:not(:disabled) { background: #4C2AA3; }
.circle-go:disabled { background: var(--ink-4); cursor: default; }
.circle-ghost {
  height: 40px; padding: 0 18px; border-radius: 8px;
  border: 1px solid var(--field-border); background: var(--surface); font: 500 13px var(--font); color: var(--ink-2);
}
.circle-ghost:hover { background: var(--hover); color: var(--ink-1); }
.circle button:focus-visible { outline: 2px solid var(--ink-1); outline-offset: 2px; }

/* the settings doorway */
.circle-row { display: flex; gap: 8px; margin: 0 0 11px; flex-wrap: wrap; }

@media (max-width: 700px) {
  .circle { padding: 26px 16px 40px; }
  .circle-paste { font-size: 20px; letter-spacing: 2px; height: 58px; }
  .circle-code { font-size: 24px; letter-spacing: 2px; }
}

/* §10's motion budget is spent on the board's roll. Nothing here animates — least of all the
   waiting state, where motion would turn "it happens by itself" into "something is loading". */
@media (prefers-reduced-motion: reduce) {
  .circle, .circle * { animation: none !important; transition: none !important; }
}
`;

/** Idempotent. One `<style>`, injected on first open, never rebuilt. */
function ensureCss() {
  if (document.getElementById(CIRCLE_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = CIRCLE_CSS_ID;
  s.textContent = CIRCLE_CSS;
  document.head.appendChild(s);
}
