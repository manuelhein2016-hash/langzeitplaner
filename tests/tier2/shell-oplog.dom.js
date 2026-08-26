// TIER 2 · CHARACTERIZATION — LZP-402's five op-log bridge commands, exercised
// against the real Swift host in a real WKWebView. node --test can say nothing
// about these: they are file-system semantics (append vs rewrite, atomic
// replace, absent-file behaviour) that only exist on the native side.
//
// This file is also the ACTIVE half of the isolation proof. tests/run-dom-tests.sh
// shasums ~/Library/Application Support/LangzeitPlaner before and after the run
// and fails on any change — but a fingerprint only proves something if a test
// actually asks the shell to write the new files. That is what happens below:
// every op-log and checkpoint write in this file is aimed at whatever path the
// host resolves, and the runner's after-fingerprint is the verdict on where it
// landed. Point the shell at the real board dir and this file's writes would
// show up in that diff.
//
// The other direction — that the host REFUSES rather than falls back — is the
// `exit(70)` in resolveScratchDir()/dataFile(), which cannot be provoked from
// inside the page (the process is already running) and is checked from bash.

const storage = await importApp('storage.js');

// ── the fresh-scratch baseline (ADR 001 §9/§11) ──────────────────────────────

test('a solo board has no op log and no checkpoint at all', async () => {
  // §11's promise, measured in the shipping shell rather than argued: the two
  // v2 files do not exist until a family space is created, so the bridge has
  // nothing to hand back. `store-persistence.test.js` pins the same property
  // from the other side (a persist touches exactly the two v1 slots).
  assert.equal(await window.__TAURI__.core.invoke('load_ops', {}), '',
    'a fresh board came up with an op log already on disk');
  assert.equal(await window.__TAURI__.core.invoke('load_checkpoint', {}), '',
    'a fresh board came up with a checkpoint already on disk');
});

test('the READ doors are pure — asking does not create the files', async () => {
  await window.__TAURI__.core.invoke('load_ops', {});
  await window.__TAURI__.core.invoke('load_checkpoint', {});
  assert.equal(await storage.opsLogExists(), false,
    'opsLogExists() must stay an honest predicate: reading created a file');
  assert.equal(await window.__TAURI__.core.invoke('load_ops', {}), '');
});

// ── append_ops ───────────────────────────────────────────────────────────────

test('append_ops appends: the second call does not replace the first', async () => {
  await window.__TAURI__.core.invoke('append_ops', { contents: '{"i":1}\n{"i":2}\n' });
  await window.__TAURI__.core.invoke('append_ops', { contents: '{"i":3}\n' });
  const txt = await window.__TAURI__.core.invoke('load_ops', {});
  assert.equal(txt, '{"i":1}\n{"i":2}\n{"i":3}\n',
    'the earlier lines survived the later append, in order');
});

test('the appended bytes are durable and byte-exact, not re-serialized', async () => {
  // An op line is signed material in WP-6. A host that pretty-printed, reordered
  // keys or re-encoded UTF-8 on the way through would invalidate every signature
  // it stored. Round-trip a line with the properties that would expose that.
  const line = JSON.stringify({ z: 1, a: 'ü — "quoted"', n: [1, 2, 3] });
  await window.__TAURI__.core.invoke('append_ops', { contents: line + '\n' });
  const txt = await window.__TAURI__.core.invoke('load_ops', {});
  assert.ok(txt.endsWith(line + '\n'), 'the last line is not the bytes we sent: ' + txt.slice(-120));
});

test('an empty append is a no-op rather than an error', async () => {
  const before = await window.__TAURI__.core.invoke('load_ops', {});
  await window.__TAURI__.core.invoke('append_ops', { contents: '' });
  assert.equal(await window.__TAURI__.core.invoke('load_ops', {}), before);
});

// ── truncate_ops ─────────────────────────────────────────────────────────────

