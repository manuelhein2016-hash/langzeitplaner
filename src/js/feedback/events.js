// src/js/feedback/events.js — a ring buffer that CANNOT HOLD A SENTENCE.  LZP-1009 · story 21.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PRINCIPLE 9, AND WHY A RING BUFFER IS NOT A TELEMETRY BUFFER
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Story 21.4: "still no analytics, no tracking, no third-party services beyond the sync
// endpoint." A buffer of recent events is the exact shape of the thing that story forbids, so the
// three properties that make this one different are structural, not promised:
//
//   1. **IT NEVER SENDS.** Nothing in this file, and nothing that imports it, can reach a socket.
//      The buffer is read by `report.js` when — and only when — a human has opened the
//      Rückmeldung screen. There is no flush, no timer, no `beforeunload` hook, no upload.
//   2. **IT IS BOUNDED AND IT FORGETS.** `CAPACITY` entries, oldest dropped, cleared on
//      `clearEvents()` and never persisted: it is not written to `board.json`, to
//      `localStorage`, or to any file. Quit the app and it is gone.
//   3. **IT CANNOT HOLD CONTENT.** This is the part worth the code below. Every field of every
//      event is validated against a closed grammar before it is stored: a number, or a TOKEN
//      matching `/^[A-Za-z][A-Za-z0-9:._-]{0,47}$/`. „Scheidungsanwältin Dr. Kübler 14:30" is
//      not a token — it has spaces and an umlaut — so it is not merely filtered out, it is
//      **unrepresentable**. A caller that passes an entry title gets an event with that field
//      absent, and `tests/tier1/feedback.test.js` §1 proves it with a real German fixture.
//
// The mutant that proves §1 is not measuring nothing: widen `TOKEN_RE` to `/^.{0,64}$/` and the
// row that dies is §1d, "an entry title offered as an event detail is dropped, not stored".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE KINDS ARE A CLOSED TABLE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// LZP-1009 names four examples — `renderBoard 51ms`, `drag:commit REFUSED not_owner`,
// `sync: 3 ops applied`, `KeyStoreUnavailableError`. A free-form `note(string)` would carry all
// four and would also carry a board. So each is a KIND with a fixed field list, and a kind this
// table does not name cannot be recorded at all.

/** How many events are kept. Small on purpose: a report is a snapshot, not a log file. */
export const CAPACITY = 40;

/**
 * The only shape a non-numeric detail may take. An identifier, a route name, an error class, a
 * refusal code — the vocabulary of the program, never the vocabulary of the family.
 */
export const TOKEN_RE = /^[A-Za-z][A-Za-z0-9:._-]{0,47}$/;

/**
 * Every event this product may record, with the fields it carries.
 *
 * `num` fields are clamped to `[0, max]` and floored; `tok` fields must match `TOKEN_RE`. A field
 * that fails is OMITTED — never coerced to a placeholder derived from the value, which is how a
 * sanitiser leaks a length or a first character.
 */
export const EVENT_KINDS = Object.freeze({
  render:  Object.freeze({ fields: Object.freeze({ ms: { num: 600000 } }) }),
  refusal: Object.freeze({ fields: Object.freeze({ op: { tok: true }, code: { tok: true } }) }),
  sync:    Object.freeze({ fields: Object.freeze({ applied: { num: 100000 }, phase: { tok: true } }) }),
  error:   Object.freeze({ fields: Object.freeze({ name: { tok: true } }) }),
  screen:  Object.freeze({ fields: Object.freeze({ name: { tok: true } }) }),
  action:  Object.freeze({ fields: Object.freeze({ name: { tok: true }, n: { num: 100000 } }) }),
});

export const EVENT_KIND_NAMES = Object.freeze(Object.keys(EVENT_KINDS));

/** @type {Array<Object>} */
let ring = [];
let dropped = 0;

/**
 * Record one structural event. Never throws — an instrumentation call that can break the app is
 * worse than no instrumentation.
 *
 * @param {string} kind one of `EVENT_KIND_NAMES`
 * @param {Object} [detail] fields, each validated against the kind's own table
 * @param {number} [at] ms since epoch; the caller's clock, so this file has none
 */
