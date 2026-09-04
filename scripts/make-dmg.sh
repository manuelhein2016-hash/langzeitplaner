#!/bin/bash
# LZP-107 — build a laid-out DMG from a .app, using only tools that ship with macOS.
#
#   ./scripts/make-dmg.sh <path/to/LangzeitPlaner.app> [out.dmg]
#
# THIS IS NOT THE PRODUCTION PATH. Releases are built by Tauri's own DMG bundler from
# src-tauri/tauri.conf.json > bundle.macOS.dmg (LZP-101, .github/workflows/release.yml).
# This script exists for two reasons, both of which the production path cannot serve:
#
#   1. Verification. Rust is not installable on the dev machine, so `tauri build` cannot
#      run here. Without this script every claim about the DMG -- that the background is
#      picked up, that the geometry matches the icon positions, that the whole thing fits
#      in a mailbox -- would be an assertion instead of a measurement.
#   2. A Rust-free escape hatch. The hand-built Swift shell in shell-macos/ produces a
#      real .app; this turns that into a real, emailable DMG when the CI runner is not
#      an option.
#
# It deliberately mirrors what Tauri's bundler does, so a discrepancy here is a warning
# about there. Keep the constants in sync with tauri.conf.json; check-dmg-geometry.mjs
# fails the build if they drift.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:?usage: make-dmg.sh <path/to/LangzeitPlaner.app> [out.dmg]}"
OUT="${2:-$REPO/build/dmg/LangzeitPlaner.dmg}"
VOLNAME="LangzeitPlaner"

# ── geometry — must equal tauri.conf.json > bundle.macOS.dmg ───────────────────
WIN_W=660
WIN_H=420
APP_X=170
APP_Y=170
FOLDER_X=490
FOLDER_Y=170
ICON_SIZE=128

# ── the third item: the page a blocked user can still open ────────────────────
# D1 ships unsigned, so Gatekeeper refuses the app on first launch. LZP-106's
# guided unlock screen answers that -- but it lives INSIDE the app she cannot
# open yet. The DMG window is the one surface that reaches her first, so the
# standalone page (scripts/build-unlock-page.sh) rides on the image next to the
# app: double-clicking an HTML file opens Safari, which Gatekeeper does not block.
#
# THE POSITION IS MEASURED, NOT CHOSEN. assets/dmg/background.svg was rendered at
# 660x420 and every candidate icon centre scanned against three things it must not
# collide with: the app item's box, the Applications item's box, and the painted
# artwork. Result: in a 660x420 window already holding two 128pt icons there is
# NO fully clear slot -- zero candidates score 0. (304, 70) is the minimum: it
# clears both Finder items completely and grazes the arrowhead's upper tip by
# 115 px^2 of the 20 024 px^2 the item occupies (0.6%). Everything else is worse.
# The window needs to grow, or the art needs a third slot, before this is clean;
# neither is this script's to change. .github/scripts/check-dmg-readme.mjs fails
# the build if this position ever starts overlapping an item box.
#
# These two are deliberately NOT in tauri.conf.json. Tauri's schema declares
# bundle.macOS.dmg with `additionalProperties: false` and exactly five keys, so an
# invented sixth makes `cargo tauri build` reject the config outright. The
# production path gets the same numbers from .github/scripts/dmg-add-readme.sh,
# and check-dmg-readme.mjs fails if the two ever disagree.
READ_X=304
READ_Y=70
READ_NAME="Bitte zuerst lesen.html"

