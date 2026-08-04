#!/bin/sh
# Move the freshly built app into /Applications and pin it to the Dock.
# Run after `bun run package`, or use `bun run install-app` to do both.
set -e

APP="release/mac-arm64/Aliax.app"
DEST="/Applications/Aliax.app"
[ -d "$APP" ] || { echo "no build at $APP — run: bun run package" >&2; exit 1; }

# Quit a running copy first; replacing a bundle under a live process leaves it
# in a half-swapped state that macOS refuses to launch.
osascript -e 'tell application "Aliax" to quit' 2>/dev/null || true
pkill -f "/Applications/Aliax.app/Contents/MacOS/Aliax" 2>/dev/null || true
sleep 1

rm -rf "$DEST"
cp -R "$APP" "$DEST"
# Apple Silicon refuses to launch a bundle with no signature at all, and signing
# in place (after the copy) keeps the identity tied to its final path. With a
# Developer ID present, use it and add the update feed: the updater refuses to
# apply a Developer ID release over an ad-hoc-signed install, so only a properly
# signed local copy is allowed to self-update.
IDENTITY=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
if [ -n "$IDENTITY" ]; then
  codesign --force --deep --sign "$IDENTITY" "$DEST"
  cat > "$DEST/Contents/Resources/app-update.yml" <<'YML'
provider: github
owner: LandonDev
repo: aliax-releases
YML
  echo "signed as $IDENTITY (self-update enabled)"
else
  codesign --force --deep --sign - "$DEST" 2>/dev/null
  echo "ad-hoc signed (no Developer ID yet — self-update stays off)"
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST"

# Pin to the Dock, but only once — re-running should not stack duplicates.
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "/Applications/Aliax.app"; then
  defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$DEST</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
  killall Dock
  echo "pinned Aliax to the Dock"
else
  echo "Aliax already in the Dock"
fi

echo "installed $DEST"
