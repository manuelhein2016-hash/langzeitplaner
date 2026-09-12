#!/bin/bash
# LZP-107 — generate every release image from committed SVG sources.
#
#   ./scripts/build-release-assets.sh [--verbose]
#
# Produces (all gitignored; no binary blob is ever committed without its source):
#   src-tauri/icons/icon.icns          the app icon, WITH transparency
#   src-tauri/icons/*.png              the PNG sizes Tauri's bundler expects
#   src-tauri/dmg/background.png       DMG window background, 1x  (660x420)
#   src-tauri/dmg/background@2x.png    the same at 2x
#   src-tauri/dmg/background.tiff      both of the above in one hidpi TIFF  <- what tauri.conf uses
#   build/email/LangzeitPlaner-Installation.png       the invitation-e-mail screenshot (LZP-108)
#   build/email/LangzeitPlaner-Installation@2x.png
#
# Toolchain: swiftc + sips + tiffutil + iconutil. All ship with macOS; none is an npm
# dependency. Nothing here needs Rust, so it runs and is verifiable on the dev machine
# as well as on a GitHub Actions macOS runner.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
VERBOSE=0; [[ "${1:-}" == "--verbose" ]] && VERBOSE=1
say() { echo "▸ $*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 0. the renderer ────────────────────────────────────────────────────────────
# Built into a temp dir, never committed. macOS 13+ decodes SVG natively through
# NSImage; render-svg fails loudly rather than silently producing a blank page if
# that ever stops being true.
say "compiling scripts/render-svg.swift"
RENDER="$WORK/render-svg"
swiftc -O -o "$RENDER" scripts/render-svg.swift -framework AppKit

# ── 1a. the MENU-BAR glyph, from assets/tray-glyph.svg ────────────────────────
# 13.2 — a template image is rendered from its ALPHA alone, so the colour app icon
# used as one arrives in the menu bar as a solid blob. This is the real glyph, at
# the 22pt menu-bar size and its @2x. `lib.rs` embeds them with include_bytes!,
# which is why a missing file has to be a loud build failure and not a blank icon.
say "menu-bar glyph from assets/tray-glyph.svg"
mkdir -p src-tauri/icons
"$RENDER" src-tauri/icons/tray-glyph.png 22 22 --svg assets/tray-glyph.svg 0 0 22 22 0 0 \
  | { [ "$VERBOSE" = 1 ] && cat || cat >/dev/null; }
"$RENDER" src-tauri/icons/tray-glyph@2x.png 44 44 --svg assets/tray-glyph.svg 0 0 44 44 0 0 \
  | { [ "$VERBOSE" = 1 ] && cat || cat >/dev/null; }
for f in src-tauri/icons/tray-glyph.png src-tauri/icons/tray-glyph@2x.png; do
  [ -s "$f" ] || { echo "✗ $f was not produced" >&2; exit 1; }
done

# ── 1. app icon, from assets/icon.svg ──────────────────────────────────────────
# NOT from assets/icon-1024.png: that file was flattened onto white, so every size
# derived from it gives the app a white square instead of a rounded icon. Rendering
# the SVG keeps the alpha channel. See docs/v2/RELEASE.md.
say "icon set from assets/icon.svg"
ICONSET="$WORK/LangzeitPlaner.iconset"
mkdir -p "$ICONSET" src-tauri/icons
while read -r name size; do
  "$RENDER" "$ICONSET/$name" "$size" "$size" --svg assets/icon.svg 0 0 "$size" "$size" 0 0 \
    | { [ "$VERBOSE" = 1 ] && cat || cat >/dev/null; }
done <<'SIZES'
icon_16x16.png 16
icon_16x16@2x.png 32
icon_32x32.png 32
icon_32x32@2x.png 64
icon_128x128.png 128
icon_128x128@2x.png 256
icon_256x256.png 256
icon_256x256@2x.png 512
icon_512x512.png 512
icon_512x512@2x.png 1024
SIZES
iconutil -c icns "$ICONSET" -o src-tauri/icons/icon.icns
# Tauri's macOS bundler reads icon.icns; the PNGs keep `tauri icon`-shaped tooling and
# any future Linux/Windows target happy without a second source of truth.
for s in 32 128 256 512; do
  "$RENDER" "src-tauri/icons/${s}x${s}.png" "$s" "$s" --svg assets/icon.svg 0 0 "$s" "$s" 0 0 >/dev/null
done
cp "$ICONSET/icon_128x128@2x.png" src-tauri/icons/128x128@2x.png
cp "$ICONSET/icon_512x512@2x.png" src-tauri/icons/icon.png

# ── 2. DMG background ──────────────────────────────────────────────────────────
# Geometry is pinned to tauri.conf.json > bundle.macOS.dmg.windowSize. If you change
# one, change the other; the CI step "DMG window geometry" fails when they disagree.
say "DMG background (660x420 and 2x)"
mkdir -p src-tauri/dmg
"$RENDER" src-tauri/dmg/background.png     660 420 --svg assets/dmg/background.svg 0 0 660 420 0 0
"$RENDER" src-tauri/dmg/background@2x.png 1320 840 --svg assets/dmg/background.svg 0 0 1320 840 0 0

# One TIFF carrying both representations is the only way Finder draws a background
# crisply on a Retina display: it picks the 2x rep and halves it. Handing Finder a
# bare 2x PNG makes a window twice the size of the art.
tiffutil -cathidpicheck src-tauri/dmg/background.png src-tauri/dmg/background@2x.png \
         -out src-tauri/dmg/background.tiff >/dev/null

# ── 3. the invitation-e-mail illustration (LZP-108) ────────────────────────────
# Composited from the SAME background source and the SAME icon positions the bundler
# uses, so the picture in the e-mail cannot drift away from the window Mom opens.
# The folder icon is the live system icon for /Applications, not a redrawn copy.
say "invitation-e-mail illustration"
mkdir -p build/email
compose() {           # compose <out> <scale>
  local out="$1" s="$2"
  "$RENDER" "$out" $((740*s)) $((520*s)) \
    --fill '#eef1f6' \
    --svg  assets/dmg/window-back.svg   0            0            $((740*s)) $((520*s)) 0 0 \
    --svg  assets/dmg/background.svg    $((40*s))    $((58*s))    $((660*s)) $((420*s)) 0 $((11*s)) \
    --svg  assets/icon.svg              $((146*s))   $((164*s))   $((128*s)) $((128*s)) 0 0 \
    --appicon /Applications             $((466*s))   $((164*s))   $((128*s)) $((128*s)) 0 0 \
    --svg  assets/dmg/window-front.svg  0            0            $((740*s)) $((520*s)) 0 0
}
compose build/email/LangzeitPlaner-Installation.png 1
compose build/email/LangzeitPlaner-Installation@2x.png 2

# ── 3b. the e-mail itself, assembled next to its picture (LZP-108) ────────────
# The four authored files live in docs/v2/email/. They are copied here so the <img>
# src (a bare relative filename -- no URL, no tracking pixel) actually resolves: open
# build/email/invitation.de.html in a browser, select all, copy, paste into Mail.
say "invitation e-mail"
cp docs/v2/email/invitation.de.txt  docs/v2/email/invitation.en.txt \
   docs/v2/email/invitation.de.html docs/v2/email/invitation.en.html build/email/

# Self-contained previews. Same HTML with the PNG inlined as a data: URI, so the
# e-mail can be proof-read in a browser (or sent to someone for review) without the
# image file travelling beside it. These are for CHECKING ONLY -- do not paste a
# preview into a mail client: Gmail and several others refuse to display data: images,
# so the recipient would see nothing. Paste invitation.<lang>.html instead.
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const png = readFileSync("build/email/LangzeitPlaner-Installation.png").toString("base64");
  for (const lang of ["de", "en"]) {
    const f = `build/email/invitation.${lang}.html`;
    writeFileSync(f.replace(".html", ".preview.html"),
      readFileSync(f, "utf8").replace("src=\"LangzeitPlaner-Installation.png\"",
                                      `src="data:image/png;base64,${png}"`));
  }
'

# ── 3c. the standalone unlock page (LZP-106's renderUnlockDocument) ───────────
# Built here so it cannot rot, even though nothing consumes it yet -- see
# docs/v2/invitation-email.md § 8.2 for why it is not on the DMG. Skips itself
# cleanly if src/js/firstrun.js is not present.
say "unlock page"
./scripts/build-unlock-page.sh

# ── 4. what it all weighs ──────────────────────────────────────────────────────
echo
echo "  bytes  file"
find src-tauri/icons src-tauri/dmg build/email build/dmg -type f -not -name "*.dmg" \
  | sort | while read -r f; do printf "%7d  %s\n" "$(stat -f%z "$f")" "$f"; done
echo
printf "  icons  %s\n  dmg    %s\n  email  %s  (not shipped in the app)\n" \
  "$(du -sh src-tauri/icons | cut -f1)" "$(du -sh src-tauri/dmg | cut -f1)" "$(du -sh build/email | cut -f1)"
echo "✓ release assets built"
