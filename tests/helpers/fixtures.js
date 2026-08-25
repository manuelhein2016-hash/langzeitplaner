// Deterministic board states for tier 1. Built on the app's own defaultState()
// so a change to v1's defaults shows up as a test failure rather than drifting
// past a hand-copied literal — but with the random uid()s replaced by stable
// ids, because assertions on lane assignment need reproducible tie-breaks
// (layout.assignLanes falls back to `a.id < b.id`).

import '../helpers/env.js';
import { defaultState } from '../../src/js/store.js';

export const CAT = ['cat-1', 'cat-2', 'cat-3', 'cat-4'];

/**
 * A board with four fixed-id categories, empty content, and settings you can
 * patch. `pinned` mode + an explicit startMonth keeps buildBoard() independent
 * of the wall clock.
 */
export function boardState(patch = {}) {
  const s = defaultState();
  s.categories.forEach((c, i) => { c.id = CAT[i]; });
  s.settings.lastCategoryId = CAT[0];
  s.settings.mode = 'pinned';
  s.settings.startMonth = '2026-01';
  s.settings.pageYears = 0;
  Object.assign(s.settings, patch.settings || {});
  if (patch.layers) Object.assign(s.settings.layers, patch.layers);
  if (patch.notes) s.notes = patch.notes;
  if (patch.bars) s.bars = patch.bars;
  if (patch.scratchpads) s.scratchpads = patch.scratchpads;
  if (patch.categories) s.categories = patch.categories;
  return s;
}

export const note = (id, date, text, extra = {}) => ({
  id, date, text, categoryId: CAT[0], repeatsYearly: false, ...extra,
});

export const bar = (id, startDate, endDate, label, extra = {}) => ({
  id, startDate, endDate, label, categoryId: CAT[0], ...extra,
});

/** Find one day cell in a built model. */
export function dayOf(model, dateISO) {
  for (const col of model.cols) {
    for (const d of col.days) if (!d.empty && d.date === dateISO) return d;
  }
  return null;
}

/** Find the column for a 'YYYY-MM' key. */
export const colOf = (model, key) => model.cols.find((c) => c.key === key);
