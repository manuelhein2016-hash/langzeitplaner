// tests/tier1/platform-updater.test.js — LZP-102 + LZP-104.
// Stories 22.3 (check on launch + roughly daily), 22.5 (one channel), 22.6 (signed and verified
// before installing), 22.7 (minimum version, one plain sentence, never touch user data).
//
// WHY THIS SUITE EXISTS IN THIS SHAPE.
// The updater's *effects* live in two native shells: `shell-macos/main.swift` (buildable and
// testable on this machine) and `src-tauri/src/lib.rs` (the spec'd production shell, which needs a
// Rust toolchain nobody has here). Neither can be unit-tested from Node. So every decision the
// updater makes was pushed out of both shells and into `src/js/platform/updater.js`, which is
// DOM-free, I/O-free and clock-free, and this file is the gate on it. What remains in the shells
// is four commands that do exactly what they are told.
//
// NO TEST HERE READS THE WALL CLOCK OR THE NETWORK (ADR 005 §5, DoD Gate 2+). Every timestamp is a
// literal, and the only "network" is a recording double.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL,
  TARGET,
  DAILY_MS,
  LAUNCH_GAP_MS,
  VersionError,
  ManifestError,
  parseVersion,
  isVersion,
  compareVersions,
  isNewer,
  parseManifest,
  dueForCheck,
  nextCheckAt,
  decide,
  createUpdater,
  bridgePort,
} from '../../src/js/platform/updater.js';

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers. No fixtures file: the manifest shape is the contract under test,
// so it is spelled out here rather than hidden behind a builder that could drift.
// ─────────────────────────────────────────────────────────────────────────────

const URL_OK = 'https://github.com/example/langzeitplaner/releases/download/v1.2.0/LangzeitPlaner_1.2.0_universal.app.tar.gz';

function manifestJSON(over = {}) {
  const base = {
    version: '1.2.0',
    notes: 'Kleinere Korrekturen.',
    pub_date: '2026-09-01T10:00:00Z',
    channel: 'stable',
    platforms: {
      'darwin-universal': {
        url: URL_OK,
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=',
        size: 15_728_640,
      },
    },
  };
  return JSON.stringify({ ...base, ...over });
}

/**
 * A recording port double. Every call is appended to `calls`, which is how the
 * "updates never touch user data" assertion is made mechanical: the recorded
 * call list is compared against the four allowed method names.
 */
function makePort({
  currentVersion = '1.0.0',
  enabled = true,
  disclosed = true,
  lastCheckAt = null,
  stagedVersion = null,
  manifest = manifestJSON(),
  fetchResult = null,
  downloadResult = { ok: true, staged: true },
  throwOn = null,
} = {}) {
  const calls = [];
  const rec = (name, arg) => calls.push(arg === undefined ? name : `${name}:${JSON.stringify(arg)}`);
  const state = { lastCheckAt, stagedVersion };
  const port = {
    calls,
    state,
    async status() {
      rec('status');
      if (throwOn === 'status') throw new Error('boom');
      return {
        currentVersion,
        enabled,
        disclosed,
        lastCheckAt: state.lastCheckAt,
        stagedVersion: state.stagedVersion,
      };
    },
    async noteCheck(at) {
      rec('noteCheck', at);
      state.lastCheckAt = at;
    },
    async fetchManifest() {
      rec('fetchManifest');
      if (throwOn === 'fetchManifest') throw new Error('offline');
      return fetchResult ?? { ok: true, manifest };
    },
    async download(t) {
      rec('download', t.version);
      if (throwOn === 'download') throw new Error('interrupted');
      if (downloadResult.ok) state.stagedVersion = t.version;
      return downloadResult;
    },
  };
  return port;
}

const frozenClock = (t) => () => t;

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Version ordering — the comparator the whole feature stands on
// ─────────────────────────────────────────────────────────────────────────────

