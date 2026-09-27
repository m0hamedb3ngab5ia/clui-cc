#!/bin/bash
# Force-stops Clui CC (installed app and dev build) even when it's frozen.
# Usage: force-quit.sh [repo_dir]   (repo_dir also matches a dev build's electron)

REPO_DIR="${1:-}"
# Leading slash: must not match this helper, "Force Quit Clui CC.app"
APP_PATTERN="${CLUI_APP_PATTERN:-/Clui CC.app/Contents/}"  # override for testing
LOG_FILE="$HOME/.clui-debug.log"

app_pids() {
  {
    pgrep -f "$APP_PATTERN" 2>/dev/null
    if [ -n "$REPO_DIR" ]; then
      pgrep -f "$REPO_DIR/node_modules/electron" 2>/dev/null
      pgrep -f "$REPO_DIR/dist/main" 2>/dev/null
      # Dev builds launched with a relative path: match by working directory
      for pid in $(pgrep -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null); do
        [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$REPO_DIR" ] && echo "$pid"
      done
    fi
  } | grep -vx "$$" | sort -u | xargs
}

# App processes plus everything they spawned (Claude runs, tools), which a
# hard kill of the app would otherwise leave orphaned
descendants() {
  local kids
  kids=$(pgrep -P "$1" 2>/dev/null)
  for k in $kids; do echo "$k"; descendants "$k"; done
}

find_pids() {
  local all=""
  for p in $(app_pids); do all="$all $p $(descendants "$p" | xargs)"; done
  echo "$all" | tr ' ' '\n' | grep -v '^$' | sort -u | xargs
}

pids=$(find_pids)
if [ -z "$pids" ]; then
  echo "Clui CC was not running."
  exit 0
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%S.000Z)] [force-quit] external force quit, pids: $pids" >> "$LOG_FILE" 2>/dev/null

# Graceful first (lets the app flush its log), then kill whatever is still stuck
kill -TERM $pids 2>/dev/null
for _ in 1 2 3 4; do
  sleep 0.5
  [ -z "$(find_pids)" ] && break
done
left=$(find_pids)
[ -n "$left" ] && kill -KILL $left 2>/dev/null
sleep 0.3

if [ -z "$(find_pids)" ]; then
  echo "Clui CC force-quit."
else
  echo "Could not stop: $(find_pids)"
  exit 1
fi
