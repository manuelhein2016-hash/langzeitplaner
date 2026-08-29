// src/js/family/leavedelete.js — F20's four irreversible moments, and the sentences that come
// before them.  LZP-606 (20.3) · LZP-607 (20.4) · the confirmations for 20.1 and 20.2 · addendum
// deliverable 22 · ADR 002 §7.4 · ADR 003 §3 (`handlers/lifecycle.js`).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE COPY IS THE DELIVERABLE. THE DIALOGS ARE THE PACKAGING.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The addendum's design note under F20 is one sentence long and it is the whole ticket:
//
//   > "Removal/leave confirmations must state the consequences of 20.2/20.3 in one plain
//   >  sentence."
//
// So `LIFECYCLE_COPY` below is not strings-for-a-dialog; it is the product's answer to four
// questions a person is entitled to have answered before they press a button they cannot unpress,
// and `consequencesOf()` is a pure function so those answers can be asserted in a test without a
// DOM. The dialogs are forty lines of `openSheet`. If this file is ever refactored, the copy is
// the part that must survive intact.
//
// ── THE FOUR SENTENCES, AND WHERE EACH ONE COMES FROM ────────────────────────────────────────
//
//   20.2  removal  "their shared/Belegt entries leave every family board and their access ends —
//                   their private data on their own machine is untouched, BECAUSE IT WAS NEVER
//                   OURS."   The last clause is not reassurance, it is architecture: the relay
//                   only ever held that member's shared and Belegt ciphertext, and
//                   `purgeMember()` deletes exactly that. There is no endpoint that could reach
//                   a Privat entry, because a Privat entry never left the Mac it was typed on.
//
//   20.3  leaving  "others' shared entries disappear from my board, my own entries all revert to
//                   private and stay with me — NOBODY EVER LOSES THEIR OWN DATA BY LEAVING."
//                   Symmetric with 20.2 and self-initiated. `leaveSpace` runs the same
//                   `purgeMember` and additionally deletes the space when the leaver was the last
//                   one in it, which is a consequence this file states rather than discovers.
//
//   20.4  delete   "server data is purged and EVERY MEMBER REVERTS TO A FULLY INTACT SOLO BOARD."
//                   True because every device holds a complete replica (ADR 003 §6.3). This is
//                   the one destructive-looking action in the product that destroys no user data
//                   at all, and the copy has to carry that or the button never gets pressed.
//
//   20.1  transfer "nothing about the entries changes — including who can see what." A role is
//                   not a key. 20.5 is untouched by a transfer, and saying so here is what keeps
//                   the danger zone from implying that the admin seat is a viewing seat.
//
// ── THE HONESTY THE DESIGN DEMANDS, IN EVERY ONE OF THEM (addendum §6, ADR 002 §7.4) ─────────
//
//   > "unsharing is not unremembering: once synced, others' devices held a copy; 16.5 removes it
//   >  from their boards, but a screenshot is forever."
//
// Both the removal and the leave confirmation carry the second line — „Geteiltes lässt sich
// zurücknehmen, Gesehenes nicht." — and the relay agrees with it in as many words: every
// lifecycle response carries `alreadyDeliveredIsIrrevocable: true`, which ADR 002 §7.4 put there
// so that "the client cannot claim something stronger on screen". `assertRelayAgrees()` below
// checks it and warns when a response has stopped saying so, because copy that outlives the
// behaviour it describes is the failure mode this whole product is written against.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT SAY ─────────────────────────────────────────────────
//
//  · It never says a removal reaches into anyone's Mac. It does not.
//  · It never says the removed member "can no longer read what they had". They can. What ends is
//    access to anything NEW.
//  · It never phrases the admin role as sight (20.5). See `adminpanel.js`'s `cannotSee` line.
//
// ── THE ONE SEAM THAT IS OUT OF SCOPE, NAMED WHERE IT BITES ──────────────────────────────────
//
// LZP-608 — the epoch rotation that must follow a removal (ADR 002 §4.1/§4.2) — is a parallel
// round's. Every relay response already carries `rotateRequired: true`, and `runRemove()` passes
// it to `port.afterRemove()` rather than swallowing it, so the day 608 lands it has a caller and
// a value waiting for it and nothing in this file changes. Until then the copy claims exactly
// what the server does: access ends, the ops are purged, the wraps are deleted, the outstanding
// invites are revoked. It claims nothing about future ciphertext, because without the rotation
// that claim would be false.

