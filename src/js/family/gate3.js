// ADR 003 §7 gate 3 — the shell's `sync_enabled` switch, and the two acts that move it.
//
// ── WHY THIS IS ITS OWN MODULE (LZP-1010) ────────────────────────────────────────────────────
//
// The switch has to move at the opt-in, and the product has TWO opt-ins that reach the relay
// before any space exists:
//
//   • `familysettings.js` — „Familienkreis erstellen" on the settings sheet, which calls
//     `mount.js#optIn` and POSTs /api/v1/spaces.
//   • `createjoin.js` — the circle screen's own create and join, which POST /api/v1/spaces and
//     /api/v1/invites/redeem.
//
// Neither could move it. `armShellSync` refused while no space existed, and creating the space
// is the request the switch was refusing — so „Familienkreis erstellen" answered
// „Das hat nicht geklappt: net: the shell reported blocked" on every shell ever shipped.
// `createjoin.js` did not arm at all: it had no reference to gate 3 anywhere in the file.
//
// `familysettings.js` imports `createjoin.js`, so the second cannot import the first. And this
// must stay a LEAF: `createjoin.js` deliberately does not depend on `engine.js`, and a helper
// that dragged the sync engine in through the back door would be a real regression, not a tidy.
// So this module imports nothing at all, holds only the bridge mechanics, and leaves the
// question "does this Mac have a space?" to each caller — which is the one part the two answer
// differently (`FAMILY_PREFS.space` / `CIRCLE_SPACE_PREF` there, `familyCircle()` here).
//
// Both functions are silent. A person cannot act on either answer, and the visible symptom of a
// shell that would not arm already has its own sentence in „Server & eigene Geräte" (19.3).

/** The shell bridge, or `null` in a browser. */
export function shellInvoke() {
  const fn = globalThis.window?.__TAURI__?.core?.invoke;
  return typeof fn === 'function' ? fn : null;
}

/**
 * Open gate 3. The caller has decided that this is an opt-in — a deliberate, explicit act by the
 * person, never the drawing of a sheet. That distinction is the whole of the guarantee: a solo
 * Mac originates nothing because nothing but an opt-in can reach this line.
 * @returns {Promise<'armed'|'not-in-a-shell'|'failed'>}
 */
export async function armGate3() {
  const invoke = shellInvoke();
  if (!invoke) return 'not-in-a-shell';
  try {
    await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
    return 'armed';
  } catch (e) {
    console.warn('[family] the shell would not arm sync_enabled:', (e && e.message) || e);
    return 'failed';
  }
}

/**
 * Close it again, after an opt-in that armed the switch and then failed to produce a space.
 *
 * This is the only thing in the product that turns gate 3 off, and every caller must satisfy
 * itself first that no space exists — the caller owns that question, so it is asserted there and
 * not here. Its effect is to restore the state the person was in one second earlier: solo, and
 * originating nothing. Leaving a circle is `POST /members/leave` (story 20.3) and is not this.
 * @returns {Promise<'disarmed'|'not-in-a-shell'|'failed'>}
 */
export async function disarmGate3() {
  const invoke = shellInvoke();
  if (!invoke) return 'not-in-a-shell';
  try {
    await invoke('set_shell_pref', { key: 'sync_enabled', value: false });
    return 'disarmed';
  } catch (e) {
    console.warn('[family] the shell would not disarm sync_enabled:', (e && e.message) || e);
    return 'failed';
  }
}
