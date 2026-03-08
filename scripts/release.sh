#!/usr/bin/env bash
set -euo pipefail

REPO="amagarian/wrapkit"
KEY_PATH="$HOME/.tauri/wrapkit.key"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Read version from tauri.conf.json
VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v${VERSION}"

echo "==> Releasing Wrapkit ${TAG}"

# Ensure signing key exists
if [ ! -f "$KEY_PATH" ]; then
  echo "ERROR: Signing key not found at $KEY_PATH"
  echo "Run: npm run tauri signer generate -- -w $KEY_PATH"
  exit 1
fi

# Export signing env vars
export TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# Build
echo "==> Building..."
env -u CI npx tauri build

# Locate build artifacts
CARGO_TARGET=$(find /var/folders -path "*/cursor-sandbox-cache/*/cargo-target/release/bundle" -type d 2>/dev/null | head -1)
if [ -z "$CARGO_TARGET" ]; then
  CARGO_TARGET="$PROJECT_DIR/src-tauri/target/release/bundle"
fi

APP_TAR_GZ="$CARGO_TARGET/macos/Wrapkit.app.tar.gz"
APP_SIG="$CARGO_TARGET/macos/Wrapkit.app.tar.gz.sig"
DMG="$CARGO_TARGET/dmg/Wrapkit_${VERSION}_aarch64.dmg"

for f in "$APP_TAR_GZ" "$APP_SIG" "$DMG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Expected artifact not found: $f"
    echo "Looking in: $CARGO_TARGET"
    ls -R "$CARGO_TARGET" 2>/dev/null || true
    exit 1
  fi
done

echo "==> Found build artifacts"

# Read signature
SIGNATURE=$(cat "$APP_SIG")

# Build latest.json
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

# Copy DMG with clean name
cp "$DMG" /tmp/Wrapkit.dmg

# Create GitHub release
echo "==> Creating GitHub release ${TAG}..."
gh release create "$TAG" \
  --repo "$REPO" \
  --title "Wrapkit ${TAG}" \
  --notes "Wrapkit ${TAG}" \
  "$APP_TAR_GZ" \
  "$APP_SIG" \
  /tmp/latest.json \
  /tmp/Wrapkit.dmg

echo ""
echo "==> Release ${TAG} published!"
echo "    https://github.com/${REPO}/releases/tag/${TAG}"
