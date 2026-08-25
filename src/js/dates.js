// Plain YYYY-MM-DD arithmetic. No times, no timezones, no DST — see spec §13.
// Every date in the app is a string; Date objects are used only as a calculator
// and always in UTC so a local midnight can never shift a day.

export const p2 = (n) => String(n).padStart(2, '0');

export const iso = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** 0 = Sonntag … 6 = Samstag */
export const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

export const dowISO = (s) => {
  const { y, m, d } = parseISO(s);
  return dow(y, m, d);
};

export const isWeekend = (s) => {
  const w = dowISO(s);
  return w === 0 || w === 6;
};

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export const isLeap = (y) => daysInMonth(y, 2) === 29;

export function todayISO() {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

export function addDays(s, n) {
  const { y, m, d } = parseISO(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  const A = parseISO(a);
  const B = parseISO(b);
  return Math.round(
    (Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000
  );
}

/** Lexicographic compare works for YYYY-MM-DD; wrapped for intent. */
export const cmpDate = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const minDate = (a, b) => (a <= b ? a : b);
export const maxDate = (a, b) => (a >= b ? a : b);

export const monthKey = (y, m) => `${y}-${p2(m)}`;
export const monthKeyOf = (s) => s.slice(0, 7);

/** Month index on an absolute scale, so month ranges compare with one number. */
export const monthOrdinal = (y, m) => y * 12 + (m - 1);
export const monthOrdinalOf = (s) => {
  const { y, m } = parseISO(s);
  return monthOrdinal(y, m);
};

export function addMonths(y, m, n) {
  const o = monthOrdinal(y, m) + n;
  return { y: Math.floor(o / 12), m: (o % 12) + 1 };
}

/**
 * Yearly-repeat projection (spec 9.4): a Feb-29 series shows on Feb 28 in
 * non-leap years, everything else keeps its month/day.
 */
export function projectYearly(anchorISO, year) {
  const { m, d } = parseISO(anchorISO);
  if (m === 2 && d === 29 && !isLeap(year)) return iso(year, 2, 28);
  return iso(year, m, d);
}

export const WD_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
export const WD_EN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
export const MONTH_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
export const MONTH_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