[ -d "$APP" ] || { echo "no such .app: $APP" >&2; exit 1; }
BG="$REPO/src-tauri/dmg/background.tiff"
[ -f "$BG" ] || { echo "missing $BG — run ./scripts/build-release-assets.sh first" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
STAGE="$(mktemp -d)"; RW="$(mktemp -d)/rw.dmg"; MNT="$(mktemp -d)/mnt"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$STAGE" "$(dirname "$RW")" "$(dirname "$MNT")"; }
trap cleanup EXIT

echo "▸ staging"
cp -R "$APP" "$STAGE/$VOLNAME.app"
# The drop target. It must be named exactly "Applications": macOS localises the display
# name of that folder through /System/Library/CoreServices/SystemFolderLocalizations,
# where "Applications" maps to "Programme" in de.lproj. Rename it and the German label
# is lost -- and so is the "drag to Programme" of story 22.1.
ln -s /Applications "$STAGE/Applications"
mkdir -p "$STAGE/.background"
cp "$BG" "$STAGE/.background/background.tiff"

# The unlock page. Built on demand rather than required, because the whole point
# of this script is that somebody can run it from a clean checkout and LOOK at the
# window; a missing generated file should not be a puzzle.
PAGE="$REPO/build/dmg/$READ_NAME"
if [ ! -f "$PAGE" ]; then
  echo "  the unlock page is not built yet — building it"
  "$REPO/scripts/build-unlock-page.sh"
fi
if [ ! -f "$PAGE" ]; then
  echo "missing $PAGE — scripts/build-unlock-page.sh produced nothing." >&2
  echo "Without it the DMG carries no instructions, and under D1 macOS refuses the app" >&2
  echo "before any screen inside it can explain why. Fix the generator; do not ship around it." >&2
  exit 1
fi
cp "$PAGE" "$STAGE/$READ_NAME"

echo "▸ creating read/write image"
# +12 MB of slack: Finder writes .DS_Store and its own metadata into the mounted volume,
# and an image sized exactly to the payload fails that write with a cryptic I/O error.
# The unlock page (~19 KB) is already inside $STAGE when this runs, so it is inside the
# `du` and the slack is unchanged by construction rather than by re-tuning a constant.
SIZE_KB=$(( $(du -sk "$STAGE" | cut -f1) + 12000 ))
rm -f "$RW"
hdiutil create -srcfolder "$STAGE" -volname "$VOLNAME" -fs HFS+ \
  -format UDRW -size "${SIZE_KB}k" "$RW" >/dev/null

mkdir -p "$MNT"
hdiutil attach "$RW" -nobrowse -mountpoint "$MNT" >/dev/null

echo "▸ laying out the window"
# Finder automation. If this fails -- no GUI session, or Automation permission not
# granted to the calling process -- the DMG is still valid and still installable; it
# just opens with default icon positions and no background. That is a cosmetic loss,
# so it warns instead of failing the build.
LAYOUT_OK=1
osascript <<APPLESCRIPT >/dev/null 2>&1 || LAYOUT_OK=0
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 140, ${WIN_W} + 200, ${WIN_H} + 140}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to $ICON_SIZE
    set background picture of viewOptions to file ".background:background.tiff"
    set position of item "$VOLNAME.app" of container window to {$APP_X, $APP_Y}
    set position of item "Applications" of container window to {$FOLDER_X, $FOLDER_Y}
    set position of item "$READ_NAME" of container window to {$READ_X, $READ_Y}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
if [ "$LAYOUT_OK" = 1 ]; then echo "  layout applied"; else
  echo "  ::warning:: Finder layout could not be applied (no GUI session or Automation not permitted)."
  echo "             The DMG is valid and installable; it will open unstyled."
fi

sync
hdiutil detach "$MNT" -quiet
trap 'rm -rf "$STAGE" "$(dirname "$RW")" "$(dirname "$MNT")"' EXIT

echo "▸ compressing"
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null

BYTES=$(stat -f%z "$OUT")
# Mail providers cap the BASE64-ENCODED attachment, which is 4/3 of the file plus line
# breaks -- call it x1.36. 20 MB providers (GMX, Web.de, T-Online) therefore allow about
# 14.7 MB of actual DMG; 25 MB providers (Gmail, iCloud) about 18.4 MB.
printf '\n  %s\n  %d bytes = %.2f MiB, ~%.1f MB once base64-encoded\n' \
  "$OUT" "$BYTES" "$(echo "$BYTES/1048576" | bc -l)" "$(echo "$BYTES*1.36/1000000" | bc -l)"
if [ "$BYTES" -gt 14700000 ]; then
  echo "  ::warning:: over the 20 MB-provider budget — GMX/Web.de/T-Online will reject the attachment."
fi
echo "✓ done"
