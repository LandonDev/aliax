#!/bin/sh
# Cut a release: bump the version, build a signed + notarized zip and dmg, push
# them to the public feed repo, and tag the source. Users see the Update button
# on their next check (app launch, or every 4 hours).
#
# One-time setup this script checks for:
#   1. A "Developer ID Application" certificate in the Keychain
#      (developer.apple.com -> Certificates -> + -> Developer ID Application).
#   2. Notary credentials stored as profile "aliax" — see the command it prints.
set -e
cd "$(dirname "$0")/.."

BUMP="${1:-patch}"
FEED_REPO="LandonDev/aliax-releases"

IDENTITY=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')
[ -n "$IDENTITY" ] || {
  echo "no Developer ID Application certificate in the Keychain." >&2
  echo "developer.apple.com/account/resources/certificates/add -> Developer ID Application" >&2
  exit 1
}
# Read the team from the certificate itself. The Developer ID cert can belong to
# a different team than the Apple Development one, and a wrong --team-id makes
# notarization fail with an unhelpful error.
TEAM=$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')
xcrun notarytool history --keychain-profile aliax >/dev/null 2>&1 || {
  echo "no notary credentials stored. Create an app-specific password at" >&2
  echo "account.apple.com -> App-Specific Passwords, then run:" >&2
  echo "  xcrun notarytool store-credentials aliax --apple-id <your-apple-id> --team-id $TEAM --password <app-specific-password>" >&2
  exit 1
}
GH_TOKEN=$(gh auth token) || { echo "gh is not signed in" >&2; exit 1; }
export GH_TOKEN
export APPLE_KEYCHAIN_PROFILE=aliax

# Release what is committed, so the tag and the artifact always match.
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty — commit first" >&2; exit 1; }

npm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "releasing $VERSION signed as $IDENTITY (team $TEAM)"

bun run build
# electron-builder picks the certificate itself and rejects the full
# "Developer ID Application: ..." string, so hand it just the name and team.
bunx electron-builder --mac \
  -c.mac.identity="${IDENTITY#Developer ID Application: }" \
  -c.mac.notarize=true \
  -c.mac.target=zip -c.mac.target=dmg \
  --publish always

# electron-builder leaves the release as a draft and, in practice, uploads only
# the blockmap — so finish the job here. Without latest-mac.yml and the zip the
# feed exists but no app can ever see an update. The unversioned dmg copy gives
# the README a download link that never goes stale.
echo "uploading artifacts"
cp "release/Aliax-$VERSION-arm64.dmg" "release/Aliax-arm64.dmg"
gh release upload "v$VERSION" --repo "$FEED_REPO" --clobber \
  "release/Aliax-$VERSION-arm64-mac.zip" \
  "release/Aliax-$VERSION-arm64.dmg" \
  "release/Aliax-arm64.dmg" \
  release/latest-mac.yml

# Title and notes from the commits since the last release.
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)
NOTES=$(git log --pretty='- %s' ${PREV_TAG:+$PREV_TAG..}HEAD)
gh release edit "v$VERSION" --repo "$FEED_REPO" --draft=false \
  --title "Aliax $VERSION" --notes "$NOTES" >/dev/null

# electron-builder's two publish passes leave a second, stray draft under the
# same tag; delete every draft still standing once the real release is live.
gh api "repos/$FEED_REPO/releases" \
  --jq ".[] | select(.draft and .tag_name==\"v$VERSION\") | .id" |
  while read -r id; do gh api -X DELETE "repos/$FEED_REPO/releases/$id" >/dev/null; done

# Verify what users will actually fetch, rather than trusting the upload.
sleep 5
FEED_VERSION=$(curl -sL "https://github.com/$FEED_REPO/releases/latest/download/latest-mac.yml" | sed -n 's/^version: //p')
[ "$FEED_VERSION" = "$VERSION" ] || {
  echo "feed still serves '$FEED_VERSION', expected '$VERSION'" >&2
  exit 1
}

git commit -aqm "Release v$VERSION"
git tag "v$VERSION"
git push -q && git push -q --tags

echo "published $VERSION — feed verified at github.com/$FEED_REPO"
