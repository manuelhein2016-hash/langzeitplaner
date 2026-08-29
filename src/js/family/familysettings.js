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
//
// The order is the order a person meets them: you opt in, then you pair, then you occasionally
// wonder whether it is working.

import { el, toast } from '../ui.js';
import { t } from '../i18n.js';
import { store } from '../store.js';
import { buildPairingSection } from './pairingui.js';
import { buildSyncSection } from './syncstatus.js';
import { FAMILY_PREFS } from './engine.js';

/**
 * Mount every family section into the open settings sheet.
 *
 * @param {HTMLElement} body the sheet body
 * @param {{rebuild:Function, close:Function}} api the same `{rebuild, close}` every section takes
 * @param {{onOptIn:(origin:string) => Promise<void>}} [hooks]
 */
export function buildFamilySections(body, api, hooks = {}) {
  buildOptInSection(body, api, hooks);
  buildPairingSection(body, api);
  buildSyncSection(body, api);
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