test('parseVersion accepts the strict semver subset and the git-tag v prefix', () => {
  const v = parseVersion('1.2.3');
  assert.equal(v.major, 1);
  assert.equal(v.minor, 2);
  assert.equal(v.patch, 3);
  assert.deepEqual([...v.pre], []);
  assert.equal(v.build, null);
  // Release tags are `v1.2.3`; a tag pasted into a manifest by hand must still order correctly
  // rather than silently becoming "no update available forever".
  assert.equal(parseVersion('v1.2.3').raw, '1.2.3');
  assert.deepEqual([...parseVersion('1.0.0-beta.11').pre], ['beta', '11']);
  assert.equal(parseVersion('1.0.0+build.7').build, 'build.7');
});

test('parseVersion rejects everything that is not exactly MAJOR.MINOR.PATCH', () => {
  // A loose parser turns a typo in a release tag into a silent no-op update.
  const bad = ['1.2', '1.2.3.4', '01.2.3', '1.2.3-', 'x.y.z', '', ' 1.2.3', '1.2.3 ', 'latest', '1.2.-3'];
  for (const s of bad) {
    assert.throws(() => parseVersion(s), VersionError, `expected ${JSON.stringify(s)} to be rejected`);
    assert.equal(isVersion(s), false, `isVersion(${JSON.stringify(s)}) should be false`);
  }
  for (const v of [null, undefined, 123, {}, ['1.2.3']]) {
    assert.throws(() => parseVersion(v), VersionError);
  }
});

test('compareVersions is a total order over major/minor/patch', () => {
  const ordered = ['0.9.9', '1.0.0', '1.0.1', '1.1.0', '1.2.0', '1.10.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      const expect = i < j ? -1 : i > j ? 1 : 0;
      assert.equal(
        compareVersions(ordered[i], ordered[j]),
        expect,
        `${ordered[i]} vs ${ordered[j]}`,
      );
    }
  }
  // 1.10.0 > 1.2.0 is the one a string comparison gets wrong, and it is the one
  // that bites in month eleven of a project.
  assert.equal(isNewer('1.10.0', '1.2.0'), true);
});

