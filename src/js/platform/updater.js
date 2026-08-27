// src/js/platform/updater.js — LZP-102 (auto-updater) + LZP-104 (minimum version).
// Stories 22.3, 22.5, 22.6, 22.7. Amendment A11 (Ferien datasets ride this channel).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// This module is the updater's *decision logic* and nothing else. It decides
//
//   · whether a check is due at all (22.3 — "on launch and roughly daily"),
//   · what a manifest means and whether it is well-formed at all,
//   · whether the offered build is newer, the same, or OLDER than what runs
//     (a downgrade offer is refused, never installed),
//   · whether this client is below the manifest's declared minimum and must
//     therefore say so in one plain sentence (22.7 / LZP-104).
//
// It performs **no I/O of any kind**: no `fetch`, no timers, no clock, no
// storage, no DOM. Every effect is injected as a port. That is not tidiness —
// it is the only way this ticket could be built at all. The spec'd production
// shell is Tauri (`src-tauri/`), which needs a Rust toolchain that does not
// exist on the machine this was written on, while `shell-macos/` (Swift +
// WKWebView) is buildable and testable here. Two shells, one brain: the brain
// is this file, it is covered by `tests/tier1/platform-updater.test.js`, and
// each shell only has to implement four small commands correctly.
//
// ADR 005 §5 rule 4 says `platform/net.js` is the only `fetch` call site in the
// product. This module honours that by never being a call site at all — the
// update request is made by the NATIVE shell process, outside the WebView. See
// the note on 21.5 below, which is the reason that matters.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE 21.5 ↔ 22.3 TENSION — READ THIS BEFORE CHANGING ANYTHING HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// Story 21.5 (superseding 13.4): "in solo mode the app makes zero network
// requests; with a Familienkreis it talks to exactly one sync endpoint and
// nothing else."  Story 22.3: "the app checks for updates on launch and roughly
// daily."  An update check is a network request. Both cannot be literally true.
//
// The reading implemented here — the most conservative one that still delivers
// 22.3, and the one the PO must confirm or overrule:
//
//   1. THE BOARD still makes zero network requests, in solo mode and in family
//      mode alike. The document's CSP stays `default-src 'self'`, the WKWebView
//      navigation gate stays, and `platform/net.js` stays the only `fetch()` in
//      the product — unused in solo mode. Nothing in this file can reach the
//      network even if it wanted to.
//   2. THE SHELL — the native process, not the web page — performs exactly one
//      additional request: an unauthenticated HTTPS GET of one static manifest
//      file on one pinned host. No cookies, no query string, no identifiers, no
//      board content, no telemetry, no per-user anything. The only fact that
//      leaves the machine is "some Mac asked for latest.json", which is what any
//      download of the app already discloses.
//   3. IT DOES NOT HAPPEN SILENTLY OR BEFORE THE USER HAS BEEN TOLD. The port
//      reports two booleans: `disclosed` (the first-run screen — LZP-106's
//      Systemeinstellungen unlock, the one screen every install must pass —
//      has stated this in one line) and `enabled` (the settings switch). Until
//      `disclosed` is true, `check()` returns without touching the port's
//      network method at all. That is asserted by a test.
//
// Consequence for the honesty of the copy (Gate 7+ / A1): the marketing and
// About wording "keine Netzwerkverbindung" must become "das Board geht nie
// online; die App fragt einmal täglich, ob es eine neuere Version gibt" — and
// the Datenschutz text (21.3) must name the release host as a second remote
// beside the sync endpoint. That is a PO call, not an engineering one.
//
// ─────────────────────────────────────────────────────────────────────────────
// 22.6 — SIGNATURES ARE VERIFIED NATIVELY, NOT HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// This module never sees a public key and never verifies anything. It hands the
// port a `{version, url, signature, size}` triple and the port either reports
// `{ok: true, staged: true}` or reports failure. Verification happens in the
// shell, over the downloaded bytes, BEFORE anything is installed — because a
// verifier that runs inside the thing being replaced is not a verifier. What
// this module owns is the *response* to a verification failure: nothing is
// staged, nothing is marked available, the error is surfaced, and the flow does
// not silently retry. That path has its own test.
//
// ─────────────────────────────────────────────────────────────────────────────
// 22.7 — UPDATES NEVER TOUCH USER DATA
// ─────────────────────────────────────────────────────────────────────────────
//
// The whole port surface is four methods — `status`, `noteCheck`,
// `fetchManifest`, `download`. None of them can read or write a board, an op
// log, a checkpoint or a snapshot, and `tests/tier1/platform-updater.test.js`
// asserts that a complete run calls those four and nothing else. Schema
// migrations (11.6) run at the next boot, after the swap, exactly as they
// already do for any other version change — the updater has no part in them.

