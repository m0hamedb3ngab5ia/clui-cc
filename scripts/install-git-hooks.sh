#!/bin/bash
# Install the post-commit hook that rebuilds /Applications/Clui CC.app after every
# commit in the main worktree (runs scripts/reinstall.sh in the background).
set -e
cd "$(dirname "$0")/.."
HOOK="$(git rev-parse --git-common-dir)/hooks/post-commit"
cat > "$HOOK" <<'H'
#!/bin/bash
# Auto-installed by scripts/install-git-hooks.sh: rebuild + reinstall Clui CC in the background.
[ "${CLUI_SKIP_REINSTALL:-0}" = "1" ] && exit 0
# Only the main worktree; linked worktrees (parallel branches) don't ship to /Applications.
[ "$(git rev-parse --git-dir)" = "$(git rev-parse --git-common-dir)" ] || exit 0
ROOT="$(git rev-parse --show-toplevel)"
LOG="$HOME/.clui-reinstall.log"
echo "post-commit: rebuilding Clui CC in background (log: $LOG)"
nohup bash "$ROOT/scripts/reinstall.sh" >>"$LOG" 2>&1 </dev/null &
H
chmod +x "$HOOK"
echo "installed $HOOK"
