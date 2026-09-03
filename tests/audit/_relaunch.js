// tests/audit/_relaunch.js — THE ONE MOVE THE EXISTING RIGS NEVER MAKE.
//
// Every family rig in `tests/fleet/` builds its circle with `e6-attack-circle.js#bootMac`, which
// is a FIRST INSTALL: it clears the disk, seeds `board.json`, and calls `init()` once. TWELVE of
// the 33 fleet test files never quit and open again — measured, `grep -c relaunch` = 0 in each:
//
//   disorder · e10-backup-restore · e10-fleet-board · e6-attack-removed · e6-gate-privat
//   e6-gate-removal · e6-removal · e9-attack-coedit · e9-attack-moderation · e9-attack-restore
//   fleet-harness · round9-e6
//
// which is every removal rig and every co-editor rig this product has.
//
// That is the whole reason the three compaction defects of this week were invisible to 5,000+
// green rows: a relaunch is the ONLY event that turns an op into a register-only fact.
//
// `quitAndOpen` is the move, and it is deliberately thin — `persistNow()` then `init()` over the
// same disk, exactly what `tests/helpers/fleet.js#relaunch` does for the PERSONAL fleet, with the
// family engine rebuilt afterwards because a real quit drops it.
//
// NOT A TEST FILE: it declares no `test()`, and `tests/audit/*.test.js` cannot see it.

import { on, engineFor } from '../fleet/e6-attack-circle.js';

export { on };

/**
 * Quit and open again on the same disk. Returns nothing; `mac.store` and `mac.engine` are the
 * new session's.
 */
export async function quitAndOpen(C, mac) {
  await on(mac, async () => {
    clearTimeout(mac.store._saveTimer);
    await mac.store.persistNow();
    mac.store.ready = false;
    mac.store.listeners.clear();
    await mac.store.init();
    mac.engine = engineFor(C, mac);
  });
}

/** How many ops this Mac still holds as LINES (parked included), and how many registers it holds. */
export function shape(mac) {
  const ops = mac.store._log.ops({ includeParked: true });
  return {
    ops: ops.length,
    kinds: ops.map((o) => o.k).sort(),
    horizon: mac.store._log.horizon(),
    registers: [...mac.store._log.registers().keys()].length,
  };
}