/** The one and only release channel (22.5). Every device — both of the PO's
 *  Macs and Mom's — follows this, and a manifest that declares any other
 *  channel is rejected rather than quietly ignored. */
export const CHANNEL = 'stable';

/** The platform key inside `manifest.platforms`. Matches Tauri's target triple
 *  naming so ONE manifest file serves both shells (see `src-tauri/`). */
export const TARGET = 'darwin-universal';

/** "roughly daily" (22.3). */
export const DAILY_MS = 24 * 60 * 60 * 1000;

/** "on launch" (22.3), debounced. A Mac that is opened and closed six times in
 *  an afternoon must not produce six requests: a launch check is skipped if the
 *  last check is younger than this. Four hours keeps "on launch" true for any
 *  realistic first-of-the-day launch while collapsing a burst into one. */
export const LAUNCH_GAP_MS = 4 * 60 * 60 * 1000;

/** Up to this much random lateness is added to the *daily* timer so a family's
 *  three Macs do not all wake at the same second. Injected rng; defaults to
 *  none, so tests are deterministic unless they ask for jitter. */
export const MAX_JITTER_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/** A version string that is not a version. Thrown by `parseVersion`/`compareVersions`. */
export class VersionError extends Error {
  constructor(message, value) {
    super(message);
    this.name = 'VersionError';
    this.value = value;
  }
}

/** A manifest that cannot be trusted to mean what it appears to mean.
 *  `field` names the offending member so a failure is diagnosable from the log
 *  line alone. */
export class ManifestError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ManifestError';
    this.field = field ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Versions — a strict semver subset
// ─────────────────────────────────────────────────────────────────────────────
//
// Strict on purpose. A loose parser that shrugs at "1.2" or "v1.2.3.4" turns a
// typo in a release tag into a silent no-op update, or worse into an ordering
// nobody predicted. Everything that is not exactly MAJOR.MINOR.PATCH with an
// optional pre-release and optional build metadata is an error, loudly.

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_RE = /^(0|[1-9]\d*)$/;

/**
 * @param {string} input a version, with or without the git-tag `v` prefix
 * @returns {{major:number, minor:number, patch:number, pre:string[], build:string|null, raw:string}}
 * @throws {VersionError}
 */
export function parseVersion(input) {
  if (typeof input !== 'string') throw new VersionError('version is not a string', input);
  // Release tags are `v1.2.0`; manifests carry `1.2.0`. Accept both, normalise
  // to one shape, so a tag pasted into a manifest by hand still orders right.
  const s = input.startsWith('v') ? input.slice(1) : input;
  const m = SEMVER_RE.exec(s);
  if (!m) throw new VersionError(`not a semantic version: ${JSON.stringify(input)}`, input);
  return Object.freeze({
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: Object.freeze(m[4] ? m[4].split('.') : []),
    build: m[5] ?? null,
    raw: s,
  });
}

/** True when `input` parses. Never throws — for validating untrusted input. */
export function isVersion(input) {
  try {
    parseVersion(input);
    return true;
  } catch {
    return false;
  }
}

/** Semver §11 pre-release ordering, in full: numeric identifiers compare
 *  numerically, alphanumeric ones ASCII-lexically, numeric sorts BEFORE
 *  alphanumeric, and a shorter run of identifiers sorts before a longer one
 *  when all preceding identifiers are equal. */
