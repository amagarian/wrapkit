#!/usr/bin/env bash
set -euo pipefail

REPO="amagarian/wrapkit"
KEY_PATH="$HOME/.tauri/wrapkit.key"
SIGNING_IDENTITY="Developer ID Application: Aiden Magarian (NF6D29P3HJ)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v${VERSION}"

echo "==> Releasing Wrapkit ${TAG}"

if [ ! -f "$KEY_PATH" ]; then
  echo "ERROR: Signing key not found at $KEY_PATH"
  echo "Run: npm run tauri signer generate -- -w $KEY_PATH"
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# Temporarily disable code signing in tauri.conf.json (macOS provenance xattrs break codesign)
python3 -c "
import json
c = json.load(open('src-tauri/tauri.conf.json'))
c['bundle']['macOS']['signingIdentity'] = None
json.dump(c, open('src-tauri/tauri.conf.json','w'), indent=2)
"

# Eject any stale DMG volumes
for vol in /Volumes/dmg.*; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done

echo "==> Building (without Tauri signing)..."
env -u CI npx tauri build

# Restore signing identity
python3 -c "
import json
c = json.load(open('src-tauri/tauri.conf.json'))
c['bundle']['macOS']['signingIdentity'] = '${SIGNING_IDENTITY}'
json.dump(c, open('src-tauri/tauri.conf.json','w'), indent=2)
"

BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle"
APP_DIR="$BUNDLE_DIR/macos/Wrapkit.app"
DMG="$BUNDLE_DIR/dmg/Wrapkit_${VERSION}_aarch64.dmg"

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: Wrapkit.app not found at $APP_DIR"
  exit 1
fi

echo "==> Stripping macOS extended attributes & signing..."
xattr -d com.apple.FinderInfo "$APP_DIR" 2>/dev/null || true
xattr -d "com.apple.fileprovider.fpfs#P" "$APP_DIR" 2>/dev/null || true
codesign --force --deep --sign "$SIGNING_IDENTITY" "$APP_DIR"
echo "==> Code signing succeeded"

# Recreate the updater tar.gz from the freshly signed app
echo "==> Creating updater archive..."
cd "$BUNDLE_DIR/macos"
tar czf Wrapkit.app.tar.gz Wrapkit.app
cd "$PROJECT_DIR"

# Sign the updater archive
npx tauri signer sign "$BUNDLE_DIR/macos/Wrapkit.app.tar.gz"

APP_TAR_GZ="$BUNDLE_DIR/macos/Wrapkit.app.tar.gz"
APP_SIG="$BUNDLE_DIR/macos/Wrapkit.app.tar.gz.sig"

for f in "$APP_TAR_GZ" "$APP_SIG" "$DMG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Expected artifact not found: $f"
    exit 1
  fi
done

echo "==> Found build artifacts"

SIGNATURE=$(cat "$APP_SIG")
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > /tmp/latest.json <<ENDJSON
{
  "version": "${VERSION}",
  "notes": "Wrapkit ${TAG}",
  "pub_date": "${NOW}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/Wrapkit.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/Wrapkit.app.tar.gz"
    }
  }
}
ENDJSON

echo "==> Created latest.json"
cat /tmp/latest.json

cp "$DMG" /tmp/Wrapkit.dmg

echo "==> Creating GitHub release ${TAG}..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "Wrapkit ${TAG}" \
  --notes "Wrapkit ${TAG}" \
  "$APP_TAR_GZ" \
  "$APP_SIG" \
  /tmp/latest.json \
  /tmp/Wrapkit.dmg

cp /tmp/Wrapkit.dmg ~/Desktop/Wrapkit.dmg

echo ""
echo "==> Release ${TAG} published!"
echo "    https://github.com/${REPO}/releases/tag/${TAG}"
echo "    DMG copied to ~/Desktop/Wrapkit.dmg"
