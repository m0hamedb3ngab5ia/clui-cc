#!/bin/bash
# ──────────────────────────────────────────────────────
#  Clui CC — Install "Force Quit Clui CC" on the Desktop
#
#  Double-click this file to create a desktop app that
#  force-stops Clui CC, even when Clui CC is frozen.
#  Re-run it after moving the repo.
# ──────────────────────────────────────────────────────
set -e

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
DEST="${1:-$HOME/Desktop}/Force Quit Clui CC.app"
SCRIPT="$REPO_DIR/scripts/force-quit.sh"
STOP_ICON="/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/AlertStopIcon.icns"

# AppleScript runs the shell script and shows the result as a notification
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
SRC=$(mktemp -t clui-force-quit).applescript
cat > "$SRC" <<APPLESCRIPT
set out to do shell script "/bin/bash " & quoted form of "$(esc "$SCRIPT")" & " " & quoted form of "$(esc "$REPO_DIR")"
display notification out with title "Clui CC"
APPLESCRIPT

rm -rf "$DEST"
osacompile -o "$DEST" "$SRC"
rm -f "$SRC"
# Stop-sign icon: drop the compiled asset catalog so applet.icns is used
if [ -f "$STOP_ICON" ]; then
  cp "$STOP_ICON" "$DEST/Contents/Resources/applet.icns"
  rm -f "$DEST/Contents/Resources/Assets.car"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$DEST/Contents/Info.plist" 2>/dev/null || true
fi
# Re-sign ad hoc after editing the bundle so macOS doesn't call it damaged
codesign --force --sign - "$DEST" >/dev/null 2>&1 || true
touch "$DEST"

echo "Installed: $DEST"
echo "Double-click it whenever Clui CC freezes."
