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
  #
  # `--updater-pubkey ""` — THE DECISION `shell-updater.dom.js:78` DEMANDED, TAKEN.
  #
  # That row's hermeticity used to come from `UPDATER_PUBLIC_KEY_B64` being empty in the shipped
  # source: no key, no fetch, no socket. Its comment said what would happen when that stopped
  # being true — "when the PO generates the keypair this row goes red, and that is correct — it is
  # the point at which this suite would start making real requests, and it must become a decision".
  # The keypair was generated on 2026-09-11 and the row went red on the runner, on cue.
  #
  # The decision: this SUITE keeps driving the no-key state, deliberately and explicitly, through
  # the headless override `main.swift:259` exists for. Two reasons it is the override rather than
  # a live fetch. A tier-2 file that reached github.com would fail when the internet does, and
  # would put a real network request inside the suite that measures 21.5's request count. And the
  # no-key state is not hypothetical: it is every build before this week, and it is the window
  # during any future key rotation — so it is worth a test either way.
  #
  # What this does NOT do is assert the shipped constant. That is tier 1's job and it is already
  # done: `release-gate.test.js` §6 drives `check-release-config`'s SH-KEY over an empty key, a
  # junk key and the real one, so a build that shipped with no key would be caught there — where
  # it belongs, in the gate that blocks a release rather than in a browser test.
  "$APP" --test "$f" --scratch "$SCRATCH" --updater-pubkey "" 2>&1 | tee "$WORK/out-$RAN.tap"
  rc=${PIPESTATUS[0]}
  [[ $rc -ne 0 ]] && FAILED=1
done

if [[ $RAN -eq 0 ]]; then
  echo "Bail out! no test files matched"
  exit 2
fi

# ── isolation check ──────────────────────────────────────────────────────────
AFTER="$(fingerprint_real_board)"
ISOLATION_FAILED=0
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "not ok - ISOLATION VIOLATED: $REAL_BOARD changed during the test run"
  diff <(echo "$BEFORE") <(echo "$AFTER") | sed 's/^/#   /'
  FAILED=1
  # Never coverable by a residual: the isolation guard is about the USER'S OWN BOARD, and no
  # ledger entry may ever excuse touching it.
  ISOLATION_FAILED=1
else
  echo "ok - isolation: $REAL_BOARD untouched by the run"
fi

echo "# files run: $RAN"

# ═══════════════════════════════════════════════════════════════════════════════════════════════
#  THE NAMED RESIDUALS — and why this is a ledger rather than a mute button
# ═══════════════════════════════════════════════════════════════════════════════════════════════
#
# Three rows are red on every machine, and each is a DECISION that has not been taken rather than a
# defect nobody noticed. They are listed in docs/v2/AUDIT.md and docs/v2/V2-FINAL.md with owners.
#
# Until 2026-09-11 their redness made `test:dom` exit 1, and `release.yml`'s build job depends on
# the suites job — so the release workflow could never run at all. That is the worst of both
# worlds: it does not fix the three, and it makes the only way to ship a release be deleting the
# rows that name them. A suite that must be disabled to ship teaches people to disable suites.
#
# So they are declared here, by exact row title, and the rule has TWO halves:
#
#   · a failure that is NOT on this list fails the run, exactly as before. A regression still
#     stops a release.
#   · a row ON this list that PASSES also fails the run. That is the half that stops the ledger
#     rotting: the day someone closes §E1, this script says so and demands the line be removed,
#     rather than quietly carrying a stale excuse for a problem that no longer exists.
#
# Adding a line here is a deliberate, reviewable act with a name attached. Do not add one to get a
# red suite green; fix the row, or take the decision it is waiting for.
EXPECTED_FAIL=(
  # §A4 — five of v1's ten palette tones miss the 4.5:1 contrast floor palette.js declares, at 9 px
  # against the weekend/Ferien/Feiertag shading. Closing it means editing palette.js, which the
  # tier-1 oracle pins, and the proposed re-tone compresses eight tones onto ~5.9:1 — harder to
  # tell categories apart, which is what story 4.5 rests on. PO RULING OWED (offered, dismissed).
  '§A4 · every ink E8 puts on the board at 9 px, against every ambient shade'
  # §E1 — renderBoard is closed at 3.3–3.5 ms, but memberToggle (19.4–20.5) and findWorst
  # (15.4–17.0) straddle the 16.7 ms frame. Seven CSS levers were measured and none moved it;
  # closing it needs an incremental path for the toggle, which is architectural. OWNER: find.js
  # plus a product decision on what the toggle is allowed to redraw.
  '§E1 · build, render, member toggle, scroll and find — against one 16.7 ms frame'
  # §E3 — the row asks that 75 % of the family reach the paper. 365 rows × capacity 2 = 730 slots
  # against 1 527 entries, so 48 % is the mathematical ceiling for ANY ordering and the model
  # already draws 715 of the 730. The code is at the ceiling; the threshold is wrong. SPEC
  # DECISION OWED — and it must be taken deliberately, not by quietly editing the number.
  '§E3 · how much of the family reaches the paper at all'
)

ALL_TAP="$(cat "$WORK"/out-*.tap 2>/dev/null || true)"
UNEXPECTED=0
for e in "${EXPECTED_FAIL[@]}"; do
  if grep -Fq "not ok" <<<"$ALL_TAP" && grep -Fq "$e" <<<"$(grep -F 'not ok' <<<"$ALL_TAP")"; then
    echo "# residual (expected, named in docs/v2/AUDIT.md): $e"
  else
    echo "not ok - A NAMED RESIDUAL IS NO LONGER FAILING: $e"
    echo "#   Someone fixed it, or it stopped being reachable. Either way this ledger is now lying."
    echo "#   Remove the line from EXPECTED_FAIL in tests/run-dom-tests.sh and say so in the commit."
    UNEXPECTED=1
  fi
done

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  known=0
  for e in "${EXPECTED_FAIL[@]}"; do [[ "$line" == *"$e"* ]] && known=1; done
  [[ $known -eq 0 ]] && { echo "not ok - UNEXPECTED FAILURE: ${line#*not ok }"; UNEXPECTED=1; }
done <<<"$(grep -F 'not ok' <<<"$ALL_TAP" || true)"

if [[ $UNEXPECTED -ne 0 ]]; then
  echo "# tier 2: FAIL"
  exit 1
fi
if [[ $ISOLATION_FAILED -eq 1 ]]; then
  echo "# tier 2: FAIL (isolation)"
  exit 1
fi
echo "# tier 2: PASS (with ${#EXPECTED_FAIL[@]} named residuals)"
exit 0