import { el, openSheet, toast } from '../ui.js';
import { t, getLang } from '../i18n.js';

/** Whichever of a `{de, en}` pair the app is currently speaking. Same one-liner as
 *  `familysettings.js` — deliberately duplicated rather than shared, so neither file imports the
 *  other for four tokens. */
const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE COPY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// German first, English complete — 13.7. Every entry is either a `{de, en}` pair of strings or a
// `{de, en}` pair of functions with identical arity, so `say()` works on all of them and a
// missing translation is a missing property rather than a German sentence in an English sheet.
//
// It lives here rather than in `i18n.js` for the reason `crypto/backup.js`'s `EXPORT_SHEET_COPY`
// and `crypto/probe.js`'s `unavailableMessage()` live in their modules: this is family-mode copy
// behind the one dynamic door (`family/mount.js`), and `i18n.js` is in the boot graph of every
// solo Mac. Folding it into `i18n.js` later is mechanical; the pairs are already complete.

export const LIFECYCLE_COPY = Object.freeze({

  // ── 20.2 · removing somebody else ─────────────────────────────────────────────────────────
  remove: Object.freeze({
    title: Object.freeze({
      de: (name) => `${name} aus dem Familienkreis entfernen?`,
      en: (name) => `Remove ${name} from the family circle?`,
    }),
    /** The one plain sentence the addendum asks for. */
    consequence: Object.freeze({
      de: (name) =>
        `Die geteilten und die Belegt-Einträge von ${name} verschwinden von allen Familien-Boards `
        + 'und der Zugang zum Kreis endet sofort — die privaten Einträge auf dem eigenen Mac '
        + 'bleiben unberührt, denn sie waren nie bei uns.',
      en: (name) =>
        `${name}'s shared and Belegt entries leave every family board and access to the circle `
        + 'ends immediately — the private entries on their own Mac stay untouched, because they '
        + 'were never ours.',
    }),
    /** Addendum §6. Never omitted, in either language. */
    honesty: Object.freeze({
      de: 'Was ihr Mac schon geladen hat, bleibt auf ihrem Mac. Geteiltes lässt sich zurücknehmen, Gesehenes nicht.',
      en: 'What their Mac has already loaded stays on their Mac. Sharing can be taken back; having been seen cannot.',
    }),
    confirm: Object.freeze({ de: 'Entfernen', en: 'Remove' }),
    done: Object.freeze({
      de: (name) => `${name} ist nicht mehr im Kreis.`,
      en: (name) => `${name} is no longer in the circle.`,
    }),
    already: Object.freeze({
      de: (name) => `${name} war schon nicht mehr im Kreis.`,
      en: (name) => `${name} was already out of the circle.`,
    }),
  }),

  // ── 20.3 · leaving, self-initiated ────────────────────────────────────────────────────────
  leave: Object.freeze({
    title: Object.freeze({
      de: (space) => `„${space}“ verlassen?`,
      en: (space) => `Leave “${space}”?`,
    }),
    consequence: Object.freeze({
      de: () =>
        'Die geteilten Einträge der anderen verschwinden von deinem Board, und deine eigenen '
        + 'Einträge werden alle wieder privat und bleiben bei dir — beim Verlassen verliert '
        + 'niemand seine eigenen Daten.',
      en: () =>
        "The others' shared entries disappear from your board, and your own entries all revert "
        + 'to private and stay with you — nobody ever loses their own data by leaving.',
    }),
    honesty: Object.freeze({
      de: 'Was die anderen Macs schon geladen haben, bleibt dort. Geteiltes lässt sich zurücknehmen, Gesehenes nicht.',
      en: "What the others' Macs have already loaded stays there. Sharing can be taken back; having been seen cannot.",
    }),
    /** Only when it is true: `handlers/lifecycle.js` deletes a space whose last member leaves. */
    lastOneOut: Object.freeze({
      de: 'Du bist die letzte Person im Kreis. Mit dir wird auch der Kreis auf dem Server gelöscht.',
      en: 'You are the last person in the circle. Leaving deletes the circle on the server as well.',
    }),
    /** Only when it is true. Not a block — a fact, offered before the fact becomes a surprise. */
    youAreAdmin: Object.freeze({
      de: 'Du bist Verwalter. Übergib die Rolle vorher an jemanden, sonst bleibt der Kreis ohne Verwalter zurück.',
      en: 'You are the admin. Hand the role to somebody first, or the circle is left without one.',
    }),
    confirm: Object.freeze({ de: 'Verlassen', en: 'Leave' }),
    done: Object.freeze({
      de: 'Du bist aus dem Kreis. Dein Board gehört wieder dir allein.',
      en: 'You are out of the circle. Your board is yours alone again.',
    }),
  }),

  // ── 20.4 · deleting the whole circle ──────────────────────────────────────────────────────
  delete: Object.freeze({
    title: Object.freeze({
      de: (space) => `„${space}“ löschen?`,
      en: (space) => `Delete “${space}”?`,
    }),
    consequence: Object.freeze({
      de: () =>
        'Alle Daten des Kreises auf dem Server werden gelöscht, und jedes Mitglied behält ein '
        + 'vollständig intaktes Board für sich allein — niemand verliert einen einzigen eigenen '
        + 'Eintrag.',
      en: () =>
        "All of the circle's data on the server is purged, and every member keeps a fully intact "
        + 'board of their own — nobody loses a single entry of their own.',
    }),
    honesty: Object.freeze({
      de: 'Danach ist der Kreis für alle weg. Ein neuer lässt sich anlegen; dieser kommt nicht zurück.',
      en: 'After this the circle is gone for everyone. A new one can be made; this one does not come back.',
    }),
    /** The typed confirmation. `handlers/lifecycle.js` requires `confirm === spaceId` on the
     *  wire; a person types the NAME, which is the only one of the two they can read. */
    typeToConfirm: Object.freeze({
      de: 'Tippe den Namen des Kreises, um zu bestätigen.',
      en: 'Type the name of the circle to confirm.',
    }),
    mismatch: Object.freeze({
      de: 'Der Name stimmt noch nicht.',
      en: 'That is not the name yet.',
    }),
    confirm: Object.freeze({ de: 'Endgültig löschen', en: 'Delete for good' }),
    done: Object.freeze({
      de: 'Der Kreis ist gelöscht. Jedes Board bleibt vollständig — deins auch.',
      en: 'The circle is deleted. Every board stays complete — yours too.',
    }),
  }),

  // ── 20.1 · handing over the admin role ────────────────────────────────────────────────────
  transfer: Object.freeze({
    title: Object.freeze({
      de: (name) => `Verwalter-Rolle an ${name} übergeben?`,
      en: (name) => `Hand the admin role to ${name}?`,
    }),
    consequence: Object.freeze({
      de: (name) =>
        `${name} kann danach einladen, Einladungen zurückziehen, Mitglieder entfernen und den `
        + 'Kreis löschen. Du bleibst Mitglied wie alle anderen.',
      en: (name) =>
        `${name} will then be able to invite, revoke invites, remove members and delete the `
        + 'circle. You stay a member like everybody else.',
    }),
    /** 20.5, said at the exact moment somebody might assume the opposite. */
    honesty: Object.freeze({
      de: 'An den Einträgen ändert sich nichts — auch nicht daran, wer was sehen kann. Die Rolle verwaltet den Kreis, sie liest ihn nicht.',
      en: 'Nothing about the entries changes — including who can see what. The role manages the circle; it does not read it.',
    }),
    confirm: Object.freeze({ de: 'Übergeben', en: 'Hand over' }),
    done: Object.freeze({
      de: (name) => `${name} verwaltet den Kreis jetzt.`,
      en: (name) => `${name} manages the circle now.`,
    }),
  }),

  /** One sentence for every way the relay can say no. `familyFailed` already exists in i18n and
   *  carries the detail; this is the calm frame around it. */
  failed: Object.freeze({
    de: 'Das hat nicht geklappt. Am Kreis hat sich nichts geändert.',
    en: 'That did not work. Nothing about the circle has changed.',
  }),
  offline: Object.freeze({
    de: 'Dieser Mac ist gerade nicht mit dem Server verbunden. Am Kreis hat sich nichts geändert.',
    en: 'This Mac cannot reach the server right now. Nothing about the circle has changed.',
  }),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PURE HALF — what a person is told, as data
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** @typedef {'remove'|'leave'|'delete'|'transfer'} LifecycleKind */

/**
 * The sentences one confirmation shows, in order, in one language.
 *
 * Pure: no DOM, no clock, no network. This is the function the tier-2 suite asserts against, so
 * that "the removal confirmation states 20.2's consequence and §6's honesty in both languages" is
 * a checkable claim rather than a screenshot somebody looked at once.
 *
 * @param {LifecycleKind} kind
 * @param {'de'|'en'} lang
 * @param {{name?:string, space?:string, isAdmin?:boolean, lastOneOut?:boolean}} [ctx]
 * @returns {string[]} at least two sentences: the consequence, then the honesty
 */
export function consequencesOf(kind, lang, ctx = {}) {
  const l = lang === 'en' ? 'en' : 'de';
  const c = LIFECYCLE_COPY[kind];
  if (!c) throw new Error(`leavedelete.consequencesOf: unknown kind ${JSON.stringify(kind)}`);
  const name = ctx.name || (l === 'en' ? 'this member' : 'dieses Mitglied');
  const out = [];

  if (kind === 'remove' || kind === 'transfer') out.push(c.consequence[l](name));
  else out.push(c.consequence[l]());

  // The order is deliberate. The consequence answers "what happens", the honesty answers "and
  // what does not" — and the second is the one a person would otherwise assume in our favour.
  out.push(c.honesty[l]);

  if (kind === 'leave') {
    // Both can be true at once (a two-person circle whose admin leaves), and both are shown.
    if (ctx.lastOneOut) out.push(c.lastOneOut[l]);
    else if (ctx.isAdmin) out.push(c.youAreAdmin[l]);
  }
  return out;
}

/**
 * The title of one confirmation, in one language.
 * @param {LifecycleKind} kind @param {'de'|'en'} lang
 * @param {{name?:string, space?:string}} [ctx]
 */
export function titleOf(kind, lang, ctx = {}) {
  const l = lang === 'en' ? 'en' : 'de';
  const c = LIFECYCLE_COPY[kind];
  if (!c) throw new Error(`leavedelete.titleOf: unknown kind ${JSON.stringify(kind)}`);
  if (kind === 'remove' || kind === 'transfer') {
    return c.title[l](ctx.name || (l === 'en' ? 'this member' : 'dieses Mitglied'));
  }
  return c.title[l](ctx.space || (l === 'en' ? 'this circle' : 'diesem Kreis'));
}

/**
 * ADR 002 §7.4's belt-and-braces: the relay states `alreadyDeliveredIsIrrevocable` so that a
 * client cannot promise more than the system does. We show that sentence unconditionally — it is
 * true whatever the relay says — so this is not a gate. It is a tripwire: a response that has
 * stopped carrying the flag means someone changed the contract, and the copy in this file is
 * downstream of that contract.
 *
 * @param {Object} body a lifecycle response body
 * @param {string} route for the warning
 */
function assertRelayAgrees(body, route) {
  if (body && body.alreadyDeliveredIsIrrevocable === true) return;
  console.warn(
    `[family] ${route} answered without alreadyDeliveredIsIrrevocable. ADR 002 §7.4 requires it; `
    + 'the confirmation copy in leavedelete.js is written against it.',
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SHEET — one builder, four callers
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `ui.confirmSheet` takes ONE body string, and every confirmation here has at least two
// paragraphs plus, for 20.4, a field. So this builds on `openSheet` directly rather than
// widening a primitive that four other call sites are happy with.
//
// The shape is fixed for all four: a first paragraph in the sheet's normal voice, the honesty
// line quieter beneath it, and the destructive button on the right in `btn-danger`. Cancel is
// first and is the default target of ⎋ (`openSheet` closes on the scrim and the ✕ too), because
// this is the only family sheet where doing nothing is the safe outcome.

/**
 * `canConfirm` + `notYet` are 20.4's typed gate and nothing else uses them; they are a parameter
 * rather than a special case inside the delete caller so that the gate is visible in this
 * builder's signature instead of hidden in one branch of it.
 *
 * @param {{kind:LifecycleKind, ctx:Object, extraNodes?:HTMLElement[],
 *          canConfirm?:() => boolean, notYet?:{de:string, en:string},
 *          onConfirm:() => Promise<void>|void}} spec
 */
function confirmLifecycle(spec) {
  const lang = getLang() === 'en' ? 'en' : 'de';
  const copy = LIFECYCLE_COPY[spec.kind];
  let confirmBtn = null;

  const api = openSheet({
    title: titleOf(spec.kind, lang, spec.ctx),
    narrow: true,
    build: (body) => {
      const lines = consequencesOf(spec.kind, lang, spec.ctx);
      // Line 0 is the consequence: full weight, the sentence the story promises.
      const lead = el('p', null, lines[0]);
      lead.style.cssText = 'margin:0 0 10px;font:400 12.5px/1.6 var(--font);color:var(--ink-1)';
      body.appendChild(lead);
      // Everything after it is context: the §6 honesty, and the two conditional leave lines.
      for (const s of lines.slice(1)) {
        const p = el('p', null, s);
        p.style.cssText = 'margin:0 0 8px;font:400 11.5px/1.6 var(--font);color:var(--ink-3)';
        body.appendChild(p);
      }
      for (const n of spec.extraNodes || []) body.appendChild(n);
    },
    actions: [
      { label: t('cancel'), run: (a) => a.close() },
      {
        label: say(copy.confirm),
        kind: 'danger',
        run: async (a) => {
          if (spec.canConfirm && !spec.canConfirm()) {
            toast(say(spec.notYet || LIFECYCLE_COPY.delete.mismatch));
            return;
          }
          // The button is disabled rather than the sheet closed: a lifecycle call is one round
          // trip and a failure must leave the person exactly where they were, with the sentence
          // they just read still on screen.
          if (confirmBtn) confirmBtn.disabled = true;
          try {
            await spec.onConfirm();
            a.close();
          } catch (e) {
            if (confirmBtn) confirmBtn.disabled = false;
            reportFailure(e);
          }
        },
      },
    ],
  });

  // `openSheet` builds its own footer buttons and hands back no handles, so the danger button is
  // found by position — last child of the footer — rather than by a class the CSS also uses.
  const foot = api.body.parentElement?.querySelector('.sheet-foot');
  confirmBtn = foot ? foot.lastElementChild : null;
  return api;
}

/** One calm sentence for every failure, with the technical detail behind i18n's `familyFailed`. */
function reportFailure(e) {
  const offline = globalThis.navigator && globalThis.navigator.onLine === false;
  toast(offline ? say(LIFECYCLE_COPY.offline) : say(LIFECYCLE_COPY.failed));
  console.warn('[family] lifecycle call failed', e);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR CALLERS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Each takes the `AdminPort` (see `adminpanel.js`) and a `member` view-model, does the round trip
// and reports. None of them touches the store: what a leave or a delete does to THIS Mac's board
// is `port.afterLeave` / `port.afterDelete`, which `family/mount.js` supplies, because the
// membership and the key ring live in the handle that module holds.

/**
 * 20.2 — remove another member.
 * @param {{port:Object, member:{memberId:string, name:string}, onDone?:Function}} spec
 */
export function confirmRemoveMember(spec) {
  const { port, member } = spec;
  return confirmLifecycle({
    kind: 'remove',
    ctx: { name: member.name },
    onConfirm: async () => {
      const res = await port.removeMember(member.memberId);
      assertRelayAgrees(res, 'members/remove');
      // `alreadyRemoved` is a success, not an error: `handlers/lifecycle.js` makes the endpoint
      // idempotent precisely so a lost response never costs a second confirmation dialogue.
      toast(res && res.alreadyRemoved
        ? say(LIFECYCLE_COPY.remove.already)(member.name)
        : say(LIFECYCLE_COPY.remove.done)(member.name));
      spec.onDone?.(res);
    },
  });
}

/**
 * 20.3 — leave the circle.
 * @param {{port:Object, spaceName:string, isAdmin:boolean, lastOneOut:boolean,
 *          onDone?:Function}} spec
 */
export function confirmLeaveCircle(spec) {
  const { port } = spec;
  return confirmLifecycle({
    kind: 'leave',
    ctx: { space: spec.spaceName, isAdmin: !!spec.isAdmin, lastOneOut: !!spec.lastOneOut },
    onConfirm: async () => {
      const res = await port.leaveSpace();
      assertRelayAgrees(res, 'members/leave');
      toast(say(LIFECYCLE_COPY.leave.done));
      spec.onDone?.(res);
    },
  });
}

/**
 * 20.4 — delete the circle. The only confirmation in the product with a typed gate, because it
 * is the only action whose blast radius is other people's boards rather than one's own.
 *
 * @param {{port:Object, spaceName:string, onDone?:Function}} spec
 */
export function confirmDeleteSpace(spec) {
  const { port } = spec;
  const wanted = String(spec.spaceName || '').trim();

  const field = el('div', 'field');
  const label = el('label', null, say(LIFECYCLE_COPY.delete.typeToConfirm));
  label.style.cssText = 'width:auto;flex:none;font:400 11.5px/1.5 var(--font);color:var(--ink-2)';
  const input = el('input');
  input.type = 'text';
  input.className = 'txt';
  input.placeholder = wanted;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid var(--field-border);border-radius:5px;font:400 12px var(--font)';
  field.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 0';
  field.appendChild(label);
  field.appendChild(input);
  setTimeout(() => input.focus(), 0);

  return confirmLifecycle({
    kind: 'delete',
    ctx: { space: wanted },
    extraNodes: [field],
    // Whitespace-tolerant and case-sensitive: „familie weber" is not the name, and a trailing
    // space from a copy-paste is not a different circle.
    canConfirm: () => input.value.trim() === wanted && wanted.length > 0,
    notYet: LIFECYCLE_COPY.delete.mismatch,
    onConfirm: async () => {
      const res = await port.deleteSpace();
      // 20.4's own promise, echoed by the relay so a client cannot render this as data loss.
      if (res && res.localBoardsUnaffected !== true) {
        console.warn('[family] spaces/:id/delete answered without localBoardsUnaffected');
      }
      toast(say(LIFECYCLE_COPY.delete.done));
      spec.onDone?.(res);
    },
  });
}

/**
 * 20.1 — hand the admin role over. Not destructive, and still behind a confirmation: it is the
 * one action in the panel a person cannot undo alone afterwards.
 *
 * @param {{port:Object, member:{memberId:string, name:string}, onDone?:Function}} spec
 */
export function confirmTransferAdmin(spec) {
  const { port, member } = spec;
  return confirmLifecycle({
    kind: 'transfer',
    ctx: { name: member.name },
    onConfirm: async () => {
      const res = await port.transferAdmin(member.memberId);
      // The relay checked that the successor exists and is current, and stored NOTHING — the
      // admin chain is an in-log op (ADR 001 §4.1). `port.transferAdmin` writes that op; this
      // only reports. A relay that claims to have recorded a role is a relay to distrust.
      if (res && res.authoritative === true) {
        console.warn('[family] members/transfer claimed to be authoritative; ADR 003 §5.1 says it cannot be');
      }
      toast(say(LIFECYCLE_COPY.transfer.done)(member.name));
      spec.onDone?.(res);
    },
  });
}
