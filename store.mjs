/**
 * The companion's data in its Host-owned OwnedStore namespace. Every key is listed here:
 *
 *   meta                          StoreMeta      format written once; channelOwner written on the first start with a channel
 *   counter                       Counters       next task, op and refusal-notice numbers
 *   task/<taskId>                 TaskRecord
 *   events/<taskId>/<chunk>       EventChunk     <chunk> is a zero-padded index, so a prefix scan is in order
 *   inbox/<source>:<eventId>      InboxEntry     deleted 7 days after it has a disposition
 *   outbox/<deliveryKey>          OutboxEntry    deleted 7 days after delivery
 *   op/<seq>                      SessionOp      a committed session operation, deleted once executed
 *   judge/batch                   JudgeBatch     the batch being judged; the commit that disposes it deletes it
 *   judge/backoff                 JudgeBackoff   set while the judge model is treated as unavailable
 *   usage/<yyyy-mm-dd>            DayUsage       session usage summed per day
 *   alerts                        Alerts         which store-size notice has been sent
 *   refusal/<role>:<scope>        RefusalRecord  a platform refusal the owner was told about, until a task under it is continued
 *
 * The Host writes its own rows into this same namespace before it calls `start` (managed-shutdown:<id>,
 * managed-process:<id>, managed-incarnation:<id>, managed-binding:<id>, managed-predecessor:<id>,
 * managed-marker-revision:<id>, managed-config:<id>). They all start with `managed-`, no key above does,
 * and this module never writes, deletes or reads one: they are the Host's, not companion data. The
 * platform documents no reserved prefix, so `managed-` is what the Host writes today, not a promise.
 *
 * Session status is computed from the platform's run facts and never stored here. Shapes of the
 * engine's records are defined next to the code that owns them (tasks.mjs, signals.mjs, effects.mjs).
 *
 * @typedef {import('@agnes/protocol').JsonValue} JsonValue
 * @typedef {{ instanceId: string, userId: string }} ChannelOwner
 * @typedef {{ format: number, channelOwner?: ChannelOwner }} StoreMeta  outbox rows and status answers belong to channelOwner
 * @typedef {{ id: string, workspace: string, createdAt: string, eventChunks: number, [field: string]: any }} TaskRecord
 * @typedef {{ at: string, kind: string, data: JsonValue }} TaskEvent
 * @typedef {{ taskId: string, index: number, events: TaskEvent[] }} EventChunk
 * @typedef {import('@agnes/extension-api').OwnedStore} OwnedStore
 */

export const STORE_FORMAT = 1
// The Host caps one value at 64 KiB; the margin leaves room for the chunk's own fields.
export const EVENT_CHUNK_MAX_BYTES = 48 * 1024
export const STORE_MAX_KEYS = 10000
export const STORE_MAX_BYTES = 16 * 1024 * 1024
const CHUNK_DIGITS = 6
const SCAN_PAGE = 256
const HOST_PREFIX = 'managed-'
const isHostKey = (key) => key.startsWith(HOST_PREFIX)

export class StoreFormatError extends Error {
  /** @param {'newer' | 'unreadable'} reason @param {unknown} found */
  constructor(reason, found) {
    super(
      reason === 'newer'
        ? `companion store format ${JSON.stringify(found)} is newer than this build (${STORE_FORMAT}); upgrade the companion. Nothing was changed.`
        : `companion store has an unreadable format stamp (${JSON.stringify(found)}). Nothing was changed.`,
    )
    this.name = 'StoreFormatError'
    this.reason = reason
  }
}

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const chunkKey = (taskId, index) => `events/${taskId}/${String(index).padStart(CHUNK_DIGITS, '0')}`

/** True when the namespace holds a row that is neither the Host's nor ours to adopt. @param {OwnedStore} owned */
function holdsForeignRows(owned) {
  let cursor
  do {
    const page = owned.scan({ prefix: '', limit: SCAN_PAGE, ...(cursor ? { cursor } : {}) })
    if (page.rows.some((row) => !isHostKey(row.key))) return true
    cursor = page.nextCursor
  } while (cursor)
  return false
}

/** @param {OwnedStore} owned */
function checkFormat(owned) {
  const meta = owned.get('meta')
  if (meta === undefined) {
    if (holdsForeignRows(owned)) throw new StoreFormatError('unreadable', undefined)
    owned.set('meta', { format: STORE_FORMAT })
    return
  }
  const format = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.format : undefined
  if (format === STORE_FORMAT) return
  if (Number.isSafeInteger(format) && format > STORE_FORMAT) throw new StoreFormatError('newer', format)
  throw new StoreFormatError('unreadable', format)
}

