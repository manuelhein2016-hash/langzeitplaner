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
