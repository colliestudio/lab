#!/bin/sh
# Scorecard measurements for the packaged app (macOS). Usage: scripts/measure.sh <scratch-dir>
# Uses its own userData (CANVAS_USER_DATA) so it never touches the real app's settings.
set -e
D=${1:?scratch dir}; mkdir -p "$D/ud"
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP="$HERE/dist/mac-arm64/Canvas.app"
C="$APP/Contents"
printf '{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":260,"height":90,"text":"Plain note"},{"id":"b","type":"text","x":0,"y":200,"width":260,"height":90,"text":"Another"}],"edges":[]}' > "$D/plain.canvas"
endpoint() { python3 -c "import json;print(json.load(open('$D/ud/endpoint.json'))['$1'])"; }
metrics() { curl -s "127.0.0.1:$(endpoint port)/app/metrics" | python3 -c "import json,sys;d=json.load(sys.stdin);print(' ', d['totalMB'],'MB total;', ', '.join(f\"{p['type']}{'('+p.get('name','')+')' if p.get('name') else ''} {p['MB']}\" for p in d['processes']), '| windows', len(d['windows']), 'views', d['agentViews'])"; }
now() { python3 -c 'import time;print(int(time.time()*1000))'; }

echo "size: $(du -sh "$APP" | cut -f1) app, $(du -sh "$C/Resources/app.asar" | cut -f1) asar"
for i in 1 2 3; do
  rm -f "$D/ud/logs/main.log"
  T=$(now); open -n -a "$APP" --env CANVAS_USER_DATA="$D/ud" --env CANVAS_NO_DIALOG=1 "$D/plain.canvas"
  for j in $(seq 1 100); do grep -q "visible in" "$D/ud/logs/main.log" 2>/dev/null && break; sleep 0.05; done
  V=$(grep "visible in" "$D/ud/logs/main.log" | tail -1)
  VT=$(python3 -c "import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].split()[0].replace('Z','+00:00')).timestamp()*1000))" "$V")
  echo "start $i: open → board visible $((VT - T)) ms (${V#* window: })"
  [ $i = 3 ] || { sleep 2; kill "$(endpoint pid)"; sleep 2; }
done
sleep 25; echo "idle, 1 window:"; metrics
NO_EMBED=1 HOLD_MS=40000 CANVAS_EXE="$C/MacOS/Canvas" CANVAS_SHIM="$C/Resources/app.asar.unpacked/build/shim.mjs" CANVAS_USER_DATA="$D/ud" \
  node "$HERE/scripts/mcp-smoke.mjs" "$D" "$D/plain.canvas" > "$D/hold.log" 2>&1 &
sleep 25; echo "idle, 1 window + 1 hidden agent view:"; metrics
grep screenshot "$D/hold.log" | sed 's/^/  /'
wait
kill "$(endpoint pid)"