/** @param {string} key */
function hostSafe(key) {
  if (isHostKey(key)) throw new Error(`${key} belongs to the Host`)
  return key
}

/**
 * Checks the format stamp (stamping an empty store) and returns the typed accessors. Throws
 * StoreFormatError for a store this build must not touch, so the managed service never starts on it.
 * @param {OwnedStore} owned
 */
export function openStore(owned) {
  owned.transaction(() => checkFormat(owned))

  /** @param {string} taskId @returns {TaskRecord | undefined} */
  const getTask = (taskId) => owned.get(`task/${taskId}`)

  /** @param {string} prefix @returns {{ key: string, value: any }[]} */
  const scan = (prefix) => {
    const rows = []
    let cursor
    do {
      const page = owned.scan({ prefix, limit: SCAN_PAGE, ...(cursor ? { cursor } : {}) })
      rows.push(...page.rows)
      cursor = page.nextCursor
    } while (cursor)
    return rows
  }

  return Object.freeze({
    getTask,
    /** @param {string} key */
    get: (key) => owned.get(key),
    /** @param {string} key @param {JsonValue} value */
    set: (key, value) => owned.set(hostSafe(key), value),
    /** @param {string} key */
    delete: (key) => owned.delete(hostSafe(key)),
    scan,
    /** Synchronous and atomic; the Host refuses a callback that returns a promise. @template T @param {() => T} work */
    transaction: (work) => owned.transaction(work),
    /** @param {{ id: string, workspace: string, createdAt: string, [field: string]: any }} task */
    createTask(task) {
      owned.transaction(() => {
        if (getTask(task.id)) throw new Error(`task ${task.id} exists`)
        owned.set(`task/${task.id}`, { ...task, eventChunks: 0 })
      })
    },
    /** Writes a task record that already exists, keeping its chunk count. @param {TaskRecord} task */
    putTask(task) {
      owned.transaction(() => {
        const current = getTask(task.id)
        if (!current) throw new Error(`unknown task ${task.id}`)
        owned.set(`task/${task.id}`, { ...task, eventChunks: current.eventChunks })
      })
    },
    /** @param {string} taskId @param {TaskEvent} event */
    appendEvent(taskId, event) {
      if (bytes({ taskId, index: 0, events: [event] }) > EVENT_CHUNK_MAX_BYTES)
        throw new Error(`event for task ${taskId} is too large for one chunk`)
      owned.transaction(() => {
        const task = getTask(taskId)
        if (!task) throw new Error(`unknown task ${taskId}`)
        const last = task.eventChunks - 1
        /** @type {EventChunk | undefined} */
        const open = last >= 0 ? owned.get(chunkKey(taskId, last)) : undefined
        const grown = open && { ...open, events: [...open.events, event] }
        if (grown && bytes(grown) <= EVENT_CHUNK_MAX_BYTES) {
          owned.set(chunkKey(taskId, last), grown)
          return
        }
        owned.set(chunkKey(taskId, task.eventChunks), { taskId, index: task.eventChunks, events: [event] })
        owned.set(`task/${taskId}`, { ...task, eventChunks: task.eventChunks + 1 })
      })
    },
    /** @param {string} taskId @returns {TaskEvent[]} */
    readEvents(taskId) {
      return scan(`events/${taskId}/`).flatMap((row) => row.value.events)
    },
    /** Deletes a task's event chunks, for compaction into its summary. @param {string} taskId */
    dropEvents(taskId) {
      owned.transaction(() => {
        for (const row of scan(`events/${taskId}/`)) owned.delete(row.key)
        const task = getTask(taskId)
        if (task) owned.set(`task/${taskId}`, { ...task, eventChunks: 0 })
      })
    },
    /** The channel owner this store was used with, or undefined before its first start with a channel. @returns {ChannelOwner | undefined} */
    channelOwner: () => owned.get('meta')?.channelOwner,
    /** @param {ChannelOwner} channelOwner */
    recordChannelOwner(channelOwner) {
      owned.transaction(() => owned.set('meta', { ...owned.get('meta'), channelOwner }))
    },
    /** Key count and serialized bytes against the Host caps (10k keys, 16 MiB). The caps cover the whole namespace, so the Host's own rows count here on purpose. */
    usage() {
      const rows = scan('')
      const total = rows.reduce((sum, row) => sum + bytes(row.value), 0)
      return { keys: rows.length, bytes: total, ratio: Math.max(rows.length / STORE_MAX_KEYS, total / STORE_MAX_BYTES) }
    },
  })
}

/** @typedef {ReturnType<typeof openStore>} Store */
