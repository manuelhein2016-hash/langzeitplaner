// LZP-107 — generate the standalone unlock page that rides ON the DMG.
//
// This is not a test; it is a code generator that happens to need a DOM. The
// page comes from firstrun.js's renderUnlockDocument(), which lifts its copy
// and its CSS out of the live app so the sheet on the disk image cannot drift
// away from the screen inside the app. That means it can only be produced by
// running the real app in a real engine — which is exactly what the tier-2
// harness already does, so it is reused rather than reinvented.
//
// It lives in scripts/dom/, NOT in tests/tier2/, so `npm run test:dom` does not
// pick it up as a test file.
//
// Driven by scripts/build-release-assets.sh. Output is one base64 line between
// markers, because a multi-megabyte HTML document through console.log is at the
// mercy of whatever line handling sits between WKWebView and stdout.

const firstrun = await importApp('firstrun.js');

test('renderUnlockDocument produces a self-contained page', () => {
  assert.equal(typeof firstrun.renderUnlockDocument, 'function',
    'firstrun.js must export renderUnlockDocument (LZP-106 contract)');
  const html = firstrun.renderUnlockDocument();

  assert.ok(html.startsWith('<!doctype html>'), 'a complete document, not a fragment');
  assert.ok(!/<script/i.test(html), 'no script: this page opens from a mounted disk image');
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html),
    'no external asset: the DMG is not on the network and neither is Mum');
  assert.ok(html.includes('lang="de"'), 'German is present');
  assert.ok(html.includes('lang="en"'), 'English is present');
  assert.ok(html.length > 2000, 'the styles were inlined, not dropped');

  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(html)));
  console.log('<<<LZP-UNLOCK-DOC-BEGIN>>>' + b64 + '<<<LZP-UNLOCK-DOC-END>>>');
});
