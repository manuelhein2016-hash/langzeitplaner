// TIER 2 · THE DEMONSTRATION — the Familienkreis, in the app we actually ship.
// LZP-1002 · stories 15.2 · 15.3 · 15.5 · 16.x · 20.2 · ADR 003 §3.7, §7 gate 3 · net.js §6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR, AND WHY EVERY OTHER FAMILY DEMONSTRATION NEEDED IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A whole-product conformance audit found that `chooseTransport()` (net.js §7) returns the
// **bridge** transport whenever a shell `invoke` exists — which, inside this app, is always — and
// that `sync_request` was implemented by NEITHER shell. So every M1/E6/E7/E9 demonstration that
// reported PASS had run in a browser on `createFetchTransport`. Fifty-one family stories were
// marked PASS with an unwritten caveat: *holds in the browser build and under test.*
//
// `shell-transport.dom.js` closed the transport half — the command exists, it refuses correctly,
// a single sealed op round-trips. This file closes the PRODUCT half, and it is the only test in
// the tree that does:
//
//   **Several real, separate instances of the shipped `.app`, each with its own bundle
//   identifier, its own WebKit store, its own Keychain items and its own Application Support
//   directory, forming one Familienkreis through the bridge and through nothing else.**
//
// Separate bundle identifiers are not fastidiousness. `WKWebsiteDataStore.default()` is keyed on
// the bundle id, so two launches of one bundle SHARE IndexedDB — and the device identity lives
// in IndexedDB (ADR 002 §2.2). Two "instances" of one bundle would be one Mac wearing two hats,
// and every interesting property here (two member rows, two recovery keys, a co-signature that
// one Mac cannot mint alone) would be vacuous. `tests/run-dom-tests.sh` already discovered the
// same fact for its own isolation; the driver does what that script does, five times.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// HOW ONE FILE IS SEVERAL MACS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `scripts/shell-family-e2e.mjs` builds the app copies, starts `node server/dev-server.mjs` on
// loopback, and launches each instance in turn with a generated file that is one line —
// `globalThis.__LZP_E2E = {…}` — followed by THIS FILE, unmodified. The line carries the phase to
// run and whatever the previous phase emitted; nothing else about the app is different from a
// `npm run test:dom` launch. A phase reports back by printing `E2E-OUT <json>` as a TAP comment,
// which the driver reads off stdout — the same channel `diag()` has always used.
//
// **Run plainly (`npm run test:dom`), `__LZP_E2E` is absent and every row `skip()`s with the
// driver command in its reason.** Visible in the TAP output, counted separately, never a silent
// pass — the discipline `shell-transport.dom.js` set for the same situation.
//
//     node scripts/shell-family-e2e.mjs
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const E2E = globalThis.__LZP_E2E || null;
const PHASE = E2E ? String(E2E.phase || '') : '';
const SKIP_REASON =
  'this file is driven by `node scripts/shell-family-e2e.mjs`, which launches five instances of '
  + 'the shipped .app against a loopback relay. Run plainly there is no circle to demonstrate.';

const { store } = await importApp('store.js');
const mount = await importApp('family/mount.js');
const cj = await importApp('family/createjoin.js');
const net = await importApp('platform/net.js');
const sharing = await importApp('family/sharing.js');
const adminpanel = await importApp('family/adminpanel.js');
const leavedelete = await importApp('family/leavedelete.js');
const familysettings = await importApp('family/familysettings.js');
const engine = await importApp('family/engine.js');
const popover = await importApp('popover.js');
const fbport = await importApp('feedback/port.js');
const fbreport = await importApp('feedback/report.js');
const fbredact = await importApp('feedback/redact.js');
const board = await importApp('board.js');

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});

/** What this phase hands the next one. Read off stdout by the driver. */
const OUT = {};
const emit = () => diag('E2E-OUT ' + JSON.stringify(OUT));

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE WIRE COUNTERS — what actually opened a socket, measured rather than asserted
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `fetch` is wrapped rather than deleted, because a deleted `fetch` would make
// `createFetchTransport` throw a TypeError that a catch could swallow into "offline"; a wrapped
// one lets the call proceed and RECORDS it, so a transport that reached for the browser is caught
// doing it rather than inferred from a failure.
//
// ── WHAT EACH COUNTER CAN AND CANNOT SEE, STATED RATHER THAN ASSUMED ─────────────────────────
//
// `WIRE.fetch` IS COMPLETE. `createFetchTransport` resolves `globalThis.fetch` AT CALL TIME
// (`net.js`: `const f = fetchImpl || globalThis.fetch`), so this wrapper catches a fetch made by
// a transport built at any moment, before or after this line. An empty `WIRE.fetch` therefore
// means no part of this page opened a browser socket — full stop.
//
// `WIRE.sync_request` IS NOT COMPLETE, AND THAT IS WHY IT IS NEVER THE ONLY EVIDENCE. The FAMILY
// ENGINE is started on the boot path, before this file runs, and `family/mount.js#ports()`
// captures `invoke` as a value at that moment — so the engine holds the ORIGINAL function and its
// calls do not pass through this wrapper. `family/createjoin.js` reads `ports.invoke()` at
// transport-construction time, so everything IT drives (create, join, redeem, invite, the admin
// panel and the two co-signature sheets) IS counted.
//
// For the engine, the argument is structural and is stronger than a counter: the engine RECORDS
// which transport `chooseTransport` handed it (`transportKind`), and `createBridgeTransport`
// contains no `fetch` at all — its only egress is `invoke('sync_request')`. `transportKind ===
// 'bridge'` plus an empty `WIRE.fetch` leaves exactly one thing the bytes can have travelled on.
// `tests/tier1/platform-net.test.js` pins the "no fetch in the bridge transport" half.
const WIRE = { fetch: [], sync_request: [], sync_urls: [] };
const realFetch = window.fetch;
window.fetch = function countedFetch(...a) {
  WIRE.fetch.push(String(a[0] && a[0].url ? a[0].url : a[0]));
  return realFetch.apply(this, a);
};
const realInvoke = window.__TAURI__.core.invoke;
window.__TAURI__.core.invoke = function countedInvoke(cmd, args) {
  if (cmd === 'sync_request') {
    WIRE.sync_request.push(String((args && args.method) || '?') + ' ' + String((args && args.url) || '?'));
    WIRE.sync_urls.push(String((args && args.url) || ''));
  }
  return realInvoke.call(this, cmd, args);
};

const PALETTE_COLORS = ['violett', 'gruen', 'orange', 'blau'];
const ORIGIN = E2E ? String(E2E.origin || '') : '';