test('equal versions compare equal, including across build metadata', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
  // semver §10: build metadata is ignored in precedence. Two builds of one
  // version are one version — offering one for the other is not an update, and
  // shipping it would be an infinite update loop on every launch.
  assert.equal(compareVersions('1.2.3+ci.44', '1.2.3+ci.45'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.3+ci.45'), 0);
});

test('pre-release ordering follows semver §11 in full', () => {
  // The canonical sequence from the specification.
  const seq = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 0; i + 1 < seq.length; i++) {
    assert.equal(compareVersions(seq[i], seq[i + 1]), -1, `${seq[i]} should precede ${seq[i + 1]}`);
    assert.equal(compareVersions(seq[i + 1], seq[i]), 1, `${seq[i + 1]} should follow ${seq[i]}`);
  }
  // numeric identifiers sort numerically (beta.11 > beta.2 — the trap a string
  // comparison falls into), and numeric sorts BEFORE alphanumeric.
  assert.equal(compareVersions('1.0.0-beta.11', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  // a pre-release is always older than its own release
  assert.equal(isNewer('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isNewer('1.0.0-rc.1', '1.0.0'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The manifest — well-formed, and everything that is not
// ─────────────────────────────────────────────────────────────────────────────

test('a well-formed manifest normalises to the documented shape and is frozen', () => {
  const m = parseManifest(manifestJSON());
  assert.equal(m.version, '1.2.0');
  assert.equal(m.channel, CHANNEL);
  assert.equal(m.minimumVersion, null);
  assert.equal(m.notes, 'Kleinere Korrekturen.');
  assert.equal(m.pubDate, '2026-09-01T10:00:00Z');
  assert.equal(m.platforms[TARGET].url, URL_OK);
  assert.equal(m.platforms[TARGET].size, 15_728_640);
  assert.equal(Object.isFrozen(m), true);
  assert.equal(Object.isFrozen(m.platforms[TARGET]), true);
  // objects are accepted as well as raw text, so a test never has to stringify
  assert.equal(parseManifest(JSON.parse(manifestJSON())).version, '1.2.0');
  // snake_case (Tauri's spelling) and camelCase both read
  assert.equal(parseManifest(manifestJSON({ minimum_version: '1.1.0' })).minimumVersion, '1.1.0');
  assert.equal(parseManifest(manifestJSON({ minimumVersion: '1.1.0' })).minimumVersion, '1.1.0');
});

test('a malformed manifest always fails as ManifestError, never as something else', () => {
  // One catch in the caller has to cover "the host sent us rubbish" completely.
  // Anything that escapes as a SyntaxError or a TypeError is a crash path in the
  // shipping app, on input an attacker chooses.
  const cases = [
    ['not JSON at all', '<!doctype html><h1>404</h1>'],
    ['truncated JSON', '{"version": "1.2.0", "platf'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"1.2.0"'],
    ['null', 'null'],
    ['no version', JSON.stringify({ platforms: {} })],
    ['version not a semver', manifestJSON({ version: 'newest' })],
    ['version numeric', manifestJSON({ version: 2 })],
    ['no platforms member', JSON.stringify({ version: '1.2.0', channel: 'stable' })],
    ['platforms is an array', manifestJSON({ platforms: [] })],
    ['asset is not an object', manifestJSON({ platforms: { 'darwin-universal': 'yes' } })],
    ['asset has no url', manifestJSON({ platforms: { 'darwin-universal': { signature: 'x' } } })],
    ['asset has no signature', manifestJSON({ platforms: { 'darwin-universal': { url: URL_OK } } })],
    ['asset signature is blank', manifestJSON({ platforms: { 'darwin-universal': { url: URL_OK, signature: '   ' } } })],
    ['asset signature is not a string', manifestJSON({ platforms: { 'darwin-universal': { url: URL_OK, signature: 42 } } })],
    ['url is plain http', manifestJSON({ platforms: { 'darwin-universal': { url: 'http://example.com/a.tar.gz', signature: 'x' } } })],
    ['url is a file path', manifestJSON({ platforms: { 'darwin-universal': { url: '/tmp/evil.app.tar.gz', signature: 'x' } } })],
    ['url carries credentials', manifestJSON({ platforms: { 'darwin-universal': { url: 'https://u:p@example.com/a.tar.gz', signature: 'x' } } })],
    ['size is negative', manifestJSON({ platforms: { 'darwin-universal': { url: URL_OK, signature: 'x', size: -1 } } })],
    ['size is a string', manifestJSON({ platforms: { 'darwin-universal': { url: URL_OK, signature: 'x', size: '15MB' } } })],
    ['minimum_version is nonsense', manifestJSON({ minimum_version: 'yesterday' })],
    ['__proto__ as a platform key', '{"version":"1.2.0","channel":"stable","platforms":{"__proto__":{"url":"' + URL_OK + '","signature":"x"}}}'],
  ];
  for (const [why, text] of cases) {
    assert.throws(
      () => parseManifest(text),
      (e) => e instanceof ManifestError && typeof e.message === 'string' && e.message.length > 0,
      `manifest case "${why}" did not fail as a ManifestError`,
    );
  }
  // and the prototype was not polluted on the way past
  assert.equal({}.url, undefined);
});

test('22.5 — a manifest for any channel but "stable" is refused outright', () => {
  // One release channel for every device. A "beta" manifest reaching Mom's Mac
  // would split the family across builds and reintroduce exactly the per-person
  // support round 22.5 exists to delete. Refused, not silently ignored.
  assert.throws(() => parseManifest(manifestJSON({ channel: 'beta' })), ManifestError);
  assert.throws(() => parseManifest(manifestJSON({ channel: '' })), ManifestError);
  assert.throws(() => parseManifest(manifestJSON({ channel: null })), ManifestError);
  // an absent channel means the only channel there is
  const m = parseManifest(JSON.stringify(JSON.parse(manifestJSON())));
  assert.equal(m.channel, 'stable');
});

test('a manifest whose minimum is newer than the build it ships is refused', () => {
  // Obeying it would brick every client permanently: the update it offers would
  // itself still be below the minimum. Refuse the manifest, not the client.
  assert.throws(() => parseManifest(manifestJSON({ version: '1.2.0', minimum_version: '1.3.0' })), ManifestError);
  // equal is fine — "you must be on exactly this build"
  assert.equal(parseManifest(manifestJSON({ version: '1.2.0', minimum_version: '1.2.0' })).minimumVersion, '1.2.0');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Cadence — 22.3's "on launch and roughly daily"
// ─────────────────────────────────────────────────────────────────────────────

test('the daily cadence: never checked, just checked, a day later, and a manual press', () => {
  const T = 1_800_000_000_000; // a literal; nothing here reads the clock
  // never checked → due, on any reason
  assert.equal(dueForCheck({ lastCheckAt: null, now: T, reason: 'timer' }), true);
  assert.equal(dueForCheck({ lastCheckAt: 0, now: T, reason: 'launch' }), true);
  // checked one minute ago → not due on the timer
  assert.equal(dueForCheck({ lastCheckAt: T - 60_000, now: T, reason: 'timer' }), false);
  // one second short of a day → still not due; exactly a day → due
  assert.equal(dueForCheck({ lastCheckAt: T - DAILY_MS + 1_000, now: T, reason: 'timer' }), false);
  assert.equal(dueForCheck({ lastCheckAt: T - DAILY_MS, now: T, reason: 'timer' }), true);
  assert.equal(dueForCheck({ lastCheckAt: T - 3 * DAILY_MS, now: T, reason: 'timer' }), true);
  // the user pressed the button — cadence never applies
  assert.equal(dueForCheck({ lastCheckAt: T, now: T, reason: 'manual' }), true);
});

test('the launch check is debounced, so six launches in an afternoon are one request', () => {
  const T = 1_800_000_000_000;
  // launched again ten minutes later → no second request
  assert.equal(dueForCheck({ lastCheckAt: T - 600_000, now: T, reason: 'launch' }), false);
  // one second short of the gap → still no; at the gap → yes
  assert.equal(dueForCheck({ lastCheckAt: T - LAUNCH_GAP_MS + 1_000, now: T, reason: 'launch' }), false);
  assert.equal(dueForCheck({ lastCheckAt: T - LAUNCH_GAP_MS, now: T, reason: 'launch' }), true);
  // …but the launch gap is shorter than the daily interval, which is the whole
  // point of "on launch AND roughly daily": tomorrow morning's first launch checks.
  assert.ok(LAUNCH_GAP_MS < DAILY_MS);
  assert.equal(dueForCheck({ lastCheckAt: T - 8 * 3_600_000, now: T, reason: 'launch' }), true);
  assert.equal(dueForCheck({ lastCheckAt: T - 8 * 3_600_000, now: T, reason: 'timer' }), false);
});

test('a stored check-time in the future self-heals instead of wedging the updater', () => {
  // A clock correction, a dead battery, a restored disk image: `lastCheckAt` can
  // legitimately be ahead of `now`. Treating that as "not due" would stop the
  // updater until real time caught up — potentially years, silently.
  const T = 1_800_000_000_000;
  assert.equal(dueForCheck({ lastCheckAt: T + 365 * DAILY_MS, now: T, reason: 'timer' }), true);
  assert.equal(dueForCheck({ lastCheckAt: T + 60_000, now: T, reason: 'launch' }), true);
  // garbage in the stored value is treated the same way
  assert.equal(dueForCheck({ lastCheckAt: NaN, now: T, reason: 'timer' }), true);
  assert.equal(dueForCheck({ lastCheckAt: 'gestern', now: T, reason: 'timer' }), true);
});

test('nextCheckAt schedules a day out, and jitter is bounded and opt-in', () => {
  const T = 1_800_000_000_000;
  assert.equal(nextCheckAt({ lastCheckAt: T - 1000, now: T }), T - 1000 + DAILY_MS);
  assert.equal(nextCheckAt({ lastCheckAt: null, now: T }), T + DAILY_MS);
  // a future stored value must not schedule the next check even further out
  assert.equal(nextCheckAt({ lastCheckAt: T + DAILY_MS, now: T }), T + DAILY_MS);
  // jitter spreads a family's Macs; it is injected, so this is deterministic
  const withJitter = nextCheckAt({ lastCheckAt: T, now: T, random: () => 0.5, maxJitterMs: 3_600_000 });
  assert.equal(withJitter, T + DAILY_MS + 1_800_000);
  assert.equal(nextCheckAt({ lastCheckAt: T, now: T, random: () => 0 }), T + DAILY_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The decision — including the downgrade and the minimum version
// ─────────────────────────────────────────────────────────────────────────────

test('a newer build is offered with its asset; the same build is not', () => {
  const m = parseManifest(manifestJSON());
  const d = decide({ manifest: m, currentVersion: '1.0.0' });
  assert.equal(d.status, 'update-available');
  assert.equal(d.target.version, '1.2.0');
  assert.equal(d.target.url, URL_OK);
  assert.equal(d.target.signature, m.platforms[TARGET].signature);
  assert.equal(d.outdated, false);
  assert.equal(d.message, null);

  const same = decide({ manifest: m, currentVersion: '1.2.0' });
  assert.equal(same.status, 'up-to-date');
  assert.equal(same.target, null);
});

test('22.3 — a build already staged is not downloaded a second time', () => {
  // Re-fetching 15 MB on every check is the rudest thing this feature could do
  // to a family on a metered connection, and it would do it daily, forever.
  const m = parseManifest(manifestJSON());
  const d = decide({ manifest: m, currentVersion: '1.0.0', stagedVersion: '1.2.0' });
  assert.equal(d.status, 'already-staged');
  assert.equal(d.target, null);
  // a staged build NEWER than the manifest (a manifest rollback) also counts
  assert.equal(decide({ manifest: m, currentVersion: '1.0.0', stagedVersion: '1.3.0' }).status, 'already-staged');
  // …but a staged build older than the offer is not good enough
  assert.equal(decide({ manifest: m, currentVersion: '1.0.0', stagedVersion: '1.1.0' }).status, 'update-available');
});

test('A DOWNGRADE IS REFUSED — the manifest can never move a device backwards', () => {
  // 22.7: "updates never touch user data; schema migrations run after the swap."
  // Migrations run forward only, so a device that has migrated its board to a
  // newer schema and is then rolled back to an older binary reads a file it does
  // not understand. The honest recovery for a bad release is to publish a HIGHER
  // version, and that path is unaffected by this rule.
  const m = parseManifest(manifestJSON({ version: '1.1.0' }));
  const d = decide({ manifest: m, currentVersion: '1.2.0' });
  assert.equal(d.status, 'downgrade-refused');
  assert.equal(d.target, null);
  // even a very old offer, and even a pre-release of the running version
  assert.equal(decide({ manifest: parseManifest(manifestJSON({ version: '0.1.0' })), currentVersion: '1.2.0' }).status, 'downgrade-refused');
  assert.equal(decide({ manifest: parseManifest(manifestJSON({ version: '1.2.0-rc.1' })), currentVersion: '1.2.0' }).status, 'downgrade-refused');
});

test('an unsupported platform is reported as such, never as an available update', () => {
  const m = parseManifest(manifestJSON({ platforms: { 'linux-x86_64': { url: URL_OK, signature: 'x' } } }));
  const d = decide({ manifest: m, currentVersion: '1.0.0' });
  assert.equal(d.status, 'unsupported-platform');
  assert.equal(d.target, null);
});

test('22.7 / LZP-104 — an outdated client is told so in one plain sentence', () => {
  const m = parseManifest(manifestJSON({ version: '1.2.0', minimum_version: '1.1.0' }));
  const d = decide({ manifest: m, currentVersion: '1.0.0' });
  assert.equal(d.outdated, true);
  assert.equal(d.minimumVersion, '1.1.0');
  // ONE sentence, and it is an i18n key + args rather than a literal, because
  // Gate 7+ requires the string in German and English both. `updateRequired`
  // exists in src/js/i18n.js in DE and EN.
  assert.deepEqual({ key: d.message.key, args: [...d.message.args] }, { key: 'updateRequired', args: ['1.1.0'] });
  // the boundary: exactly at the minimum is NOT outdated
  assert.equal(decide({ manifest: m, currentVersion: '1.1.0' }).outdated, false);
  assert.equal(decide({ manifest: m, currentVersion: '1.1.1' }).outdated, false);
  // a pre-release of the minimum is below it
  assert.equal(decide({ manifest: m, currentVersion: '1.1.0-rc.1' }).outdated, true);
  // no minimum declared → never outdated, no message
  const none = decide({ manifest: parseManifest(manifestJSON()), currentVersion: '0.1.0' });
  assert.equal(none.outdated, false);
  assert.equal(none.message, null);
});

test('22.7 — "does not fail silently": the minimum survives every path that could swallow it', () => {
  // This is the actual failure mode LZP-104 guards against. An outdated client
  // typically CANNOT be rescued by the same manifest — the asset may be missing,
  // the platform unpublished, the offer a downgrade — and every one of those
  // branches returns early. If the message were computed inside any of them it
  // would go missing precisely when it matters most.
  const noAsset = parseManifest(
    manifestJSON({ version: '2.0.0', minimum_version: '2.0.0', platforms: { 'linux-x86_64': { url: URL_OK, signature: 'x' } } }),
  );
  const a = decide({ manifest: noAsset, currentVersion: '1.0.0' });
  assert.equal(a.status, 'unsupported-platform');
  assert.equal(a.outdated, true);
  assert.equal(a.message.key, 'updateRequired');

  // an outdated client whose manifest offers an OLDER build than it runs — a
  // release published in the wrong order. Still told.
  const weird = parseManifest(manifestJSON({ version: '1.1.0', minimum_version: '1.1.0' }));
  const b = decide({ manifest: weird, currentVersion: '1.0.5' });
  assert.equal(b.outdated, true);
  assert.equal(b.message.args[0], '1.1.0');

  // and when it CAN be rescued, both facts are reported at once
  const c = decide({ manifest: parseManifest(manifestJSON({ minimum_version: '1.1.0' })), currentVersion: '1.0.0' });
  assert.equal(c.status, 'update-available');
  assert.equal(c.outdated, true);
});

test('decide refuses to guess when the running build has no usable version', () => {
  // A build whose CFBundleShortVersionString is missing or malformed is a build
  // bug. Comparing against it by guessing would either update forever or never.
  const m = parseManifest(manifestJSON());
  assert.throws(() => decide({ manifest: m, currentVersion: undefined }), VersionError);
  assert.throws(() => decide({ manifest: m, currentVersion: 'dev' }), VersionError);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · The runner — the flow, including the 21.5 gate and the signature failure
// ─────────────────────────────────────────────────────────────────────────────

test('21.5 — NOT ONE BYTE moves before the first-run screen has disclosed the check', () => {
  // The spec tension is real: 21.5 says solo mode makes zero network requests,
  // 22.3 says check daily. The conservative reading implemented here is that the
  // check is a SHELL request, not a board request, AND that it cannot happen
  // before the user has been told it will. `disclosed` is set by LZP-106's
  // first-run screen — the one screen every unsigned install must pass through.
  const port = makePort({ disclosed: false });
  const u = createUpdater({ port, now: frozenClock(1_800_000_000_000) });
  return u.checkOnLaunch().then((r) => {
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'not-disclosed');
    assert.deepEqual(port.calls, ['status'], 'the network port was touched before disclosure');
    assert.equal(u.getState().phase, 'off');
  });
});

test('21.5 — turning the switch off in settings stops the requests, not just the hint', () => {
  const port = makePort({ enabled: false });
  const u = createUpdater({ port, now: frozenClock(1_800_000_000_000) });
  return u.checkDaily().then((r) => {
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'disabled');
    assert.deepEqual(port.calls, ['status']);
  });
});

test('a happy check downloads, stages, and reports "applies at next start"', async () => {
  const T = 1_800_000_000_000;
  const port = makePort({ currentVersion: '1.0.0' });
  const u = createUpdater({ port, now: frozenClock(T) });
  const r = await u.checkOnLaunch();
  assert.equal(r.ran, true);
  assert.equal(r.staged, true);
  assert.equal(r.decision.status, 'update-available');
  const s = u.getState();
  assert.equal(s.phase, 'staged');
  assert.equal(s.stagedVersion, '1.2.0');
  assert.equal(s.lastError, null);
  assert.equal(s.lastCheckAt, T);
  // the check time is persisted BEFORE the request, so a host that hangs cannot
  // leave the device retrying on every single launch
  assert.deepEqual(port.calls, ['status', `noteCheck:${T}`, 'fetchManifest', 'download:"1.2.0"']);
});

test('22.6 — a signature that does not verify installs NOTHING and says so', () => {
  // The shell downloaded the bytes, checked them against the updater key and
  // refused. What this layer owes: no staged version, no "update available"
  // hint, an error that a human can see, and no hot retry — a signature failure
  // is not a transient hiccup, it is a corrupted release or an attack.
  const T = 1_800_000_000_000;
  const port = makePort({
    currentVersion: '1.0.0',
    downloadResult: { ok: false, error: 'signature' },
  });
  const u = createUpdater({ port, now: frozenClock(T) });
  return u.checkOnLaunch().then((r) => {
    assert.equal(r.error, 'signature-or-download');
    assert.equal(r.detail, 'signature');
    const s = u.getState();
    assert.equal(s.phase, 'error');
    assert.equal(s.stagedVersion, null, 'a rejected build must never be staged');
    assert.equal(s.available, null, 'a rejected build must never be announced as available');
    assert.equal(s.lastError, 'signature-or-download');
    // nothing beyond the one download attempt
    assert.deepEqual(port.calls, ['status', `noteCheck:${T}`, 'fetchManifest', 'download:"1.2.0"']);
  });
});

test('a malformed manifest leaves the installed app exactly as it was', async () => {
  const T = 1_800_000_000_000;
  const port = makePort({ manifest: '<!doctype html><title>502 Bad Gateway</title>' });
  const u = createUpdater({ port, now: frozenClock(T) });
  const r = await u.checkNow();
  assert.equal(r.error, 'manifest');
  assert.match(r.detail, /not JSON/);
  assert.equal(u.getState().stagedVersion, null);
  // crucially: `download` was never reached
  assert.deepEqual(port.calls, ['status', `noteCheck:${T}`, 'fetchManifest']);
});

test('a network failure is an error state, not an exception escaping into the app', async () => {
  const T = 1_800_000_000_000;
  for (const port of [
    makePort({ fetchResult: { ok: false, error: 'offline' } }),
    makePort({ throwOn: 'fetchManifest' }),
  ]) {
    const u = createUpdater({ port, now: frozenClock(T) });
    const r = await u.check('timer');
    assert.equal(r.error, 'network');
    assert.equal(u.getState().phase, 'error');
  }
});

test('the cadence gate is enforced by the runner, not only by the pure predicate', async () => {
  const T = 1_800_000_000_000;
  const port = makePort({ lastCheckAt: T - 60_000 });
  const u = createUpdater({ port, now: frozenClock(T) });
  const r = await u.checkDaily();
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'not-due');
  assert.deepEqual(port.calls, ['status'], 'a not-due check must not reach the network');
  // …and the manual press ignores it
  const r2 = await u.checkNow();
  assert.equal(r2.ran, true);
  assert.ok(port.calls.includes('fetchManifest'));
});

test('22.7 — a complete run touches the four updater commands and nothing else', () => {
  // "Updates never touch user data." Made mechanical: the port a shell has to
  // implement is four methods, none of which can read or write a board, an op
  // log, a checkpoint or a snapshot — and a full happy-path run is asserted to
  // call exactly those. A fifth method appearing here is the review signal.
  const T = 1_800_000_000_000;
  const port = makePort({ currentVersion: '1.0.0' });
  const u = createUpdater({ port, now: frozenClock(T) });
  return u.checkOnLaunch().then(() => {
    const names = port.calls.map((c) => c.split(':')[0]);
    assert.deepEqual([...new Set(names)].sort(), ['download', 'fetchManifest', 'noteCheck', 'status']);
    for (const n of names) {
      assert.ok(
        !/board|ops|checkpoint|snapshot|export|import/i.test(n),
        `the updater reached a data command: ${n}`,
      );
    }
  });
});

test('createUpdater refuses a port that cannot honour the contract', () => {
  assert.throws(() => createUpdater({}), TypeError);
  assert.throws(() => createUpdater({ port: {}, now: () => 0 }), /port\.status/);
  assert.throws(
    () => createUpdater({ port: { status() {}, noteCheck() {}, fetchManifest() {} }, now: () => 0 }),
    /port\.download/,
  );
});

test('the outdated client reports the error phase even when there is nothing to install', async () => {
  const T = 1_800_000_000_000;
  const port = makePort({
    currentVersion: '1.0.0',
    manifest: manifestJSON({ version: '1.0.0', minimum_version: '1.0.0', platforms: { 'linux-x86_64': { url: URL_OK, signature: 'x' } } }),
  });
  const u = createUpdater({ port, now: frozenClock(T) });
  const r = await u.checkNow();
  assert.equal(r.decision.outdated, false); // 1.0.0 is not below 1.0.0
  // now the real case: a client below the minimum with no rescue available
  const port2 = makePort({
    currentVersion: '0.9.0',
    manifest: manifestJSON({ version: '1.0.0', minimum_version: '1.0.0', platforms: { 'linux-x86_64': { url: URL_OK, signature: 'x' } } }),
  });
  const u2 = createUpdater({ port: port2, now: frozenClock(T) });
  const r2 = await u2.checkNow();
  assert.equal(r2.decision.outdated, true);
  assert.equal(u2.getState().phase, 'error');
  assert.equal(u2.getState().message.key, 'updateRequired');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · The bridge port — the exact command names both shells implement
// ─────────────────────────────────────────────────────────────────────────────

test('bridgePort speaks the four command names the two shells implement', async () => {
  const seen = [];
  const invoke = async (cmd, args) => {
    seen.push([cmd, args]);
    if (cmd === 'update_status') {
      return JSON.stringify({ currentVersion: '1.0.0', enabled: true, disclosed: true, lastCheckAt: 0, stagedVersion: null });
    }
    if (cmd === 'update_fetch_manifest') return JSON.stringify({ ok: true, manifest: manifestJSON() });
    if (cmd === 'update_download') return JSON.stringify({ ok: true, staged: true });
    return null;
  };
  const p = bridgePort(invoke);
  const st = await p.status();
  assert.equal(st.currentVersion, '1.0.0');
  await p.noteCheck(42);
  const fm = await p.fetchManifest();
  assert.equal(fm.ok, true);
  const dl = await p.download({ version: '1.2.0', url: URL_OK, signature: 'x', size: 1 });
  assert.equal(dl.staged, true);
  assert.deepEqual(seen.map(([c]) => c), [
    'update_status',
    'update_note_check',
    'update_fetch_manifest',
    'update_download',
  ]);
  assert.deepEqual(seen[1][1], { at: 42 });
});

test('bridgePort degrades safely when the shell answers with nothing or with rubbish', async () => {
  // An older shell that does not know these commands returns null. The updater
  // must then behave as "off", not throw during boot.
  const p = bridgePort(async () => null);
  const st = await p.status();
  assert.equal(st.disclosed, false);
  assert.equal(st.enabled, false);
  const fm = await p.fetchManifest();
  assert.equal(fm.ok, false);
  const p2 = bridgePort(async () => 'not json');
  assert.equal((await p2.download({ version: '1', url: 'u', signature: 's' })).ok, false);
});

test('the runner is inert against a shell that does not know the updater commands', async () => {
  const p = bridgePort(async () => null);
  const u = createUpdater({ port: p, now: frozenClock(1_800_000_000_000) });
  const r = await u.checkOnLaunch();
  assert.equal(r.ran, false);
  assert.equal(u.getState().phase, 'off');
});
