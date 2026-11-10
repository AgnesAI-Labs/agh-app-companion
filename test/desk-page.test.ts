// @vitest-environment happy-dom
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Desk, POLL_MS } from '../client/desk.js'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const AT = '2026-11-10T08:00:00.000Z'
const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `任务 ${id}`, workspace: 'api', state: 'running', reason: null, sessionId: `s-${id}`,
  session: { kind: 'active', flags: [] }, sessionState: 'ok', wait: null,
  usage: { tokens: 1200, cost: 0.5 }, budgetBase: { tokens: null, cost: null }, refusals: 0, generation: 0, resumed: 0,
  createdAt: '2026-11-10T07:00:00.000Z', updatedAt: '2026-11-10T07:30:00.000Z', endedAt: null,
  prUrl: null, prLink: null, queue: null, ...over,
})
const desk = (over: Record<string, any> = {}) => ({
  at: AT, running: true, canSubmit: true, submitBlock: null, problems: [], workspaces: ['api', 'web'],
  tasks: { needsYou: [], running: [], queued: [], paused: [], recent: [], older: [], olderTotal: 0, unknown: [] },
  cards: [], messages: [], judge: { backoff: null, waiting: 0 },
  usage: { today: null, caps: { dailyCost: null, taskCost: null, taskTokens: null, maxHops: 8 }, near: 0.8, top: [] },
  store: { ratio: 0.1, warn: false, full: false }, sessionsReadable: true, ...over,
})
const withTasks = (tasks: Record<string, unknown>, over: Record<string, any> = {}) =>
  desk({ tasks: { ...desk().tasks, ...tasks }, ...over })

function stub(initial: any) {
  let current = initial
  const services = {
    query: vi.fn(async (_name: string, input: unknown) => (typeof current === 'function' ? current(input) : current)),
    effect: vi.fn(async (_name: string, _input: unknown, _options: { operationId: string }) => ({ state: 'completed', operationId: 'x', output: { ok: true, result: 'accepted' } }) as any),
  }
  return { services, set: (next: any) => (current = next) }
}

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLElement
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
async function mount(initial: any, props: Record<string, unknown> = {}) {
  const s = stub(initial)
  const openSettings = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(React.createElement(Desk as any, { services: s.services, openSettings, ...props })))
  await flush()
  return { ...s, openSettings }
}
const $ = (selector: string) => host.querySelector(selector) as HTMLElement
const $$ = (selector: string) => [...host.querySelectorAll(selector)] as HTMLElement[]
const click = (el: Element | null) => act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const byText = (selector: string, text: string | RegExp) =>
  $$(selector).find((el) => (typeof text === 'string' ? el.textContent === text : text.test(el.textContent ?? ''))) as HTMLElement
const type = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })

beforeEach(() => {
  ;(HTMLFormElement.prototype as any).requestSubmit ??= function () {
    this.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: (() => { let n = 0; return () => `op-${++n}` })() }, configurable: true })
})
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('task desk page', () => {
  it('shows each state of a task with the one action it has', async () => {
    await mount(withTasks({
      needsYou: [task('T-0001', { state: 'waiting', wait: 'approval', session: { kind: 'active', flags: ['waitingOnApproval'] } }), task('T-0002', { state: 'waiting', wait: 'question' }), task('T-0003', { state: 'waiting', wait: 'unreadable', session: null, sessionState: 'missing' })],
      running: [task('T-0004')],
      queued: [{ workspace: 'api', tasks: [task('T-0005', { state: 'queued', sessionId: null, sessionState: 'none', session: null, queue: { holder: 'T-0004', position: 1 } })] }],
      paused: [task('T-0006', { state: 'paused', reason: 'sessionLost' }), task('T-0007', { state: 'paused', reason: 'budget', usage: { tokens: 10, cost: 7 }, budgetBase: { tokens: null, cost: 1 } })],
      recent: [task('T-0008', { state: 'done', endedAt: AT }), task('T-0009', { state: 'failed', reason: 'approvalExpired', endedAt: AT })],
      older: [task('T-0010', { state: 'abandoned', endedAt: AT })], olderTotal: 1,
      unknown: [task('T-0011', { state: 'mystery' })],
    }, { usage: { today: { date: '2026-11-10', basis: 'UTC', tokens: 4000, cost: 3.5, unknown: false }, caps: { dailyCost: 4, taskCost: 5, taskTokens: null, maxHops: 8 }, near: 0.8, top: [{ id: 'T-0004', tokens: null, cost: null }] } }))
    const link = (id: string) => ($(`[data-testid="go-${id}"]`) as HTMLAnchorElement)
    expect(link('T-0001').getAttribute('href')).toBe('/?session=s-T-0001')
    expect(link('T-0001').textContent).toBe('去批准')
    expect(link('T-0002').textContent).toBe('去会话回答')
    expect(link('T-0003').textContent).toBe('打开会话')
    expect($('[data-testid="wait-T-0001"]').textContent).toContain('批准在会话页里做')
    expect($('[data-testid="wait-T-0003"]').textContent).toContain('读不到会话状态')
    expect($('[data-testid="paused-T-0006"]').textContent).toContain('继续会开一个新会话')
    expect($('[data-testid="continue-T-0006"]').textContent).toBe('继续（开新会话）')
    expect($('[data-testid="paused-T-0007"]').textContent).toContain('已用 6.00，超过单任务上限 5.00')
    expect($('[data-testid="row-T-0005"]').textContent).toContain('排在 T-0004 后，第 1 个')
    expect($('[data-testid="retry-T-0009"]')).not.toBeNull()
    expect($('[data-testid="row-T-0011"]').textContent).toContain('状态未知')
    expect($('[data-testid="older"] [data-testid="row-T-0010"]')).not.toBeNull()
    expect($('[data-testid="older"]').hasAttribute('open')).toBe(false)
    // Usage: unknown is unknown, a cap shows how close the day is.
    expect($('[data-testid="usage"]').textContent).toContain('3.50 / 4.00')
    expect($('[data-testid="usage"]').textContent).toContain('接近上限')
    expect($('[data-testid="usage"]').textContent).toContain('T-0004未知')
    expect($('[data-testid="usage"]').textContent).not.toMatch(/元|¥|\$/)
  })

  it('has no approve button and never calls anything that decides an approval', async () => {
    const s = await mount(withTasks({ needsYou: [task('T-0001', { state: 'waiting', wait: 'approval' })], running: [task('T-0004')] }))
    const labels = $$('button,a').map((el) => el.textContent ?? '')
    expect($$('button').filter((b) => /批准|允许|同意|拒绝|approve|allow/i.test(b.textContent ?? ''))).toEqual([])
    expect(labels.filter((t) => /去批准/.test(t))).toEqual(['去批准'])
    expect($$('a').filter((a) => (a.textContent ?? '').includes('批准')).map((a) => a.getAttribute('href'))).toEqual(['/?session=s-T-0001'])
    expect($$('button').some((b) => /暂停/.test(b.textContent ?? ''))).toBe(false)
    await click($('[data-testid="more-T-0004"]'))
    expect($$('[role=menuitem]').map((el) => el.textContent)).toEqual(['打开会话', '详情与记录', '停止…'])
    expect(s.services.query.mock.calls.every(([name]) => name === 'companion.desk')).toBe(true)
    expect(s.services.effect).not.toHaveBeenCalled()
  })

  it('shows null usage as unknown and never as 0', async () => {
    await mount(withTasks({ running: [task('T-0001', { usage: { tokens: null, cost: null } })] }), {})
    await click($('[data-testid="row-T-0001"] .cp-row-main'))
    const drawer = $('[data-testid="drawer"]').textContent ?? ''
    expect(drawer).toContain('费用未知')
    expect(drawer).toContain('token未知')
    expect(drawer).toContain('“未知”是平台没报，不是零。')
    expect(drawer).not.toMatch(/费用0|token0/)
    expect($('[data-testid="usage"]').textContent).toContain('今天还没用')
  })

  it('renders every value that came from a task, a worker, a chat message or a remote as text', async () => {
    const bad = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>粗</b>'
    const s = await mount(withTasks({
      running: [task('T-0001', { title: bad })],
      recent: [task('T-0002', { state: 'done', title: bad, endedAt: AT, prUrl: `https://git.example.test/o/r/pull/9?x=${bad}`, prLink: null })],
    }, {
      cards: [{ key: 'card:1', kind: 'handback', text: bad, detail: `原因：${bad}`, original: bad, options: [{ taskId: 'T-0001', title: bad }], allowNew: true, at: AT, sentAt: null }],
      messages: [{ key: 'inbox/desk:1', text: bad, at: AT, state: 'answered', taskIds: [], replies: [{ text: bad, at: AT, sent: true }] }],
      problems: [{ kind: 'refusal', text: bad, code: bad, workspace: bad, role: 'worker', missing: null, taskIds: [], at: AT }],
    }))
    s.set(withTasks({ recent: [task('T-0002', { state: 'done', title: bad, endedAt: AT, prUrl: 'https://x.example.test/p', prLink: null })] }))
    const html = host.innerHTML
    expect(host.querySelector('img,script,b')).toBeNull()
    expect(html).toContain('&lt;img src=x onerror="alert(1)"&gt;')
    expect(host.textContent).toContain(bad)
    // The drawer's note, brief and timeline are text too.
    s.set(withTasks({ recent: [task('T-0002', { state: 'done', title: bad, endedAt: AT })] }, {
      detail: { ...task('T-0002', { state: 'done', title: bad, endedAt: AT }), brief: bad, briefHash: 'a'.repeat(64), note: bad, compacted: null, events: [{ at: AT, kind: 'state', event: 'x', from: 'running', to: 'done', reason: null, by: null, unquoted: false, note: bad }] },
    }))
    await click($('[data-testid="row-T-0002"] .cp-row-main'))
    expect(host.querySelector('img,script,b')).toBeNull()
    expect($('[data-testid="drawer"]').textContent).toContain(bad)
  })

  it('links a PR only when the server says it is the task\'s repository\'s pull request page', async () => {
    const s = await mount(withTasks({ recent: [task('T-0001', { state: 'done', endedAt: AT, prUrl: 'https://evil.example.test/o/r/pull/9', prLink: null })] }))
    expect(host.querySelectorAll('a[href^="http"]')).toHaveLength(0)
    expect($('[data-testid="pr-T-0001"]')).toBeNull()
    await click($('[data-testid="row-T-0001"] .cp-row-main'))
    expect($('[data-testid="drawer"]').textContent).toContain('https://evil.example.test/o/r/pull/9')
    expect($('[data-testid="drawer"]').textContent).toContain('没有当链接')
    expect($('[data-testid="drawer"] a[href^="http"]')).toBeNull()
    // A server value that is not an https page is not a link either.
    s.set(withTasks({ recent: [task('T-0001', { state: 'done', endedAt: AT, prUrl: 'javascript:alert(1)', prLink: 'javascript:alert(1)' })] }))
    await click($('[data-testid="refresh"]'))
    expect(host.querySelectorAll('a[href^="javascript"]')).toHaveLength(0)
    expect($('[data-testid="pr-T-0001"]')).toBeNull()
    s.set(withTasks({ recent: [task('T-0001', { state: 'done', endedAt: AT, prUrl: 'https://git.example.test/o/r/pull/9', prLink: 'https://git.example.test/o/r/pull/9' })] }))
    await click($('[data-testid="refresh"]'))
    const pr = $('[data-testid="pr-T-0001"]') as HTMLAnchorElement
    expect(pr.getAttribute('href')).toBe('https://git.example.test/o/r/pull/9')
    expect(pr.getAttribute('rel')).toBe('noreferrer noopener')
  })

  it('asks before stopping, says it cannot be undone, and sends nothing on cancel', async () => {
    const s = await mount(withTasks({ running: [task('T-0001')] }))
    await click($('[data-testid="more-T-0001"]'))
    await click($('[data-testid="stop-T-0001"]'))
    expect($('[role=alertdialog]').textContent).toContain('不能再重开')
    expect(s.services.effect).not.toHaveBeenCalled()
    await click(byText('[role=alertdialog] button', '不停'))
    expect($('[role=alertdialog]')).toBeNull()
    expect(s.services.effect).not.toHaveBeenCalled()
    await click($('[data-testid="more-T-0001"]'))
    await click($('[data-testid="stop-T-0001"]'))
    const reads = s.services.query.mock.calls.length
    await click($('[data-testid="stop-confirm"]'))
    await flush()
    expect(s.services.effect).toHaveBeenCalledWith('companion.submit', { kind: 'button', action: 'stop', taskId: 'T-0001' }, { operationId: expect.any(String) })
    expect(s.services.query.mock.calls.length).toBeGreaterThan(reads)
  })

  it('continues a paused task with the continue button and re-reads', async () => {
    const s = await mount(withTasks({ paused: [task('T-0001', { state: 'paused', reason: 'refused', refusals: 3 })] }))
    expect($('[data-testid="paused-T-0001"]').textContent).toContain('审批连续 3 次没有看到批准')
    const reads = s.services.query.mock.calls.length
    await click($('[data-testid="continue-T-0001"]'))
    await flush()
    expect(s.services.effect).toHaveBeenCalledWith('companion.submit', { kind: 'button', action: 'continue', taskId: 'T-0001' }, { operationId: expect.any(String) })
    expect(s.services.query.mock.calls.length).toBeGreaterThan(reads)
  })

  it('retries a failed task and reopens a done one as a reply to it', async () => {
    const s = await mount(withTasks({ recent: [task('T-0001', { state: 'failed', reason: 'sessionFailed', endedAt: AT }), task('T-0002', { state: 'done', endedAt: AT })] }))
    await click($('[data-testid="retry-T-0001"]'))
    expect(($('#cp-ro') as HTMLTextAreaElement).value).toBe('按原来的要求再试一次。')
    await click($('[data-testid="reopen-send"]'))
    await flush()
    expect(s.services.effect).toHaveBeenLastCalledWith('companion.submit', { kind: 'message', text: '按原来的要求再试一次。', replyTo: 'T-0001' }, { operationId: expect.any(String) })
    await click($('[data-testid="more-T-0002"]'))
    await click(byText('[role=menuitem]', '重开…'))
    expect(($('#cp-ro') as HTMLTextAreaElement).value).toBe('')
    expect(($('[data-testid="reopen-send"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends a message with only its text, keeps the draft when it fails, and retries under the same operation id', async () => {
    const s = await mount(withTasks({ running: [task('T-0001')] }))
    const area = $('#cp-cmp') as HTMLTextAreaElement
    await type(area, '给 api 仓修登录')
    s.services.effect.mockRejectedValueOnce(new Error('offline'))
    await click($('[data-testid="send"]'))
    await flush()
    expect(area.value).toBe('给 api 仓修登录')
    expect(host.textContent).toContain('再点一次不会重复发')
    await click($('[data-testid="send"]'))
    await flush()
    const ids = s.services.effect.mock.calls.map((c) => c[2].operationId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(s.services.effect.mock.calls.map((c) => c[1])).toEqual([{ kind: 'message', text: '给 api 仓修登录' }, { kind: 'message', text: '给 api 仓修登录' }])
    expect(area.value).toBe('')
    await type(area, '再来一条')
    await click($('[data-testid="send"]'))
    await flush()
    expect(s.services.effect.mock.calls.at(-1)![2].operationId).not.toBe(ids[0])
  })

  it('inserts a workspace name from its chip and shows what the engine answered', async () => {
    await mount(withTasks({}, { messages: [{ key: 'inbox/desk:1', text: '现在有几个任务？', at: AT, state: 'answered', taskIds: [], replies: [{ text: '现在有 0 个任务', at: AT, sent: true }] }, { key: 'inbox/desk:2', text: '修登录', at: AT, state: 'judging', taskIds: [], replies: [] }] }))
    await click(byText('.cp-chip', 'web'))
    expect(($('#cp-cmp') as HTMLTextAreaElement).value).toBe('web ')
    const replies = $('[data-testid="replies"]').textContent ?? ''
    expect(replies).toContain('现在有 0 个任务')
    expect(replies).toContain('在想…')
  })

  it('turns the composer off with the reason', async () => {
    await mount(withTasks({}, { canSubmit: false, submitBlock: 'store-full' }))
    expect(($('#cp-cmp') as HTMLTextAreaElement).disabled).toBe(true)
    expect($('#cp-cmp-hint').textContent).toBe('存储快满了，先不新建任务。清理旧任务后再试。')
  })

  it('answers a choice card with the card and the pick, and says when the phone has it too', async () => {
    const s = await mount(withTasks({ running: [task('T-0001'), task('T-0002')] }, {
      cards: [{ key: 'card:inbox/desk:1:0', kind: 'ask', text: '这条要接到哪个任务？', detail: null, original: '再改一下', options: [{ taskId: 'T-0001', title: '修登录' }, { taskId: 'T-0002', title: '改样式' }], allowNew: true, at: AT, sentAt: AT }],
    }))
    const text = $('[data-testid="choice-card"]').textContent ?? ''
    expect(text).toContain('你说：再改一下')
    expect(text).toContain('手机上也有这张卡，先点的算')
    await click($('[data-testid="pick-T-0002"]'))
    await flush()
    expect(s.services.effect).toHaveBeenCalledWith('companion.submit', { kind: 'choice', card: 'card:inbox/desk:1:0', pick: 'T-0002' }, { operationId: expect.any(String) })
    await click($('[data-testid="pick-new"]'))
    await flush()
    expect(s.services.effect.mock.calls.at(-1)![1]).toEqual({ kind: 'choice', card: 'card:inbox/desk:1:0', pick: 'new' })
  })

  it('shows a refused submit as the reason, not as sent', async () => {
    const s = await mount(withTasks({ running: [task('T-0001')] }, { cards: [{ key: 'c', kind: 'ask', text: '问', detail: null, original: null, options: [{ taskId: 'T-0001', title: 'x' }], allowNew: false, at: AT, sentAt: null }] }))
    s.services.effect.mockResolvedValueOnce({ state: 'completed', operationId: 'x', output: { ok: false, code: 'card-answered', text: '这张卡片已经有人选过了。' } } as any)
    await click($('[data-testid="pick-T-0001"]'))
    await flush()
    expect($('.cp-toasts').textContent).toContain('这张卡片已经有人选过了。')
    expect($('[data-testid="choice-card"]').textContent).toContain('还没送到手机，可以在这里先选')
  })

  it('shows one status with its one action, and only the status when the engine is not running', async () => {
    const s = await mount(desk({
      running: false, canSubmit: false, submitBlock: 'not-running',
      problems: [{ kind: 'settings', missing: ['ownerName', 'channelInstance'], text: 'x' }],
    }))
    expect($('[data-testid="status-settings"] h3').textContent).toBe('还差 2 项设置，伴侣才能接活')
    expect($$('[data-testid="status-settings"] li').map((li) => li.textContent)).toEqual(['称呼：还没填', '可用工作区（短名=路径）', '专用工作区（主脑判断用）', '手机聊天渠道实例：还没填'])
    expect($('#cp-cmp')).toBeNull()
    expect($('[data-testid="usage"]')).toBeNull()
    await click(byText('[data-testid="status-settings"] button', '去伴侣设置'))
    expect(s.openSettings).toHaveBeenCalledOnce()
  })

  it.each([
    ['capability', { kind: 'capability', missing: 'managedSessions', text: 'this host does not provide plugin-managed sessions' }, '这台 AGH 缺少伴侣需要的能力', false],
    ['owner', { kind: 'owner', text: 'this store was used with owner a' }, '这份伴侣数据属于另一位主人', false],
    ['engine', { kind: 'engine', unavailable: true, text: 'companion store format 2 is newer than this build (1); upgrade the companion. Nothing was changed.' }, '伴侣数据比这个版本新', false],
    ['model', { kind: 'model', roles: ['judge'], text: 'a model route is set' }, '设置里的模型路由伴侣还不能用', true],
    ['channel', { kind: 'channel', text: 'channel instance im-1 has no bound owner' }, '手机聊天渠道还没绑定你的账号', true],
  ])('says the %s problem in words, with the engine\'s text under technical details', async (id, problem, title, action) => {
    const s = await mount(desk({ running: id === 'model' || id === 'channel', problems: [problem] }))
    expect($(`[data-testid="status-${id}"] h3`).textContent).toBe(title)
    expect($(`[data-testid="status-${id}"] code`).textContent).toBe((problem as any).text)
    expect($$(`[data-testid="status-${id}"] button`)).toHaveLength(action ? 1 : 0)
    if (action) {
      await click($(`[data-testid="status-${id}"] button`))
      expect(s.openSettings).toHaveBeenCalledOnce()
    }
  })

  it('keeps working without a chat channel, and turns off for a rebound one', async () => {
    await mount(withTasks({ running: [task('T-0001')] }, { problems: [{ kind: 'channel', text: 'the chat channel gateway is not available on this platform; the companion runs without a channel' }] }))
    expect($('[data-testid="status-channel"] h3').textContent).toBe('手机聊天渠道还没接上')
    expect(($('#cp-cmp') as HTMLTextAreaElement).disabled).toBe(false)
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mount(withTasks({}, {
      canSubmit: false, submitBlock: 'rebound',
      problems: [{ kind: 'channel', text: 'channel instance im-1 was rebound to another owner; restart the companion service to serve the new owner' }],
      cards: [{ key: 'c', kind: 'ask', text: '问', detail: null, original: null, options: [{ taskId: 'T-0001', title: 'x' }], allowNew: true, at: AT, sentAt: null }],
    }))
    expect($('[data-testid="status-channel"] h3').textContent).toContain('已停止收发')
    expect($('[data-testid="choice-card"]').textContent).toContain('渠道换绑期间先不能选')
    expect($$('[data-testid^="pick-"]')).toHaveLength(0)
  })

  it('opens a task\'s detail with a query for that task and shows the frozen words and the record', async () => {
    const t = task('T-0001', { state: 'done', endedAt: AT })
    const detail = { ...t, brief: '给 api 仓修登录', briefHash: 'abcdef0123456789'.repeat(4), note: '改好了', compacted: { events: 4, firstAt: AT, lastAt: AT }, events: [{ at: AT, kind: 'created', event: null, from: null, to: null, reason: null, by: 'owner', unquoted: false, note: null }, { at: AT, kind: 'state', event: 'sessionCompleted', from: 'running', to: 'done', reason: null, by: null, unquoted: false, note: null }] }
    const s = await mount((input?: { taskId?: string }) => withTasks({ recent: [t] }, input?.taskId ? { detail } : {}))
    expect(s.services.query).toHaveBeenLastCalledWith('companion.desk', {})
    await click($('[data-testid="row-T-0001"] .cp-row-main'))
    await flush()
    expect(s.services.query).toHaveBeenLastCalledWith('companion.desk', { taskId: 'T-0001' })
    const drawer = $('[data-testid="drawer"]').textContent ?? ''
    expect(drawer).toContain('给 api 仓修登录')
    expect(drawer).toContain('校验 abcdef01')
    expect(drawer).toContain('改好了')
    expect(drawer).toContain('执行会话写的')
    expect(drawer).toContain('更早的 4 条记录已合并')
    expect(drawer).toContain('你派的活，任务建好')
    expect(drawer).toContain('进行中 → 完成')
    await click($('[data-testid="drawer-close"]'))
    expect($('[data-testid="drawer"]')).toBeNull()
    await flush()
    expect(s.services.query).toHaveBeenLastCalledWith('companion.desk', {})
  })

  it('reads again every 10 seconds, keeps the last screen when a read fails, and uses only the latest read', async () => {
    vi.useFakeTimers()
    const first = withTasks({ running: [task('T-0001')] })
    const s = await mount(first)
    expect(s.services.query).toHaveBeenCalledTimes(1)
    s.set(withTasks({ running: [task('T-0001'), task('T-0002')] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    expect($$('[data-testid^="row-"]')).toHaveLength(2)
    s.services.query.mockRejectedValueOnce(new Error('down'))
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    expect($$('[data-testid^="row-"]')).toHaveLength(2)
    expect($('[data-testid="health"]').textContent).toContain('读取失败，保留')
    // A slow read that started first must not overwrite a faster one started later.
    let release: (value: unknown) => void = () => {}
    s.services.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS) })
    s.services.query.mockResolvedValueOnce(withTasks({ running: [task('T-0003')] }))
    await click($('[data-testid="refresh"]'))
    expect($$('[data-testid^="row-"]').map((el) => el.getAttribute('data-testid'))).toEqual(['row-T-0003'])
    await act(async () => release(withTasks({ running: [task('T-0001')] })))
    expect($$('[data-testid^="row-"]').map((el) => el.getAttribute('data-testid'))).toEqual(['row-T-0003'])
  })
})
