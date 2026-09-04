#!/bin/bash
# LZP-107 / LZP-106 — produce the standalone unlock page.
#
#   ./scripts/build-unlock-page.sh   ->  build/dmg/Bitte zuerst lesen.html
#
# WHY IT NEEDS A BROWSER TO BUILD. src/js/firstrun.js exposes
# renderUnlockDocument(), which builds the page out of the SAME DOM nodes and
# the SAME stylesheet the in-app screen uses, precisely so the two cannot drift.
# That means it can only run inside a loaded app, so this reuses the tier-2
# harness: build the Swift shell, run one generator file in a real WKWebView,
# and take the document back out over stdout as base64.
#
# WHERE IT ENDS UP. Under D1 the app is blocked on first launch, so no screen
# inside the app can be the first thing a non-technical person sees -- and the
# in-app unlock screen cannot present itself unasked either, because
# `gatekeeper_status` is implemented in neither shell (firstrun.js:37,117). So
# this page riding ON the disk image next to the app is not a second surface, it
# is the ONLY one that reaches a blocked reader: a double-click opens it in
# Safari, which Gatekeeper does not block.
#
# WIRED UP 2026-09-04, both paths. It used to say here that nothing consumed the
# file, and that was true and cost a real thing: the built page was thrown away
# and the mounted DMG held three entries. Tauri genuinely cannot stage it --
# `bundle.macOS.dmg` is "additionalProperties": false with exactly five keys, so
# an invented sixth makes `cargo tauri build` REJECT the config -- so it is an
# explicit post-bundle step instead:
#
#   verification   scripts/make-dmg.sh                staged + positioned
#   production     .github/scripts/dmg-add-readme.sh  injected into the built DMG
#   gate           release.yml step 10                fails if it is not on the image
#   agreement      .github/scripts/check-dmg-readme.mjs   producer == both consumers
#
# The position (304, 70) is measured against the artwork, not chosen; see
# make-dmg.sh's header for the scan and docs/v2/invitation-email.md § 8.2.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
OUT="build/dmg/Bitte zuerst lesen.html"

if [ ! -f src/js/firstrun.js ]; then
  echo "  skipped: src/js/firstrun.js does not exist yet (LZP-106 has not landed)"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "▸ building a throwaway shell to render in"
./shell-macos/build.sh --dest "$WORK" >/dev/null

echo "▸ rendering the unlock page in a real WKWebView"
RAW="$("$WORK/LangzeitPlaner.app/Contents/MacOS/LangzeitPlaner" \
        --test scripts/dom/render-unlock-doc.dom.js --scratch "$WORK/scratch" 2>&1)"

if ! printf '%s' "$RAW" | grep -q '^# pass 1$'; then
  echo "$RAW" >&2
  echo "::error title=Unlock page did not render::The generator's assertions failed. firstrun.js's renderUnlockDocument() contract changed, or the page grew an external asset." >&2
  exit 1
fi

B64="$(printf '%s' "$RAW" | sed -n 's/.*<<<LZP-UNLOCK-DOC-BEGIN>>>\(.*\)<<<LZP-UNLOCK-DOC-END>>>.*/\1/p')"
[ -n "$B64" ] || { echo "::error title=No document on stdout::markers not found" >&2; exit 1; }

mkdir -p build/dmg
printf '%s' "$B64" | base64 --decode > "$OUT"

BYTES=$(stat -f%z "$OUT")
[ "$BYTES" -gt 2000 ] || { echo "::error title=Unlock page is suspiciously small::$BYTES bytes" >&2; exit 1; }
printf '  %s  %d bytes\n' "$OUT" "$BYTES"
