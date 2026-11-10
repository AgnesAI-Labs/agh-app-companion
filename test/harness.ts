import { createEngine } from '../engine.mjs'
import { LIMITS, type Limits } from '../limits.mjs'
import type { StartRequest } from '../sessions.mjs'
import { DEFAULT_SETTINGS } from '../settings.mjs'
import { openStore } from '../store.mjs'
import { fakeSessions, type Reply } from './fake-sessions.js'
import { memoryOwnedStore } from './owned-store.js'

export const SETTINGS = {
  ...DEFAULT_SETTINGS,
  ownerName: 'owner',
  workspaces: [
    { shortName: 'api', path: '/w/api' },
    { shortName: 'web', path: '/w/web' },
  ],
  dedicatedWorkspace: '/w/companion',
  channelInstance: 'im-1',
}

export type Item = { id: string; origin: 'owner' | 'material'; text: string; chosenNew?: true }
export type JudgeInput = { snapshot: any; recent: any[]; batch: Item[] }

/** Reads the judge input the engine sent, so a scripted judge can cite the batch ids. */
export function readJudgeInput(input: string): JudgeInput {
  return JSON.parse(input.slice(input.indexOf('\n\n{') + 2))
}

/** The channel's fake gateway: drops a repeated deliveryKey, as the IM channel plan requires. */
export function fakeChannel() {
  const delivered = new Map<string, { deliveryKey: string; text: string; detail: string | null; card: any; messageId: string }>()
  let calls = 0
  let down = false
  return {
    delivered,
    get calls() {
      return calls
    },
    setDown(value: boolean) {
      down = value
    },
    port: {
      async deliver(message: { deliveryKey: string; text: string; detail: string | null; card: any }) {
        calls++
        if (down) throw new Error('channel down')
        const existing = delivered.get(message.deliveryKey)
        if (existing) return { messageId: existing.messageId }
        const messageId = `m${delivered.size + 1}`
        delivered.set(message.deliveryKey, { ...message, messageId })
        return { messageId }
      },
    },
    texts() {
      return [...delivered.values()].map((m) => m.text)
    },
  }
}

type Judge = (input: JudgeInput, raw: string) => string | Reply
type Worker = (request: StartRequest, input: string) => Reply

export function harness(options: { judge?: Judge; worker?: Worker; limits?: Partial<Limits> } = {}) {
  const owned = memoryOwnedStore()
  const store = openStore(owned)
  let clock = Date.parse('2026-11-10T08:00:00.000Z')
  let judge: Judge = options.judge ?? (() => '{"decisions":[]}')
  let worker: Worker | undefined = options.worker
  const judgeInputs: JudgeInput[] = []
  const sessions = fakeSessions({
    reply(request, input) {
      if (request.role === 'worker') return worker?.(request, input)
      const parsed = readJudgeInput(input)
      judgeInputs.push(parsed)
      const out = judge(parsed, input)
      return typeof out === 'string' ? { outcome: 'completed', text: out } : out
    },
  })
  const channel = fakeChannel()
  const limits = { ...LIMITS, ...options.limits }
  let eventSeq = 0
  const engine = () =>
    createEngine({
      store,
      sessions: sessions.port,
      channel: channel.port,
      settings: SETTINGS,
      now: () => new Date(clock).toISOString(),
      limits,
    })
  let current = engine()
  const h = {
    owned,
    store,
    sessions,
    channel,
    judgeInputs,
    limits,
    get engine() {
      return current
    },
    /** A fresh engine over the same store and ports, as after a restart. */
    restart() {
      current = engine()
      return current
    },
    setJudge(next: Judge) {
      judge = next
    },
    setWorker(next: Worker | undefined) {
      worker = next
    },
    advance(ms: number) {
      clock += ms
    },
    now: () => new Date(clock).toISOString(),
    signal(fields: Record<string, unknown>) {
      const eventId = (fields.eventId as string) ?? `e${++eventSeq}`
      return current.receive({ source: 'im', eventId, at: new Date(clock).toISOString(), origin: 'owner', ...fields })
    },
    say(text: string, fields: Record<string, unknown> = {}) {
      return h.signal({ kind: 'message', text, ...fields })
    },
    tick: () => current.tick(),
    task: (id: string) => store.getTask(id) as any,
    tasks: () => store.scan('task/').map((row) => row.value as any),
    entry: (key: string) => store.get(key) as any,
    workers: () => sessions.byRole('worker'),
    /** Owner asks for a task; the scripted judge creates it in `workspace`. Returns the task id. */
    async create(text: string, workspace = 'api', title = text) {
      const previous = judge
      judge = ({ batch }) =>
        JSON.stringify({ decisions: [{ kind: 'create', messages: [batch[0]!.id], workspace, title }] })
      await h.say(text)
      await h.tick()
      judge = previous
      const created = h.tasks().at(-1)
      return created.id as string
    },
    sessionOf(id: string) {
      return h.task(id).sessionId as string
    },
  }
  return h
}

/** Judge output in the wire shape. */
export const decisions = (...items: unknown[]) => JSON.stringify({ decisions: items })