export function noteEvent(kind, detail, at) {
  try {
    const spec = EVENT_KINDS[kind];
    if (!spec) return;                                  // an unnamed kind is not recordable
    const e = { k: kind, t: Number.isFinite(at) ? Math.floor(at) : 0 };
    for (const [name, rule] of Object.entries(spec.fields)) {
      const v = detail ? detail[name] : undefined;
      if (rule.num) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
        e[name] = Math.min(Math.floor(v), rule.max ?? rule.num);
      } else {
        if (typeof v !== 'string' || !TOKEN_RE.test(v)) continue;
        e[name] = v;
      }
    }
    ring.push(e);
    while (ring.length > CAPACITY) { ring.shift(); dropped++; }
  } catch { /* instrumentation may not fail a session */ }
}

/** A copy, oldest first. The caller cannot mutate the buffer through it. */
export function readEvents() {
  return ring.map((e) => ({ ...e }));
}

/** How many were pushed out of the window, so the report can say "und 12 weitere davor". */
export function droppedCount() { return dropped; }

/** Forget everything. Called when the Rückmeldung screen is closed, and by tests. */
export function clearEvents() { ring = []; dropped = 0; }

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The one automatic thing in this file, and the argument for it
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `installErrorTap()` subscribes to `error` and `unhandledrejection` and records `error.name` —
// **the class name only, never `message` and never `stack`**, because a message is a string the
// program built and a program that builds messages out of board data is exactly the program this
// product is.
//
// Is that "automatic", which Principle 9 forbids? No, and the distinction is the whole of the
// principle: what 9 forbids is anything that **leaves the Mac** without a person. This writes to
// a 40-entry array in RAM that no code path can transmit. It is the difference between a
// notebook on the desk and a postcard in the mailbox — and without it, the single most useful
// line in Mom's report („KeyStoreUnavailableError") is a line she would have to type from a
// screen that never showed it to her.
//
// ⚠ IT IS INSTALLED AT BOOT, NOT WHEN THE SCREEN OPENS, and that is deliberate rather than an
// oversight — `settings.js` calls `initFeedback()` when it is evaluated, which is every launch.
// The alternative was considered and is worse: a tap installed by `openFeedback()` would hold an
// empty buffer for exactly the errors the report is about, because a person opens the Rückmeldung
// screen AFTER something broke, not before. A notebook you start writing in once the thing you
// wanted to record has already happened is not a notebook.
//
// So the honest statement of the cost is: on every launch, this product adds two listeners that
// can write at most forty class names to an array in RAM, and no code path can transmit that
// array. `tests/tier2/feedback.dom.js` measures the other half — a live page, a whole second,
// and nothing opens, schedules, or asks her anything.

let tapInstalled = false;

/**
 * @param {Object} [w] the event target, injected for tests
 * @param {() => number} [now]
 * @returns {boolean} whether it was installed by this call
 */
export function installErrorTap(w, now) {
  if (tapInstalled) return false;
  const target = w || (typeof window !== 'undefined' ? window : null);
  if (!target || typeof target.addEventListener !== 'function') return false;
  const clock = typeof now === 'function' ? now : () => Date.now();
  target.addEventListener('error', (ev) => {
    noteEvent('error', { name: nameOf(ev && ev.error) }, clock());
  });
  target.addEventListener('unhandledrejection', (ev) => {
    noteEvent('error', { name: nameOf(ev && ev.reason) }, clock());
  });
  tapInstalled = true;
  return true;
}

/** Reset for tests. Not called by the product. */
export function _resetTap() { tapInstalled = false; }

/**
 * The class name of a thrown value and nothing else.
 *
 * Note what is NOT read: `.message`, `.stack`, `.cause`, `.toString()`. `RedactionError` is a
 * real error class in this product (`core/project.js`) and its message names the FIELD that was
 * refused; `KeyStoreUnavailableError`'s does not, and neither would a future one. Reading `name`
 * needs no such case-by-case judgement.
 */
function nameOf(err) {
  const n = err && err.constructor && err.constructor.name;
  return typeof n === 'string' && TOKEN_RE.test(n) ? n : 'Error';
}
