#!/usr/bin/env bash
# Build the unsigned Canvas.app (Wails v3 shell + bun-compiled service) into desktop/build/.
#   desktop/build.sh            full build
#   SKIP_WEB=1 desktop/build.sh  reuse frontend/dist
set -euo pipefail
cd "$(dirname "$0")/.."
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.25.5}"   # Wails v3 needs Go ≥ 1.25; mise has 1.23 (auto-downloads)
OUT=desktop/build
APP="$OUT/Canvas.app"
mkdir -p "$OUT"
t() { local s=$SECONDS; "$@"; echo "  ($((SECONDS - s)) s) $1 $2" >&2; }

[ -n "${SKIP_WEB:-}" ] || t npx vite build --logLevel warn --outDir desktop/frontend/dist --emptyOutDir
t bun build --compile --minify desktop/sidecar/main.ts --outfile "$OUT/canvas-bridge" >/dev/null
(cd desktop && t env CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=12.0 CGO_CFLAGS=-mmacosx-version-min=12.0 CGO_LDFLAGS=-mmacosx-version-min=12.0 \
  go build -tags production -trimpath -buildvcs=false -ldflags="-w -s" -o build/Canvas .)

/bin/rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/Canvas" "$OUT/canvas-bridge" "$APP/Contents/MacOS/"
cp desktop/assets/Info.plist "$APP/Contents/Info.plist"
cp desktop/assets/icons.icns "$APP/Contents/Resources/icons.icns"
# register with LaunchServices so .canvas files open with it (no signing, no install)
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
du -sh "$APP" "$APP/Contents/MacOS/"* | sed 's/^/  /'
