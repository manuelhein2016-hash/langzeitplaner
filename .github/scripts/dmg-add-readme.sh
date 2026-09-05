#!/bin/bash
# LZP-107 · E10 follow-up — put the unlock page ON the DMG that CI actually ships.
#
#   .github/scripts/dmg-add-readme.sh <built.dmg> [page.html]
#
# ═══════════════════════════════════════════════════════════════════════════════
# WHY THIS FILE EXISTS AT ALL — the answer is "Tauri cannot", and it was checked.
# ═══════════════════════════════════════════════════════════════════════════════
# The obvious fix is a config key. There is none, and this is measured against the
# published schema and the bundler source, not assumed:
#
#   · https://schema.tauri.app/config/2 · definitions.DmgConfig has exactly five
#     properties -- background, windowPosition, windowSize, appPosition,
#     applicationFolderPosition -- and `"additionalProperties": false`. Inventing a
#     sixth key does not get ignored; `cargo tauri build` rejects the config.
#   · bundle.resources and bundle.macOS.files both copy INTO the .app bundle
#     ($RESOURCES/, Contents/). Neither can reach the DMG root, which is the only
#     place a blocked user can double-click something.
#   · crates/tauri-bundler/src/bundle/macos/dmg/mod.rs builds the argument list for
#     its vendored create-dmg by hand and passes exactly: --volname, --icon,
#     --app-drop-link, --window-size, --hide-extension, and optionally --window-pos,
#     --background, --volicon, --eula. The vendored script DOES support
#     `--add-file <name> <path> <x> <y>` (bundle_dmg line 115) -- Tauri never passes
#     it, and exposes no way to add arguments.
#   · The script itself cannot be patched in place either: mod.rs does
#     `remove_dir_all(output_path)` and then rewrites bundle_dmg.sh from an
#     `include_str!`, every run.
#
# So the only production route is post-bundle surgery, which is what this does:
# decompress to read/write, add the page, reposition it, re-compress. That is
# option (a) of docs/v2/invitation-email.md § 8.2, minus one thing -- it does NOT
# re-run the whole layout. Tauri's .DS_Store already holds the window bounds, the
# background and both icon positions; a per-item `set position` adds a record to it
# instead of replacing it, so a Finder failure here degrades to "the page is on the
# DMG at a Finder-chosen spot" rather than "the styled window is gone".
#
# THE ORDER OF THE TRADE, stated once so nobody re-litigates it under pressure:
# a page in an awkward place beats a beautiful window with no instructions. The
# file being present is a hard failure; its position is a warning.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Must equal scripts/make-dmg.sh. tests/tier1/dmg-contents.test.js and
# .github/scripts/check-dmg-readme.mjs both fail if these drift, and
# check-dmg-readme.mjs also fails if the box they describe starts overlapping the
# app icon or the Applications folder. The measurement behind (304, 70) is written
# out in full in scripts/make-dmg.sh.
READ_X=304
READ_Y=70
READ_NAME="Bitte zuerst lesen.html"

DMG="${1:?usage: dmg-add-readme.sh <built.dmg> [page.html]}"
PAGE="${2:-$REPO/build/dmg/$READ_NAME}"

[ -f "$DMG" ] || { echo "::error title=No DMG to patch::$DMG does not exist."; exit 1; }
if [ ! -f "$PAGE" ]; then
  echo "::error title=Unlock page was never built::Expected $PAGE. It is produced by scripts/build-unlock-page.sh, which scripts/build-release-assets.sh calls from the 'Build release artwork' step. Either that step did not run, or build-unlock-page.sh took its 'src/js/firstrun.js does not exist' early exit. Do not ship the DMG without it: under decision D1 the app is unsigned, macOS refuses it on first launch, and LZP-106's unlock screen is inside the app she cannot open yet — this page is the only surface that reaches her first."
  exit 1
fi

VOLNAME="$(basename "$DMG" .dmg)"
VOLNAME="${VOLNAME%%_*}"   # Tauri names the file <product>_<version>_<arch>.dmg

