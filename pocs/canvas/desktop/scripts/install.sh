#!/bin/sh
# Install or update Collie Canvas from the Mac Mini's build server:
#   curl -fsSL http://mini.internal:5412/apps/install.sh | sh
#
# Downloads the newest build, checks it, quits a running Collie Canvas politely, replaces
# ~/Applications/Collie Canvas.app, clears the quarantine flag (the build is unsigned), opens it.
# The previous app stays as a backup until the new one has started; if it doesn't start, the backup
# goes back. Canvases and settings are not touched (they live elsewhere).
#
# Overrides (for testing): COLLIE_APPS_URL, COLLIE_INSTALL_DIR, COLLIE_OPEN_CMD (default "open"),
# COLLIE_NO_LAUNCH=1 (replace only, no quit, no launch).
set -eu

BASE="${COLLIE_APPS_URL:-http://mini.internal:5412/apps}"
DEST="${COLLIE_INSTALL_DIR:-$HOME/Applications}"
OPEN="${COLLIE_OPEN_CMD:-open}"
NAME="Collie Canvas"
BUNDLE_ID="studio.collie.canvas"
TARGET="$DEST/$NAME.app"
BACKUP="$DEST/.$NAME.previous"
EXEC_DIR="$TARGET/Contents/MacOS/"

say() { printf '%s\n' "$*"; }
die() { printf 'collie-canvas install: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this is a macOS app"
[ "$(uname -m)" = arm64 ] || die "the build is arm64 only (this Mac is $(uname -m))"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/collie-canvas.XXXXXX")"
STAGE=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$STAGE" ] || rm -rf "$STAGE"
}
trap cleanup EXIT

json() { plutil -extract "$1" raw -o - "$TMP/latest.json"; }
running() { pgrep -f -- "$EXEC_DIR" >/dev/null 2>&1; }
plist() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }

say "Fetching $BASE/latest.json"
curl -fsSL "$BASE/latest.json" -o "$TMP/latest.json" || die "can't reach $BASE (is the Mac Mini up and on this network?)"
FILE="$(json file)"
SHA="$(json sha)"
VERSION="$(json version)"
BUILD="$(json build)"
WANT="$(json sha256)"
case "$FILE" in */* | "" ) die "bad file name in latest.json" ;; esac

say "Downloading $FILE"
curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/app.zip" || die "download failed"
GOT="$(shasum -a 256 "$TMP/app.zip" | cut -d' ' -f1)"
[ "$GOT" = "$WANT" ] || die "checksum mismatch (expected $WANT, got $GOT); try again"

# unpack next to the target so the final move is a rename on one volume
mkdir -p "$DEST"
STAGE="$(mktemp -d "$DEST/.collie-canvas-new.XXXXXX")"
ditto -x -k "$TMP/app.zip" "$STAGE" || die "can't unpack the download"
NEW="$STAGE/$NAME.app"
[ -d "$NEW" ] || die "the zip has no $NAME.app"
[ "$(plist "$NEW" CFBundleIdentifier)" = "$BUNDLE_ID" ] || die "unexpected app in the zip (bundle id $(plist "$NEW" CFBundleIdentifier))"
[ -x "$NEW/Contents/MacOS/$NAME" ] || die "the app has no executable"
codesign --verify --deep --strict "$NEW" 2>/dev/null || die "the app's signature doesn't verify; the download may be damaged"
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true

OLD_VERSION=""
[ ! -d "$TARGET" ] || OLD_VERSION="$(plist "$TARGET" CFBundleShortVersionString) ($(plist "$TARGET" CFBundleVersion), $(plist "$TARGET" CollieCanvasBuild))"

if [ -z "${COLLIE_NO_LAUNCH:-}" ] && running; then
  say "Quitting $NAME"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  i=0
  while running && [ "$i" -lt 60 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  running && die "$NAME is still running (a window may be asking to save?). Quit it and run this again."
fi

rm -rf "$BACKUP"
[ ! -d "$TARGET" ] || mv "$TARGET" "$BACKUP"
if ! mv "$NEW" "$TARGET"; then
  [ ! -d "$BACKUP" ] || mv "$BACKUP" "$TARGET"
  die "can't put the new app in place"
fi

if [ -n "${COLLIE_NO_LAUNCH:-}" ]; then
  rm -rf "$BACKUP"
  say "Installed $NAME $VERSION ($BUILD, $SHA) at $TARGET (not launched)"
  exit 0
fi

say "Opening $NAME"
started=""
if $OPEN "$TARGET" >/dev/null 2>&1; then
  i=0
  while [ "$i" -lt 40 ]; do
    if running; then
      sleep 2 # still there after a moment: it didn't crash on start
      running && started=1
      break
    fi
    sleep 0.5
    i=$((i + 1))
  done
fi

if [ -z "$started" ]; then
  rm -rf "$TARGET"
  if [ -d "$BACKUP" ]; then
    mv "$BACKUP" "$TARGET"
    die "the new build didn't start; the previous app is back in place"
  fi
  die "the new build didn't start (no previous app to put back)"
fi

rm -rf "$BACKUP"
say "Installed $NAME $VERSION ($BUILD, $SHA)${OLD_VERSION:+, was $OLD_VERSION}"
say "Shows the canvas serve at its saved address (default http://mini.internal:5310; change it in the app: Collie Canvas > Backend...)"
