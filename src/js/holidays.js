// Feiertage are COMPUTED, never looked up (spec 6.5) — fixed dates + Easter
// arithmetic + the Buß-und-Bettag rule. This layer therefore has no data
// horizon: it works for any year, forever, offline.

import { iso, addDays, dow, p2 } from './dates.js';

export const BUNDESLAENDER = [
  { code: '', de: 'Nur bundesweite Feiertage', en: 'Nationwide holidays only' },
  { code: 'BW', de: 'Baden-Württemberg', en: 'Baden-Württemberg' },
  { code: 'BY', de: 'Bayern', en: 'Bavaria' },
  { code: 'BE', de: 'Berlin', en: 'Berlin' },
  { code: 'BB', de: 'Brandenburg', en: 'Brandenburg' },
  { code: 'HB', de: 'Bremen', en: 'Bremen' },
  { code: 'HH', de: 'Hamburg', en: 'Hamburg' },
  { code: 'HE', de: 'Hessen', en: 'Hesse' },
  { code: 'MV', de: 'Mecklenburg-Vorpommern', en: 'Mecklenburg-Vorpommern' },
  { code: 'NI', de: 'Niedersachsen', en: 'Lower Saxony' },
  { code: 'NW', de: 'Nordrhein-Westfalen', en: 'North Rhine-Westphalia' },
  { code: 'RP', de: 'Rheinland-Pfalz', en: 'Rhineland-Palatinate' },
  { code: 'SL', de: 'Saarland', en: 'Saarland' },
  { code: 'SN', de: 'Sachsen', en: 'Saxony' },
  { code: 'ST', de: 'Sachsen-Anhalt', en: 'Saxony-Anhalt' },
  { code: 'SH', de: 'Schleswig-Holstein', en: 'Schleswig-Holstein' },
  { code: 'TH', de: 'Thüringen', en: 'Thuringia' },
];

export const ALL_STATE_CODES = BUNDESLAENDER.map((b) => b.code).filter(Boolean);

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** Buß- und Bettag: the last Wednesday before 23 November. */
export function bussUndBettag(year) {
  let d = 22;
  while (dow(year, 11, d) !== 3) d -= 1;
  return iso(year, 11, d);
}

