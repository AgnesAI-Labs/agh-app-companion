/**
 * The platform's `ManagedSessions` as the engine's sessions port. The shapes already match
 * (sessions.mjs); what this module owns is the platform's refusal: an RPC error object whose
 * `data.reason` names the gate that refused (`data.code` alone for a port the declaration does not
 * grant). Every refusal becomes a SessionRefusal so the engine can tell it from a lost call, and
 * REFUSALS decides per code whether waiting can help.
 *
 * @typedef {import('./sessions.mjs').ManagedSessions} ManagedSessions
 * @typedef {'workspace' | 'platform' | 'start'} RefusalScope
 *   what one owner notice covers: one workspace, the whole deployment, or one start key
 * @typedef {{ retryable: boolean, scope: RefusalScope, text?: (detail: { workspace: string, missing: string | null }) => string }} RefusalRule
 *   text is the owner's notice; a retryable refusal has none because it is never told
 */

/** Failed starts of one task generation, other than refusals, before the task is parked. */
export const START_ATTEMPTS = 3

/** @type {Readonly<Record<string, RefusalRule>>} */
export const REFUSALS = Object.freeze({
  // The start was left unstarted behind a running turn; the same key queues it once the turn ends.
  SESSION_BUSY: { retryable: true, scope: 'start' },
  WORKSPACE_NOT_AUTHORIZED: {
    retryable: false,
    scope: 'workspace',
    text: ({ workspace }) =>
      `平台没有授权伴侣在 ${workspace} 里开会话。请在平台上为伴侣授权这个工作区，然后对任务说“继续”。`,
  },
  FULL_ACCESS_UNAVAILABLE: {
    retryable: false,
    scope: 'platform',
    text: ({ missing }) =>
      `平台现在不允许完全访问的会话（缺少 ${missing ?? '未知条件'}），伴侣的执行会话开不起来。平台具备后对任务说“继续”。`,
  },
  MODEL_ROUTE_MISSING: {
    retryable: false,
    scope: 'platform',
    text: () => '平台没有设置里选的模型路由。改设置后对任务说“继续”。',
  },
  AUTO_REVIEW: {
    retryable: false,
    scope: 'platform',
    text: () => '平台开着自动审批，伴侣不在这种情况下开会话。关掉后对任务说“继续”。',
  },
  BUNDLE_UNAVAILABLE: {
    retryable: false,
    scope: 'platform',
    text: () => '伴侣的会话配置没有通过审核或没有启用。启用后对任务说“继续”。',
  },
  BUNDLE_NOT_OWN: {
    retryable: false,
    scope: 'platform',
    text: () => '平台认为伴侣用了别的插件的会话配置。这是伴侣的错误，请更新伴侣。',
  },
  START_KEY_REUSED: {
    retryable: false,
    scope: 'start',
    text: () => '这次开会话的设置和上次不同，平台拒绝了。对任务说“继续”会换一个新会话。',
  },
  SESSION_ARCHIVED: {
    retryable: false,
    scope: 'start',
    text: () => '这个任务的会话已归档。对任务说“继续”会换一个新会话。',
  },
  // Not a platform code: the companion's own refusal after repeated start errors it cannot name.
  START_FAILED: {
    retryable: false,
    scope: 'start',
    text: ({ missing }) => `开会话连续失败 ${START_ATTEMPTS} 次，已停下：${missing ?? '未知错误'}。对任务说“继续”会换一个新会话再试。`,
  },
  CAPABILITY_DENIED: {
    retryable: false,
    scope: 'platform',
    text: () => '平台没有给伴侣开会话的权限。请在平台上重新信任并启用伴侣。',
  },
  MANAGED_SESSION_LANE: {
    retryable: false,
    scope: 'platform',
    text: () => '平台拒绝了伴侣的会话请求（运行位置不对）。请重启伴侣服务。',
  },
  INVALID_PARAMS: {
    retryable: false,
    scope: 'platform',
    text: () => '平台认为伴侣的请求无效。这是伴侣的错误，请更新伴侣。',
  },
})

/** A code this build does not know stops and says so, instead of retrying something nobody understands. */
const UNKNOWN = Object.freeze({ retryable: false, scope: /** @type {const} */ ('platform') })

export class SessionRefusal extends Error {
  /** @param {string} code @param {string | null} missing */
  constructor(code, missing) {
    super(`managed sessions refused: ${code}${missing ? ` (missing ${missing})` : ''}`)
    this.name = 'SessionRefusal'
    this.code = code
    this.missing = missing
    const rule = REFUSALS[code] ?? UNKNOWN
    this.retryable = rule.retryable
    this.scope = rule.scope
  }

  /** @param {string} workspace */
  text(workspace) {
    const text = REFUSALS[this.code]?.text
    return text ? text({ workspace, missing: this.missing }) : `平台拒绝了伴侣开会话（${this.code}）。`
  }
}

/** @param {unknown} error @returns {SessionRefusal | undefined} */
export function refusalOf(error) {
  if (error instanceof SessionRefusal) return error
  const data = error && typeof error === 'object' ? /** @type {{ data?: unknown }} */ (error).data : undefined
  if (!data || typeof data !== 'object') return undefined
  const { reason, code, missing } = /** @type {Record<string, unknown>} */ (data)
  const name = typeof reason === 'string' ? reason : typeof code === 'string' ? code : undefined
  return name ? new SessionRefusal(name, typeof missing === 'string' ? missing : null) : undefined
}

/**
 * Wraps the platform port. Absent (`init.sessions` on a host without the capability) gives undefined,
 * which the service reports instead of starting the engine.
 * @param {ManagedSessions | undefined} platform
 * @returns {ManagedSessions | undefined}
 */
export function platformSessions(platform) {
  if (!platform) return undefined
  /** @template {unknown[]} A @template R @param {(...args: A) => Promise<R>} call */
  const guarded =
    (call) =>
    /** @param {A} args */
    async (...args) => {
      try {
        return await call(...args)
      } catch (error) {
        throw refusalOf(error) ?? error
      }
    }
  return Object.freeze({
    start: guarded((request) => platform.start(request)),
    send: guarded((sessionId, input) => platform.send(sessionId, input)),
    admitInput: guarded((sessionId, input) => platform.admitInput(sessionId, input)),
    inputResult: guarded((sessionId, input) => platform.inputResult(sessionId, input)),
    list: guarded(() => platform.list()),
    status: guarded((sessionId) => platform.status(sessionId)),
    events: guarded((sessionId, options) => platform.events(sessionId, options)),
    result: guarded((sessionId) => platform.result(sessionId)),
    usage: guarded((sessionId) => platform.usage(sessionId)),
    toolResult: guarded((sessionId, callSeq) => platform.toolResult(sessionId, callSeq)),
    interrupt: guarded((sessionId) => platform.interrupt(sessionId)),
    archive: guarded((sessionId) => platform.archive(sessionId)),
  })
}
