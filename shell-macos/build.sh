#!/bin/bash
# Hand-built .app bundle — no installer, no packager. Rebuild any time with:
#   ./shell-macos/build.sh
# Pass --dest <dir> to put the bundle somewhere other than /Applications.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="/Applications"
[[ "${1:-}" == "--dest" ]] && DEST="$2"

APP="$DEST/LangzeitPlaner.app"
C="$APP/Contents"

echo "▸ building icon"
# Rendered from assets/icon.svg, NOT from assets/icon-1024.png: that PNG was flattened
# onto an opaque white background, so every size derived from it gives the app a white
# square in the Dock, in Finder and in the DMG window. The SVG keeps its alpha channel.
# Falls back to the old path if this macOS has no SVG rasteriser (needs 13+).
ICONSET="$(mktemp -d)/LangzeitPlaner.iconset"
mkdir -p "$ICONSET"
RENDER="$(mktemp -d)/render-svg"
if swiftc -O -o "$RENDER" "$REPO/scripts/render-svg.swift" -framework AppKit 2>/dev/null \
   && "$RENDER" "$ICONSET/probe.png" 16 16 --svg "$REPO/assets/icon.svg" 0 0 16 16 0 0 >/dev/null 2>&1; then
  rm -f "$ICONSET/probe.png"
  ICON_SRC="svg"
else
  echo "  (no SVG rasteriser — falling back to assets/icon-1024.png, icon will be a white square)"
  ICON_SRC="png"
fi
while read -r name size; do
  if [ "$ICON_SRC" = svg ]; then
    "$RENDER" "$ICONSET/$name" "$size" "$size" --svg "$REPO/assets/icon.svg" 0 0 "$size" "$size" 0 0 >/dev/null
  else
    sips -z "$size" "$size" "$REPO/assets/icon-1024.png" --out "$ICONSET/$name" >/dev/null
  fi
done <<'EOF'
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
EOF

echo "▸ assembling bundle at $APP"
rm -rf "$APP"
mkdir -p "$C/MacOS" "$C/Resources/web"

iconutil -c icns "$ICONSET" -o "$C/Resources/AppIcon.icns"

cp "$REPO/index.html" "$C/Resources/web/"
cp -R "$REPO/src" "$C/Resources/web/"

cat > "$C/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LangzeitPlaner</string>
  <key>CFBundleDisplayName</key><string>LangzeitPlaner</string>
  <key>CFBundleIdentifier</key><string>org.langzeitplaner.app</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>LangzeitPlaner</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Local-only. No network access.</string>
</dict>
</plist>
PLIST

plutil -lint "$C/Info.plist"

echo "▸ compiling"
swiftc -O -o "$C/MacOS/LangzeitPlaner" "$REPO/shell-macos/main.swift" \
  -framework Cocoa -framework WebKit
chmod +x "$C/MacOS/LangzeitPlaner"

# Ad-hoc signature: keeps macOS from treating each rebuild as a new, untrusted
# binary. Not a Developer ID signature — first launch may still need
# right-click → Open (spec §4, Gatekeeper note).
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "  (codesign skipped)"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "✓ $APP"
