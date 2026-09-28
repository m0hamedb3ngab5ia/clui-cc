#!/bin/bash
# ──────────────────────────────────────────────────────
#  Clui CC — launch the latest main from source
#
#  Double-click (or copy to the Desktop as "Clui CC.command").
#  Runs from a dedicated checkout that is only ever fast-forwarded:
#    git worktree add -b run-main ~/dev/clui-cc-main personal/main
#  Pulls, reinstalls deps only when package-lock.json changed, builds,
#  starts Electron detached and closes this window. On failure the
#  window stays open with the error; a stale build is never launched.
#
#  Overrides: CLUI_RUN_DIR, CLUI_REMOTE, CLUI_BRANCH
# ──────────────────────────────────────────────────────

RUN_DIR="${CLUI_RUN_DIR:-$HOME/dev/clui-cc-main}"
REMOTE="${CLUI_REMOTE:-personal}"
BRANCH="${CLUI_BRANCH:-main}"
ELECTRON="$RUN_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOCK_STAMP="$RUN_DIR/node_modules/.clui-lock-sha"
LOG="$HOME/.clui-launch.log"

fail() {
  echo
  echo "Clui CC not launched: $*"
  echo "Fix the error above, then double-click again."
  exit 1
}

# Close this Terminal window once the script has exited (nohup: survives the hangup)
close_window() {
  local t
  t=$(tty 2>/dev/null) || return 0
  [ "$TERM_PROGRAM" = "Apple_Terminal" ] || return 0
  nohup osascript \
    -e 'on run {t}' \
    -e 'delay 1' \
    -e 'tell application "Terminal"' \
    -e 'repeat with w in windows' \
    -e 'try' \
    -e 'if tty of selected tab of w is t then close w' \
    -e 'end try' \
    -e 'end repeat' \
    -e 'end tell' \
    -e 'end run' "$t" >/dev/null 2>&1 &
}

cd "$RUN_DIR" 2>/dev/null || fail "no checkout at $RUN_DIR"

if pgrep -f "$ELECTRON" >/dev/null 2>&1; then
  echo "Clui CC already running. ⌥ + Space to toggle."
  close_window
  exit 0
fi

echo "Updating $RUN_DIR from $REMOTE/$BRANCH..."
git pull --ff-only "$REMOTE" "$BRANCH" || fail "git pull --ff-only failed"

lock_sha=$(shasum package-lock.json | cut -d' ' -f1)
if [ ! -x "$ELECTRON" ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null)" != "$lock_sha" ]; then
  echo "package-lock.json changed; installing dependencies..."
  npm ci || fail "npm ci failed"
  # npm 11 skips electron's install script, and its unzip silently stops early on
  # Node 26: fetch the Electron binary under Node 22 instead
  if [ ! -f node_modules/electron/path.txt ]; then
    rm -rf node_modules/electron/dist
    npx -y -p node@22 -- node node_modules/electron/install.js || fail "Electron download failed"
  fi
  echo "$lock_sha" > "$LOCK_STAMP"
fi

echo "Building..."
npm run build || fail "build failed"

echo "Starting Clui CC (log: $LOG)..."
nohup npx electron . >>"$LOG" 2>&1 </dev/null &
disown

for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f "$ELECTRON" >/dev/null 2>&1 && break
  sleep 1
done
pgrep -f "$ELECTRON" >/dev/null 2>&1 || fail "Electron did not start (see $LOG)"

echo "Clui CC running. ⌥ + Space to toggle."
close_window
exit 0