test('truncate_ops keeps the tail from a 0-based line index', async () => {
  await window.__TAURI__.core.invoke('truncate_ops', { keepFromLine: 2 });
  const lines = (await window.__TAURI__.core.invoke('load_ops', {})).trim().split('\n');
  assert.equal(lines.length, 2, 'expected 2 lines back, got ' + lines.length);
  assert.equal(lines[0], '{"i":3}', 'the kept head is the line at index 2');
});

test('truncate_ops line indices agree with what loadOps() handed the caller', async () => {
  // The caller computes keepFromLine against the ARRAY loadOps() returned, so
  // the host has to count lines the same way storage.js's parseJSONL does.
  const ops = await storage.loadOps();
  assert.equal(ops.length, 2, 'loadOps() disagrees with the raw line count');
  await storage.truncateOps(1);
  const after = await storage.loadOps();
  assert.equal(after.length, 1);
  assert.deepEqual(after[0], ops[1], 'the surviving op is the one at the given index');
});

test('truncating everything away removes the log rather than leaving a stub', async () => {
  await window.__TAURI__.core.invoke('truncate_ops', { keepFromLine: 99 });
  assert.equal(await window.__TAURI__.core.invoke('load_ops', {}), '');
  assert.equal(await storage.opsLogExists(), false);
});

// ── checkpoint ───────────────────────────────────────────────────────────────

test('save_checkpoint / load_checkpoint round-trip byte-for-byte', async () => {
  const payload = JSON.stringify({ registers: { 'note:x@text': ['a', 'st'] }, seq: 7 });
  await window.__TAURI__.core.invoke('save_checkpoint', { contents: payload });
  assert.equal(await window.__TAURI__.core.invoke('load_checkpoint', {}), payload);
});

test('save_checkpoint replaces rather than appends', async () => {
  // It is the one file nothing can re-derive, so it is written atomically —
  // whole-file temp + rename, exactly like save_board.
  const second = JSON.stringify({ registers: {}, seq: 8 });
  await window.__TAURI__.core.invoke('save_checkpoint', { contents: second });
  assert.equal(await window.__TAURI__.core.invoke('load_checkpoint', {}), second);
});

// ── storage.js takes the NATIVE branch for all five ──────────────────────────

test('storage.js op-log functions use the bridge, not the localStorage fallback', async () => {
  const keysBefore = Object.keys(localStorage).sort();
  await storage.appendOps([{ op: 'via-storage', k: 1 }]);
  await storage.saveCheckpoint({ via: 'storage' });
  const ops = await storage.loadOps();
  const cp = await storage.loadCheckpoint();
  assert.equal(ops.at(-1).op, 'via-storage');
  assert.equal(cp.via, 'storage');
  assert.deepEqual(Object.keys(localStorage).sort(), keysBefore,
    'the browser fallback branch was taken: localStorage grew');
  assert.equal(await storage.opsLogExists(), true);
});

test('opsPath() names the production file beside board.json', () => {
  // Cosmetic, like storagePath(): a label for the settings sheet, never
  // evidence of where bytes went in this run.
  assert.equal(storage.opsPath(), '~/Library/Application Support/LangzeitPlaner/ops.jsonl');
});

// ── isolation ────────────────────────────────────────────────────────────────

test('ISOLATION: the op log this run wrote is the scratch one, not the user\'s', async () => {
  // Everything this file appended is still there and nothing else is: if the
  // host had resolved ops.jsonl inside the real board directory we would be
  // reading (and would have corrupted) whatever lives there. The runner's
  // before/after shasum of that directory is the other half of this assertion.
  const ops = await storage.loadOps();
  assert.equal(ops.length, 1, 'unexpected op log contents: ' + JSON.stringify(ops));
  assert.equal(ops[0].op, 'via-storage');
});

test('the app booted with no uncaught errors or rejections', () => {
  assert.deepEqual(window.__lzpErrors, []);
});
