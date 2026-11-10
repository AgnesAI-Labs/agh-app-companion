/**
 * The companion's data in its Host-owned OwnedStore namespace. Every key is listed here:
 *
 *   meta                          StoreMeta      written once, read on every start
 *   task/<taskId>                 TaskRecord
 *   events/<taskId>/<chunk>       EventChunk     <chunk> is a zero-padded index, so a prefix scan is in order
 *
 * Session status is computed from the platform's run facts and never stored here.
 *
 * @typedef {import('@agnes/protocol').JsonValue} JsonValue
 * @typedef {{ format: number }} StoreMeta
 * @typedef {{ id: string, workspace: string, createdAt: string, eventChunks: number }} TaskRecord
 * @typedef {{ at: string, kind: string, data: JsonValue }} TaskEvent
 * @typedef {{ taskId: string, index: number, events: TaskEvent[] }} EventChunk
 * @typedef {import('@agnes/extension-api').OwnedStore} OwnedStore
 */

export const STORE_FORMAT = 1
// The Host caps one value at 64 KiB; the margin leaves room for the chunk's own fields.
export const EVENT_CHUNK_MAX_BYTES = 48 * 1024
const CHUNK_DIGITS = 6
const SCAN_PAGE = 256

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

/** @param {OwnedStore} owned */
function checkFormat(owned) {
  const meta = owned.get('meta')
  if (meta === undefined) {
    if (owned.scan({ prefix: '', limit: 1 }).rows.length) throw new StoreFormatError('unreadable', undefined)
    owned.set('meta', { format: STORE_FORMAT })
    return
  }
  const format = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.format : undefined
  if (format === STORE_FORMAT) return
  if (Number.isSafeInteger(format) && format > STORE_FORMAT) throw new StoreFormatError('newer', format)
  throw new StoreFormatError('unreadable', format)
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

  return Object.freeze({
    getTask,
    /** @param {{ id: string, workspace: string, createdAt: string }} task */
    createTask(task) {
      owned.transaction(() => {
        if (getTask(task.id)) throw new Error(`task ${task.id} exists`)
        owned.set(`task/${task.id}`, { ...task, eventChunks: 0 })
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
      const events = []
      let cursor
      do {
        const page = owned.scan({ prefix: `events/${taskId}/`, limit: SCAN_PAGE, ...(cursor ? { cursor } : {}) })
        for (const row of page.rows) events.push(...row.value.events)
        cursor = page.nextCursor
      } while (cursor)
      return events
    },
  })
}
