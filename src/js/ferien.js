// ─────────────────────────────────────────────────────────────────────────────
// Schulferien — BUNDLED DATA, not computed (spec §13, 7.4).
//
// THE OFFICIAL KMK TABLES. Ferien are negotiated per Bundesland and published by
// the Kultusministerkonferenz only a few years ahead, so unlike Feiertage they
// cannot be derived from a rule — they have to be carried.
//
// Source: https://www.kmk.org/service/ferien.html — the per-school-year tables
// `FER2025_26.pdf` … `FER2028_29.pdf`, four school years, all sixteen Länder.
//
// HOW THIS WAS VERIFIED, because a calendar that shades the wrong week is worse
// than one that shades nothing: the tables were extracted from the PDFs by word
// GEOMETRY (a state's continuation lines sit both above and below its name row,
// so column heuristics attribute Bayern's February break to Baden-Württemberg),
// and the result for 2026/27 was then compared against the KMK's own per-state
// .ics downloads — an independent publication of the same data, parsed by a
// different code path. 16/16 states and 1 400 holiday-days matched exactly, with
// zero differences, which is what earns the other three school years their trust.
//
// THE NAMES ARE THE KMK's OWN. Its columns group „Ostern/Frühjahr" and
// „Himmelfahrt/Pfingsten", and splitting those into the six invented names this
// file used to carry would mean guessing — Bavaria's February break sits in the
// „Ostern/Frühjahr" column and is not Osterferien. Guessing a holiday's name is
// how a hover tooltip ends up lying, so the source's own labels are kept.
//
// To extend: drop in the next `FERnnnn_nn.pdf`, re-run the extraction, set
// `horizon` to the EARLIEST last-covered day across the sixteen Länder (beyond
// that day at least one state has no data, and 7.4 says the shading is simply
// absent past the horizon) and `updated` to the release date.
// ─────────────────────────────────────────────────────────────────────────────

export const FERIEN_META = {
  verified: true,
  horizon: '2029-07-28',
  updated: '2026-09-12',
  source: 'KMK — Ferienkalender 2025/26–2028/29 (kmk.org/service/ferien.html)',
};

/**
 * 7.4 — the last day THIS Bundesland has data for.
 *
 * `FERIEN_META.horizon` is the dataset's horizon: the EARLIEST last-covered day across all
 * sixteen Länder, so it never promises coverage a state does not have. That makes it safe and,
 * for fifteen of the sixteen, pessimistic by up to six weeks — and the person reading it in
 * settings has exactly one Bundesland selected. So when a state is known, show that state's own
 * last covered day; the conservative global figure is the fallback for „nur bundesweite Feiertage"
 * and for an unknown code.
 *
 * Underselling is the safe direction and overselling is not: a horizon later than the data would
 * invite someone to read absent shading as "no holidays", which is the one thing 7.4 exists to
 * prevent.
 *
 * @param {string} code a Bundesland code, or anything else for the dataset-wide answer
 * @returns {string} `YYYY-MM-DD`
 */
export function ferienHorizonFor(code) {
  const rows = FERIEN[code];
  if (!Array.isArray(rows) || rows.length === 0) return FERIEN_META.horizon;
  let last = FERIEN_META.horizon;
  for (const [, , end] of rows) if (end > last) last = end;
  return last;
}

// ── 13.7 · THE FERIEN NAMES STAY GERMAN, IN BOTH LANGUAGES ──────────────────
//
// This used to be a translation table — `Sommerferien` → „Summer break" — applied
// whenever `lang === 'en'`. Story 13.7 says the opposite in as many words:
// *"switching translates the full UI while German content terms (Feiertage names,
// Ferien names) remain German."*
//
// They are proper nouns of the German school calendar, not chrome. „Ostern/Frühjahr"
// is what the KMK publishes and what a parent in Germany reads on a school letter;
// an English reader here is reading a German calendar, and a translated name makes
// it harder, not easier, to match what the school actually said. The LAYER LABEL
// („Schulferien" / „School holidays") is chrome and is still translated by i18n.js.
//
// Kept as an empty frozen export rather than deleted so that an importer gets an
// empty table instead of a TypeError, and so this reasoning has somewhere to live.
export const FERIEN_NAMES_EN = Object.freeze({});

