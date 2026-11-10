/**
 * The plugin-managed sessions port (platform gap G1) as this package codes against it. The platform
 * does not provide it yet; tests use test/fake-sessions.ts. Shapes follow the companion design §4.7 G1.
 *
 * @typedef {'judge' | 'worker'} Role
 * @typedef {'notLoaded' | 'idle' | 'active' | 'systemError'} StatusKind
 * @typedef {'waitingOnApproval' | 'waitingOnUserInput'} StatusFlag
 * @typedef {{ kind: StatusKind, flags: StatusFlag[] }} SessionStatus  computed from run facts, never stored
 * @typedef {'read-only' | 'full-access'} Permission
 * @typedef {'task' | 'ephemeral'} Retention
 * @typedef {{
 *   role: Role, bundle: string, permission: Permission, retention: Retention,
 *   workspace: string, input: string, startKey: string, model?: string,
 * }} StartRequest  model absent = deployment default; a named route the deployment lacks is refused, never replaced
 * @typedef {{ kind: 'started' } | { kind: 'notSubmitted', reason: 'busy' | 'archived' | 'duplicateKey' }} SendResult
 * @typedef {'completed' | 'failed' | 'interrupted'} TurnOutcome
 * @typedef {{ kind: 'status', status: SessionStatus } | { kind: 'text', text: string } | { kind: 'error', message: string }
 *   | { kind: 'approval', state: 'pending' } | { kind: 'approval', state: 'answered', decision: 'approved' | 'refused' }
 *   | { kind: 'approval', state: 'expired' } | { kind: 'turn', outcome: TurnOutcome }} SessionEvent
 *   A turn's end is reported once as `turn`; `result` then holds that turn's final reply.
 * @typedef {{ sessionId: string, startKey: string, role: Role, status: SessionStatus, archived: boolean }} SessionRow
 * @typedef {{ tokens: number | null, cost: number | null }} Usage  null = the platform cannot say; never read as 0
 * @typedef {{
 *   start(request: StartRequest): Promise<{ sessionId: string, created: boolean }>,
 *   send(input: { sessionId: string, input: string, idempotencyKey: string }): Promise<SendResult>,
 *   list(): Promise<SessionRow[]>,
 *   events(sessionId: string, cursor?: number): Promise<{ events: SessionEvent[], cursor: number }>,
 *   result(sessionId: string): Promise<{ text: string } | undefined>,
 *   usage(sessionId: string): Promise<Usage>,
 *   interrupt(sessionId: string): Promise<void>,
 *   archive(sessionId: string): Promise<void>,
 * }} ManagedSessions
 */

export const PACKAGE_ID = '@agh-apps/companion'

/** How each role's session is opened. Launch blocks carry no permission, so the default lives here. */
export const ROLES = Object.freeze({
  judge: Object.freeze({ bundle: `${PACKAGE_ID}#judge`, permission: 'read-only', retention: 'ephemeral' }),
  worker: Object.freeze({ bundle: `${PACKAGE_ID}#worker`, permission: 'full-access', retention: 'task' }),
})

/**
 * @param {Role} role
 * @param {{ workspace: string, input: string, startKey: string, model?: string }} input
 * @returns {StartRequest}
 */
export function startRequest(role, { model, ...rest }) {
  return { role, ...ROLES[role], ...rest, ...(model ? { model } : {}) }
}
