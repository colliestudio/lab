#!/usr/bin/env bash
# Dev loop: vite with HMR on 127.0.0.1:5272, the service from source (tsx), a debug Go build of the
# shell that proxies its assets to vite (Wails FRONTEND_DEVSERVER_URL). Edit src/ → windows hot-reload;
# edit desktop/sidecar → quit and rerun (or kill the service: the shell restarts it from source).
#   desktop/dev.sh [file.canvas …]
set -euo pipefail
cd "$(dirname "$0")/.."
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.25.5}"
[ -d desktop/frontend/dist ] || npx vite build --logLevel warn --outDir desktop/frontend/dist
npx vite --port 5272 --strictPort --host 127.0.0.1 --logLevel warn &
VITE=$!
trap 'kill $VITE 2>/dev/null' EXIT
(cd desktop && time go build -o build/Canvas-dev .) 2>&1 | grep -v 'ld: warning' || true
FRONTEND_DEVSERVER_URL=http://127.0.0.1:5272 \
CANVAS_SIDECAR="$PWD/node_modules/.bin/tsx $PWD/desktop/sidecar/main.ts" \
CANVAS_DEBUG=1 CANVAS_HOME="${CANVAS_HOME:-$PWD/desktop/build/dev-home}" \
  desktop/build/Canvas-dev "$@"
