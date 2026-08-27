#!/bin/bash
# Tier 2 — run the DOM characterization tests in a real WebKit engine.
#
# Builds shell-macos/ into a throwaway .app, then launches it once per test
# file with `--test <file> --scratch <dir>`. The board it loads is the real
# index.html + src/, rendered by WKWebView — the same engine the shipping app
# uses. Output is TAP; exit code is non-zero if any test or any file fails.
#
#   ./tests/run-dom-tests.sh                    # all of tests/tier2/*.dom.js
#   ./tests/run-dom-tests.sh tests/tier2/x.dom.js   # just one file
#   KEEP_BUILD=1 ./tests/run-dom-tests.sh       # leave the temp .app in place
#
# Zero npm dependencies: bash, swiftc, WebKit.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lzp-domtests.XXXXXX")"
APP="$WORK/LangzeitPlaner.app/Contents/MacOS/LangzeitPlaner"
REAL_BOARD="$HOME/Library/Application Support/LangzeitPlaner"

cleanup() {
  # Defined below the build step; a no-op until then, so an early bail-out that
  # never got as far as launching anything does not try to clean up after it.
  if declare -F webkit_cleanup >/dev/null; then webkit_cleanup; fi
  if [[ -n "${KEEP_BUILD:-}" ]]; then
    echo "# build kept at $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# ── isolation guard ──────────────────────────────────────────────────────────
# Fingerprint the user's real board before the run so we can prove afterwards
# that no test touched it. If it does not exist, the fingerprint is the literal
# string "absent" — and "absent" must still be the answer at the end.
fingerprint_real_board() {
  if [[ -d "$REAL_BOARD" ]]; then
    ( cd "$REAL_BOARD" && find . -type f -exec shasum {} \; 2>/dev/null | sort )
  else
    echo "absent"
  fi
}
BEFORE="$(fingerprint_real_board)"

# ── build ────────────────────────────────────────────────────────────────────
echo "# building shell-macos → $WORK"
if ! "$REPO/shell-macos/build.sh" --dest "$WORK" >"$WORK/build.log" 2>&1; then
  echo "Bail out! build failed:"
  sed 's/^/#   /' "$WORK/build.log"
  exit 2
fi
[[ -x "$APP" ]] || { echo "Bail out! no executable at $APP"; exit 2; }

# ── WebKit-side isolation (added by LZP-302) ─────────────────────────────────
#
# `--scratch` redirects the app's DATA directory, and the fingerprint above
# proves nothing reached the user's real board. Neither covers WebKit's OWN
# storage: `WKWebsiteDataStore.default()` is keyed on the BUNDLE IDENTIFIER, so
# until now every tier-2 run shared `~/Library/WebKit/org.langzeitplaner.app/`
# — localStorage and IndexedDB included — with the installed app.
#
# That became load-bearing when tier 2 started persisting CryptoKeys, because a
# CryptoKey in IndexedDB is encrypted under a per-application "WebCrypto master
# key" that WebKit keeps in the LOGIN KEYCHAIN, in an item whose ACL is bound to
# the code signature of the binary that created it. `shell-macos/build.sh` signs
# ad hoc, so every rebuild has a new cdhash, the ACL no longer authorizes the new
# binary, and WebKit silently fails to read the master key:
#
#     Cannot store WebCrypto master key, error -25299   (errSecDuplicateItem)
#
# after which persisted CryptoKeys deserialise to `null` — no error, no warning.
# The test-visible symptom is a persistence test that passes once and then fails
# for ever on the same machine.
#
# So the test build gets its OWN bundle identifier. Two things follow, and both
# are wanted: the WebKit store is genuinely isolated from the installed app, and
# the stale master-key item this suite has to clear belongs to the SUITE rather
# than to the user's app. Clearing the production one would have orphaned every
# device key on a real installation — the exact damage this file exists to
# prevent.
TEST_BUNDLE_ID="org.langzeitplaner.domtest"
WEBCRYPTO_ACCOUNT="com.apple.WebKit.WebCrypto.master+$TEST_BUNDLE_ID"
WEBKIT_DATA="$HOME/Library/WebKit/$TEST_BUNDLE_ID"

plutil -replace CFBundleIdentifier -string "$TEST_BUNDLE_ID" "$WORK/LangzeitPlaner.app/Contents/Info.plist"
codesign --force --deep --sign - "$WORK/LangzeitPlaner.app" 2>/dev/null || true

# Drop the master-key item left by a PREVIOUS run's binary. Absent is fine.
security delete-generic-password -a "$WEBCRYPTO_ACCOUNT" >/dev/null 2>&1 || true
rm -rf "$WEBKIT_DATA"
echo "# webkit isolation: bundle $TEST_BUNDLE_ID, fresh website data + WebCrypto master key"

webkit_cleanup() {
  security delete-generic-password -a "$WEBCRYPTO_ACCOUNT" >/dev/null 2>&1 || true
  rm -rf "$WEBKIT_DATA"
}

# ── run ──────────────────────────────────────────────────────────────────────
if [[ $# -gt 0 ]]; then
  FILES=("$@")
else
  FILES=("$REPO"/tests/tier2/*.dom.js)
fi

FAILED=0
RAN=0
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "Bail out! no such test file: $f"; FAILED=1; continue; }
  RAN=$((RAN + 1))
  SCRATCH="$WORK/scratch-$RAN"
  mkdir -p "$SCRATCH"
  echo "# ── $(basename "$f") ────────────────────────────────────────────"
  # Each file gets a fresh process AND a fresh scratch dir, so files cannot
  # see each other's persisted board — the tier-1 per-file isolation, in WebKit.
  "$APP" --test "$f" --scratch "$SCRATCH"
  rc=$?
  [[ $rc -ne 0 ]] && FAILED=1
done

if [[ $RAN -eq 0 ]]; then
  echo "Bail out! no test files matched"
  exit 2
fi

# ── isolation check ──────────────────────────────────────────────────────────
AFTER="$(fingerprint_real_board)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "not ok - ISOLATION VIOLATED: $REAL_BOARD changed during the test run"
  diff <(echo "$BEFORE") <(echo "$AFTER") | sed 's/^/#   /'
  FAILED=1
else
  echo "ok - isolation: $REAL_BOARD untouched by the run"
fi

echo "# files run: $RAN"
[[ $FAILED -eq 0 ]] && echo "# tier 2: PASS" || echo "# tier 2: FAIL"
exit $FAILED