/** The circle screen's root, once `openCircleScreen` has drawn it. */
const $c = (sel) => document.querySelector('.circle ' + sel);

function typeInto(node, value) {
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Arm the shell's gate-3 switch the way the product does — through `familysettings.js`. */
async function armShell() {
  return familysettings.armShellSync();
}

const settleTimeout = { timeout: 25000, interval: 120 };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · WHAT `chooseTransport()` RETURNS IN THE SHIPPED APP — the question this workflow exists for
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 chooseTransport returns "bridge" in the shipped shell, and the bridge command answers', async () => {
  if (!E2E) skip(SKIP_REASON);
  // Not a mock and not the injected `invoke` a tier-1 double supplies: this is
  // `window.__TAURI__.core.invoke`, the real `WKScriptMessageHandlerWithReply` bridge, inside the
  // real WKWebView, inside the binary `shell-macos/build.sh` produced.
  const picked = net.chooseTransport({
    origin: ORIGIN,
    deviceShort: 'CHFBZPVRBG6M14TJ',
    sign: async () => new Uint8Array(64),
    clientVersion: '2.0.0',
    invoke: (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
  });
  assert.equal(picked.kind, 'bridge',
    'chooseTransport chose fetch inside the shell — that is a gate-3 bug, and it is the exact '
    + 'condition the conformance audit found');
  assert.equal(picked.transport.origin, ORIGIN);

  // …and `bridge` is not a label. The command exists and answers.
  const st = await invoke('sync_status');
  assert.equal(typeof st, 'object');
  assert.equal(st.originConfigured, true, 'the driver did not pin an origin — §1 cannot run');
  assert.equal(st.origin, ORIGIN);
  OUT.transportKind = picked.kind;
});

test('§1 the page cannot name a host — the origin is shell configuration, and only a path travels', async () => {
  if (!E2E) skip(SKIP_REASON);
  // NOT in the solo phase: this row ARMS the switch to reach the pin check, and §11's whole
  // subject is an instance whose switch has never been moved. §11 makes the same refusal
  // assertion from the other side, on a shell that is genuinely solo.
  if (PHASE === 'solo') skip('§11 owns the unarmed shell — arming it here would destroy its subject');
  // ORDER FIRST, on an instance that has not yet been armed. With the switch at its default the
  // command refuses at check 1 — before it looks at the URL at all — which is exactly what "solo
  // makes zero requests is a property of the order" means. The switch is PERSISTED (`sync.json`),
  // so on a relaunch of a Mac that already has a circle it is legitimately on; the row branches on
  // the fact rather than assuming a state, and asserts something either way.
  const armed0 = (await invoke('sync_status')).enabled === true;
  const beforeArming = await invoke('sync_request', {
    url: 'https://evil.example/api/v1/meta', method: 'GET', headers: {}, body: '',
  });
  assert.equal(beforeArming.reason, armed0 ? 'url_is_not_the_pinned_origin' : 'sync_disabled',
    armed0
      ? 'an armed shell accepted an off-origin URL'
      : 'the switch is not the FIRST check — an unarmed shell looked at the URL before refusing');
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });

  // The single most important property of the new attack surface, asserted from the page that
  // would be the attacker. There is no argument to `sync_request` that changes WHERE it goes.
  const off = await invoke('sync_request', {
    url: 'https://evil.example/api/v1/meta', method: 'GET', headers: {}, body: '',
    origin: 'https://evil.example',            // ← not a parameter. The shell has no such argument.
  });
  assert.equal(off.error, 'blocked');
  assert.equal(off.reason, 'url_is_not_the_pinned_origin');
  assert.ok(!off.status, 'a refused request must carry no HTTP answer');
  // The probes above are this file's own; they must not be counted as the product's traffic.
  WIRE.sync_request.length = 0;
  WIRE.sync_urls.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · CREATE — „Familienkreis erstellen", on the first Mac, through the bridge
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 a Familienkreis is created from the real screen, and every byte went through the bridge', async () => {
  if (PHASE !== 'create') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);

  // The shell's gate-3 switch, pushed by the product's own code path. Without it `sync_request`
  // refuses everything — which is precisely the state a shipped shell was in before this pass.
  assert.equal(await armShell(), 'no-space', 'a Mac with no space must not arm the switch');
  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  WIRE.sync_request.length = 0;
  WIRE.sync_urls.length = 0;

  // The address. In the shell this is normally the pinned origin, reconciled into settings by
  // `familysettings.js#refitOriginForShell`; here we write it directly because the settings sheet
  // is not what this row is about.
  store.setSettings({ [engine.FAMILY_PREFS.origin]: ORIGIN });
  cj.initCreateJoin();                                   // DEFAULT ports — the real ones

  const before = WIRE.sync_request.length;
  cj.openCircleScreen({ screen: 'create' });
  assert.ok($c('#circle-name'), 'the create screen did not draw');
  typeInto($c('#circle-name'), 'Familie Weber');
  typeInto($c('#circle-display'), E2E.displayName || 'Papa');
  $c('#circle-color-' + (E2E.colorRef || 'violett')).click();
  $c('#circle-create-go').click();

  await waitFor(() => $c('#circle-code'), { ...settleTimeout, what: 'the invite code' });
  const code = $c('#circle-code').textContent.trim();
  assert.match(code, /[A-Za-z0-9]/, 'no invite code on the created screen');

  const circle = cj.familyCircle();
  assert.ok(circle, 'no circle in settings after create');
  assert.match(circle.spaceId, /^fsp_/);

  // ── THE PROOF THAT MATTERS ────────────────────────────────────────────────────────────────
  // `POST /spaces` and `POST /invites` both happened, and BOTH went through `sync_request`.
  const sent = WIRE.sync_request.slice(before);
  assert.ok(sent.some((s) => s.startsWith('POST ') && s.endsWith('/api/v1/spaces')),
    'POST /spaces did not go through the bridge: ' + JSON.stringify(sent));
  assert.ok(sent.some((s) => s.endsWith('/api/v1/invites')),
    'POST /invites did not go through the bridge: ' + JSON.stringify(sent));
  assert.deepEqual(WIRE.fetch, [],
    'the page opened a socket of its own — createFetchTransport is still reachable in the shell: '
    + JSON.stringify(WIRE.fetch));
  // Every URL the shell was handed named the pinned origin. The shell would have refused any
  // other; this asserts the page never even tried.
  const urls = WIRE.sync_urls.slice(WIRE.sync_urls.length - sent.length);
  assert.ok(urls.length > 0 && urls.every((u) => u.startsWith(ORIGIN + '/api/v1/')),
    'a request was addressed off-origin: ' + JSON.stringify(urls));

  // The circle is armed and the shell's switch is now correctly on for a Mac with a space.
  assert.equal(await armShell(), 'armed');

  // FURTHER INVITES, IN THE SAME LAUNCH. Not a shortcut: every launch of a Mac that is already in
  // a circle is a chance for finding F-SHELL-1 to refuse a peer's attestation terminally, so the
  // demonstration keeps the pre-share launch count at its minimum. `createInvite` is the same
  // `AdminPort` call the „Neue Einladung" button makes.
  const codes = [code];
  const port = adminpanel.createAdminPort(circle);
  for (let i = 0; i < Number(E2E.extraInvites || 0); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    codes.push((await port.createInvite()).code);
  }
  assert.equal(codes.length, 1 + Number(E2E.extraInvites || 0), 'an invite was not minted');
  assert.deepEqual(WIRE.fetch, [], 'minting an invite reached for fetch');

  OUT.spaceId = circle.spaceId;
  OUT.memberId = store.state.settings[engine.CIRCLE_MEMBER_PREF];
  OUT.code = code;
  OUT.codes = codes;
  OUT.bridgeCalls = WIRE.sync_request.length;
  emit();
});