function comparePre(a, b) {
  // "a version with a pre-release has LOWER precedence than the normal version"
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = NUMERIC_RE.test(x);
    const yn = NUMERIC_RE.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Total order over versions. Build metadata is ignored, per semver §10 — two
 * builds of the same version are the same version, and offering one for the
 * other is not an update.
 * @returns {-1|0|1}
 * @throws {VersionError} if either side is unparsable
 */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return comparePre(x.pre, y.pre);
}

/** `a` is strictly newer than `b`. */
export function isNewer(a, b) {
  return compareVersions(a, b) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────
//
// The wire format is Tauri v2's static-JSON updater endpoint, so one file feeds
// both shells and neither needs a bespoke server (22.8 — it is a static asset on
// the GitHub release):
//
//   {
//     "version": "1.2.0",
//     "notes": "…",
//     "pub_date": "2026-09-01T10:00:00Z",
//     "channel": "stable",              ← ours; Tauri ignores unknown members
//     "minimum_version": "1.1.0",       ← ours (22.7 / LZP-104)
//     "platforms": {
//       "darwin-universal": {
//         "url": "https://…/LangzeitPlaner_1.2.0_universal.app.tar.gz",
//         "signature": "<base64 minisign signature>",
//         "size": 15728640
//       }
//     }
//   }

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a member that may appear in snake_case (Tauri's spelling) or camelCase. */
function pick(o, snake, camel) {
  if (hasOwn(o, snake)) return o[snake];
  if (hasOwn(o, camel)) return o[camel];
  return undefined;
}

/**
 * A download URL we are willing to hand to the shell. Deliberately narrow:
 *
 *  · `https:` only — a manifest that could downgrade the transport to plain
 *    HTTP would let a network attacker choose the bytes, and while the
 *    signature check (22.6) still saves us, defence in depth costs one line.
 *  · no embedded credentials — `https://user:pass@host/` is a phishing shape and
 *    has no business in a release asset URL.
 *  · a real host.
 */
function checkUrl(raw, field) {
  if (typeof raw !== 'string' || raw === '') {
    throw new ManifestError(`${field}: url missing`, field);
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ManifestError(`${field}: url is not a URL: ${JSON.stringify(raw)}`, field);
  }
  if (u.protocol !== 'https:') {
    throw new ManifestError(`${field}: url must be https, got ${u.protocol}`, field);
  }
  if (u.username !== '' || u.password !== '') {
    throw new ManifestError(`${field}: url must not carry credentials`, field);
  }
  if (u.hostname === '') throw new ManifestError(`${field}: url has no host`, field);
  return raw;
}

/**
 * Validate and normalise an update manifest.
 *
 * @param {string|object} input raw JSON text (what the shell hands back) or an
 *        already-parsed object (what a test hands in).
 * @param {{channel?:string}} [opts]
 * @returns {Readonly<{version:string, notes:string|null, pubDate:string|null,
 *          channel:string, minimumVersion:string|null,
 *          platforms:Readonly<Record<string, Readonly<{url:string, signature:string, size:number|null}>>>}>}
 * @throws {ManifestError} — always this type, never a raw SyntaxError, so one
 *         `catch` in the caller covers "the server sent us rubbish" completely.
 */
export function parseManifest(input, { channel = CHANNEL } = {}) {
  let raw = input;
  if (typeof input === 'string') {
    if (input.length > 256 * 1024) {
      // A manifest is a few hundred bytes. Anything of this size is either a
      // mistake or someone's idea of a denial of service; either way we are not
      // parsing it.
      throw new ManifestError('manifest is implausibly large', null);
    }
    try {
      raw = JSON.parse(input);
    } catch (e) {
      throw new ManifestError(`manifest is not JSON: ${e.message}`, null);
    }
  }
  if (!isPlainObject(raw)) throw new ManifestError('manifest is not an object', null);

  // ── version ──────────────────────────────────────────────────────────────
  const versionRaw = raw.version;
  let version;
  try {
    version = parseVersion(versionRaw).raw;
  } catch (e) {
    throw new ManifestError(`version: ${e.message}`, 'version');
  }

  // ── channel (22.5 — there is exactly one) ────────────────────────────────
  const chan = hasOwn(raw, 'channel') ? raw.channel : channel;
  if (typeof chan !== 'string' || chan !== channel) {
    throw new ManifestError(
      `channel: this build follows "${channel}" only, manifest declares ${JSON.stringify(chan)}`,
      'channel',
    );
  }

  // ── minimum_version (22.7 / LZP-104) ─────────────────────────────────────
  const minRaw = pick(raw, 'minimum_version', 'minimumVersion');
  let minimumVersion = null;
  if (minRaw !== undefined && minRaw !== null) {
    try {
      minimumVersion = parseVersion(minRaw).raw;
    } catch (e) {
      throw new ManifestError(`minimum_version: ${e.message}`, 'minimum_version');
    }
    // A manifest that demands a minimum newer than the build it ships is
    // self-contradictory: obeying it would brick every client permanently,
    // because the update it offers would still be too old. Refuse the manifest
    // instead of the client.
    if (compareVersions(minimumVersion, version) > 0) {
      throw new ManifestError(
        `minimum_version ${minimumVersion} is newer than the version it ships (${version})`,
        'minimum_version',
      );
    }
  }

  // ── platforms ────────────────────────────────────────────────────────────
  const platformsRaw = raw.platforms;
  if (!isPlainObject(platformsRaw)) {
    throw new ManifestError('platforms: missing or not an object', 'platforms');
  }
  const platforms = {};
  for (const key of Object.keys(platformsRaw)) {
    // `Object.keys` skips inherited members, and JSON.parse never sets a
    // prototype, so a `"__proto__"` member arrives as an ordinary own key —
    // which we simply refuse rather than copy onto an object.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ManifestError(`platforms: illegal key ${JSON.stringify(key)}`, 'platforms');
    }
    const p = platformsRaw[key];
    if (!isPlainObject(p)) {
      throw new ManifestError(`platforms.${key}: not an object`, `platforms.${key}`);
    }
    const url = checkUrl(p.url, `platforms.${key}`);
    const signature = p.signature;
    if (typeof signature !== 'string' || signature.trim() === '') {
      // 22.6 is not optional. An asset with no signature is not installable, so
      // it is not an asset.
      throw new ManifestError(`platforms.${key}: signature missing`, `platforms.${key}`);
    }
    let size = null;
    if (p.size !== undefined && p.size !== null) {
      if (typeof p.size !== 'number' || !Number.isInteger(p.size) || p.size <= 0) {
        throw new ManifestError(`platforms.${key}: size must be a positive integer`, `platforms.${key}`);
      }
      size = p.size;
    }
    platforms[key] = Object.freeze({ url, signature, size });
  }

  const notes = typeof raw.notes === 'string' ? raw.notes : null;
  const pubDateRaw = pick(raw, 'pub_date', 'pubDate');
  const pubDate = typeof pubDateRaw === 'string' ? pubDateRaw : null;

  return Object.freeze({
    version,
    notes,
    pubDate,
    channel: chan,
    minimumVersion,
    platforms: Object.freeze(platforms),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence — 22.3's "on launch and roughly daily"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{lastCheckAt:number|null, now:number, reason?:'launch'|'timer'|'manual',
 *          intervalMs?:number, launchGapMs?:number}} args
 * @returns {boolean}
 */
export function dueForCheck({
  lastCheckAt,
  now,
  reason = 'timer',
  intervalMs = DAILY_MS,
  launchGapMs = LAUNCH_GAP_MS,
}) {
  if (reason === 'manual') return true; // the user pressed the button; always honour it
  if (typeof lastCheckAt !== 'number' || !Number.isFinite(lastCheckAt) || lastCheckAt <= 0) {
    return true; // never checked
  }
  const age = now - lastCheckAt;
  // A stored timestamp in the FUTURE means the clock moved backwards (a manual
  // correction, a dead PRAM battery, a restored image). Treating that as "not
  // due" would wedge the updater until real time caught up — potentially years.
  // A future stamp is treated as due, which self-heals on the next write.
  if (age < 0) return true;
  return age >= (reason === 'launch' ? launchGapMs : intervalMs);
}

/**
 * When the daily timer should next fire, with optional per-device jitter so a
 * family's Macs do not converge on one second.
 * @param {{lastCheckAt:number|null, now:number, intervalMs?:number,
 *          random?:() => number, maxJitterMs?:number}} args
 */
export function nextCheckAt({
  lastCheckAt,
  now,
  intervalMs = DAILY_MS,
  random = null,
  maxJitterMs = MAX_JITTER_MS,
}) {
  const base =
    typeof lastCheckAt === 'number' && Number.isFinite(lastCheckAt) && lastCheckAt > 0 && lastCheckAt <= now
      ? lastCheckAt + intervalMs
      : now + intervalMs;
  const jitter = random ? Math.floor(random() * maxJitterMs) : 0;
  return base + jitter;
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────────

/** @typedef {'up-to-date'|'update-available'|'already-staged'|'downgrade-refused'|'unsupported-platform'} UpdateStatus */

/**
 * What to do about a manifest, given what is running and what is already
 * staged. Pure; no I/O, no clock.
 *
 * @param {{manifest:object, currentVersion:string, stagedVersion?:string|null, target?:string}} args
 * @returns {Readonly<{status:UpdateStatus, version:string, notes:string|null,
 *          outdated:boolean, minimumVersion:string|null,
 *          target:Readonly<{version:string,url:string,signature:string,size:number|null}>|null,
 *          message:Readonly<{key:string, args:string[]}>|null}>}
 */
export function decide({ manifest, currentVersion, stagedVersion = null, target = TARGET }) {
  const cur = parseVersion(currentVersion); // throws — a build with no version is a build bug
  const offered = parseVersion(manifest.version);

  // ── 22.7 / LZP-104 ───────────────────────────────────────────────────────
  // Computed FIRST and independently of everything below, because the whole
  // point of the story is that an outdated client says so instead of failing
  // quietly. It must still say so when the manifest offers no usable asset,
  // when the platform is unsupported, and even when the offered build is a
  // downgrade — every path that could otherwise swallow the message.
  const outdated =
    manifest.minimumVersion != null && compareVersions(cur, manifest.minimumVersion) < 0;
  const message = outdated
    ? Object.freeze({ key: 'updateRequired', args: Object.freeze([manifest.minimumVersion]) })
    : null;

  const base = {
    version: manifest.version,
    notes: manifest.notes ?? null,
    outdated,
    minimumVersion: manifest.minimumVersion ?? null,
    message,
  };

  const cmp = compareVersions(offered, cur);
  if (cmp < 0) {
    // A DOWNGRADE. Never installed, under any circumstance — not on a rollback,
    // not on a "the manifest says so". Rolling a family back would mean running
    // a build older than the on-disk schema it already migrated (11.6, 22.7),
    // and the honest recovery for a bad release is to publish a higher version,
    // which this rule cannot get in the way of.
    return Object.freeze({ ...base, status: 'downgrade-refused', target: null });
  }
  if (cmp === 0) {
    return Object.freeze({ ...base, status: 'up-to-date', target: null });
  }

  const asset = hasOwn(manifest.platforms, target) ? manifest.platforms[target] : undefined;
  if (!asset) {
    // Newer, but nothing this machine can install. Not an error — a universal
    // build simply may not have been published yet — but it is not an update
    // either, and it must not be reported as one.
    return Object.freeze({ ...base, status: 'unsupported-platform', target: null });
  }

  if (stagedVersion != null && compareVersions(stagedVersion, offered) >= 0) {
    // Already downloaded and verified; it applies at the next start (22.3).
    // Re-downloading 15 MB on every check would be the single rudest thing
    // this feature could do to a family on a metered connection.
    return Object.freeze({ ...base, status: 'already-staged', target: null });
  }

  return Object.freeze({
    ...base,
    status: 'update-available',
    target: Object.freeze({
      version: manifest.version,
      url: asset.url,
      signature: asset.signature,
      size: asset.size,
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The runner
// ─────────────────────────────────────────────────────────────────────────────
//
// THE PORT — four methods, implemented identically by `shell-macos/main.swift`
// (real, built and run) and `src-tauri/src/lib.rs` (written, UNVERIFIED — no
// Rust toolchain here). Everything the updater is allowed to do to the machine
// is in this list, and the list contains nothing that can reach user data.
//
//   status()          → {currentVersion, enabled, disclosed, lastCheckAt, stagedVersion}
//   noteCheck(atMs)   → void            persist "we asked at this time"
//   fetchManifest()   → {ok, manifest?, error?}      ONE https GET, native side
//   download(target)  → {ok, staged?, error?}        download + VERIFY + stage
//
// `download` returning `{ok:false, error:'signature'}` is the security-critical
// path: the shell verified and refused, and NOTHING was installed. This module's
// job there is to not paper over it.

/** @typedef {'idle'|'off'|'checking'|'up-to-date'|'available'|'staged'|'error'} UpdaterPhase */

const FOUR_PORT_METHODS = ['status', 'noteCheck', 'fetchManifest', 'download'];

/**
 * @param {{port:object, target?:string, intervalMs?:number, launchGapMs?:number,
 *          now?:() => number, log?:(level:string, msg:string, detail?:any) => void}} args
 */
export function createUpdater({
  port,
  target = TARGET,
  intervalMs = DAILY_MS,
  launchGapMs = LAUNCH_GAP_MS,
  now = null,
  log = null,
} = {}) {
  if (!port) throw new TypeError('createUpdater: a port is required');
  for (const m of FOUR_PORT_METHODS) {
    if (typeof port[m] !== 'function') {
      throw new TypeError(`createUpdater: port.${m} is not a function`);
    }
  }
  // The clock is a port too (ADR 005 §5: nothing here reads the wall clock).
  const clock = typeof now === 'function' ? now : () => { throw new TypeError('createUpdater: now() port is required'); };
  const say = typeof log === 'function' ? log : () => {};

  /** @type {{phase:UpdaterPhase, lastCheckAt:number|null, lastError:string|null,
   *          available:object|null, stagedVersion:string|null, outdated:boolean,
   *          minimumVersion:string|null, message:object|null, currentVersion:string|null}} */
  let state = {
    phase: 'idle',
    lastCheckAt: null,
    lastError: null,
    available: null,
    stagedVersion: null,
    outdated: false,
    minimumVersion: null,
    message: null,
    currentVersion: null,
  };

  const set = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    return state;
  };

  /**
   * One check. Returns a small record of what happened — the caller (the quiet
   * "Update verfügbar" hint of 22.4, LZP-103) renders from `getState()`.
   *
   * @param {'launch'|'timer'|'manual'} reason
   */
  async function check(reason = 'timer') {
    const st = await port.status();
    const currentVersion = st && st.currentVersion;
    set({
      currentVersion: currentVersion ?? null,
      lastCheckAt: typeof st?.lastCheckAt === 'number' ? st.lastCheckAt : null,
      stagedVersion: st?.stagedVersion ?? null,
    });

    // ── 21.5, enforced here and not only in the shell ────────────────────────
    // Two gates, and BOTH must be open before a single byte moves. `disclosed`
    // is the first-run screen having said what happens; `enabled` is the
    // settings switch. Returning before `fetchManifest` is what makes "zero
    // network until the user has been told" a property of the code rather than
    // a promise in a document.
    if (!st || st.disclosed !== true) {
      set({ phase: 'off' });
      return { ran: false, reason: 'not-disclosed' };
    }
    if (st.enabled !== true) {
      set({ phase: 'off' });
      return { ran: false, reason: 'disabled' };
    }

    const at = clock();
    if (!dueForCheck({ lastCheckAt: state.lastCheckAt, now: at, reason, intervalMs, launchGapMs })) {
      return { ran: false, reason: 'not-due' };
    }

    set({ phase: 'checking' });
    // Recorded BEFORE the request, not after. A host that hangs or a laptop that
    // sleeps mid-request must not leave `lastCheckAt` untouched — that turns
    // every subsequent launch into another attempt at the same dead host.
    await port.noteCheck(at);
    set({ lastCheckAt: at });

    let res;
    try {
      res = await port.fetchManifest();
    } catch (e) {
      return fail('network', e && e.message ? e.message : String(e));
    }
    if (!res || res.ok !== true) {
      return fail('network', (res && res.error) || 'fetch failed');
    }

    let manifest;
    try {
      manifest = parseManifest(res.manifest);
    } catch (e) {
      // A malformed manifest is indistinguishable from a hostile one. Both end
      // here, both leave the installed app exactly as it was.
      return fail('manifest', e.message);
    }

    let decision;
    try {
      decision = decide({
        manifest,
        currentVersion,
        stagedVersion: state.stagedVersion,
        target,
      });
    } catch (e) {
      return fail('version', e.message);
    }

    set({
      outdated: decision.outdated,
      minimumVersion: decision.minimumVersion,
      message: decision.message,
      lastError: null,
    });
    if (decision.outdated) {
      say('warn', `client ${currentVersion} is below the declared minimum ${decision.minimumVersion}`);
    }

    if (decision.status === 'update-available') {
      let dl;
      try {
        dl = await port.download(decision.target);
      } catch (e) {
        return fail('download', e && e.message ? e.message : String(e), decision);
      }
      if (!dl || dl.ok !== true) {
        // 22.6. The shell downloaded bytes, checked them against the updater
        // key, and refused. NOTHING is installed and nothing is staged; the
        // running app is untouched. We record the failure loudly rather than
        // retrying, because a signature failure is not a transient network
        // hiccup — it is either a corrupted release or an attack, and both
        // want a human.
        return fail('signature-or-download', (dl && dl.error) || 'download failed', decision);
      }
      set({
        phase: 'staged',
        stagedVersion: decision.target.version,
        available: decision.target,
        lastError: null,
      });
      say('info', `staged ${decision.target.version}; applies at next start`);
      return { ran: true, decision, staged: true };
    }

    set({
      phase:
        decision.status === 'already-staged'
          ? 'staged'
          : decision.outdated
            ? 'error'
            : 'up-to-date',
      available: decision.status === 'already-staged' ? state.available : null,
    });
    return { ran: true, decision, staged: decision.status === 'already-staged' };
  }

  function fail(kind, detail, decision = null) {
    set({ phase: 'error', lastError: kind, available: null });
    say('error', `update ${kind}: ${detail}`);
    return { ran: true, error: kind, detail, decision };
  }

  return {
    /** 22.3 — the launch check. */
    checkOnLaunch: () => check('launch'),
    /** 22.3 — the roughly-daily timer. */
    checkDaily: () => check('timer'),
    /** The user pressed "Nach Updates suchen"; cadence does not apply. */
    checkNow: () => check('manual'),
    check,
    /** Snapshot for the quiet hint (22.4) and the settings panel. Frozen. */
    getState: () => state,
    /** When the daily timer should next fire. */
    nextCheckAt: (opts = {}) => nextCheckAt({ lastCheckAt: state.lastCheckAt, now: clock(), intervalMs, ...opts }),
  };
}

/**
 * The bridge-backed port, for the two real shells. Kept here rather than in the
 * shells so both speak exactly one protocol; `invoke` is injected so this file
 * still never touches `window`.
 *
 * @param {(cmd:string, args?:object) => Promise<any>} invoke
 */
export function bridgePort(invoke) {
  const json = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  return {
    async status() {
      return json(await invoke('update_status', {})) ?? {
        currentVersion: null,
        enabled: false,
        disclosed: false,
        lastCheckAt: null,
        stagedVersion: null,
      };
    },
    async noteCheck(atMs) {
      await invoke('update_note_check', { at: atMs });
    },
    async fetchManifest() {
      return json(await invoke('update_fetch_manifest', {})) ?? { ok: false, error: 'no reply' };
    },
    async download(t) {
      return json(
        await invoke('update_download', {
          version: t.version,
          url: t.url,
          signature: t.signature,
          size: t.size ?? 0,
        }),
      ) ?? { ok: false, error: 'no reply' };
    },
  };
}
