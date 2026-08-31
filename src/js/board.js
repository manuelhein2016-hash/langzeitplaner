// Turns the layout model into DOM. Nothing here decides geometry — that is
// layout.js — so the same numbers drive screen, drag previews and print.

import { buildBoard, UNKNOWN_MEMBER_INITIAL } from './layout.js';
import { t, getLang } from './i18n.js';
import { parseISO, MONTH_DE, MONTH_EN } from './dates.js';
import { colorOf } from './palette.js';
import { store } from './store.js';

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

// ═════════════════════════════════════════════════════════════════════════════
// The family copy (LZP-705 / LZP-706)
//
// ADR 004 §4.3 puts these keys in `i18n.js`, which belongs to another work
// package. `t()` answers the KEY ITSELF when a table has no entry, so every
// string below resolves through `i18n` FIRST and falls back to this table only
// while the key is missing. The day the i18n owner lands them, i18n wins and
// this table goes quiet without a line changing here.
//
// „Belegt"/"Busy" and „Geteilt"/"Shared" are the addendum's own glossary §13.
// `belegtOwnerTip` is the REQUIRED string of ADR 002 §7.4's copy contract, which
// LZP-1003 audits verbatim; `expPending` exists because §6 forbids the badge
// from promising a state that has not reached the server. None of it uses
// §7.4's four forbidden claims — „gelöscht bei allen", „zurückgezogen",
// „niemand kann es mehr sehen", „live".
// ═════════════════════════════════════════════════════════════════════════════
const FAMILY_COPY = {
  de: {
    belegt: 'Belegt',
    geteilt: 'Geteilt',
    privat: 'Privat',
    belegtOwnerTip: 'Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text.',
    geteiltOwnerTip: 'Andere sehen: Datum, Text, deinen Namen, deine Farbe.',
    expPending: 'noch nicht abgeglichen',
  },
  en: {
    belegt: 'Busy',
    geteilt: 'Shared',
    privat: 'Private',
    belegtOwnerTip: 'Others see: the date, your name, your colour — no text.',
    geteiltOwnerTip: 'Others see: the date, the text, your name, your colour.',
    expPending: 'not synced yet',
  },
};

/** `t()` if `i18n.js` knows the key, this file's table otherwise. */
function ft(key) {
  const v = t(key);
  if (v !== key) return v;
  const table = FAMILY_COPY[getLang()] || FAMILY_COPY.de;
  return table[key] ?? key;
}

let model = null;
export const currentModel = () => model;

export function renderBoard(root) {
  const state = store.state;
  model = buildBoard(state);

  const scrollLeft = root.parentElement ? root.parentElement.scrollLeft : 0;
  root.textContent = '';
  // Density lives on :root only. Every position below is expressed in calc()
  // against these variables, never in resolved pixels — that is what lets the
  // print stylesheet re-metric the identical DOM for A4/A3 (F12) by overriding
  // them on <body>, which sits between :root and the board.
  document.documentElement.style.setProperty('--row-h', `${model.rowH}px`);
  document.documentElement.style.setProperty('--col-w', `${model.colW}px`);

  const frag = document.createDocumentFragment();
  for (const col of model.cols) frag.appendChild(renderColumn(col, model, state));
  root.appendChild(frag);

  if (root.parentElement) root.parentElement.scrollLeft = scrollLeft;
  return model;
}

function renderColumn(col, m, state) {
  const c = el('div', 'col');
  c.dataset.month = col.key;
  c.dataset.index = String(col.index);
  if (col.isTodayMonth) c.classList.add('is-today-month');

  const head = el('div', 'col-head');
  head.appendChild(el('span', null, col.label));
  head.title = col.fullLabel;
  c.appendChild(head);

  const rows = el('div', 'rows');
  rows.style.height = 'calc(var(--row-h) * 31)';
  rows.dataset.month = col.key;

  for (const d of col.days) rows.appendChild(renderDay(d, m));
  for (const seg of col.segs) renderSegment(rows, seg);

  if (col.horizon) {
    rows.appendChild(el('div', 'horizon-cue', t('continues')));
  }
  c.appendChild(rows);
  c.appendChild(renderPad(col, state));
  return c;
}