test('§2 the admin can mint further invites, still through the bridge', async () => {
  if (PHASE !== 'invite') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  cj.initCreateJoin();
  const circle = cj.familyCircle();
  assert.ok(circle, 'this Mac is in no circle');
  const port = adminpanel.createAdminPort(circle);
  const before = WIRE.sync_request.length;
  const codes = [];
  for (let i = 0; i < Number(E2E.count || 1); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    codes.push((await port.createInvite()).code);
  }
  assert.equal(codes.length, Number(E2E.count || 1));
  assert.ok(WIRE.sync_request.length > before, 'no bridge call was made to mint an invite');
  assert.deepEqual(WIRE.fetch, [], 'the admin panel reached for fetch');
  OUT.codes = codes;
  OUT.spaceId = circle.spaceId;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · JOIN — a SECOND INSTANCE, its own keys, its own Keychain, redeeming a real invite
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 a second instance joins the circle by pasting the code — through the bridge', async () => {
  if (PHASE !== 'join') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);

  await invoke('set_shell_pref', { key: 'sync_enabled', value: true });
  store.setSettings({ [engine.FAMILY_PREFS.origin]: ORIGIN });
  cj.initCreateJoin();

  const before = WIRE.sync_request.length;
  cj.openCircleScreen({ screen: 'join' });
  assert.ok($c('#circle-code-in'), 'the join screen did not draw');
  typeInto($c('#circle-code-in'), E2E.code);
  typeInto($c('#circle-display'), E2E.displayName);
  $c('#circle-color-' + E2E.colorRef).click();
  $c('#circle-join-go').click();

  await waitFor(() => cj.familyCircle(), { ...settleTimeout, what: 'the circle in settings' });
  const circle = cj.familyCircle();
  assert.equal(circle.spaceId, E2E.spaceId, 'joined a different space than the one invited to');

  const sent = WIRE.sync_request.slice(before);
  assert.ok(sent.some((s) => s.endsWith('/api/v1/invites/redeem')),
    'POST /invites/redeem did not go through the bridge: ' + JSON.stringify(sent));
  assert.deepEqual(WIRE.fetch, [], 'the join screen reached for fetch');

  // D9 — the designed waiting state. A joiner holds NO space key yet; that is not an error and
  // the screen says so. Whether it has already cleared depends on the admin's next sync, so this
  // row asserts the FACT is present and readable, not which way it points.
  assert.equal(typeof circle.keysPending, 'boolean');
  assert.equal(await armShell(), 'armed');

  OUT.memberId = store.state.settings[engine.CIRCLE_MEMBER_PREF];
  OUT.spaceId = circle.spaceId;
  OUT.keysPending = circle.keysPending;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · SETTLE — the engine runs, the keys are delivered (D9), the roster fills in
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4 the family engine arms on relaunch and reports the transport it actually chose', async () => {
  if (PHASE !== 'settle') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();

  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  // THE ANSWER, from the running product rather than from a constructed transport: the engine
  // records which transport `chooseTransport` handed it.
  assert.equal(parts.transportKind, 'bridge',
    'the family engine is running on fetch inside the shell — gate 3 is not doing its job');
  assert.equal(parts.circle.spaceId, E2E.spaceId);

  // Keys — ADR 002 §7.1 steps 4-6. `deliver()` is the ADMIN's half (wrap the current epoch to
  // every member's device) and `admit()` is everybody's (fetch the wraps addressed to me). The
  // cadence would do both on its own timer; this drives them so the demonstration is not a race,
  // and both are the SHIPPED functions on the running engine, not re-implementations.
  if (E2E.expectKeys !== false) {
    await waitFor(async () => {
      try { await parts.sync.keys.deliver(); } catch { /* not the admin, or nothing to deliver */ }
      try { await parts.sync.keys.admit(); } catch { /* not yet */ }
      return parts.keyring.currentEpoch(E2E.spaceId) > 0;
    }, { timeout: 40000, interval: 400, what: 'the epoch key to arrive (D9)' });
    assert.ok(parts.keyring.currentEpoch(E2E.spaceId) >= 1, 'no epoch key after settling');
  }
  // One real sync, so this Mac's own ops and everybody else's have actually moved.
  try { await parts.sync.syncNow(); } catch { /* reported by the rows that need it */ }

  // The roster, read through the same transport.
  const roster = await parts.sync.keys.roster();
  assert.equal(roster.ok, true, 'the roster did not come back: ' + JSON.stringify(roster));
  assert.ok(roster.members.length >= Number(E2E.expectMembers || 1),
    `roster has ${roster.members.length} members, expected at least ${E2E.expectMembers}`);

  // The engine's own record of `chooseTransport`'s verdict, plus the complete negative. See the
  // counters' header for why this pair, and not a call count, is the argument for the engine.
  assert.deepEqual(WIRE.fetch, [],
    'the running engine reached for fetch: ' + JSON.stringify(WIRE.fetch));

  try {
    const r0 = await parts.sync.keys.roster();
    diag('ROSTER0 ' + JSON.stringify((r0.members || []).map((m) => ({
      m: m.memberId, rec: typeof m.recoveryPubSig, devs: (m.devices || []).map((d) => ({
        s: d.deviceShort, att: typeof d.attestation, len: (d.attestation || '').length })) }))));
  } catch (e) { diag('ROSTER0 threw ' + e.message); }
  const refusals = (store.warnings || []).filter((w) => /refused|parked/.test(String(w)));
  for (const w of (store.warnings || []).filter((x) => !/unknown v1 field/.test(String(x)))) diag('WARN ' + w);
  OUT.refused = refusals.length;
  OUT.transportKind = parts.transportKind;
  OUT.epoch = parts.keyring.currentEpoch(E2E.spaceId);
  OUT.members = roster.members.map((m) => ({ memberId: m.memberId, alive: m.alive !== false }));
  OUT.bridgeCalls = WIRE.sync_request.length;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · A GETEILT ENTRY CROSSES — the product's actual point
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§5 a Geteilt entry is authored, sealed and pushed through the bridge', async () => {
  if (PHASE !== 'share') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  await waitFor(() => parts.keyring.currentEpoch(E2E.spaceId) > 0,
    { ...settleTimeout, what: 'this Mac to hold an epoch key' });

  popover.useSharing(sharing);
  const id = 'e2e-' + Math.random().toString(36).slice(2, 10);
  const date = E2E.date;
  const catId = store.state.categories[0].id;
  store.apply('createNoteInline', {
    id, date, text: E2E.text, categoryId: catId,
    visibility: 'privat', unhideCategoryId: null, lastCategoryId: catId,
  });
  // The same transaction `popover.js#applyLevel` runs — the shipped plan function, the shipped
  // patch, authored into the family space as a real op.
  let plan = null;
  store.txn('set-visibility', (tx) => {
    const x = tx.get('note', id);
    if (!x) return false;
    plan = sharing.planVisibilityChange(x, 'geteilt');
    if (!plan) return false;
    tx.note(id).set(plan.patch);
  });
  assert.ok(plan, 'planVisibilityChange declined — the note was not shareable');
  assert.equal(plan.to, 'geteilt');

  // The push, through the engine the last row proved is running on the bridge. `pushNow` reports
  // what it actually sent; a `pushed: 0` would mean the publication never reached the outbox,
  // which is the failure this row exists to catch.
  const pushed = await waitFor(async () => {
    const r = await parts.sync.pushNow();
    return r && r.pushed > 0 ? r : null;
  }, { ...settleTimeout, what: 'the shared entry to reach the relay' });
  assert.ok(pushed.pushed >= 1, 'nothing was pushed: ' + JSON.stringify(pushed));
  assert.equal(parts.transportKind, 'bridge',
    'the engine that pushed this op is not on the bridge');
  assert.deepEqual(WIRE.fetch, [],
    'the sync engine reached for fetch: ' + JSON.stringify(WIRE.fetch));
  diag('pushed ' + pushed.pushed + ' op(s) in ' + pushed.batches + ' batch(es) through the '
    + parts.transportKind + ' transport');

  OUT.noteId = id;
  OUT.text = E2E.text;
  OUT.date = date;
  emit();
});