// name: [de, en]; states: null = bundesweit, otherwise the list that observes it.
// Municipal specials (Augsburger Friedensfest, the Bavarian Mariä-Himmelfahrt
// patchwork) are out of scope — granularity is the Bundesland (spec §13).
const FIXED = [
  { md: [1, 1], name: ['Neujahr', "New Year's Day"], states: null },
  { md: [1, 6], name: ['Heilige Drei Könige', 'Epiphany'], states: ['BW', 'BY', 'ST'] },
  { md: [3, 8], name: ['Internationaler Frauentag', "International Women's Day"], states: ['BE', 'MV'] },
  { md: [5, 1], name: ['Tag der Arbeit', 'Labour Day'], states: null },
  { md: [8, 15], name: ['Mariä Himmelfahrt', 'Assumption Day'], states: ['SL'] },
  { md: [9, 20], name: ['Weltkindertag', "World Children's Day"], states: ['TH'] },
  { md: [10, 3], name: ['Tag der Deutschen Einheit', 'German Unity Day'], states: null },
  { md: [10, 31], name: ['Reformationstag', 'Reformation Day'],
    states: ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'] },
  { md: [11, 1], name: ['Allerheiligen', "All Saints' Day"], states: ['BW', 'BY', 'NW', 'RP', 'SL'] },
  { md: [12, 25], name: ['1. Weihnachtstag', 'Christmas Day'], states: null },
  { md: [12, 26], name: ['2. Weihnachtstag', 'Boxing Day'], states: null },
];

// Offsets in days from Easter Sunday.
const EASTER_BASED = [
  { off: -2, name: ['Karfreitag', 'Good Friday'], states: null },
  { off: 0, name: ['Ostersonntag', 'Easter Sunday'], states: ['BB'] },
  { off: 1, name: ['Ostermontag', 'Easter Monday'], states: null },
  { off: 39, name: ['Christi Himmelfahrt', 'Ascension Day'], states: null },
  { off: 49, name: ['Pfingstsonntag', 'Whit Sunday'], states: ['BB'] },
  { off: 50, name: ['Pfingstmontag', 'Whit Monday'], states: null },
  { off: 60, name: ['Fronleichnam', 'Corpus Christi'], states: ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'] },
];

// Short forms for the ~60px of row that a holiday gets to occupy.
const SHORT = {
  'Tag der Deutschen Einheit': 'Dt. Einheit',
  'Internationaler Frauentag': 'Frauentag',
  'Heilige Drei Könige': 'Hl. Drei Könige',
  'Christi Himmelfahrt': 'Christi Himmelf.',
  'Buß- und Bettag': 'Buß- u. Bettag',
  '1. Weihnachtstag': '1. Weihn.',
  '2. Weihnachtstag': '2. Weihn.',
  'Mariä Himmelfahrt': 'Mariä Himmelf.',
  'German Unity Day': 'Unity Day',
  "International Women's Day": "Women's Day",
  "World Children's Day": "Children's Day",
  "All Saints' Day": 'All Saints',
  'Repentance and Prayer Day': 'Repentance Day',
};

const shorten = (full) => SHORT[full] || full;

const cache = new Map();

/**
 * @returns Map<'YYYY-MM-DD', {name, short, own:boolean, states:string[]}>
 * `own` is true when the selected Bundesland observes it. When `state` is ''
 * only the nationwide set is `own`. Other states' holidays are still returned
 * so the dimmed union view (spec 6.6) can render them.
 */
export function holidaysForYear(year, state, lang = 'de') {
  const key = `${year}|${state}|${lang}`;
  if (cache.has(key)) return cache.get(key);

  const li = lang === 'en' ? 1 : 0;
  const easter = easterSunday(year);
  const out = new Map();

  const put = (date, name, states) => {
    const own = states === null || (state !== '' && states.includes(state));
    const prev = out.get(date);
    if (prev) {
      // ── 6.5 · TWO HOLIDAYS ON ONE DATE, AND NEITHER OF THEM VANISHES ──────
      //
      // This used to `return` and drop one outright, so in every year where
      // Christi Himmelfahrt lands on 1 May it simply disappeared from the board
      // — a nationwide public holiday, gone, with nothing to say it had been
      // there. `tests/COVERAGE.md` recorded it as fact.
      //
      // The day row has space for ONE chip, so the shown label still belongs to
      // the holiday the user's own state observes — that is the one they get a
      // day off for, and `short` is what fits. But the tooltip is a sentence,
      // not a chip, so both names go in it. Nothing is lost and nothing is
      // invented; the board says „Tag der Arbeit" and hovering says both.
      const keep = prev.own || !own ? prev : null;
      const winner = keep || {
        name, short: shorten(name), own,
        states: states === null ? ALL_STATE_CODES : states,
      };
      const other = keep ? name : prev.name;
      const both = winner.name.includes(other) ? winner.name : `${winner.name} · ${other}`;
      out.set(date, { ...winner, name: both });
      return;
    }
    out.set(date, {
      name,
      short: shorten(name),
      own,
      states: states === null ? ALL_STATE_CODES : states,
    });
  };

  for (const h of FIXED) put(iso(year, h.md[0], h.md[1]), h.name[li], h.states);
  for (const h of EASTER_BASED) put(addDays(easter, h.off), h.name[li], h.states);
  put(bussUndBettag(year),
      li ? 'Repentance and Prayer Day' : 'Buß- und Bettag', ['SN']);

  cache.set(key, out);
  return out;
}

/** Union across the years a board can touch, keyed by date. */
export function holidayIndex(years, state, lang) {
  const idx = new Map();
  for (const y of years) {
    for (const [d, h] of holidaysForYear(y, state, lang)) idx.set(d, h);
  }
  return idx;
}

export const stateName = (code, lang) => {
  const b = BUNDESLAENDER.find((x) => x.code === code);
  return b ? b[lang === 'en' ? 'en' : 'de'] : code;
};

export const _internals = { p2 };
