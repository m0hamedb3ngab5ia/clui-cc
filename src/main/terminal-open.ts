/**
 * "Open in CLI": run `claude` for a session in Terminal.app.
 *
 * Tabs we open get a `custom title` marker (`clui:<sessionId>`), so later clicks:
 *   1. focus the tab already running that session (re-run `claude --resume` in it if
 *      claude has exited there),
 *   2. otherwise add a new tab to the window that already holds CLUI tabs (Shell > New Tab
 *      via System Events; needs Automation permission for System Events),
 *   3. otherwise open a new window.
 * The script is passed to `osascript` with argv, so no shell/AppleScript escaping of
 * the command is needed beyond the shell quoting of the project path.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MARKER_PREFIX = 'clui:'

/** Shell-safe single-quote escaping; blocks all expansion ($, `, \). */
export const shellSingleQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

export type OpenPlan = { marker: string; cmd: string }

/** Validate inputs and build the marker + shell command. Returns null when unsafe. */
export function planOpen(
  sessionId: string | null,
  projectPath: string,
  claudeBin = 'claude',
): OpenPlan | null {
  if (sessionId && !UUID_RE.test(sessionId)) return null
  if (/[\0\r\n]/.test(projectPath) || !projectPath.startsWith('/')) return null
  const dir = shellSingleQuote(projectPath)
  const cmd = sessionId
    ? `cd ${dir} && ${claudeBin} --resume ${sessionId}`
    : `cd ${dir} && ${claudeBin}`
  const marker = sessionId ? `${MARKER_PREFIX}${sessionId}` : `${MARKER_PREFIX}new`
  return { marker, cmd }
}

/** argv: marker, cmd, prefix. Prints focused|tab|window. */
export const OPEN_SCRIPT = `on run argv
  set marker to item 1 of argv
  set cmd to item 2 of argv
  set prefix to item 3 of argv
  tell application "Terminal"
    activate
    -- 1. a tab already running this session → focus it
    if marker does not end with "new" then
      set sid to text ((length of prefix) + 1) thru -1 of marker
      repeat with w in windows
        repeat with t in tabs of w
          try
            -- marker set by us, or a pre-marker window whose title shows "claude --resume <id>"
            if custom title of t is marker or name of w contains sid then
              set selected of t to true
              set index of w to 1
              set frontmost of w to true
              set procs to processes of t
              if (procs does not contain "claude") and (procs does not contain "node") then
                do script cmd in t
              end if
              return "focused"
            end if
          end try
        end repeat
      end repeat
    end if
    -- 2. a window that already holds CLUI tabs → new tab there
    set tgt to missing value
    repeat with w in windows
      repeat with t in tabs of w
        try
          if custom title of t starts with prefix then
            set tgt to w
            exit repeat
          end if
        end try
      end repeat
      if tgt is not missing value then exit repeat
    end repeat
    if tgt is not missing value then
      set index of tgt to 1
      set frontmost of tgt to true
      -- macOS 26 Terminal uses native window tabs: a new tab is a new AppleScript window
      -- sharing the group's bounds, so detect it by window id rather than tab count.
      set idsBefore to id of every window
      try
        tell application "System Events" to tell process "Terminal"
          click menu item 1 of menu 1 of (menu item "New Tab" of menu "Shell" of menu bar 1)
        end tell
        set newWin to missing value
        set tries to 0
        repeat until newWin is not missing value or tries > 30
          delay 0.1
          set tries to tries + 1
          repeat with w in windows
            if idsBefore does not contain (id of w) then
              set newWin to w
              exit repeat
            end if
          end repeat
        end repeat
        if newWin is not missing value then
          do script cmd in newWin
          set custom title of selected tab of newWin to marker
          return "tab"
        end if
      end try
    end if
    -- 3. fallback: new window
    set newTab to do script cmd
    set custom title of newTab to marker
    return "window"
  end tell
end run`

export function osascriptArgs(plan: OpenPlan): string[] {
  return ['-e', OPEN_SCRIPT, plan.marker, plan.cmd, MARKER_PREFIX]
}
