// Mode/effort flags for a `claude -p` run. Loaded by node's type stripping in tests.
import { isEffortLevel, isPermissionMode } from '../../shared/permission-modes'

export function modeArgs(options: { permissionMode?: unknown; effort?: unknown }): string[] {
  const mode = isPermissionMode(options.permissionMode) ? options.permissionMode : 'default'
  const args = ['--permission-mode', mode]
  if (isEffortLevel(options.effort)) args.push('--effort', options.effort)
  return args
}

/** stdin control request that switches a live run's permission mode */
export function setModeRequest(mode: string, requestId: string): object {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } }
}
