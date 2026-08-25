// ─────────────────────────────────────────────────────────────────────────────
// Schulferien — BUNDLED DATA, not computed (spec §13, 7.4).
//
// ⚠️  THE DATES BELOW ARE UNVERIFIED SAMPLE DATA.
//
// Ferien are negotiated per Bundesland and published by the KMK only ~2–3 years
// ahead, so unlike Feiertage they cannot be derived from a rule. This file is
// structurally final but its contents must be replaced with the official KMK
// tables before release. `FERIEN_META.verified = false` makes the app say so:
// settings shows a warning next to the horizon line instead of pretending.
//
// To ship real data: replace FERIEN, set `verified: true`, set `horizon` to the
// last covered day and `updated` to the release date. Nothing else changes.
// Source to use: https://www.kmk.org/service/ferien.html
// ─────────────────────────────────────────────────────────────────────────────

export const FERIEN_META = {
  verified: false,
  horizon: '2028-08-31',
  updated: '2026-08-01',
  source: 'KMK (Platzhalterdaten / placeholder data)',
};

export const FERIEN_NAMES_EN = {
  Herbstferien: 'Autumn break',
  Weihnachtsferien: 'Christmas break',
  Winterferien: 'Winter break',
  Osterferien: 'Easter break',
  Frühjahrsferien: 'Spring break',
  Pfingstferien: 'Whitsun break',
  Sommerferien: 'Summer break',
};

