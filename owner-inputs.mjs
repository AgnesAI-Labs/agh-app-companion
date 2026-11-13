import { enqueueMessage, getTask, label, transit } from './tasks.mjs'
import { SessionRefusal } from './platform-sessions.mjs'

/** Old sends never acquire the current task session merely because that session is idle. */
export async function migrateOwnerSend(deps, opKey, op) {
  const tx = deps.tx()
  const task = tx.store.getTask(op.taskId)
  const inbox = op.inbox ? tx.store.get(op.inbox) : undefined
  let target = null
  if (task?.generation === 0) {
    const rows = (await deps.sessions.list()).filter((row) => row.startKey === `${op.taskId}:0`)
    if (rows.length === 1) target = {
      sessionId: rows[0].sessionId, taskId: op.taskId, taskGeneration: 0, startKey: rows[0].startKey,
    }
  }
  const migrated = {
    ...op, kind: 'ownerInput', originalText: op.input, source: inbox?.signal ?? null,
    target, legacy: true, revision: 1, host: null,
    request: target ? {
      key: op.key, target: { taskId: target.taskId, taskGeneration: target.taskGeneration, startKey: target.startKey },
      input: { kind: 'legacyOwnerMessage', text: op.input, originalInbox: op.inbox ?? null },
    } : null,
  }
  tx.store.transaction(() => {
    const current = tx.store.get(opKey)
    if (current?.kind === 'send' && current.key === op.key) tx.store.set(opKey, migrated)
  })
  return migrated
}

/** Host is the sole execution/disposition authority. C preserves original routing and caches its result. */
export async function runOwnerInput(deps, opKey, op) {
  const tx = deps.tx()
  const task = tx.store.getTask(op.taskId)
  if (!op.target?.sessionId && op.target) {
    const binding = tx.store.get(`session-binding/${op.target.startKey}`)
    if (binding && binding.startKey === op.target.startKey && binding.generation === op.target.taskGeneration) {
      op = { ...op, target: { ...op.target, sessionId: binding.sessionId }, revision: op.revision + 1 }
      tx.store.set(opKey, op)
    }
  }
  const notice = (reason, location) => {
    const store = deps.tx().store
    if (store.get(opKey)?.revision !== op.revision) return
    const title = task ? label(task) : op.taskId
    enqueueMessage(deps.tx(), {
      deliveryKey: `owner-input:${op.key}:${reason}`, taskIds: [op.taskId], about: op.inbox,
      text: `${title}：这条原话及原发送身份已保留。${reason}。请在 AGH 网页任务台展开“保留的主人消息”，用 Host 入口查看原话和当前决定；飞书上的普通按钮不能作此处置。${location ? `原会话位置：${location}` : ''}`,
      detail: op.originalText,
    })
  }
  if (!op.target?.sessionId || !op.request) {
    notice('原会话或历史目标无法证明', null)
    return false
  }
  let result
  try {
    result = await deps.sessions.inputResult(op.target.sessionId, { key: op.key })
    if ((result.state === 'absent' && result.historyCoverage === 'complete') || result.state === 'queued' ||
      (op.legacy && result.state === 'legacySend' && result.delivery !== 'consumed')) {
      if (!task || task.state === 'abandoned' || task.state === 'expired' || task.state === 'paused') {
        notice('任务已停止，原发送结果没有被改成失败或转投新会话', null)
        return false
      }
      result = await deps.sessions.admitInput(op.target.sessionId, op.request)
    }
  } catch (error) {
    if (error instanceof SessionRefusal) notice(error.code, null)
    return false
  }
  return deps.tx().store.transaction(() => {
    const store = deps.tx().store
    const current = store.get(opKey)
    if (current?.kind !== 'ownerInput' || current.revision !== op.revision || current.key !== op.key) return false
    const terminal = result.state === 'consumed' || result.state === 'retained' ||
      (result.state === 'legacySend' && result.delivery === 'consumed')
    if (terminal) {
      store.set(`input-result/${op.key}`, { ...op, host: result })
      if (task) {
        const fresh = getTask(deps.tx(), op.taskId)
        if (fresh.attach?.inbox === op.inbox) store.putTask({ ...fresh, attach: { ...fresh.attach, sent: result.state === 'consumed' || result.state === 'legacySend' } })
        if (result.state === 'consumed' && (fresh.state === 'done' || fresh.state === 'failed'))
          transit(deps.tx(), op.taskId, 'ownerMessage')
      }
      store.delete(opKey)
      return true
    }
    store.set(opKey, { ...current, host: result })
    if (result.state === 'needsOwner' || result.state === 'recoveryUnknown' || result.state === 'waitingQuestion')
      notice(result.reason, result.reviewLocation)
    else if (result.state === 'legacySend') notice('旧发送结果未知，只查询原 key，不重放', null)
    else if (result.state === 'absent') notice('历史覆盖不完整', null)
    return false
  })
}
