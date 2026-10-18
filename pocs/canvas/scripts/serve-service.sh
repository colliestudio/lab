#!/usr/bin/env bash
# The always-on canvas serve (launchd agent on the Mini): releases, upgrades, rollback.
#
#   release [ref]   tag the ref (default poc), export it to <home>/releases/<tag>, build, switch <home>/current
#                   to it and (re)start the service. This is the whole upgrade. If the new release does not
#                   answer /api/info and list the data folder (GET /api/boards; macOS can block a process from
#                   the folder without Full Disk Access) within CANVAS_SERVE_WAIT seconds, current goes back to the previous one (exit 1).
#   rollback [tag]  switch back to the release before the current one (or the named tag) and restart
#   install         (re)write the launchd agent for the current release and start it
#   uninstall       stop and remove the agent; releases stay
#   status          current release, launchd state, what the server answers, releases
#
# macOS only (launchd); the git and file handling also runs on Linux, which is how the tests run there. Everything is overridable with CANVAS_SERVE_* (tests and QA use scratch values; see the defaults below).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${CANVAS_SERVE_REPO:-$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)}"
# Where the canvas package sits inside REPO: empty when it is the repo root, "pocs/canvas" in the lab monorepo.
# A release exports only that directory. Only meaningful when this script lives in REPO (a scratch REPO elsewhere: root).
SUBDIR=""
if [ "$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)" = "$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" ]; then
  SUBDIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-prefix)"
  SUBDIR="${SUBDIR%/}"
fi
REF="${CANVAS_SERVE_REF:-poc}"
PREFIX="${CANVAS_SERVE_TAG_PREFIX:-serve-}"
SHOME="${CANVAS_SERVE_HOME:-$HOME/code/canvas-serve}"
LABEL="${CANVAS_SERVE_LABEL:-studio.collie.canvas-serve}"
DATA="${CANVAS_SERVE_DATA:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Collie Canvas}"
PORT="${CANVAS_SERVE_PORT:-5310}"
HOST_NAMES="${CANVAS_SERVE_HOST_NAMES-mini.internal}"
AGENTS="${CANVAS_SERVE_AGENTS:-$HOME/Library/LaunchAgents}"
LOGS="${CANVAS_SERVE_LOGS:-$HOME/Library/Logs/canvas-serve}"
LAUNCHCTL="${CANVAS_SERVE_LAUNCHCTL:-launchctl}"
WAIT="${CANVAS_SERVE_WAIT:-30}"
LOG_MAX="${CANVAS_SERVE_LOG_MAX:-5242880}"
DOMAIN="gui/$(id -u)"
PLIST="$AGENTS/$LABEL.plist"

die() { echo "serve-service: $*" >&2; exit 1; }

# A scratch run must not touch the real service: the variables that say which service, repo, folder and
# agent this is are set together or not at all.
overridden=() unset_=()
for v in HOME LABEL REPO DATA AGENTS PORT LOGS TAG_PREFIX; do
  if [ -n "$(printenv "CANVAS_SERVE_$v" || true)" ]; then overridden+=("CANVAS_SERVE_$v"); else unset_+=("CANVAS_SERVE_$v"); fi
done
if [ "${#overridden[@]}" -gt 0 ] && [ "${#unset_[@]}" -gt 0 ]; then
  die "set all of CANVAS_SERVE_HOME, _LABEL, _REPO, _DATA, _AGENTS, _PORT, _LOGS, _TAG_PREFIX or none; set: ${overridden[*]}; missing: ${unset_[*]}"
fi