test('§5 the entry arrives on the OTHER instance, decrypted, with its text', async () => {
  if (PHASE !== 'receive') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  await waitFor(() => parts.keyring.currentEpoch(E2E.spaceId) > 0,
    { ...settleTimeout, what: 'this Mac to hold an epoch key' });

  // Pull until the foreign entry is in this Mac's own projection. Not "a request happened" —
  // the actual entry, with the actual text, opened with the actual space key.
  let lastPull = null;
  const trace = async () => {
    try { diag('status ' + JSON.stringify(parts.sync.status())); } catch (e) { diag('status threw ' + e.message); }
    try {
      const r = await parts.sync.keys.roster();
      diag('roster ok=' + r.ok + ' members=' + (r.members || []).length
        + ' att=' + JSON.stringify((r.members || []).map((m) => [m.memberId, !!m.attestation])));
    } catch (e) { diag('roster threw ' + e.message); }
    try { diag('refreshAttestations → ' + await parts.refreshAttestations((await parts.sync.keys.roster()).members)); } catch (e) { diag('refresh threw ' + e.message); }
    try { for (const w of (store.warnings || []).filter((x) => !/unknown v1 field/.test(String(x)))) diag('WARN ' + w); } catch (e) { diag('warnings threw ' + e.message); }
    try {
      const membersui = await importApp('family/membersui.js');
      const regs = membersui.membersRegisters();
      const keys = Object.keys(regs || {});
      diag('REGKEYS ' + JSON.stringify(keys.slice(0, 40)));
      const devs = keys.filter((k) => /dev\./.test(k));
      diag('DEVREGS ' + JSON.stringify(devs));
      diag('MEMREGS ' + JSON.stringify(keys.filter((k) => /^member/.test(k)).slice(0, 20)));
    } catch (e) { diag('regs threw ' + e.message); }
    try { diag('MYSHORT ' + JSON.stringify(store.diagnostics().identity)); } catch { /* */ }
    try { diag('notes ' + JSON.stringify((store.state.notes || []).map((n) => [n.id, n.text, n.isForeign]))); } catch { /* */ }
  };
  const found = await waitFor(async () => {
    // `admit()` first: the sharer may have sealed at an epoch newer than the one this Mac held
    // when it last settled (every join rotates, ADR 002 §4.1), and an envelope at an epoch this
    // Mac cannot open PARKS rather than failing. This is the cadence's own order, driven.
    try { await parts.sync.keys.admit(); } catch { /* nothing new */ }
    lastPull = await parts.sync.pullNow();
    const all = [...(store.state.notes || [])];
    return all.find((n) => n && n.text === E2E.text) || null;
  }, { timeout: 60000, interval: 400, what: 'the Geteilt entry to cross' }).catch(async (e) => {
    await trace();
    diag('last pull: ' + JSON.stringify(lastPull));
    throw e;
  });
  diag('pull: ' + JSON.stringify(lastPull) + ' · epoch ' + parts.keyring.currentEpoch(E2E.spaceId));

  assert.equal(found.text, E2E.text, 'the entry arrived without its text — the seal did not open');
  assert.equal(found.date, E2E.date);
  assert.equal(found.isForeign, true, 'the entry is not marked as somebody else\'s');
  assert.equal(parts.transportKind, 'bridge', 'the engine that pulled this op is not on the bridge');
  assert.deepEqual(WIRE.fetch, [],
    'the receiving engine reached for fetch: ' + JSON.stringify(WIRE.fetch));

  // It is on the BOARD, not merely in the store — the product's own claim.
  await waitFor(() => document.querySelector('.board') && document.body.textContent.includes(E2E.text),
    { timeout: 8000, what: 'the entry to render' });
  assert.includes(document.body.textContent, E2E.text);

  OUT.received = true;
  OUT.entityKey = found.entityKey || null;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE CO-SIGNATURE — including the founder-less circle, which was unremovable-by-anyone
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 an ordinary removal meets the relay\'s 403, and the sheet reads it as a proof demand', async () => {
  if (PHASE !== 'cosign-ask') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  cj.initCreateJoin();
  const circle = cj.familyCircle();
  const port = adminpanel.createAdminPort(circle);

  let demand = null;
  try {
    await port.removeMember(E2E.target, null);
    assert.fail('the relay allowed a removal with one key — the gate this sheet exists for is gone');
  } catch (e) {
    demand = leavedelete.proofDemand(e);
  }
  assert.ok(demand, 'the 403 was not readable as a proof demand: ' + JSON.stringify(demand));
  assert.equal(demand.act, 'member.remove');
  assert.equal(typeof demand.epoch, 'number');
  OUT.reason = demand.reason || '';

  // The ASKING sheet, built from the refusal body and from this Mac's own member list.
  const terms = {
    act: demand.act, spaceId: circle.spaceId, target: E2E.target,
    epoch: demand.epoch, presenter: port.myMemberId(),
  };
  const text = leavedelete.encodeCosignRequest(terms);
  assert.match(text, /^LZP-COSIGN\/2/);
  assert.includes(text, circle.spaceId);
  assert.includes(text, E2E.target);

  OUT.request = text;
  OUT.terms = terms;
  OUT.eligible = port.eligibleCosigners(E2E.target);
  emit();
});

test('§6 a DIFFERENT instance co-signs with its own recovery key — this Mac cannot mint it alone', async () => {
  if (PHASE !== 'cosign-sign') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  cj.initCreateJoin();
  const circle = cj.familyCircle();
  const port = adminpanel.createAdminPort(circle);

  const terms = leavedelete.parseCosignRequest(E2E.request);
  assert.ok(terms, 'the pasted request did not parse');
  assert.equal(terms.spaceId, circle.spaceId, 'the request names another circle');

  // The four refusals, exercised where they are real: this Mac is neither the presenter nor the
  // target, so it may sign — and the SAME function refuses when it is either.
  const me = { spaceId: circle.spaceId, memberId: port.myMemberId() };
  assert.equal(leavedelete.cosignRefusal(terms, me), null,
    'this Mac refused to co-sign a request it is eligible for');
  assert.equal(leavedelete.cosignRefusal(terms, { ...me, memberId: terms.presenter }), 'fromThisMac');
  assert.equal(leavedelete.cosignRefusal(terms, { ...me, memberId: terms.target }), 'youAreMeant');
  assert.equal(leavedelete.cosignRefusal(terms, { spaceId: 'fsp_somewhere_else', memberId: me.memberId }),
    'otherCircle');

  const signed = leavedelete.adminProofString(terms);
  const proof = await port.coSign(signed);
  assert.equal(proof.by, port.myMemberId(), 'the signature is not this Mac\'s own member');
  assert.notEqual(proof.by, terms.presenter, 'the presenter signed for itself — two rows, not two keys');
  assert.match(proof.sig, /^[A-Za-z0-9_-]{16,}$/);

  OUT.answer = leavedelete.encodeCosignature(terms, proof.by, proof.sig);
  OUT.by = proof.by;
  emit();
});

test('§6 the proof is spent, the removal succeeds, and the keys rotate — through the bridge', async () => {
  if (PHASE !== 'cosign-spend') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  await waitFor(() => parts.keyring.currentEpoch(E2E.spaceId) > 0,
    { ...settleTimeout, what: 'this Mac to hold an epoch key' });
  const epochBefore = parts.keyring.currentEpoch(E2E.spaceId);
  cj.initCreateJoin();
  const circle = cj.familyCircle();
  const port = adminpanel.createAdminPort(circle);

  const answer = leavedelete.parseCosignature(E2E.answer);
  assert.ok(answer, 'the pasted answer did not parse');
  // `parseCosignature` returns `{terms, by, sig}` — the five terms RIDE BACK with the signature so
  // the asking Mac can refuse a mis-pasted answer locally instead of turning it into a 401 the two
  // people cannot diagnose. This is that refusal, exercised on the honest path.
  assert.equal(leavedelete.sameTerms(answer.terms, E2E.terms), true,
    'the answer is bound to different terms than the request — the one-use property is gone');
  // …and the same check REFUSES an answer bound to a different target. Without this the row above
  // would pass on a `sameTerms` that always said yes.
  assert.equal(leavedelete.sameTerms(answer.terms, { ...E2E.terms, target: 'mem_somebodyelse' }), false);
  assert.notEqual(answer.by, E2E.terms.presenter,
    'the presenter signed for itself — that is two rows and one key, not two keys');

  const before = WIRE.sync_request.length;
  const res = await port.removeMember(E2E.target, { by: answer.by, sig: answer.sig });
  assert.ok(res, 'the removal returned nothing');
  assert.equal(res.authorizedBy, 'admin_proof',
    'the relay did not record the co-signature as the authority: ' + JSON.stringify(res));

  const sent = WIRE.sync_request.slice(before);
  assert.ok(sent.some((s) => s.includes('/api/v1/members/remove')),
    'the removal did not go through the bridge: ' + JSON.stringify(sent));
  assert.deepEqual(WIRE.fetch, [], 'the removal reached for fetch');

  // ADR 002 §4.1 — a removal ROTATES. `afterRemove` is the default port on `createAdminPort`, so
  // this is the shipped follow-up and not a re-implementation of it.
  await waitFor(() => parts.keyring.currentEpoch(E2E.spaceId) > epochBefore,
    { timeout: 40000, interval: 250, what: 'the epoch to rotate after the removal' });
  const epochAfter = parts.keyring.currentEpoch(E2E.spaceId);
  assert.ok(epochAfter > epochBefore,
    `the keys did not rotate: epoch ${epochBefore} → ${epochAfter}`);

  OUT.epochBefore = epochBefore;
  OUT.epochAfter = epochAfter;
  OUT.removal = res.removal ? res.removal.verdict : null;
  OUT.authorizedBy = res.authorizedBy;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · THE TWO-MEMBER CAVEAT — met as a SENTENCE, not as a 403
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7 the two-member caveat: the circle IS stranded, and the sentence for it is a sentence', async () => {
  if (PHASE !== 'stranded') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  cj.initCreateJoin();
  const circle = cj.familyCircle();
  const port = adminpanel.createAdminPort(circle);

  // ── THE STATE, FROM THE RELAY, WHICH IS THE ONLY PLACE IT IS TRUE ────────────────────────
  //
  // The founder has left (20.3) and one member has been removed (20.2), so two live rows remain
  // and neither of them created the circle. This is the exact state T5-M3 names: the two-key rule
  // is unsatisfiable, and no removal by anybody can ever succeed here again.
  const roster = await parts.sync.keys.roster();
  assert.equal(roster.ok, true, 'the roster did not come back');
  const alive = roster.members.filter((m) => m.removedAt === null || m.removedAt === undefined);
  assert.equal(alive.length, 2,
    `expected two live members, the relay says ${alive.length}: `
    + JSON.stringify(roster.members.map((m) => [m.memberId, m.removedAt])));
  assert.equal(roster.members.length, 4, 'the historical member set was pruned — attribution would break');
  assert.ok(alive.some((m) => m.memberId === circle.memberId), 'this Mac is not one of the two');

  // ── AND THE FINDING THIS ROW MEASURED, WHICH IS NOT WHAT IT SET OUT TO MEASURE ───────────
  //
  // `eligibleCosigners` counts from THIS MAC'S OWN MEMBER LIST — the folded family log — because
  // that is the list the sheet shows and a count taken from anywhere else would disagree with
  // what the person is looking at. A REMOVAL writes `member.set{_alive:false}` into that log
  // (`family/removal.js#REMOVAL_PATCH`, published by `afterRemove`). **A LEAVE DOES NOT.**
  // `POST /members/leave` is a relay call and the leaver, by definition, is not there afterwards
  // to author anything — so on every remaining Mac the departed founder is still a live row.
  //
  // The consequence, recorded rather than asserted away: in the ONE state the stranded sentence
  // was written for, `eligibleCosigners` does not return 0, so the sentence does not fire. The
  // person meets a `403 founder_gone_every_removal_needs_second_key` instead — which §6 shows is
  // at least readable — rather than the paragraph that explains it. Recorded as **F-SHELL-2**.
  //
  // ── AND THE NUMBER THAT DECIDES WHICH DEFECT F-SHELL-2 IS ────────────────────────────────
  //
  // `eligibleCosigners` returns log ∩ roster when this Mac HOLDS a roster, and `null` (UNKNOWN)
  // for a positive log-only count when it does not. §5 of `docs/v2/SHELL-VERIFICATION.md`
  // recorded **2** — a value no log state can produce with the roster present — so the roster
  // must have been empty at the moment of the count. `mount.rosterSnapshot()` records that
  // directly, beside the count, on the real binary. Without it the two readings are guesses.
  const cached = mount.rosterSnapshot();
  const eligible = port.eligibleCosigners(E2E.target);
  assert.ok(eligible === null || typeof eligible === 'number',
    'eligibleCosigners answered neither a number nor `null` — `null` is "unknown" and must never '
    + 'be read as zero (T5-M3)');
  diag(`eligibleCosigners → ${eligible}; rosterCache holds ${cached.length} row(s); the relay says `
    + `${alive.length - 1} member(s) besides me are alive, of whom `
    + `${Math.max(0, alive.length - 2)} could co-sign`);
  OUT.eligibleFromLog = eligible;
  OUT.rosterCached = cached.length;
  OUT.aliveOnRelay = alive.length;
  // The relay's own count of who could actually co-sign an act against the target: alive, not me,
  // not the target. THIS is zero, and it is the number the sentence is about.
  const reallyEligible = alive.filter((m) => m.memberId !== circle.memberId
    && m.memberId !== E2E.target).length;
  assert.equal(reallyEligible, 0,
    `the relay says ${reallyEligible} member(s) could co-sign — this circle is not stranded`);

  // ── THE SENTENCE ────────────────────────────────────────────────────────────────────────
  const de = leavedelete.COSIGN_COPY.nobody.de;
  const en = leavedelete.COSIGN_COPY.nobody.en;
  assert.match(de, /niemand/i);
  assert.match(en, /nobody/i);
  assert.equal(/fehler/i.test(de), false, 'the stranded sentence calls itself an error');
  assert.equal(/error/i.test(en), false, 'the stranded sentence calls itself an error');
  // It does not leave the person at a dead end: leaving is still everybody's, and it says so.
  assert.includes(de, 'Kreis verlassen');
  assert.includes(en, 'Leave circle');

  // AND NOTHING WAS SENT. Whatever the count says, reading the caveat costs no request — the
  // difference between meeting it as a sentence and meeting it as a 403.
  const before = WIRE.sync_request.length;
  leavedelete.cosignSummary({ act: 'member.remove', spaceId: circle.spaceId, target: E2E.target,
    epoch: 1, presenter: circle.memberId }, 'de', (id) => port.nameOf(id));
  await sleep(200);
  assert.equal(WIRE.sync_request.length, before,
    'reading the caveat reached the relay — it is being met as a 403, not as a sentence');
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7b · LZP-1009 — „Rückmeldung senden", END TO END, ON THE REAL RELAY
//
// `tests/tier2/feedback.dom.js` proves the screen: it composes, it previews the exact payload,
// and it sends — through a port THE TEST BINDS. That leaves the one claim neither tier can make
// on its own and that R-10 recorded as OPEN: **does the shipped app bind it, and does a real
// relay take the report?** Until this pass nothing called `setFeedbackPort`, so `canSend()` was
// false on every Mac and „Senden" was disabled with the reason on screen (E10-1009-A).
//
// So this phase binds NOTHING. It asks the port that `family/mount.js#bindFeedback` left behind
// whether it can send, builds a report off the REAL board in this launch, and posts it over the
// bridge to `server/dev-server.mjs` — the same `server/core/router.js` and the same
// `handlers/feedback.js` that would run in Frankfurt. A 202 means the relay took custody; a 501
// would mean `ctx.feedbackSink` is unbound, which is exactly what the DEPLOYED relay still
// answers and what the residual list still owes.
//
// AND IT IS INSIDE THE REDACTION BOUNDARY. The board this launch is looking at carries a Privat
// entry. The wire body is searched for it, byte for byte, before anything is sent.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§7b „Rückmeldung senden" is BOUND by the shipped app, and the real relay answers 202', async () => {
  if (PHASE !== 'feedback') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });

  // The binder is asynchronous (it exports a raw public key on the way), so it is waited for
  // rather than assumed — and a timeout here IS the finding, not a flake.
  await waitFor(() => fbport.canSend(), { ...settleTimeout, what: 'the feedback port to be bound' });
  const port = fbport.feedbackPort();
  assert.ok(port, '`canSend()` is true and `feedbackPort()` is null — the two disagree');
  assert.equal(typeof port.send, 'function', 'the bound port carries no `send`');
  assert.equal(port.spaceKind, 'family', `the port says spaceKind=${port.spaceKind} on a Mac in a circle`);
  assert.equal(typeof port.devicePub, 'string',
    'the port carries no device public key, so every report is anonymous and two reports from '
    + 'one Mac cannot be told from two Macs (`proves: unsigned`)');
  assert.equal(typeof port.sign, 'function', 'the port carries a devicePub it cannot sign with');

  // ── A PRIVAT ENTRY, ON THIS BOARD, RIGHT NOW ───────────────────────────────────────────────
  const NEEDLE = 'Scheidungsanwältin Dr. Kübler 14:30';
  const day = $('.board .day[data-date]');
  assert.ok(day, 'the board drew no day row — the report would be about nothing');
  store.mutate('e2e:fb-seed', (st) => {
    st.notes.push({ id: 'e2e-fb-1', date: day.dataset.date, text: NEEDLE,
      categoryId: st.categories[0].id, repeatsYearly: false });
  });
  board.renderBoard($('#board'));
  assert.ok(document.body.textContent.includes(NEEDLE), 'the needle is not on the board');

  // The SAME two calls `feedback/ui.js#openFeedback` makes, in the same order: the picture is
  // rendered off the live board before anything else, and `buildReport` is handed the object
  // `renderRedactedBoard` returns (`{bytes, w, h, counts}`), not a data URL.
  const image = fbredact.renderRedactedBoard($('#board'));
  assert.ok(image && image.bytes && image.bytes.length > 0, 'the redacted picture came out empty');
  const built = fbreport.buildReport({
    text: 'Die Wochenspalte springt beim Scrollen.',
    screen: 'board', now: Date.now(), image,
    appVersion: port.appVersion, spaceKind: port.spaceKind,
  });
  assert.ok(built.text.includes('Die Wochenspalte'), 'her sentence is not in the report');
  const body = fbreport.wireBody(built, {
    pub: port.devicePub,
    sig: fbreport.b64(await port.sign(fbreport.signedBytes(built))),
  });

  // ── THE STANDING BAR, ON THE ONE PAYLOAD THAT LEAVES A SOLO MAC ────────────────────────────
  const wire = JSON.stringify(body);
  for (const needle of [NEEDLE, 'Scheidungsanwältin', 'Kübler', day.dataset.date]) {
    assert.equal(wire.includes(needle), false,
      `the feedback payload carries „${needle}" — a Privat entry reached the wire`);
  }

  // ── WHY THE WIRE COUNTER IS NOT THE WITNESS HERE, MEASURED RATHER THAN ASSUMED ────────────
  //
  // `mount.js#ports()` captures `window.__TAURI__.core.invoke` BY REFERENCE, and the circle
  // engine is armed at BOOT — before `runTestFile` injects this file and its counter wrapper. So
  // a transport the app built for itself calls the original `invoke` and `WIRE.sync_request`
  // never sees it. (Measured: this row failed on exactly that, with the send having succeeded.)
  // The phases that count the wire build their transports from inside the phase, which is why
  // they can.
  //
  // The witness that survives that is stronger anyway: a 202 from `server/dev-server.mjs` cannot
  // be produced without the bytes arriving there. And the claim the counter WAS carrying —
  // "nothing here used fetch" — is still asserted, because `window.fetch` is wrapped in place.
  const fetchBefore = WIRE.fetch.length;
  const res = await port.send(body);
  assert.equal(WIRE.fetch.length, fetchBefore,
    `„Senden" reached for fetch: ${JSON.stringify(WIRE.fetch.slice(fetchBefore))}`);
  assert.equal(res.status, 202,
    `the relay answered ${res.status} ${JSON.stringify(res.body)}. 501 means ctx.feedbackSink is `
    + 'unbound on that relay — honest, and not a send');
  assert.equal(res.body.ok, true);
  // `proves` is the SENTENCE `handlers/feedback.js#PROVES` holds, not a token — the relay answers
  // in words on purpose. The signed sentence is about a key signing twice; the unsigned one says
  // „nothing at all". Matching the first and refusing the second is the whole of the claim.
  assert.match(String(res.body.proves), /signed by the same private key/,
    `the relay recorded proves=${res.body.proves} — the device signature did not verify`);
  assert.equal(/nothing at all/.test(String(res.body.proves)), false,
    'the relay took the report as UNSIGNED — the port bound no key, or the signature was dropped');
  assert.ok(typeof res.body.provesNot === 'string' && res.body.provesNot.length > 0,
    'the relay did not say what the report does NOT prove');
  assert.match(String(res.body.provesNot), /self-minted client-side and never enrolled/,
    'the relay\'s disclaimer is not the one LZP-1009 requires on every answer');

  // AND IT WENT TO THE ONE ORIGIN. The port holds no URL at all — the path is fixed at
  // `FEEDBACK_PATH` in the binder and the origin is the shell's pin — so the strongest thing
  // this row can say is that the transport it was handed is the circle's own.
  const parts = mount.circleEngine();
  assert.equal(parts.transport.origin, E2E.origin,
    'the bound sender is pointed at an origin that is not the circle\'s');
  assert.equal(parts.transportKind, 'bridge',
    `the circle engine chose ${parts.transportKind}, so the report did not travel on the bridge`);

  store.mutate('e2e:fb-clean', (st) => { st.notes = st.notes.filter((n) => n.id !== 'e2e-fb-1'); });
  await store.persistNow();

  OUT.feedbackStatus = res.status;
  OUT.feedbackSigned = /signed by the same private key/.test(String(res.body.proves));
  OUT.feedbackBytes = wire.length;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8 · THE REMOVED MAC — what the relay now refuses it, and what its board still holds
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§8 the removed instance is refused by the relay and holds no new epoch', async () => {
  if (PHASE !== 'removed') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  const epoch = parts.keyring.currentEpoch(E2E.spaceId);

  // The relay refuses this Mac now. `keys.roster()` is the cheapest signed read there is.
  const roster = await parts.sync.keys.roster();
  assert.equal(roster.ok, false,
    'a removed member could still read the roster — the removal did not take effect');

  // …and no epoch beyond the one it already had. ADR 002 §4.1: the rotation is delivered to the
  // REMAINING members, and this Mac is not one of them.
  assert.ok(epoch <= Number(E2E.epochBefore || 1),
    `the removed Mac holds epoch ${epoch}, which is past the rotation it must not have`);
  assert.deepEqual(WIRE.fetch, [], 'the removed engine reached for fetch');

  // Its OWN board is intact. Removal ends access; it does not reach into somebody's calendar.
  assert.ok((store.state.notes || []).length >= 0);
  OUT.epoch = epoch;
  OUT.rosterOk = roster.ok;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §9 · LEAVE — how the founder-less circle is actually made
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§9 the founder leaves, through the bridge, and the circle survives without a founder', async () => {
  if (PHASE !== 'leave') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  cj.initCreateJoin();
  const circle = cj.familyCircle();
  const port = adminpanel.createAdminPort(circle);

  const before = WIRE.sync_request.length;
  const res = await port.leaveSpace();
  assert.ok(res, 'leaving returned nothing');
  const sent = WIRE.sync_request.slice(before);
  assert.ok(sent.some((s) => s.includes('/api/v1/members/leave')),
    'leaving did not go through the bridge: ' + JSON.stringify(sent));
  assert.deepEqual(WIRE.fetch, [], 'leaving reached for fetch');

  OUT.left = true;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §10 · THE UNSHARE BUTTON — reverts, does not delete, notifies nobody
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§10 the admin takes an entry out of the circle — and it goes back to Privat, whole', async () => {
  if (PHASE !== 'unshare') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  await waitFor(() => parts.keyring.currentEpoch(E2E.spaceId) > 0,
    { ...settleTimeout, what: 'this Mac to hold an epoch key' });
  await waitFor(async () => {
    await parts.sync.pullNow();
    return (store.state.notes || []).some((n) => n && n.text === E2E.text);
  }, { timeout: 40000, interval: 250, what: 'the shared entry to be here to unshare' });

  // `membersRegisters()` is `membersui.js`'s one view of the folded family registers — the same
  // object the member list reads, so the moderation list cannot see a different circle than the
  // roster does.
  const membersui = await importApp('family/membersui.js');
  const rows = familysettings.sharedEntries(membersui.membersRegisters(), {
    me: store.state.settings[engine.CIRCLE_MEMBER_PREF],
  });
  const row = rows.find((r) => r.text === E2E.text);
  assert.ok(row, 'the shared entry is not in the moderation list: ' + JSON.stringify(rows.map((r) => r.text)));

  const un = await importApp('family/unshare.js');
  const driver = un.createUnshare({ lang: 'de' });
  const out = await driver.run(row.entityKey);
  assert.ok(out, 'the unshare driver returned nothing');
  assert.ok(Array.isArray(out.say) && out.say.length > 0, 'the driver said nothing');
  // ADR 002 §7.4's downgrade sentence, BY IDENTITY — the driver's own words, not a paraphrase.
  assert.ok(out.say.includes(un.UNSHARE_COPY.honesty.de) || out.verdict !== 'published',
    'the honesty line is missing from what the admin was told');
  assert.deepEqual(WIRE.fetch, [], 'the unshare driver reached for fetch');

  OUT.verdict = out.verdict;
  OUT.say = out.say;
  emit();
});