WORK="$(mktemp -d)"
RW="$WORK/rw.dmg"
MNT="$WORK/mnt"
cleanup() { hdiutil detach "$MNT" -force >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "▸ decompressing $(basename "$DMG") to read/write"
hdiutil convert "$DMG" -format UDRW -o "$RW" >/dev/null

# Room for a ~20 KB page plus the .DS_Store rewrite Finder does when the window is
# reopened. A UDRW image sized exactly to its payload fails that write with a
# cryptic I/O error, which is the same trap scripts/make-dmg.sh documents at its
# own `+12000`. 12 MB here for the same reason, and for the same cost: none, the
# slack is squeezed straight back out by the UDZO convert at the end.
GROW_MB=$(( $(stat -f%z "$RW") / 1048576 + 12 ))
hdiutil resize -size "${GROW_MB}m" "$RW" >/dev/null

mkdir -p "$MNT"
hdiutil attach "$RW" -nobrowse -readwrite -mountpoint "$MNT" >/dev/null

# Sanity: we are editing the image we think we are. A silent no-op on the wrong
# file is exactly the failure this whole ticket is about.
if [ ! -d "$MNT/LangzeitPlaner.app" ]; then
  echo "::error title=Patched the wrong image::$DMG mounted without LangzeitPlaner.app at its root."
  exit 1
fi

echo "▸ adding \"$READ_NAME\""
cp "$PAGE" "$MNT/$READ_NAME"

echo "▸ positioning it at ($READ_X, $READ_Y)"
# One item, one record. The window is opened so Finder has somewhere to write the
# position to, and closed so it flushes. Everything else in the .DS_Store —
# bounds, background, the two positions Tauri set — is left alone on purpose.
LAYOUT_OK=1
osascript <<APPLESCRIPT >/dev/null 2>&1 || LAYOUT_OK=0
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set position of item "$READ_NAME" of container window to {$READ_X, $READ_Y}
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
if [ "$LAYOUT_OK" = 1 ]; then
  echo "  positioned"
else
  echo "::warning title=Read-me icon is unpositioned::Finder refused the Apple event (-1743 on a runner with no usable Finder session), so \"$READ_NAME\" is on the DMG but will land wherever Finder puts it — possibly on the drag arrow. The page is there and readable, which is the part that matters; the window is cosmetically worse. If the 'DMG window was never laid out' gate below passed, Finder DID work for Tauri and this failing is a real regression worth reading the log for."
fi

sync
hdiutil detach "$MNT" -quiet
trap 'rm -rf "$WORK"' EXIT

echo "▸ re-compressing"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$WORK/out.dmg" >/dev/null
mv "$WORK/out.dmg" "$DMG"

# Tauri signs the DMG itself when a real Developer ID is configured (dmg/mod.rs
# skips it for the ad-hoc identity "-"). Rewriting the image invalidates that
# signature, so put it back. Under D1 this branch is dead — the identity IS "-" —
# and it exists so that turning signing on later does not quietly ship a DMG whose
# signature stopped matching its contents.
IDENT="${APPLE_SIGNING_IDENTITY:-}"
if [ -n "$IDENT" ] && [ "$IDENT" != "-" ]; then
  echo "▸ re-signing the rewritten image as '$IDENT'"
  # `--options runtime --timestamp` is the PO's hand incantation of 2026-09-05,
  # the one that ended in `accepted / source=Notarized Developer ID`, and both
  # flags are load-bearing at the NEXT step rather than at this one: Apple
  # refuses to notarize a submission whose signature carries no secure timestamp,
  # and the hardened-runtime flag is what the notarization service checks for
  # before it will issue a ticket at all. Signing without them produces a valid
  # signature and an unnotarizable file — which is precisely the shape of failure
  # this whole path exists to make impossible.
  codesign --force --options runtime --timestamp --sign "$IDENT" "$DMG"
  codesign --verify --verbose=2 "$DMG" 2>&1 | sed 's/^/  /'

  # ██ INVERTED 2026-09-05 ██  What this line emitted, verbatim:
  #
  #   > ::warning title=DMG notarization staple::The disk image was rewritten
  #   > after Tauri built it. If this release notarizes and staples the DMG (not
  #   > just the .app), that staple must be produced AFTER this step — see
  #   > docs/v2/RELEASE.md 'Turning signing on'. UNVERIFIED: signing has never
  #   > been switched on.
  #
  # The warning was correct, it was the only place in the tree that knew this,
  # and it was addressed to nobody: a warning in a step that had never run,
  # naming a staple that did not exist anywhere in the repository. The `mv` four
  # lines above replaces the file Tauri built, so any ticket Tauri stapled to the
  # old image is now in $TMPDIR; `codesign --force --sign` puts a signature back
  # and CANNOT put a staple back. The instruction is now executed instead of
  # printed — `release.yml` step 9b ("Notarize the rewritten DMG, staple it, and
  # prove both tickets") runs immediately after this script and hard-fails if
  # either `stapler validate` says no. This echo is what makes that dependency
  # legible in the log, and `check-release-config.mjs` (rows N-ORDER / N-STAPLE /
  # N-RUNTIME) fails the pre-flight if the step is ever removed or reordered.
  echo "  ▸ this image now has NO notarization ticket, by construction."
  echo "    release.yml step 9b submits it to notarytool and staples it, after this script and"
  echo "    before every gate that inspects the DMG. If that step is gone, the release is lying."
fi

# ── the file is on the image, proved by mounting the finished artifact ─────────
# Not "we copied it": copied-then-lost-in-the-convert is a real shape of this bug.
VERIFY="$WORK/verify"
mkdir -p "$VERIFY"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$VERIFY" >/dev/null
FOUND=0
[ -f "$VERIFY/$READ_NAME" ] && FOUND=1
BYTES=0
[ "$FOUND" = 1 ] && BYTES=$(stat -f%z "$VERIFY/$READ_NAME")
ls -la "$VERIFY" | sed 's/^/  /'
hdiutil detach "$VERIFY" -quiet
if [ "$FOUND" != 1 ]; then
  echo "::error title=Read-me did not survive the re-compress::\"$READ_NAME\" was copied onto the read/write image but is not on the finished $DMG. The UDZO convert or the detach lost it."
  exit 1
fi
printf '✓ "%s" is on the DMG (%d bytes)\n' "$READ_NAME" "$BYTES"
