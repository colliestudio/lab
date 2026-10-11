#!/usr/bin/env bash
# Scorecard measurements for the Wails spike (macOS).
#   desktop/measure.sh mem <Canvas pid>        footprint + RSS of the app, its service and its WebKit processes
#   desktop/measure.sh cold <file.canvas> [n]  launch → "board visible" (n runs, quits in between)
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)/build/Canvas.app"

webkit_since() { # WebKit XPC processes started at or after the given epoch second
  ps -A -o pid=,lstart=,command= | grep -E 'com\.apple\.WebKit\.(WebContent|GPU|Networking)' | grep -v grep |
    while read -r pid d1 d2 d3 d4 d5 rest; do
      s=$(date -j -f "%a %b %d %T %Y" "$d1 $d2 $d3 $d4 $d5" +%s)
      [ "$s" -ge "$1" ] && echo "$pid ${rest##*/}"
    done
}

mem() {
  local app=$1
  local start; start=$(date -j -f "%a %b %d %T %Y" "$(ps -o lstart= -p "$app" | xargs)" +%s)
  { echo "$app Canvas"; pgrep -P "$app" | while read -r c; do echo "$c $(ps -o comm= -p "$c" | xargs basename)"; done; webkit_since "$start"; } |
    while read -r pid name; do
      fp=$(footprint -p "$pid" 2>/dev/null | awk '/phys_footprint:/ {print $2, $3; exit}')
      rss=$(ps -o rss= -p "$pid" | awk '{printf "%.0f MB", $1/1024}')
      printf "%-8s %-40s footprint %-8s rss %s\n" "$pid" "$name" "$fp" "$rss"
    done | tee /dev/stderr | awk '{ v=$4; u=$5; if (u=="KB") v/=1024; if (u=="GB") v*=1024; t+=v; r+=$7 } END { printf "TOTAL footprint %.0f MB, rss %.0f MB\n", t, r }'
  echo "(WebKit processes attributed by start time ≥ app start; make sure no other WebKit app started meanwhile)"
}

cold() {
  local file=$1 n=${2:-5} home; home=$(mktemp -d)
  for i in $(seq "$n"); do
    : > "$home/canvas.log"
    t0=$(python3 -c 'import time; print(int(time.time()*1000))')
    CANVAS_HOME="$home" "$APP/Contents/MacOS/Canvas" "$file" >/dev/null 2>&1 &
    pid=$!
    for _ in $(seq 200); do grep -q 'board visible' "$home/canvas.log" 2>/dev/null && break; sleep 0.05; done
    at=$(grep -o 'at_unix_ms=[0-9]*' "$home/canvas.log" | head -1 | cut -d= -f2)
    inner=$(grep -o 'process start→visible [0-9]* ms' "$home/canvas.log" | head -1)
    echo "run $i: launch→visible $((at - t0)) ms ($inner)"
    kill "$pid"; wait "$pid" 2>/dev/null || true
    sleep 1
  done
}

"$@"
