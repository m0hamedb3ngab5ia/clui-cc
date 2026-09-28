#!/bin/bash
# Rebuild Clui CC and swap it into /Applications without killing a running copy.
#
# Safe while Clui CC is running (even when this script runs from inside a Clui
# session): the old bundle is moved aside (its open files stay valid), the new
# one is copied in, and the Desktop alias is refreshed so it keeps pointing at
# /Applications. The running app keeps the old build until it is relaunched.
#
# Run by the git post-commit hook (scripts/install-git-hooks.sh) or by hand:
#   bash scripts/reinstall.sh
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Clui CC"
DEST="/Applications/${APP_NAME}.app"
ALIAS="${CLUI_ALIAS:-$HOME/Desktop/${APP_NAME}}"
BUILD_OUT="${TMPDIR:-/tmp}/clui-reinstall-build"
LOG="${CLUI_REINSTALL_LOG:-$HOME/.clui-reinstall.log}"

notify() { osascript -e "display notification \"$1\" with title \"Clui CC\"" >/dev/null 2>&1 || true; }
fail() { echo "reinstall failed: $1"; notify "Rebuild failed: $1 (see $LOG)"; exit 1; }

echo "=== $(date '+%F %T') reinstall from $(git rev-parse --short HEAD) ($(git branch --show-current)) ==="

rm -rf "$BUILD_OUT"
npx electron-vite build --mode production || fail "electron-vite build"
npx electron-builder --mac --dir -c.directories.output="$BUILD_OUT" || fail "electron-builder"

SRC=""
for d in mac-arm64 mac; do
  [ -d "$BUILD_OUT/$d/${APP_NAME}.app" ] && SRC="$BUILD_OUT/$d/${APP_NAME}.app" && break
done
[ -n "$SRC" ] || fail "built app not found in $BUILD_OUT"

# Swap: move the old bundle aside instead of deleting it under a running process.
OLD=""
if [ -d "$DEST" ]; then
  OLD="${TMPDIR:-/tmp}/clui-old-$(date +%s).app"
  mv "$DEST" "$OLD"
fi
cp -R "$SRC" "$DEST" || { [ -n "$OLD" ] && mv "$OLD" "$DEST"; fail "copy to /Applications"; }
echo "installed $DEST"

# Old bundles from earlier swaps: drop the ones no process is using any more.
for old in "${TMPDIR:-/tmp}"/clui-old-*.app; do
  [ -d "$old" ] || continue
  if ! pgrep -f "$old/Contents/MacOS/" >/dev/null 2>&1; then rm -rf "$old"; fi
done

# Desktop launcher: a symlink resolves by path, so it always opens the bundle now in
# /Applications (a Finder alias could follow the moved-aside old bundle by file id).
# Only replace a Finder alias when Finder automation is allowed; otherwise leave it alone.
if [ -L "$ALIAS" ]; then
  [ "$(readlink "$ALIAS")" = "$DEST" ] || ln -sfn "$DEST" "$ALIAS"
elif [ -e "$ALIAS" ]; then
  if osascript -e 'tell application "Finder" to get name' >/dev/null 2>&1; then
    TMP_ALIAS="$(mktemp -d)"
    if osascript -e "tell application \"Finder\" to make new alias file at (POSIX file \"$TMP_ALIAS\" as alias) to (POSIX file \"$DEST\" as alias)" >/dev/null 2>&1; then
      mv -f "$TMP_ALIAS"/* "$ALIAS"
    else
      echo "warning: could not refresh alias at $ALIAS; leaving it unchanged"
    fi
    rm -rf "$TMP_ALIAS"
  else
    echo "warning: no Finder automation permission; alias at $ALIAS left unchanged (a symlink is safer: ln -sfn \"$DEST\" \"$ALIAS\")"
  fi
else
  ln -s "$DEST" "$ALIAS"
fi

rm -rf ./dist "$BUILD_OUT"
if [ -n "$OLD" ] && pgrep -f "$OLD/Contents/MacOS/" >/dev/null 2>&1; then
  notify "Rebuilt from $(git rev-parse --short HEAD). Relaunch to use it."
else
  notify "Rebuilt from $(git rev-parse --short HEAD)."
fi
echo "done"