function renderDay(d, m) {
  const row = el('div', 'day');
  row.dataset.row = String(d.row);
  if (d.empty) {
    row.classList.add('void');
    return row;
  }
  row.dataset.date = d.date;
  if (d.weekend) row.classList.add('we');
  if (d.ferien) row.classList.add('fer');
  if (d.isToday) row.classList.add('today');
  if (d.holiday) row.classList.add('hol');

  // 7.2 — the shading must never be cryptic; the period name is one hover away.
  const tips = [];
  if (d.ferienName) tips.push(d.ferienName);
  if (d.holidayDemoted && d.holiday) tips.push(d.holiday.name);
  if (tips.length) row.title = tips.join(' · ');

  row.appendChild(el('span', 'd-num', d.n));
  row.appendChild(el('span', 'd-wd', d.wd));

  if (d.holidayDemoted) row.appendChild(el('span', 'd-holdot'));

  const body = el('div', 'd-body');
  if (d.holidayShown && d.holiday) {
    const h = el('div', 'd-hol', d.holiday.short);
    if (!d.holiday.own) h.classList.add('foreign');
    h.title = d.holiday.name;
    body.appendChild(h);
  }
  for (const n of d.notes) body.appendChild(renderNote(n, d));
  row.appendChild(body);

  if (d.overflow > 0) {
    const more = el('div', 'd-more', `+${d.overflow}`);
    more.dataset.date = d.date;
    more.title =
      d.laneOverflow > 0 && d.overflow === d.laneOverflow
        ? `${d.laneOverflow} ${t('lanesFull')}`
        : `${d.overflow} ${t('more')}`;
    row.appendChild(more);
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// The badge family (deliverable 17) — ONE contested slot, designed together
//
// Everything below lives in the same prefix slot as the ↻ marker, BEFORE the
// text node, for the reason 9.2 already gave: `.note` is `text-overflow:
// ellipsis`, so anything after the text is the first thing truncation eats.
//
// The slot is smaller than ADR 004 §6 feared, because two of the five markers
// can never co-occur. The exposure badge is MY disclosure of MY entry; the
// initial chip and the „neu" dot only ever appear on SOMEONE ELSE'S. The real
// worst cases are therefore `↻ + badge` on my board (17 px, measured) and
// `neu + chip + ↻` for a peer's repeating entry (23 px) — never all five.
// `layout.js:PREFIX_COST_PX` holds the numbers; the DOM test measures them.
//
// Fixed order, so a crowded day stays scannable down a column:
//   [neu dot] [initial chip] [exposure badge] [↻] text
//    who-is-new  whose         my-exposure     what-kind  what
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 16.6 — the exposure badge. `null` for Privat: the ABSENCE of a badge means
 * private, which is the default and the quiet state (Principle 8), and a glyph
 * for the quiet state would put ink on every row of a solo board.
 *
 * Level is coded by COVERAGE (half vs full) and pending by TEXTURE (hatched vs
 * solid), never both by fill — ADR 004 §6 asks for "distinct glyphs" AND for
 * "the same glyph, hollow" when pending, and a badge that signalled pending by
 * emptying itself would make a pending Belegt and a pending Geteilt identical.
 */
function exposureBadge(exposure) {
  if (!exposure) return null;
  const b = el('span', `exp ${exposure.level}${exposure.pending ? ' pending' : ''}`);
  b.setAttribute('aria-hidden', 'true');   // the state is in the note's title
  return b;
}

/**
 * 17.2 — whose is this, answered before what it is.
 * `color` is the member's tone for a chip on white; on a bar label the chip
 * inverts and the CSS owns both of its colours, so the caller passes nothing.
 */
function initialChip(initial, color) {
  const c = el('span', 'chip', initial);
  if (color) c.style.background = color;
  c.setAttribute('aria-hidden', 'true');
  return c;
}

/**
 * 17.5 — the quiet „neu" dot, in the board's only accent tone so it cannot be
 * confused with the 3 px demoted-holiday dot two elements to its left.
 * `layout.js` has already applied §7.2's two suppressions: a downgrade never
 * dots and a deletion never dots.
 */
const neuDot = () => {
  const n = el('span', 'neu-dot');
  n.setAttribute('aria-hidden', 'true');
  return n;
};

/**
 * The owner's hover text for a shared entry (ADR 002 §7.4, required strings).
 * It states what others can see in plain words rather than asking the user to
 * decode a 7 px badge, and it says "not synced yet" instead of implying a
 * privacy state that has not reached the server (ADR 004 §6).
 */
function exposureTitle(exposure) {
  if (!exposure) return '';
  const tip = ft(exposure.level === 'geteilt' ? 'geteiltOwnerTip' : 'belegtOwnerTip');
  return exposure.pending ? `${tip} (${ft('expPending')})` : tip;
}

function renderNote(n, d) {
  const node = el('div', 'note');
  node.dataset.noteId = n.note.id;
  node.dataset.date = d.date;
  node.style.color = n.color;
  if (n.foreign) node.dataset.foreign = '1';
  if (n.foreign) node.classList.add('foreign');
  if (n.redacted) node.classList.add('belegt');
  // 18.1 — a class, not only a model field, so `interact.js` and the CSS can ask
  // the one question `layout.js:canEditEntry` answers instead of each re-deriving it.
  if (!n.canEdit) node.classList.add('readonly');

  if (n.isNew) node.appendChild(neuDot());
  if (n.foreign) node.appendChild(initialChip(n.initial, n.color));
  const badge = exposureBadge(n.exposure);
  if (badge) node.appendChild(badge);
  if (n.note.repeatsYearly) {
    // 9.2 / design note — the marker goes *before* the text so truncation can
    // never eat it.
    node.appendChild(el('span', 'rep', '↻'));
  }

  // ═══ 16.7 — THE REDACTION SEAM ══════════════════════════════════════════════
  // Keyed on `redacted`, which `layout.js` derives from the LEVEL, and never on
  // the absence of a text. A `pub.text` that reaches a Belegt entry is a defect
  // three layers upstream (projection, seal, or the receiving fold's stage 3c);
  // painting whatever happens to be there would turn that defect into the leak
  // this whole epic exists to make impossible. A rendering bug may produce the
  // wrong pixels — it may not produce the wrong disclosure.
  const text = typeof n.note.text === 'string' ? n.note.text : '';
  if (n.redacted) {
    // The word is an ELEMENT, not a text node, for two reasons: it must not
    // inherit the member colour the way content does — a neutral word in a
    // person's ink would read as something they wrote — and a test that asserts
    // "this block contains nothing but the neutral word" needs a node to name.
    node.appendChild(el('span', 'redacted-word', ft('belegt')));
  } else {
    node.appendChild(document.createTextNode(text));
  }

  // 2.5 — full text on hover, and for a Belegt block the *only* thing there is
  // to say: who and what level. Never the text, and never a level history
  // („war geteilt" is forbidden by ADR 004 §7.1).
  node.title = n.redacted ? redactedTitle(n) : [text, exposureTitle(n.exposure)].filter(Boolean).join('\n');
  return node;
}

/**
 * A Belegt block's hover text: who, and the level. Never the text, and never a
 * level history — „war geteilt" is forbidden by ADR 004 §7.1, and there is
 * nothing in the model to build one from.
 *
 * The initial is the chip's only accessible equivalent, so it leads — EXCEPT
 * when it is the placeholder for a member record that has not arrived, where
 * „· · Belegt" would be a dot introducing itself. Then the level stands alone,
 * which is the whole of what is known.
 */
const redactedTitle = (n) =>
  (n.initial && n.initial !== UNKNOWN_MEMBER_INITIAL)
    ? `${n.initial} · ${ft('belegt')}`
    : ft('belegt');

function renderSegment(rows, seg) {
  const right = `calc(2px + var(--lane-gap) * ${seg.lane})`;
  const bar = el('div', 'bar');
  bar.dataset.barId = seg.bar.id;
  bar.dataset.lane = String(seg.lane);
  bar.style.top = `calc(var(--row-h) * ${seg.topRow} + 1px)`;
  bar.style.height = `calc(var(--row-h) * ${seg.rows} - 3px)`;
  bar.style.right = right;
  bar.style.background = seg.color;
  if (seg.foreign) bar.dataset.foreign = '1';
  if (seg.foreign) bar.classList.add('foreign');
  // 16.7 — the stripe KEEPS the owner's colour and its full length: duration and
  // owner are deliberately visible. What the hatch says is "this range is taken,
  // and that is all you get" — the content is deliberately absent, not hidden
  // behind an affordance that suggests there is something to open.
  if (seg.redacted) bar.classList.add('belegt');
  if (!seg.canEdit) bar.classList.add('readonly');

  // 16.7 — the same rule as the note: the LABEL is what is withheld, the dates
  // are what is disclosed. `|| t('untitledBar')` is v1's own fallback and stays
  // exactly where it was, on the non-redacted branch only.
  const label = seg.redacted ? ft('belegt') : (seg.bar.label || t('untitledBar'));
  const span = `${seg.bar.startDate} – ${seg.bar.endDate}`;
  bar.title = seg.redacted
    ? [redactedTitle(seg), span].join(' · ')
    : [`${label} · ${span}`, exposureTitle(seg.exposure)].filter(Boolean).join('\n');

  // Resize grips only exist where the real end of the bar is, so dragging the
  // December half of a January bar can never silently reshape the wrong edge —
  // and, since 18.1, only where I am allowed to reshape it at all. A grip on a
  // bar I cannot edit is an affordance that lies.
  if (seg.canEdit) {
    if (!seg.contTop) bar.appendChild(el('div', 'bar-handle top'));
    if (!seg.contBot) bar.appendChild(el('div', 'bar-handle bottom'));
  }
  rows.appendChild(bar);

  // 3.3 / 3.7 — one label per month segment, on a row that carries no ink.
  const lab = el('div', 'bar-label');
  lab.dataset.barId = seg.bar.id;
  lab.dataset.row = String(seg.labelRow);
  lab.style.top = `calc(var(--row-h) * ${seg.labelRow} + (var(--row-h) - 11px) / 2)`;
  lab.style.right = `calc(2px + var(--lane-gap) * ${seg.lane + 1})`;
  lab.style.background = seg.color;
  // The label chip is white-on-colour, so the initial chip inverts inside it:
  // a member-coloured chip on a member-coloured chip is invisible.
  lab.style.setProperty('--seg-ink', seg.color);
  if (seg.foreign) lab.classList.add('foreign');
  if (seg.redacted) lab.classList.add('belegt');
  if (!seg.canEdit) lab.classList.add('readonly');
  if (seg.contTop) {
    const cue = el('span', 'cue', '↑ ');
    lab.appendChild(cue);
  }
  if (seg.isNew) lab.appendChild(neuDot());
  if (seg.foreign) lab.appendChild(initialChip(seg.initial, null));
  const segBadge = exposureBadge(seg.exposure);
  if (segBadge) lab.appendChild(segBadge);
  lab.appendChild(document.createTextNode(label));
  lab.title = bar.title;
  rows.appendChild(lab);

  // 3.6 — a bar that runs past the last visible column says so on the stripe
  // itself, not only in the column footer. Mirrored: one that began before the
  // first column gets the same glyph at its top, so "started earlier than you
  // can see" is distinguishable from an ordinary month split.
  if (seg.beyondEnd) {
    const cue = el('div', 'bar-cont-down', '↓');
    cue.style.color = seg.color;
    cue.style.right = `calc(1px + var(--lane-gap) * ${seg.lane})`;
    cue.style.top = `calc(var(--row-h) * ${seg.topRow + seg.rows} - 11px)`;
    rows.appendChild(cue);
  }
  if (seg.beyondStart) {
    const cue = el('div', 'bar-cont-up', '↑');
    cue.style.color = seg.color;
    cue.style.right = `calc(1px + var(--lane-gap) * ${seg.lane})`;
    cue.style.top = `calc(var(--row-h) * ${seg.topRow} + 1px)`;
    rows.appendChild(cue);
  }
}

function renderPad(col, state) {
  const pad = el('div', 'pad');
  pad.dataset.month = col.key;
  pad.appendChild(el('div', 'pad-label', t('scratchpad')));
  const ta = document.createElement('textarea');
  ta.value = col.pad;
  ta.spellcheck = false;
  ta.dataset.month = col.key;
  ta.rows = 5;
  ta.setAttribute('aria-label', `${t('scratchpad')} ${col.fullLabel}`);
  pad.appendChild(ta);
  if (!col.pad.trim()) pad.classList.add('empty');
  return pad;
}

export function monthLabel(key, lang) {
  const { y, m } = parseISO(`${key}-01`);
  const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
  return `${MN[m - 1]} ${y}`;
}

export { colorOf };