// [name, firstDay, lastDay] — both ends inclusive.
export const FERIEN = {
  BW: [
    ['Herbstferien', '2025-10-27', '2025-10-31'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-05'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-11'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-06-05'],
    ['Sommerferien', '2026-07-30', '2026-09-12'],
    ['Herbstferien', '2026-10-26', '2026-10-31'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-09'],
    ['Oster-/Frühjahrsferien', '2027-03-25', '2027-03-25'],
    ['Oster-/Frühjahrsferien', '2027-03-30', '2027-04-03'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-29'],
    ['Sommerferien', '2027-07-29', '2027-09-11'],
    ['Herbstferien', '2027-11-02', '2027-11-06'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-08'],
    ['Oster-/Frühjahrsferien', '2028-04-13', '2028-04-13'],
    ['Oster-/Frühjahrsferien', '2028-04-18', '2028-04-22'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-06', '2028-06-17'],
    ['Sommerferien', '2028-07-27', '2028-09-09'],
    ['Herbstferien', '2028-10-30', '2028-11-03'],
    ['Weihnachtsferien', '2028-12-23', '2029-01-05'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-07'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-06-01'],
    ['Sommerferien', '2029-07-26', '2029-09-08'],
  ],
  BY: [
    ['Herbstferien', '2025-11-03', '2025-11-07'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-05'],
    ['Oster-/Frühjahrsferien', '2026-02-16', '2026-02-20'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-10'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-06-05'],
    ['Sommerferien', '2026-08-03', '2026-09-14'],
    ['Herbstferien', '2026-11-02', '2026-11-06'],
    ['Weihnachtsferien', '2026-12-24', '2027-01-08'],
    ['Oster-/Frühjahrsferien', '2027-02-08', '2027-02-12'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-02'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-28'],
    ['Sommerferien', '2027-08-02', '2027-09-13'],
    ['Herbstferien', '2027-11-02', '2027-11-05'],
    ['Weihnachtsferien', '2027-12-24', '2028-01-07'],
    ['Oster-/Frühjahrsferien', '2028-02-28', '2028-03-03'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-21'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-06', '2028-06-16'],
    ['Sommerferien', '2028-07-31', '2028-09-11'],
    ['Herbstferien', '2028-10-30', '2028-11-03'],
    ['Weihnachtsferien', '2028-12-23', '2029-01-05'],
    ['Oster-/Frühjahrsferien', '2029-02-12', '2029-02-16'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-06'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-06-01'],
    ['Sommerferien', '2029-07-30', '2029-09-10'],
  ],
  BE: [
    ['Herbstferien', '2025-10-20', '2025-11-01'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-02'],
    ['Winterferien', '2026-02-02', '2026-02-07'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-10'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-05-26'],
    ['Sommerferien', '2026-07-09', '2026-08-22'],
    ['Herbstferien', '2026-10-19', '2026-10-31'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-02'],
    ['Winterferien', '2027-02-01', '2027-02-06'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-02'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-19'],
    ['Sommerferien', '2027-07-01', '2027-08-14'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2027-12-31'],
    ['Winterferien', '2028-01-31', '2028-02-05'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-22'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-01', '2028-06-02'],
    ['Sommerferien', '2028-07-01', '2028-08-12'],
    ['Herbstferien', '2028-10-02', '2028-10-02'],
    ['Weihnachtsferien', '2028-12-22', '2029-01-02'],
    ['Winterferien', '2029-01-29', '2029-02-03'],
    ['Winterferien', '2029-03-09', '2029-03-09'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-06'],
    ['Oster-/Frühjahrsferien', '2029-04-30', '2029-04-30'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-05-25'],
    ['Sommerferien', '2029-07-01', '2029-08-11'],
  ],
  BB: [
    ['Herbstferien', '2025-10-20', '2025-11-01'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-02'],
    ['Winterferien', '2026-02-02', '2026-02-07'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-10'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-05-26'],
    ['Sommerferien', '2026-07-09', '2026-07-09'],
    ['Herbstferien', '2026-10-19', '2026-10-30'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-02'],
    ['Winterferien', '2027-02-01', '2027-02-06'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-03'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-18'],
    ['Sommerferien', '2027-07-01', '2027-08-14'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-23', '2027-12-31'],
    ['Winterferien', '2028-01-31', '2028-02-05'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-22'],
    ['Sommerferien', '2028-06-29', '2028-08-12'],
    ['Herbstferien', '2028-10-02', '2028-10-14'],
    ['Weihnachtsferien', '2028-12-22', '2029-01-02'],
    ['Winterferien', '2029-01-29', '2029-02-03'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-06'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-05-22'],
    ['Sommerferien', '2029-06-28', '2029-08-11'],
  ],
  HB: [
    ['Herbstferien', '2025-10-13', '2025-10-25'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-05'],
    ['Winterferien', '2026-02-02', '2026-02-03'],
    ['Oster-/Frühjahrsferien', '2026-03-23', '2026-04-07'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-05-26'],
    ['Sommerferien', '2026-07-02', '2026-08-12'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-09'],
    ['Winterferien', '2027-02-01', '2027-02-02'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-03'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-18'],
    ['Sommerferien', '2027-07-08', '2027-08-18'],
    ['Herbstferien', '2027-10-18', '2027-10-30'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-08'],
    ['Winterferien', '2028-01-31', '2028-02-01'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-22'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-06', '2028-06-06'],
    ['Sommerferien', '2028-07-20', '2028-08-30'],
    ['Herbstferien', '2028-10-02', '2028-10-02'],
    ['Herbstferien', '2028-10-23', '2028-11-04'],
    ['Weihnachtsferien', '2028-12-27', '2029-01-06'],
    ['Winterferien', '2029-02-01', '2029-02-02'],
    ['Oster-/Frühjahrsferien', '2029-03-19', '2029-04-03'],
    ['Oster-/Frühjahrsferien', '2029-04-30', '2029-04-30'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-05-22'],
    ['Sommerferien', '2029-07-19', '2029-08-29'],
  ],
  HH: [
    ['Herbstferien', '2025-10-20', '2025-10-31'],
    ['Weihnachtsferien', '2025-12-17', '2026-01-02'],
    ['Winterferien', '2026-01-30', '2026-01-30'],
    ['Oster-/Frühjahrsferien', '2026-03-02', '2026-03-13'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-11', '2026-05-15'],
    ['Sommerferien', '2026-07-09', '2026-08-19'],
    ['Herbstferien', '2026-10-19', '2026-10-30'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-01'],
    ['Winterferien', '2027-01-29', '2027-01-29'],
    ['Oster-/Frühjahrsferien', '2027-03-01', '2027-03-12'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-14'],
    ['Sommerferien', '2027-07-01', '2027-08-11'],
    ['Herbstferien', '2027-10-11', '2027-10-22'],
    ['Weihnachtsferien', '2027-12-20', '2027-12-31'],
    ['Winterferien', '2028-01-28', '2028-01-28'],
    ['Oster-/Frühjahrsferien', '2028-03-06', '2028-03-17'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-22', '2028-05-26'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
    ['Herbstferien', '2028-10-02', '2028-10-13'],
    ['Herbstferien', '2028-10-30', '2028-10-30'],
    ['Weihnachtsferien', '2028-12-18', '2028-12-29'],
    ['Winterferien', '2029-02-02', '2029-02-02'],
    ['Oster-/Frühjahrsferien', '2029-03-05', '2029-03-16'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-18'],
    ['Sommerferien', '2029-07-02', '2029-08-10'],
  ],
  HE: [
    ['Herbstferien', '2025-10-06', '2025-10-18'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-10'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-10'],
    ['Sommerferien', '2026-06-29', '2026-08-07'],
    ['Herbstferien', '2026-10-05', '2026-10-17'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-12'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-02'],
    ['Sommerferien', '2027-06-28', '2027-08-06'],
    ['Herbstferien', '2027-10-04', '2027-10-16'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-11'],
    ['Oster-/Frühjahrsferien', '2028-04-03', '2028-04-14'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
    ['Herbstferien', '2028-10-09', '2028-10-20'],
    ['Weihnachtsferien', '2028-12-27', '2029-01-12'],
    ['Oster-/Frühjahrsferien', '2029-03-29', '2029-04-13'],
    ['Sommerferien', '2029-07-16', '2029-08-24'],
  ],
  MV: [
    ['Herbstferien', '2025-10-02', '2025-10-02'],
    ['Herbstferien', '2025-10-20', '2025-10-24'],
    ['Herbstferien', '2025-11-03', '2025-11-03'],
    ['Weihnachtsferien', '2025-12-20', '2026-01-03'],
    ['Winterferien', '2026-02-09', '2026-02-20'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-08'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-22', '2026-05-26'],
    ['Sommerferien', '2026-07-13', '2026-08-22'],
    ['Herbstferien', '2026-10-15', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-08', '2027-02-19'],
    ['Oster-/Frühjahrsferien', '2027-03-24', '2027-04-02'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-14', '2027-05-18'],
    ['Sommerferien', '2027-07-05', '2027-08-14'],
    ['Herbstferien', '2027-10-14', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-04'],
    ['Winterferien', '2028-02-05', '2028-02-18'],
    ['Oster-/Frühjahrsferien', '2028-04-12', '2028-04-21'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-02', '2028-06-06'],
    ['Sommerferien', '2028-06-26', '2028-08-05'],
    ['Herbstferien', '2028-10-02', '2028-10-02'],
    ['Herbstferien', '2028-10-23', '2028-10-28'],
    ['Herbstferien', '2028-10-30', '2028-10-30'],
    ['Weihnachtsferien', '2028-12-22', '2029-01-02'],
    ['Winterferien', '2029-02-05', '2029-02-16'],
    ['Oster-/Frühjahrsferien', '2029-03-09', '2029-03-09'],
    ['Oster-/Frühjahrsferien', '2029-03-28', '2029-04-06'],
    ['Oster-/Frühjahrsferien', '2029-04-30', '2029-04-30'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-18', '2029-05-22'],
    ['Sommerferien', '2029-06-18', '2029-07-28'],
  ],
  NI: [
    ['Herbstferien', '2025-10-13', '2025-10-25'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-05'],
    ['Winterferien', '2026-02-02', '2026-02-03'],
    ['Oster-/Frühjahrsferien', '2026-03-23', '2026-04-07'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-05-26'],
    ['Sommerferien', '2026-07-02', '2026-08-12'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-09'],
    ['Winterferien', '2027-02-01', '2027-02-02'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-03'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-18'],
    ['Sommerferien', '2027-07-08', '2027-08-18'],
    ['Herbstferien', '2027-10-16', '2027-10-30'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-08'],
    ['Winterferien', '2028-01-31', '2028-02-01'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-22'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-06', '2028-06-06'],
    ['Sommerferien', '2028-07-20', '2028-08-30'],
    ['Herbstferien', '2028-10-02', '2028-10-02'],
    ['Herbstferien', '2028-10-23', '2028-11-04'],
    ['Weihnachtsferien', '2028-12-27', '2029-01-06'],
    ['Winterferien', '2029-02-01', '2029-02-02'],
    ['Oster-/Frühjahrsferien', '2029-03-19', '2029-04-03'],
    ['Oster-/Frühjahrsferien', '2029-04-30', '2029-04-30'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-05-22'],
    ['Sommerferien', '2029-07-19', '2029-08-29'],
  ],
  NW: [
    ['Herbstferien', '2025-10-13', '2025-10-25'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-06'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-11'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-05-26'],
    ['Sommerferien', '2026-07-20', '2026-09-01'],
    ['Herbstferien', '2026-10-17', '2026-10-31'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-06'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-03'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-18', '2027-05-18'],
    ['Sommerferien', '2027-07-19', '2027-08-31'],
    ['Herbstferien', '2027-10-23', '2027-11-06'],
    ['Weihnachtsferien', '2027-12-24', '2028-01-08'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-22'],
    ['Sommerferien', '2028-07-10', '2028-08-22'],
    ['Herbstferien', '2028-10-23', '2028-11-04'],
    ['Weihnachtsferien', '2028-12-21', '2029-01-05'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-07'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-05-22'],
    ['Sommerferien', '2029-07-02', '2029-08-14'],
  ],
  RP: [
    ['Herbstferien', '2025-10-13', '2025-10-24'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-07'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-10'],
    ['Sommerferien', '2026-06-29', '2026-08-07'],
    ['Herbstferien', '2026-10-05', '2026-10-16'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-08'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-02'],
    ['Sommerferien', '2027-06-28', '2027-08-06'],
    ['Herbstferien', '2027-10-04', '2027-10-15'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-07'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-21'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
    ['Herbstferien', '2028-10-09', '2028-10-20'],
    ['Weihnachtsferien', '2028-12-21', '2029-01-08'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-06'],
    ['Sommerferien', '2029-07-16', '2029-08-24'],
  ],
  SL: [
    ['Herbstferien', '2025-10-13', '2025-10-24'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-02'],
    ['Winterferien', '2026-02-16', '2026-02-20'],
    ['Oster-/Frühjahrsferien', '2026-04-17', '2026-04-17'],
    ['Sommerferien', '2026-06-29', '2026-08-07'],
    ['Herbstferien', '2026-10-05', '2026-10-16'],
    ['Weihnachtsferien', '2026-12-21', '2026-12-31'],
    ['Winterferien', '2027-02-08', '2027-02-12'],
    ['Oster-/Frühjahrsferien', '2027-03-30', '2027-04-09'],
    ['Sommerferien', '2027-06-28', '2027-08-06'],
    ['Herbstferien', '2027-10-04', '2027-10-15'],
    ['Weihnachtsferien', '2027-12-20', '2027-12-31'],
    ['Winterferien', '2028-02-21', '2028-02-29'],
    ['Oster-/Frühjahrsferien', '2028-04-12', '2028-04-21'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
    ['Herbstferien', '2028-10-09', '2028-10-20'],
    ['Weihnachtsferien', '2028-12-20', '2029-01-02'],
    ['Winterferien', '2029-02-12', '2029-02-16'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-06'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-22', '2029-05-25'],
    ['Sommerferien', '2029-07-16', '2029-08-24'],
  ],
  SN: [
    ['Herbstferien', '2025-10-06', '2025-10-18'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-02'],
    ['Winterferien', '2026-02-09', '2026-02-21'],
    ['Oster-/Frühjahrsferien', '2026-04-03', '2026-04-10'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Sommerferien', '2026-07-04', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-02'],
    ['Winterferien', '2027-02-08', '2027-02-19'],
    ['Oster-/Frühjahrsferien', '2027-03-26', '2027-04-02'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-15', '2027-05-18'],
    ['Sommerferien', '2027-07-10', '2027-08-20'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-01'],
    ['Winterferien', '2028-02-14', '2028-02-26'],
    ['Oster-/Frühjahrsferien', '2028-04-14', '2028-04-22'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Sommerferien', '2028-07-22', '2028-09-01'],
    ['Herbstferien', '2028-10-23', '2028-11-03'],
    ['Weihnachtsferien', '2028-12-23', '2029-01-03'],
    ['Winterferien', '2029-02-05', '2029-02-16'],
    ['Oster-/Frühjahrsferien', '2029-03-29', '2029-04-06'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-19', '2029-05-22'],
    ['Sommerferien', '2029-07-21', '2029-08-31'],
  ],
  ST: [
    ['Herbstferien', '2025-10-13', '2025-10-25'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-05'],
    ['Winterferien', '2026-01-31', '2026-02-06'],
    ['Oster-/Frühjahrsferien', '2026-03-30', '2026-04-04'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-26', '2026-05-29'],
    ['Sommerferien', '2026-07-04', '2026-08-14'],
    ['Herbstferien', '2026-10-19', '2026-10-30'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-01', '2027-02-06'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-03-27'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-15', '2027-05-22'],
    ['Sommerferien', '2027-07-10', '2027-08-20'],
    ['Herbstferien', '2027-10-18', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-20', '2027-12-31'],
    ['Winterferien', '2028-02-07', '2028-02-12'],
    ['Oster-/Frühjahrsferien', '2028-04-10', '2028-04-22'],
    ['Himmelfahrt-/Pfingstferien', '2028-06-03', '2028-06-10'],
    ['Sommerferien', '2028-07-22', '2028-09-01'],
    ['Herbstferien', '2028-10-02', '2028-10-02'],
    ['Herbstferien', '2028-10-30', '2028-11-03'],
    ['Weihnachtsferien', '2028-12-21', '2029-01-02'],
    ['Winterferien', '2029-02-05', '2029-02-10'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-03-31'],
    ['Himmelfahrt-/Pfingstferien', '2029-04-30', '2029-04-30'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-25'],
    ['Sommerferien', '2029-07-21', '2029-08-31'],
  ],
  SH: [
    ['Herbstferien', '2025-10-20', '2025-10-30'],
    ['Weihnachtsferien', '2025-12-19', '2026-01-06'],
    ['Oster-/Frühjahrsferien', '2026-03-26', '2026-04-10'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Sommerferien', '2026-07-04', '2026-08-15'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-06'],
    ['Oster-/Frühjahrsferien', '2027-03-30', '2027-04-10'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Sommerferien', '2027-07-03', '2027-08-14'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-08'],
    ['Oster-/Frühjahrsferien', '2028-04-03', '2028-04-15'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Sommerferien', '2028-06-24', '2028-08-04'],
    ['Herbstferien', '2028-10-16', '2028-10-30'],
    ['Weihnachtsferien', '2028-12-21', '2029-01-05'],
    ['Oster-/Frühjahrsferien', '2029-03-23', '2029-04-06'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Sommerferien', '2029-06-23', '2029-08-03'],
  ],
  TH: [
    ['Herbstferien', '2025-10-06', '2025-10-18'],
    ['Weihnachtsferien', '2025-12-22', '2026-01-03'],
    ['Winterferien', '2026-02-16', '2026-02-21'],
    ['Oster-/Frühjahrsferien', '2026-04-07', '2026-04-17'],
    ['Himmelfahrt-/Pfingstferien', '2026-05-15', '2026-05-15'],
    ['Sommerferien', '2026-07-04', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-02'],
    ['Winterferien', '2027-02-01', '2027-02-06'],
    ['Oster-/Frühjahrsferien', '2027-03-22', '2027-04-03'],
    ['Himmelfahrt-/Pfingstferien', '2027-05-07', '2027-05-07'],
    ['Sommerferien', '2027-07-10', '2027-08-20'],
    ['Herbstferien', '2027-10-09', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-23', '2027-12-31'],
    ['Winterferien', '2028-02-07', '2028-02-12'],
    ['Oster-/Frühjahrsferien', '2028-04-03', '2028-04-15'],
    ['Himmelfahrt-/Pfingstferien', '2028-05-26', '2028-05-26'],
    ['Sommerferien', '2028-07-22', '2028-09-01'],
    ['Herbstferien', '2028-10-23', '2028-11-03'],
    ['Weihnachtsferien', '2028-12-23', '2029-01-05'],
    ['Winterferien', '2029-02-12', '2029-02-17'],
    ['Oster-/Frühjahrsferien', '2029-03-26', '2029-04-07'],
    ['Himmelfahrt-/Pfingstferien', '2029-05-11', '2029-05-11'],
    ['Sommerferien', '2029-07-21', '2029-08-31'],
  ],
};

/**
 * Flat, sorted list of periods for one Bundesland.
 * @returns {{name:string, start:string, end:string}[]}
 */
export function ferienFor(state, lang = 'de') {
  const rows = FERIEN[state];
  if (!rows) return [];
  return rows
    .map(([name, start, end]) => ({
      name,                       // 13.7 — never translated; see FERIEN_NAMES_EN above
      start,
      end,
    }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));
}

/** date → period name, for the whole bundled range. */
export function ferienIndex(state, lang = 'de') {
  const idx = new Map();
  for (const p of ferienFor(state, lang)) {
    // Walk the range; periods are short enough that this stays cheap and it
    // keeps lookup O(1) per day row during render.
    let d = p.start;
    let guard = 0;
    while (d <= p.end && guard++ < 400) {
      idx.set(d, p.name);
      const [y, m, day] = d.split('-').map(Number);
      const t = new Date(Date.UTC(y, m - 1, day + 1));
      d = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
        t.getUTCDate()
      ).padStart(2, '0')}`;
    }
  }
  return idx;
}