loaded() { "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

release_dir() { echo "$SHOME/releases/$1"; }

# release names, oldest first (version order: -10 after -9)
releases() {
  [ -d "$SHOME/releases" ] || return 0
  for d in "$SHOME"/releases/*/; do
    [ -f "$d/RELEASE" ] && basename "$d"
  done | sort -V
}

current_tag() {
  [ -L "$SHOME/current" ] || return 0
  basename "$(readlink "$SHOME/current")"
}

# absolute node of a release: recorded when it was built
node_of() {
  if [ -n "${CANVAS_SERVE_NODE:-}" ]; then echo "$CANVAS_SERVE_NODE"; return; fi
  sed -n 's/^node=//p' "$(release_dir "$1")/RELEASE"
}

render_plist() {
  local node="$1" args=""
  local a
  local list=("$node" --import tsx server/serve.ts "$DATA" --port "$PORT")
  [ -n "$HOST_NAMES" ] && list+=(--host-name "$HOST_NAMES")
  for a in "${list[@]}"; do args+="    <string>$(xml "$a")</string>"$'\n'; done
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>WorkingDirectory</key><string>$(xml "$SHOME/current")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$LOGS/serve.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/serve.log")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST
}

wait_unloaded() {
  local i
  for i in $(seq 1 50); do loaded || return 0; sleep 0.2; done
  echo "serve-service: $LABEL is still loaded after bootout" >&2
  return 1
}

# serve.log grows forever otherwise: at every (re)start, a log over LOG_MAX bytes becomes serve.log.1 (older ones shift, three kept).
# launchd opens the file when it spawns the process, so the move is safe right before a start.
rotate_log() {
  local f="$LOGS/serve.log" i size
  [ -f "$f" ] || return 0
  size="$(wc -c <"$f" | tr -d ' ')"
  [ "$size" -gt "$LOG_MAX" ] || return 0
  for i in 2 1; do [ -f "$f.$i" ] && mv -f "$f.$i" "$f.$((i + 1))"; done
  mv -f "$f" "$f.1"
  return 0
}

# point current at a release, write the plist, (re)start
activate() {
  local tag="$1" nowait="${2:-}" rel node new changed=1
  rel="$(release_dir "$tag")"
  [ -f "$rel/RELEASE" ] || die "no release $tag in $SHOME/releases"
  node="$(node_of "$tag")"
  [ -n "$node" ] || die "no node path recorded for $tag"
  ln -s "releases/$tag" "$SHOME/current.tmp.$$"
  # replace the symlink itself, not what it points at (BSD -h, GNU -T)
  if [ "$(uname)" = Darwin ]; then mv -fh "$SHOME/current.tmp.$$" "$SHOME/current"; else mv -fT "$SHOME/current.tmp.$$" "$SHOME/current"; fi
  mkdir -p "$LOGS" "$AGENTS"
  rotate_log
  new="$(mktemp "${TMPDIR:-/tmp}/canvas-serve-plist.XXXXXX")"
  render_plist "$node" >"$new"
  if [ -f "$PLIST" ] && cmp -s "$new" "$PLIST"; then changed=0; fi
  mv "$new" "$PLIST"
  if loaded; then
    if [ "$changed" = 1 ]; then
      "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" || true
      wait_unloaded || return 1
      "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
    else
      "$LAUNCHCTL" kickstart -k "$DOMAIN/$LABEL"
    fi
  else
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
  fi
  echo "release $tag active; http://localhost:$PORT/ ; log $LOGS/serve.log"
  [ -n "$nowait" ] || await_up "$tag"
}

# the new process answers /api/info, or say so
# The process launchd runs now is the one that holds the folder lock (not an older one, or another server on the port).
# Without a pid from launchctl there is nothing to compare.
new_process() {
  local lpid fpid
  lpid="$("$LAUNCHCTL" print "$DOMAIN/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)"
  [ -n "$lpid" ] || return 0
  fpid="$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$DATA/.canvas-serve.lock" 2>/dev/null | head -n 1)"
  [ "$lpid" = "$fpid" ]
}

# The folder answers too: GET /api/boards lists it. macOS holds a process without Full Disk Access in the read for ever
# (while /api/info keeps answering), so this is the check that a new release can actually read the data.
folder_answers() {
  local body status
  FOLDER_WHY=""
  body="$(curl -s --max-time 5 -w '\n%{http_code}' "http://localhost:$PORT/api/boards" 2>/dev/null)" || { FOLDER_WHY="GET /api/boards did not answer within 5 s"; return 1; }
  status="${body##*$'\n'}"
  [ "$status" = 200 ] && return 0
  FOLDER_WHY="GET /api/boards answered $status: $(printf '%s' "${body%$'\n'*}" | head -c 600)"
  return 1
}

await_up() {
  local i node
  [ "$WAIT" = 0 ] && return 0
  FOLDER_WHY=""
  for i in $(seq 1 "$WAIT"); do
    if curl -sf --max-time 2 "http://localhost:$PORT/api/info" >/dev/null 2>&1 && new_process && folder_answers; then echo "up on port $PORT"; return 0; fi
    sleep 1
  done
  tail -n 15 "$LOGS/serve.log" 2>/dev/null >&2 || true
  if [ -n "$FOLDER_WHY" ]; then
    node="$(node_of "$1")"
    echo "serve-service: $1 is up but cannot read the data folder ($DATA): $FOLDER_WHY" >&2
    echo "serve-service: on macOS grant ${node:-the node binary} Full Disk Access (System Settings > Privacy & Security > Full Disk Access), then run install" >&2
  fi
  echo "serve-service: $1 did not answer on port $PORT within ${WAIT}s (log above)" >&2
  return 1
}

default_build() {
  # (runs where set -e is off: every step is chained)
  mise trust -q "$PWD/mise.toml" || return 1
  mise install -y >/dev/null || return 1
  # full install to build, then a fresh install of only what serve runs on (tsx, the mcp sdk, ws, yjs, ...):
  # `install --prod` over the full tree leaves the dev packages in the virtual store
  mise exec -- sh -c 'export CI=true; pnpm install --frozen-lockfile && pnpm build && rm -rf node_modules && pnpm install --prod --frozen-lockfile'
}

CREATED_REL="" CREATED_TAG=""
cleanup_release() {
  # only what this run made, and only while it is unfinished
  [ -n "$CREATED_REL" ] && rm -rf "$CREATED_REL"
  [ -n "$CREATED_TAG" ] && git -C "$REPO" tag -d "$CREATED_TAG" >/dev/null 2>&1
  return 0
}

cmd_release() {
  local ref="${1:-$REF}" day n tag rel sha node prev
  [ -d "$DATA" ] || die "the data folder does not exist: $DATA
create it first: mkdir -p \"$DATA\""
  git -C "$REPO" rev-parse --verify -q "$ref^{commit}" >/dev/null || die "no such ref in $REPO: $ref"
  prev="$(current_tag)"
  day="$(date +%Y%m%d)"
  n=1
  # a number is free only if neither the tag nor the release dir exists (tags can be deleted or live in another clone)
  while git -C "$REPO" rev-parse -q --verify "refs/tags/$PREFIX$day-$n" >/dev/null || [ -e "$(release_dir "$PREFIX$day-$n")" ]; do n=$((n + 1)); done
  tag="$PREFIX$day-$n"
  rel="$(release_dir "$tag")"
  [ ! -e "$rel" ] || die "$rel exists"
  trap 'cleanup_release' EXIT
  trap 'exit 130' INT TERM
  git -C "$REPO" tag "$tag" "$ref"
  CREATED_TAG="$tag"
  mkdir -p "$SHOME/releases"
  mkdir "$rel"
  CREATED_REL="$rel"
  sha="$(git -C "$REPO" rev-parse --short "$tag^{commit}")"
  echo "release $tag ($ref @ $sha) -> $rel"
  # RELEASE is written last: a directory without it is an unfinished build and never a rollback target
  if ! { git -C "$REPO" archive "${tag}${SUBDIR:+:$SUBDIR}" | tar -x -C "$rel"; } ||
    ! (cd "$rel" && if [ -n "${CANVAS_SERVE_BUILD:-}" ]; then bash -c "$CANVAS_SERVE_BUILD"; else default_build; fi); then
    die "build failed; tag $tag removed, nothing switched"
  fi
  if [ -n "${CANVAS_SERVE_NODE:-}" ]; then node="$CANVAS_SERVE_NODE"; else node="$(cd "$rel" && mise which node)" || die "mise could not find node in $rel"; fi
  printf 'tag=%s\nref=%s\nsha=%s\ndate=%s\nnode=%s\n' "$tag" "$ref" "$(git -C "$REPO" rev-parse "$tag^{commit}")" "$(date -u +%FT%TZ)" "$node" >"$rel/RELEASE"
  CREATED_REL="" CREATED_TAG="" # finished: kept from here on, whatever the start does
  if ! activate "$tag"; then
    if [ -n "$prev" ]; then
      echo "serve-service: going back to $prev ($tag is kept for inspection)" >&2
      activate "$prev" nowait >&2 || true
    fi
    exit 1
  fi
}

cmd_rollback() {
  local want="${1:-}" cur prev="" t
  cur="$(current_tag)"
  if [ -n "$want" ]; then
    [ -f "$(release_dir "$want")/RELEASE" ] || die "no release $want (have: $(releases | tr '\n' ' '))"
  else
    [ -n "$cur" ] || die "no current release"
    for t in $(releases); do
      [ "$t" = "$cur" ] && break
      prev="$t"
    done
    [ -n "$prev" ] || die "no release before $cur"
    want="$prev"
  fi
  activate "$want" || die "$want did not come up"
}

cmd_install() {
  local cur
  cur="$(current_tag)"
  [ -n "$cur" ] || die "no release yet: run release first"
  activate "$cur" || die "$cur did not come up"
}

cmd_uninstall() {
  if loaded; then "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" || true; fi
  rm -f "$PLIST"
  echo "$LABEL removed; releases kept in $SHOME/releases"
}

cmd_status() {
  local cur
  cur="$(current_tag)"
  echo "current: ${cur:-none}"
  if [ -n "$cur" ] && [ -f "$(release_dir "$cur")/RELEASE" ]; then sed -n 's/^sha=/sha: /p;s/^date=/built: /p' "$(release_dir "$cur")/RELEASE"; elif [ -n "$cur" ]; then echo "current points at a missing release"; fi
  if loaded; then "$LAUNCHCTL" print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code|runs) ' || true; else echo "launchd: $LABEL not loaded"; fi
  echo "info: $(curl -s --max-time 3 "http://localhost:$PORT/api/info" || echo 'no answer')"
  echo "data: $DATA"
  echo "log: $LOGS/serve.log"
  echo "releases: $(releases | tr '\n' ' ')"
}

case "${1:-}" in
  release) shift; cmd_release "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  *) echo "usage: serve-service.sh release [ref] | rollback [tag] | install | uninstall | status" >&2; exit 2 ;;
esac
