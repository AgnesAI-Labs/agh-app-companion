/**
 * The plugin-managed sessions port the engine codes against. Its shapes are the platform's
 * `ManagedSessions` (@agnes/extension-api, managed-sessions.ts); platform-sessions.mjs adapts the real
 * port and turns its refusals into `SessionRefusal`. Tests use test/fake-sessions.ts.
 *
 * @typedef {'judge' | 'worker'} Role
 * @typedef {'notLoaded' | 'idle' | 'active' | 'systemError'} StatusKind
 * @typedef {'waitingOnApproval' | 'waitingOnUserInput'} StatusFlag
 * @typedef {{ kind: StatusKind, flags: StatusFlag[] }} SessionStatus  computed from run facts, never stored
 * @typedef {'default' | 'full-access'} Permission
 * @typedef {'task' | 'ephemeral'} Retention
 * @typedef {{ route: string, model: string }} ModelRef
 * @typedef {{
 *   bundle: string, workspace: string, input: string, startKey: string, retention: Retention,
 *   permission: Permission, memoryWrites: boolean, skillInstalls: boolean, model?: ModelRef,
 * }} StartRequest  model absent = deployment default; a route the deployment lacks is refused, never replaced
 * @typedef {{ state: 'started' } | { state: 'notSubmitted', reason: 'busy' | 'archived' | 'duplicateKey' }} SendResult
 * @typedef {'completed' | 'failed' | 'cancelled'} TurnEnd
 * @typedef {{ kind: 'text', seq: number, text: string }
 *   | { kind: 'tool', seq: number, name: string, status: string, resultSeq?: number }
 *   | { kind: 'approval', seq: number, state: 'pending' | 'decided' | 'expired', category: 'permission' | 'question', summary: string, toolName?: string }
 *   | { kind: 'approvalOutcome', seq: number, approvalSeq: number, outcome: 'allowed' | 'rejected' | 'expired', via: 'person' | 'full-access' | 'automatic' }
 *   | { kind: 'turn', seq: number, turn: number, status: 'running' | 'waiting' | TurnEnd, reason?: string }} SessionEvent
 *   A turn is reported at its start and again, with a later seq, at its end. An approval or tool is
 *   reported once, at the seq it was created with: a later change of its state is not seen after
 *   `afterSeq`. An approval's end comes as an `approvalOutcome` at the seq that ended it, so a reader
 *   paging with `afterSeq` gets each one once; `via: 'person'` is the owner's own answer on an owner
 *   surface and everything unsure is `automatic` (reconcile.mjs counts only person refusals).
 *   A tool call is reported once too; its result is read with `toolResult(sessionId, callSeq)`.
 * @typedef {{ sessionId: string, startKey: string, bundle: string, workspace: string, retention: Retention, archived: boolean, status: SessionStatus }} SessionRow
 * @typedef {{ turn: { status: TurnEnd, reason?: string } | null, text: string | null }} SessionResult
 * @typedef {{ inputTokens: number | null, outputTokens: number | null, cost: { amount: number, currency: string } | null }} SessionUsage
 *   null = the platform cannot say; never read as 0
 * @typedef {{ name: string, state: 'pending' | 'done', isError: boolean, text: string, exitCode: number | null }} ToolResult
 *   while `pending` the call has no result yet and isError, text and exitCode say nothing
 * @typedef {{
 *   start(request: StartRequest): Promise<{ sessionId: string, created: boolean }>,
 *   send(sessionId: string, input: { text: string, idempotencyKey: string }): Promise<SendResult>,
 *   list(): Promise<readonly SessionRow[]>,
 *   events(sessionId: string, options?: { afterSeq?: number }): Promise<{ events: readonly SessionEvent[], lastSeq: number }>,
 *   result(sessionId: string): Promise<SessionResult>,
 *   usage(sessionId: string): Promise<SessionUsage>,
 *   toolResult(sessionId: string, callSeq: number): Promise<ToolResult>,
 *   interrupt(sessionId: string): Promise<void>,
 *   archive(sessionId: string): Promise<void>,
 * }} ManagedSessions  every method may reject with a SessionRefusal (platform-sessions.mjs)
 */

export const PACKAGE_ID = '@agh-apps/companion'

/**
 * How each role's session is opened. Both read outside text, so neither may write memory or install
 * skills; the judge's Bundle has no tools and its sessions are ephemeral.
 */
export const ROLES = Object.freeze({
  judge: Object.freeze({
    bundle: `${PACKAGE_ID}#judge`,
    permission: 'default',
    retention: 'ephemeral',
    memoryWrites: false,
    skillInstalls: false,
  }),
  worker: Object.freeze({
    bundle: `${PACKAGE_ID}#worker`,
    permission: 'full-access',
    retention: 'task',
    memoryWrites: false,
    skillInstalls: false,
  }),
})

/**
 * @param {Role} role
 * @param {{ workspace: string, input: string, startKey: string, model?: ModelRef }} input
 * @returns {StartRequest}
 */
export function startRequest(role, { model, ...rest }) {
  return /** @type {StartRequest} */ ({ ...ROLES[role], ...rest, ...(model ? { model } : {}) })
}