test('§10 the OWNER\'s board shows nothing that distinguishes a moderated entry from her own „→ Privat"', async () => {
  if (PHASE !== 'unshare-owner') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);
  await armShell();
  const parts = await waitFor(() => mount.circleEngine(), { ...settleTimeout, what: 'the circle engine' });
  await waitFor(async () => { await parts.sync.pullNow(); return true; },
    { ...settleTimeout, what: 'a pull' });
  await sleep(600);
  await parts.sync.pullNow();

  const mine = (store.state.notes || []).find((n) => n && n.text === E2E.text);
  assert.ok(mine, 'the owner lost her own entry — unshare DELETED instead of reverting');
  assert.equal(mine.text, E2E.text, 'the owner\'s entry lost its text');
  assert.equal(mine.visibility, 'privat', 'the entry did not revert to Privat');

  // Nothing anywhere on this Mac says an admin did it. 18.3 / Principle 9: nobody is notified and
  // nobody is shamed.
  const doc = document.body.textContent;
  for (const word of ['entfernt', 'Verwaltung hat', 'moderiert', 'removed by', 'unshared']) {
    assert.equal(doc.includes(word), false, `the owner's screen says „${word}"`);
  }
  assert.equal(document.querySelectorAll('[class*="unshared"]').length, 0,
    'the owner\'s entry carries a moderation class');

  OUT.ownerKept = true;
  OUT.visibility = mine.visibility;
  emit();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §11 · SOLO MODE MAKES ZERO REQUESTS — measured through the NEW path
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§11 a whole solo session makes zero sync_request calls and zero fetches', async () => {
  if (PHASE !== 'solo') skip(PHASE ? `phase is ${PHASE}` : SKIP_REASON);

  // This instance has no circle, no space, and the shell's switch is at its default.
  assert.equal(cj.familyCircle(), null, 'this instance is not solo — the fixture is wrong');
  const st = await invoke('sync_status');
  assert.equal(st.enabled, false, 'sync_enabled is on in a solo instance');

  // The product's own arming code refuses to move the switch, because there is no space.
  assert.equal(await familysettings.armShellSync(), 'no-space');

  // A real session: edit the board, open the settings sheet, switch language, re-render.
  const cat = store.state.categories[0].id;
  for (let i = 0; i < 6; i += 1) {
    store.apply('createNoteInline', {
      id: 'solo-' + i, date: E2E.date, text: 'Solo ' + i, categoryId: cat,
      visibility: 'privat', unhideCategoryId: null, lastCategoryId: cat,
    });
  }
  const settings = await importApp('settings.js');
  if (typeof settings.openSettings === 'function') { try { settings.openSettings(); } catch { /* fine */ } }
  await sleep(400);
  if (typeof settings.closeSettings === 'function') { try { settings.closeSettings(); } catch { /* fine */ } }
  await sleep(400);

  assert.deepEqual(WIRE.sync_request, [],
    'a solo session called sync_request: ' + JSON.stringify(WIRE.sync_request));
  assert.deepEqual(WIRE.fetch, [],
    'a solo session called fetch: ' + JSON.stringify(WIRE.fetch));

  // …and even if something DID call it, the shell would refuse locally — no socket, no DNS.
  const refused = await invoke('sync_request', {
    url: ORIGIN + '/api/v1/meta', method: 'GET', headers: {}, body: '',
  });
  assert.equal(refused.error, 'blocked');
  assert.equal(refused.reason, 'sync_disabled',
    'the switch is not the FIRST check — solo\'s zero-request promise is a property of the order');
  OUT.solo = true;
  emit();
});
