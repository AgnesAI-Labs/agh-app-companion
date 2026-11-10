import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

/**
 * A loopback OpenAI-compatible model for the real-daemon run. It keeps no state: every reply is a
 * function of the request's messages, so a retried or replayed request gets the same answer.
 *
 * - A judge request carries `JUDGE_INSTRUCTIONS` and then `{"snapshot":…,"recent":…,"batch":…}`; the
 *   reply creates one task per owner message, citing the batch's own ids.
 * - A worker request carries `任务编号：` and the owner's brief; the brief's `[e2e:<script>]` marker
 *   picks a script from SCRIPTS and the tool results already in the messages pick its step.
 * - Anything else (session titles) gets a short fixed text.
 */

export const MODEL = 'deepseek-flash'

/** @typedef {{ name: string, args: Record<string, any>, result: string | null }} Call */
/** @typedef {{ tool: string, args: Record<string, unknown> } | { text: string }} Action */

const text = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
      : ''

/** The first JSON object in `body` that starts at `marker`, read with string-aware brace matching. */
export function objectAt(body, marker) {
  const start = body.indexOf(marker)
  if (start < 0) return undefined
  let depth = 0
  let quoted = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/** Tool calls in the order the model made them, each with its result when one came back. @returns {Call[]} */
export function history(messages) {
  /** @type {Map<string, Call>} */
  const byId = new Map()
  /** @type {Call[]} */
  const calls = []
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls))
      for (const call of m.tool_calls) {
        let args = {}
        try {
          args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {}
        const entry = { name: call.function?.name ?? '', args, result: null }
        byId.set(call.id, entry)
        calls.push(entry)
      }
    if (m?.role === 'tool' && byId.has(m.tool_call_id)) /** @type {Call} */ (byId.get(m.tool_call_id)).result = text(m.content)
  }
  return calls
}

const shell = (command) => ({ tool: 'shell', args: { command } })
const ran = (calls, name, fragment = '') => calls.filter((c) => c.name === name && JSON.stringify(c.args).includes(fragment))
const planned = (calls) => {
  const plan = ran(calls, 'publish_plan').at(-1)
  return plan?.result ? objectAt(plan.result, '{"status"') : undefined
}
const published = (call) => objectAt(call.result ?? '', '{"status"')?.status === 'published'
const summary = (calls) =>
  calls.map((c) => `${c.name}: ${(c.result ?? 'no result').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')

/**
 * Each worker script, as the next action for the calls so far. Both write a change, plan a publish
 * and call `publish` with the plan's proposal unchanged.
 * @type {Record<string, (calls: Call[], branch: string) => Action>}
 */
export const SCRIPTS = {
  publish(calls, branch) {
    if (!ran(calls, 'shell', 'id_test').length) return shell('cat ~/.ssh/id_test')
    if (!ran(calls, 'shell', 'e2e-change').length) return shell(`printf 'companion e2e ${branch}\\n' > e2e-change-${branch}.txt && echo wrote`)
    if (!ran(calls, 'publish_plan').length)
      return { tool: 'publish_plan', args: { title: `E2E ${branch}`, body: 'Synthetic change from the companion e2e run.', branch: `companion/${branch}`, base: 'main' } }
    const plan = planned(calls)
    if (plan?.status !== 'planned') return { text: `计划没有成功：\n${summary(calls)}` }
    if (!ran(calls, 'publish').length) return { tool: 'publish', args: plan.proposal }
    return { text: `完成。\n${summary(calls)}` }
  },
  reject(calls, branch) {
    if (!ran(calls, 'shell', 'e2e-change').length) return shell(`printf 'companion e2e ${branch}\\n' > e2e-change-${branch}.txt && echo wrote`)
    if (!ran(calls, 'publish_plan').length)
      return { tool: 'publish_plan', args: { title: `E2E ${branch}`, body: 'Synthetic change the owner rejects.', branch: `companion/${branch}`, base: 'main' } }
    const plan = planned(calls)
    if (plan?.status !== 'planned') return { text: `计划没有成功：\n${summary(calls)}` }
    const publishes = ran(calls, 'publish')
    // The companion pauses the task on the third person rejection; two spare calls show nothing more runs.
    if (publishes.length < 5 && !publishes.some(published)) return { tool: 'publish', args: plan.proposal }
    return { text: `停止。\n${summary(calls)}` }
  },
}

/** The judge's answer: one create per owner message, in the first workspace the snapshot offers. */
export function judgeReply(body) {
  const payload = objectAt(body, '{"snapshot"')
  if (!payload) return JSON.stringify({ decisions: [] })
  const workspace = payload.snapshot?.workspaces?.[0]
  const decisions = (payload.batch ?? [])
    .filter((item) => item.origin === 'owner')
    .map((item) => {
      const script = /\[e2e:(\w+)\]/.exec(item.text)?.[1] ?? 'task'
      return { kind: 'create', messages: [item.id], workspace, title: `E2E ${script} task` }
    })
  return JSON.stringify({ decisions })
}

/** @param {{ messages: any[], tools?: any[] }} body @returns {{ role: 'judge' | 'worker' | 'other', action: Action }} */
export function reply(body) {
  const all = body.messages.map((m) => text(m?.content)).join('\n')
  if (all.includes('{"snapshot"') && all.includes('"decisions"')) return { role: 'judge', action: { text: judgeReply(all) } }
  const task = /任务编号：(T-\d+)/.exec(all)?.[1]
  const script = /\[e2e:(\w+)\]/.exec(all)?.[1]
  if (task && script && SCRIPTS[script]) {
    const offered = new Set((body.tools ?? []).map((t) => t?.function?.name))
    const action = SCRIPTS[script](history(body.messages), task.toLowerCase())
    if ('tool' in action && !offered.has(action.tool))
      return { role: 'worker', action: { text: `工具 ${action.tool} 不在本会话里：${[...offered].join(', ')}` } }
    return { role: 'worker', action }
  }
  return { role: 'other', action: { text: 'E2E session' } }
}

/**
 * @param {{ log?: string }} [options] log = a JSONL file that gets every request and the reply to it
 */
export async function startModel({ log } = {}) {
  const apiKey = randomBytes(24).toString('hex')
  let count = 0
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    if (log && request.method === 'GET') appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), role: 'catalog', get: request.url })}\n`)
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] }))
      return
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      response.writeHead(400).end('not JSON')
      return
    }
    const n = ++count
    const { role, action } = reply(body)
    if (log) appendFileSync(log, `${JSON.stringify({ n, at: new Date().toISOString(), role, action, request: body })}\n`)
    const event = { id: `e2e-${n}`, object: 'chat.completion.chunk', created: 0, model: body.model }
    const delta =
      'tool' in action
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${n}`, type: 'function', function: { name: action.tool, arguments: JSON.stringify(action.args) } }] }
        : { role: 'assistant', content: action.text }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.end(
      `data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'tool' in action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    apiKey,
    model: MODEL,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return count
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve(undefined))
      }),
  }
}
