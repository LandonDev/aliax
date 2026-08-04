#!/bin/sh
# Brand the dev Electron bundle so the Dock says "Aliax" with our icon.
# ONLY CFBundleDisplayName — CFBundleName feeds the runtime app name, which
# safeStorage keys the vault's Keychain entry by (see CLAUDE.md invariant 17).
# Re-run after every install; electron re-extracts its bundle.
APP=node_modules/electron/dist/Electron.app
[ -d "$APP" ] || exit 0
plutil -replace CFBundleDisplayName -string "Aliax" "$APP/Contents/Info.plist"
[ -f build/icon.icns ] && cp build/icon.icns "$APP/Contents/Resources/electron.icns"
codesign --force --sign - "$APP" 2>/dev/null
exit 0