// [name, firstDay, lastDay] — both ends inclusive.
export const FERIEN = {
  BW: [
    ['Sommerferien', '2026-07-30', '2026-09-12'],
    ['Herbstferien', '2026-10-26', '2026-10-30'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-09'],
    ['Winterferien', '2027-02-15', '2027-02-19'],
    ['Osterferien', '2027-03-29', '2027-04-09'],
    ['Pfingstferien', '2027-05-18', '2027-05-28'],
    ['Sommerferien', '2027-07-29', '2027-09-11'],
    ['Herbstferien', '2027-11-02', '2027-11-05'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-08'],
    ['Osterferien', '2028-04-11', '2028-04-21'],
    ['Pfingstferien', '2028-06-06', '2028-06-16'],
    ['Sommerferien', '2028-07-27', '2028-09-09'],
  ],
  BY: [
    ['Sommerferien', '2026-08-01', '2026-09-14'],
    ['Herbstferien', '2026-11-02', '2026-11-06'],
    ['Weihnachtsferien', '2026-12-24', '2027-01-05'],
    ['Winterferien', '2027-02-08', '2027-02-12'],
    ['Osterferien', '2027-03-22', '2027-04-03'],
    ['Pfingstferien', '2027-05-18', '2027-05-28'],
    ['Sommerferien', '2027-07-29', '2027-09-10'],
    ['Herbstferien', '2027-11-02', '2027-11-05'],
    ['Weihnachtsferien', '2027-12-24', '2028-01-07'],
    ['Winterferien', '2028-02-28', '2028-03-03'],
    ['Osterferien', '2028-04-10', '2028-04-21'],
    ['Pfingstferien', '2028-06-06', '2028-06-16'],
    ['Sommerferien', '2028-07-27', '2028-09-08'],
  ],
  BE: [
    ['Sommerferien', '2026-07-09', '2026-08-21'],
    ['Herbstferien', '2026-10-19', '2026-10-30'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-01', '2027-02-06'],
    ['Osterferien', '2027-03-29', '2027-04-09'],
    ['Pfingstferien', '2027-05-17', '2027-05-18'],
    ['Sommerferien', '2027-07-08', '2027-08-20'],
    ['Herbstferien', '2027-10-18', '2027-10-29'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-04'],
    ['Winterferien', '2028-01-31', '2028-02-05'],
    ['Osterferien', '2028-04-10', '2028-04-21'],
    ['Sommerferien', '2028-07-06', '2028-08-18'],
  ],
  BB: [
    ['Sommerferien', '2026-07-09', '2026-08-21'],
    ['Herbstferien', '2026-10-19', '2026-10-30'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-01', '2027-02-06'],
    ['Osterferien', '2027-03-29', '2027-04-09'],
    ['Pfingstferien', '2027-05-17', '2027-05-18'],
    ['Sommerferien', '2027-07-08', '2027-08-20'],
    ['Herbstferien', '2027-10-18', '2027-10-29'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-04'],
    ['Winterferien', '2028-01-31', '2028-02-05'],
    ['Osterferien', '2028-04-10', '2028-04-21'],
    ['Sommerferien', '2028-07-06', '2028-08-18'],
  ],
  HB: [
    ['Sommerferien', '2026-07-02', '2026-08-12'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-06'],
    ['Winterferien', '2027-02-01', '2027-02-02'],
    ['Osterferien', '2027-03-22', '2027-04-06'],
    ['Pfingstferien', '2027-05-07', '2027-05-18'],
    ['Sommerferien', '2027-07-01', '2027-08-11'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-05'],
    ['Osterferien', '2028-03-20', '2028-04-04'],
    ['Sommerferien', '2028-06-29', '2028-08-09'],
  ],
  HH: [
    ['Sommerferien', '2026-07-09', '2026-08-19'],
    ['Herbstferien', '2026-10-12', '2026-10-23'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-01'],
    ['Winterferien', '2027-01-29', '2027-01-29'],
    ['Osterferien', '2027-03-08', '2027-03-19'],
    ['Pfingstferien', '2027-05-10', '2027-05-14'],
    ['Sommerferien', '2027-07-08', '2027-08-18'],
    ['Herbstferien', '2027-10-11', '2027-10-22'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-04'],
    ['Osterferien', '2028-03-06', '2028-03-17'],
    ['Sommerferien', '2028-07-06', '2028-08-16'],
  ],
  HE: [
    ['Sommerferien', '2026-07-06', '2026-08-14'],
    ['Herbstferien', '2026-10-05', '2026-10-16'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-09'],
    ['Osterferien', '2027-03-29', '2027-04-10'],
    ['Sommerferien', '2027-07-05', '2027-08-13'],
    ['Herbstferien', '2027-10-04', '2027-10-15'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-08'],
    ['Osterferien', '2028-04-03', '2028-04-14'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
  ],
  MV: [
    ['Sommerferien', '2026-07-20', '2026-08-29'],
    ['Herbstferien', '2026-10-05', '2026-10-14'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-06', '2027-02-19'],
    ['Osterferien', '2027-03-29', '2027-04-07'],
    ['Pfingstferien', '2027-05-14', '2027-05-18'],
    ['Sommerferien', '2027-07-19', '2027-08-28'],
    ['Herbstferien', '2027-10-04', '2027-10-13'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-03'],
    ['Winterferien', '2028-02-05', '2028-02-18'],
    ['Sommerferien', '2028-07-17', '2028-08-26'],
  ],
  NI: [
    ['Sommerferien', '2026-07-02', '2026-08-12'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-06'],
    ['Winterferien', '2027-02-01', '2027-02-02'],
    ['Osterferien', '2027-03-22', '2027-04-06'],
    ['Pfingstferien', '2027-05-07', '2027-05-18'],
    ['Sommerferien', '2027-07-01', '2027-08-11'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-05'],
    ['Osterferien', '2028-03-20', '2028-04-04'],
    ['Sommerferien', '2028-06-29', '2028-08-09'],
  ],
  NW: [
    ['Sommerferien', '2026-06-22', '2026-08-04'],
    ['Herbstferien', '2026-10-19', '2026-10-31'],
    ['Weihnachtsferien', '2026-12-23', '2027-01-06'],
    ['Osterferien', '2027-03-22', '2027-04-03'],
    ['Pfingstferien', '2027-05-18', '2027-05-18'],
    ['Sommerferien', '2027-07-19', '2027-08-31'],
    ['Herbstferien', '2027-10-18', '2027-10-30'],
    ['Weihnachtsferien', '2027-12-23', '2028-01-07'],
    ['Osterferien', '2028-04-10', '2028-04-22'],
    ['Sommerferien', '2028-07-17', '2028-08-29'],
  ],
  RP: [
    ['Sommerferien', '2026-07-06', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-23'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-06'],
    ['Osterferien', '2027-03-29', '2027-04-07'],
    ['Pfingstferien', '2027-05-19', '2027-05-28'],
    ['Sommerferien', '2027-07-05', '2027-08-13'],
    ['Herbstferien', '2027-10-11', '2027-10-22'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-07'],
    ['Osterferien', '2028-04-03', '2028-04-12'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
  ],
  SL: [
    ['Sommerferien', '2026-07-06', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-23'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-08', '2027-02-16'],
    ['Osterferien', '2027-03-29', '2027-04-09'],
    ['Sommerferien', '2027-07-05', '2027-08-13'],
    ['Herbstferien', '2027-10-11', '2027-10-22'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-04'],
    ['Osterferien', '2028-04-03', '2028-04-14'],
    ['Sommerferien', '2028-07-03', '2028-08-11'],
  ],
  SN: [
    ['Sommerferien', '2026-07-04', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-08', '2027-02-20'],
    ['Osterferien', '2027-03-26', '2027-04-03'],
    ['Pfingstferien', '2027-05-15', '2027-05-18'],
    ['Sommerferien', '2027-07-03', '2027-08-13'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-03'],
    ['Winterferien', '2028-02-07', '2028-02-19'],
    ['Sommerferien', '2028-07-01', '2028-08-11'],
  ],
  ST: [
    ['Sommerferien', '2026-07-04', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-05'],
    ['Winterferien', '2027-02-08', '2027-02-13'],
    ['Osterferien', '2027-03-26', '2027-04-03'],
    ['Pfingstferien', '2027-05-15', '2027-05-18'],
    ['Sommerferien', '2027-07-03', '2027-08-13'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-05'],
    ['Winterferien', '2028-02-07', '2028-02-12'],
    ['Sommerferien', '2028-07-01', '2028-08-11'],
  ],
  SH: [
    ['Sommerferien', '2026-07-06', '2026-08-15'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-06'],
    ['Osterferien', '2027-03-29', '2027-04-10'],
    ['Pfingstferien', '2027-05-17', '2027-05-18'],
    ['Sommerferien', '2027-07-05', '2027-08-14'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-06'],
    ['Osterferien', '2028-04-03', '2028-04-15'],
    ['Sommerferien', '2028-07-03', '2028-08-12'],
  ],
  TH: [
    ['Sommerferien', '2026-07-04', '2026-08-14'],
    ['Herbstferien', '2026-10-12', '2026-10-24'],
    ['Weihnachtsferien', '2026-12-21', '2027-01-02'],
    ['Winterferien', '2027-02-08', '2027-02-13'],
    ['Osterferien', '2027-03-26', '2027-04-03'],
    ['Pfingstferien', '2027-05-15', '2027-05-18'],
    ['Sommerferien', '2027-07-03', '2027-08-13'],
    ['Herbstferien', '2027-10-11', '2027-10-23'],
    ['Weihnachtsferien', '2027-12-22', '2028-01-03'],
    ['Winterferien', '2028-02-07', '2028-02-12'],
    ['Sommerferien', '2028-07-01', '2028-08-11'],
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
      name: lang === 'en' ? FERIEN_NAMES_EN[name] || name : name,
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
