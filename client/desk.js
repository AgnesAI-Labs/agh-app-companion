import React from 'react'
import {
  ago, clock, dispositionText, eventText, failedWhy, fmtCost, fmtTokens, pausedWhy, prHref, problemView, queueText,
  SESSION_KIND, sessionHref, stateLabel, stateOf, SUBMIT_BLOCK,
} from './desk-text.js'

/**
 * The companion task desk. It reads one query (`companion.desk`) and sends the owner's inputs through
 * one effect (`companion.submit`); it never writes a task, never calls an approval API and takes no
 * input from a worker session, a chat message or a remote as markup: every such value is a text node.
 * `services` is the profile services object; `openSettings` opens the companion's settings page.
 */
const h = React.createElement
export const POLL_MS = 10_000
const message = (error) => (error instanceof Error ? error.message : String(error))

const ICON = {
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  slash: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
}
/** The icon strings are this file's own constants; they are turned into elements, never into markup. */
const PARTS = Object.fromEntries(
  Object.entries(ICON).map(([name, source]) => [
    name,
    [...source.matchAll(/<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*\/>/g)].map(([, tag, attrs]) => [
      tag,
      Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])),
    ]),
  ]),
)
const Icon = ({ name }) =>
  h('svg', { className: 'cp-i', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, (PARTS[name] ?? []).map(([tag, attrs], i) => h(tag, { key: i, ...attrs })))

const list = (value) => (Array.isArray(value) ? value : [])

/** Query on open, every 10 s while the page is visible, after every action; only the latest-started read is used. */
export function useDesk(services, openId) {
  const [state, setState] = React.useState({ data: null, failed: false })
  const latest = React.useRef(0)
  const alive = React.useRef(true)
  const open = React.useRef(openId)
  open.current = openId
  const load = React.useCallback(async () => {
    const mine = ++latest.current
    try {
      const data = await services.query('companion.desk', open.current ? { taskId: open.current } : {})
      if (alive.current && mine === latest.current) setState({ data, failed: false })
    } catch {
      if (alive.current && mine === latest.current) setState((s) => ({ ...s, failed: true }))
    }
  }, [services])
  React.useEffect(() => {
    alive.current = true
    void load()
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load()
    }, POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [load])
  const first = React.useRef(true)
  React.useEffect(() => {
    if (first.current) first.current = false
    else void load()
  }, [openId, load])
  return { ...state, reload: load, lastGood: state.data?.at ?? null }
}

/** One owner input as one effect. A retry of the identical input after a lost answer reuses its operation id. */
export function useSubmit(services, reload) {
  const attempt = React.useRef(null)
  return React.useCallback(
    async (input) => {
      const json = JSON.stringify(input)
      const operationId = attempt.current?.json === json ? attempt.current.id : crypto.randomUUID()
      attempt.current = { json, id: operationId }
      try {
        const receipt = await services.effect('companion.submit', input, { operationId })
        const state = receipt?.state ?? 'completed'
        if (state === 'completed') {
          attempt.current = null
          const out = receipt.output ?? {}
          return out.ok === false ? { ok: false, text: typeof out.text === 'string' ? out.text : '没有发出。' } : { ok: true }
        }
        if (state === 'refused' || state === 'cancelled') {
          attempt.current = null
          return { ok: false, text: `没有发出（${state}${receipt.code ? `：${receipt.code}` : ''}）。` }
        }
        if (state === 'approval-required') return { ok: false, text: '这一步需要批准，批准后再点一次。' }
        return { ok: false, text: '结果还没确认，稍后刷新看一眼。再点一次不会重复发。' }
      } catch (error) {
        return { ok: false, text: `没发出去：${message(error)}。再点一次不会重复发。` }
      } finally {
        await reload()
      }
    },
    [services, reload],
  )
}

function Tag({ task }) {
  const s = stateOf(task)
  return h('span', { className: `cp-tag cp-tone-${s.tone}` }, h(Icon, { name: s.icon }), stateLabel(task))
}

function SessionLink({ task, label, primary, icon = 'terminal', testid }) {
  const href = sessionHref(task)
  const cls = `cp-btn${primary ? ' cp-primary' : ''}`
  if (!href)
    return h('button', { type: 'button', className: cls, disabled: true, title: '还没开会话', 'data-testid': testid }, h(Icon, { name: icon }), label)
  return h('a', { className: cls, href, 'data-testid': testid }, h(Icon, { name: icon }), label)
}

/** Closes on Escape and on a click elsewhere, returns focus to the opener, and keeps Tab inside. */
function Modal({ label, role = 'dialog', className, onClose, children }) {
  const box = React.useRef(null)
  React.useEffect(() => {
    const opener = document.activeElement
    const node = box.current
    const first = node?.querySelector('[data-autofocus]') ?? node?.querySelector('button,a,textarea')
    if (first) first.focus()
    return () => {
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus()
    }
  }, [])
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
    if (event.key !== 'Tab' || !box.current) return
    const items = [...box.current.querySelectorAll('button:not([disabled]),a[href],textarea,input')]
    const head = items.at(0)
    const tail = items.at(-1)
    if (!head || !tail) return
    if (event.shiftKey && document.activeElement === head) {
      event.preventDefault()
      tail.focus()
    } else if (!event.shiftKey && document.activeElement === tail) {
      event.preventDefault()
      head.focus()
    }
  }
  return h(
    React.Fragment,
    null,
    h('div', { className: 'cp-scrim', onClick: onClose }),
    h('div', { ref: box, className, role, 'aria-modal': 'true', 'aria-labelledby': label, onKeyDown }, children),
  )
}

function More({ task, onDetail, onReopen, onStop }) {
  const [open, setOpen] = React.useState(false)
  const wrap = React.useRef(null)
  React.useEffect(() => {
    if (!open) return undefined
    const away = (event) => {
      if (wrap.current && !wrap.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const pick = (fn) => () => {
    setOpen(false)
    fn()
  }
  const href = sessionHref(task)
  const unfinished = ['queued', 'running', 'waiting', 'paused'].includes(task.state)
  return h(
    'span',
    {
      className: 'cp-menu-wrap', ref: wrap,
      onKeyDown: (event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setOpen(false)
          wrap.current?.querySelector('[aria-haspopup]')?.focus()
        }
      },
    },
    h('button', {
      type: 'button', className: 'cp-icon-btn', 'aria-haspopup': 'menu', 'aria-expanded': open,
      'aria-label': `${task.id} 更多操作`, onClick: () => setOpen(!open), 'data-testid': `more-${task.id}`,
    }, h(Icon, { name: 'more' })),
    open &&
      h(
        'div',
        { className: 'cp-menu', role: 'menu', 'aria-label': `${task.id} 操作` },
        href
          ? h('a', { role: 'menuitem', href }, h(Icon, { name: 'terminal' }), '打开会话')
          : h('button', { type: 'button', role: 'menuitem', 'aria-disabled': 'true', disabled: true }, h(Icon, { name: 'terminal' }), '打开会话（还没开会话）'),
        h('button', { type: 'button', role: 'menuitem', onClick: pick(onDetail) }, h(Icon, { name: 'info' }), '详情与记录'),
        task.state === 'done' && h('button', { type: 'button', role: 'menuitem', onClick: pick(onReopen) }, h(Icon, { name: 'refresh' }), '重开…'),
        unfinished && h('hr'),
        unfinished && h('button', { type: 'button', role: 'menuitem', className: 'cp-danger', onClick: pick(onStop), 'data-testid': `stop-${task.id}` }, h(Icon, { name: 'slash' }), '停止…'),
      ),
  )
}

function Primary({ task, act }) {
  const open = (label, primary) => h('button', { type: 'button', className: `cp-btn${primary ? ' cp-primary' : ''}`, onClick: () => act.detail(task.id) }, label)
  switch (task.state) {
    case 'running':
      return h(SessionLink, { task, label: '打开会话' })
    case 'queued':
      return open('详情')
    case 'done': {
      const href = prHref(task)
      return href
        ? h('a', { className: 'cp-btn cp-primary', href, target: '_blank', rel: 'noreferrer noopener', 'data-testid': `pr-${task.id}` }, h(Icon, { name: 'ext' }), '查看 PR')
        : h(SessionLink, { task, label: '打开会话' })
    }
    case 'failed':
      return h('button', { type: 'button', className: 'cp-btn cp-primary', onClick: () => act.reopen(task.id), 'data-testid': `retry-${task.id}` }, '重试')
    case 'waiting':
      return h(SessionLink, {
        task, primary: true, icon: 'ext', testid: `go-${task.id}`,
        label: task.wait === 'approval' ? '去批准' : task.wait === 'question' ? '去会话回答' : '打开会话',
      })
    case 'paused':
      return h('button', { type: 'button', className: 'cp-btn cp-primary', onClick: () => act.proceed(task.id), 'data-testid': `continue-${task.id}` }, '继续')
    case 'abandoned':
      return null
    default:
      return h(SessionLink, { task, label: '打开会话' })
  }
}

function Row({ task, now, act }) {
  const meta = [
    h('span', { key: 'ws', className: 'cp-ws' }, task.workspace),
    h(Tag, { key: 'tag', task }),
  ]
  const queue = queueText(task)
  if (queue) meta.push(h('span', { key: 'q' }, queue))
  if (task.state === 'done' && !task.prUrl) meta.push(h('span', { key: 'nopr' }, '没有 PR 链接'))
  meta.push(h('span', { key: 'at', title: task.updatedAt }, ago(task.updatedAt, now)))
  return h(
    'div',
    { className: 'cp-row', role: 'listitem', 'data-testid': `row-${task.id}` },
    h(
      'button',
      { type: 'button', className: 'cp-row-main', onClick: () => act.detail(task.id), 'aria-label': `${task.id} ${task.title}，${stateOf(task).text}，打开详情` },
      h('span', { className: 'cp-row-t' }, h('span', { className: 'cp-id' }, task.id), h('span', { className: 'cp-title' }, task.title)),
      h('span', { className: 'cp-row-m' }, meta),
    ),
    h('div', { className: 'cp-row-a' }, h(Primary, { task, act }), h(More, { task, onDetail: () => act.detail(task.id), onReopen: () => act.reopen(task.id), onStop: () => act.stop(task.id) })),
  )
}

function CardHead({ task, tag }) {
  return h('div', { className: 'cp-card-h' }, h('span', { className: 'cp-mono cp-muted' }, task.id), h('span', { className: 'cp-ws' }, task.workspace), h('span', { className: 'cp-title' }, task.title), tag)
}

function WaitingCard({ task, now, act }) {
  const approval = task.wait === 'approval'
  const tag = h('span', { className: 'cp-tag cp-tone-warn' }, h(Icon, { name: 'hand' }), approval ? '等你批准' : task.wait === 'question' ? '等你回答' : '等你')
  return h(
    'article',
    { className: 'cp-card', 'aria-label': `${task.id} ${approval ? '等你批准' : '等你回答'}`, 'data-testid': `wait-${task.id}` },
    h(CardHead, { task, tag }),
    approval
      ? h('p', null, '要把改动推送到远端并开 PR。批准在会话页里做，这里只给入口，也不显示要批准的内容。')
      : task.wait === 'question'
        ? h('p', null, '执行会话在等你回答，打开会话查看问题。')
        : h('p', null, task.sessionState === 'unreadable' ? '在等你，但读不到会话状态，打开会话看看。' : '在等你，但读不到会话状态。打开会话看看。'),
    h('div', { className: 'cp-acts' },
      h(SessionLink, { task, primary: true, icon: 'ext', testid: `go-${task.id}`, label: approval ? '去批准' : task.wait === 'question' ? '去会话回答' : '打开会话' }),
      h('span', { className: 'cp-muted' }, ago(task.updatedAt, now)),
      h(More, { task, onDetail: () => act.detail(task.id), onReopen: () => act.reopen(task.id), onStop: () => act.stop(task.id) })),
  )
}

function PausedCard({ task, now, act, usage }) {
  return h(
    'article',
    { className: 'cp-card', 'aria-label': `${task.id} 已暂停`, 'data-testid': `paused-${task.id}` },
    h(CardHead, { task, tag: h(Tag, { task }) }),
    h('p', null, pausedWhy(task, usage)),
    h('div', { className: 'cp-acts' },
      h('button', { type: 'button', className: 'cp-btn cp-primary', onClick: () => act.proceed(task.id), 'data-testid': `continue-${task.id}` }, task.reason === 'sessionLost' ? '继续（开新会话）' : '继续'),
      h('span', { className: 'cp-muted' }, ago(task.updatedAt, now)),
      h(More, { task, onDetail: () => act.detail(task.id), onReopen: () => act.reopen(task.id), onStop: () => act.stop(task.id) })),
  )
}

function ChoiceCard({ card, now, act, disabled }) {
  const heading = card.kind === 'handback' ? '退回了一条消息' : '伴侣问你'
  const tag = h('span', { className: 'cp-tag cp-tone-warn' }, h(Icon, { name: 'hand' }), heading)
  return h(
    'article',
    { className: 'cp-card', 'aria-label': heading, 'data-testid': 'choice-card' },
    h('div', { className: 'cp-card-h' }, tag, h('span', { className: 'cp-title' }, card.text)),
    card.original ? h('div', { className: 'cp-quote' }, `你说：${card.original}`) : null,
    card.detail ? h('p', null, card.detail, h('span', { className: 'cp-muted' }, '（执行会话写的）')) : null,
    disabled
      ? h('p', null, '渠道换绑期间先不能选，重启伴侣服务后再选。')
      : h('div', { className: 'cp-picks', role: 'group', 'aria-label': '选一个' },
          list(card.options).map((o) =>
            h('button', { key: o.taskId, type: 'button', className: 'cp-btn', onClick: () => act.pick(card.key, o.taskId), 'data-testid': `pick-${o.taskId}` }, `接到 ${o.taskId} ${o.title}`)),
          card.allowNew ? h('button', { type: 'button', className: 'cp-btn', onClick: () => act.pick(card.key, 'new'), 'data-testid': 'pick-new' }, '新建任务') : null),
    h('p', { className: 'cp-muted' }, card.sentAt ? `手机上也有这张卡，先点的算。${ago(card.at, now)}` : '还没送到手机，可以在这里先选。'),
  )
}

function Status({ problem, openSettings }) {
  const v = problemView(problem)
  return h(
    'div',
    { className: `cp-banner cp-${v.tone}`, role: v.tone === 'bad' ? 'alert' : 'status', 'data-testid': `status-${v.id}` },
    h(Icon, { name: v.icon }),
    h('h3', null, v.title),
    h('p', null, v.body),
    v.checklist
      ? h('ul', { className: 'cp-checklist' }, v.checklist.map((item) => h('li', { key: item.label, className: item.done ? 'cp-done' : 'cp-todo' }, h(Icon, { name: item.done ? 'check' : 'alert' }), item.done ? item.label : `${item.label}：还没填`)))
      : null,
    v.action ? h('div', { className: 'cp-acts' }, h('button', { type: 'button', className: 'cp-btn cp-primary', onClick: openSettings }, v.action.label)) : null,
    v.tech ? h('details', { className: 'cp-tech' }, h('summary', null, '技术详情'), h('code', null, v.tech)) : null,
  )
}

function Exchange({ m, waiting }) {
  const replies = list(m.replies)
  const answer = m.state === 'judging'
    ? h('span', { className: 'cp-muted' }, waiting)
    : replies.length
      ? replies.map((r, i) => h('div', { key: i }, r.text))
      : h('span', { className: 'cp-muted' }, dispositionText(m.state, m.taskIds))
  return h('div', { className: 'cp-reply' }, h('span', { className: 'cp-who' }, '你'), h('span', null, m.text), h('span', { className: 'cp-who' }, '伴侣'), h('span', null, answer))
}

function Composer({ data, onSend }) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState('')
  const area = React.useRef(null)
  const blocked = !data.canSubmit
  const send = async () => {
    const body = text.trim()
    if (!body || blocked || sending) return
    setSending(true)
    setError('')
    const result = await onSend({ kind: 'message', text: body })
    setSending(false)
    if (result.ok) setText('')
    else setError(result.text)
  }
  const chip = (name) => {
    setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}${name} `)
    area.current?.focus()
  }
  const waiting = data.judge?.backoff ? '排队中，判断模型恢复后处理' : '在想…'
  return h(
    'section',
    { className: 'cp-sec', 'aria-labelledby': 'cp-new-h' },
    h('h2', { id: 'cp-new-h' }, '派活或提问'),
    h('form', { className: 'cp-composer', onSubmit: (e) => { e.preventDefault(); void send() } },
      h('label', { className: 'cp-sr', htmlFor: 'cp-cmp' }, '告诉伴侣要做什么'),
      h('textarea', {
        id: 'cp-cmp', ref: area, rows: 2, value: text, disabled: blocked, 'aria-describedby': 'cp-cmp-hint', maxLength: 4000,
        placeholder: '例如：给 api 仓的登录接口加限流并开 PR',
        onChange: (e) => setText(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          }
        },
      }),
      h('div', { className: 'cp-composer-row' },
        h('span', { className: 'cp-muted' }, '工作区'),
        list(data.workspaces).map((name) => h('button', { key: name, type: 'button', className: 'cp-chip', disabled: blocked, onClick: () => chip(name), 'aria-label': `插入工作区 ${name}` }, name)),
        h('button', { type: 'submit', className: 'cp-btn cp-primary cp-send', disabled: blocked || sending || !text.trim(), 'data-testid': 'send' }, h(Icon, { name: 'send' }), '发送'))),
    h('p', { className: 'cp-hint', id: 'cp-cmp-hint' }, blocked ? (SUBMIT_BLOCK[data.submitBlock] ?? '这里先不能发。') : '按 ⌘/Ctrl + Enter 发送。写上任务编号（如 T-0045）会直接接到那个任务。伴侣的回复也会发到你的手机。'),
    error ? h('p', { className: 'cp-hint', role: 'alert' }, error) : null,
    list(data.messages).length
      ? h('div', { className: 'cp-replies', 'aria-live': 'polite', 'data-testid': 'replies' }, list(data.messages).slice().reverse().map((m) => h(Exchange, { key: m.key, m, waiting })))
      : null,
  )
}

function Meter({ label, used, cap, near }) {
  if (cap == null)
    return h('div', { className: 'cp-meter' }, h('div', { className: 'cp-lab' }, h('span', null, label), h('b', null, fmtCost(used))), h('div', { className: 'cp-muted' }, '未设上限'))
  const ratio = typeof used === 'number' && cap > 0 ? used / cap : 0
  const close = ratio >= near
  return h('div', { className: 'cp-meter' },
    h('div', { className: 'cp-lab' }, h('span', null, label), h('b', null, `${fmtCost(used)} / ${fmtCost(cap)}`)),
    h('div', { className: `cp-bar${close ? ' cp-near' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': cap, 'aria-valuenow': typeof used === 'number' ? used : 0, 'aria-label': label }, h('i', { style: { width: `${Math.min(100, ratio * 100).toFixed(0)}%` } })),
    close ? h('span', { className: 'cp-tag cp-tone-warn' }, h(Icon, { name: 'alert' }), `已用 ${(ratio * 100).toFixed(0)}%，接近上限`) : null)
}

function Usage({ usage }) {
  const today = usage?.today ?? null
  const caps = usage?.caps ?? {}
  const near = usage?.near ?? 0.8
  const top = list(usage?.top)
  return h('section', { className: 'cp-panel', 'aria-labelledby': 'cp-bud-h', 'data-testid': 'usage' },
    h('h2', { id: 'cp-bud-h' }, '今天的用量'),
    today
      ? h(React.Fragment, null,
          h(Meter, { label: '费用', used: today.cost, cap: caps.dailyCost, near }),
          h('div', { className: 'cp-meter' }, h('div', { className: 'cp-lab' }, h('span', null, 'token'), h('b', null, fmtTokens(today.tokens)))),
          today.unknown ? h('p', { className: 'cp-muted' }, '有会话没报用量，实际至少是上面的数。') : null)
      : h('p', { className: 'cp-muted', style: { margin: 0 } }, '今天还没用'),
    h('p', { className: 'cp-muted' }, '按 UTC 日期，北京时间 8 点换日。'),
    h('h2', { style: { marginTop: 12 } }, '用得最多的未结束任务'),
    h('dl', { className: 'cp-kv' },
      top.length
        ? top.map((t) => h(React.Fragment, { key: t.id }, h('dt', null, t.id), h('dd', null, `${fmtCost(t.cost)}${caps.taskCost != null && typeof t.cost === 'number' && t.cost / caps.taskCost >= near ? ' · 接近单任务上限' : ''}`)))
        : h(React.Fragment, null, h('dt', null, '—'), h('dd', null, '无'))),
    h('p', { className: 'cp-muted' }, `单任务上限：${caps.taskCost == null ? '未设' : fmtCost(caps.taskCost)}。上限在伴侣设置里改。`))
}

function Engine({ data }) {
  const channel = list(data.problems).find((p) => p.kind === 'channel')
  const backoff = data.judge?.backoff
  const rebound = data.submitBlock === 'rebound'
  return h('section', { className: 'cp-panel', 'aria-labelledby': 'cp-eng-h', 'data-testid': 'engine' },
    h('h2', { id: 'cp-eng-h' }, '伴侣状态'),
    h('dl', { className: 'cp-kv' },
      h('dt', null, '服务'), h('dd', null, data.running ? (rebound ? '停止收发' : '运行中') : '没有运行'),
      h('dt', null, '渠道'), h('dd', null, channel ? (rebound ? '换绑，已拒绝' : '未连接') : '已连接'),
      h('dt', null, '判断模型'), h('dd', null, backoff ? `不可用，${clock(backoff.until)} 重试` : '正常'),
      h('dt', null, '待判断消息'), h('dd', null, String(data.judge?.waiting ?? 0)),
      h('dt', null, '存储'), h('dd', null, `${Math.round((data.store?.ratio ?? 0) * 100)}%`)))
}

const PROVIDERS = { feishu: '飞书' }

function Pairing({ pairing, onUnpair }) {
  const state = pairing?.state ?? 'unknown'
  return h('section', { className: 'cp-panel', 'aria-labelledby': 'cp-pair-h', 'data-testid': 'pairing' },
    h('h2', { id: 'cp-pair-h' }, '手机聊天'),
    state === 'paired'
      ? h(React.Fragment, null,
          h('p', { style: { margin: '0 0 8px' } }, `已配对：${PROVIDERS[pairing.provider] ?? pairing.provider} · ${pairing.label}`, pairing.running ? null : h('span', { className: 'cp-muted' }, '（渠道没在运行）')),
          h('button', { type: 'button', className: 'cp-btn cp-danger', onClick: onUnpair, 'data-testid': 'unpair' }, '解除配对'))
      : state === 'unpaired'
        ? h('p', { className: 'cp-muted', style: { margin: 0 } }, '还没有配对。到 AGH 的「插件 → 渠道」页，在渠道实例上点“配对到插件服务”，选“伴侣”，再在聊天里私聊机器人发送页面上的配对码。')
        : state === 'unsupported'
          ? h('p', { className: 'cp-muted', style: { margin: 0 } }, '这个 AGH 版本不支持把渠道配对给插件（需要 Extension API 5.12）。')
          : h('p', { className: 'cp-muted', style: { margin: 0 } }, '读不到配对状态。'))
}

function Drawer({ task, detail, now, act, onClose }) {
  const view = detail && detail.id === task.id ? detail : null
  const done = task.state === 'done' || (view && view.note)
  const href = prHref(task)
  return h(Modal, { label: 'cp-dr-h', className: 'cp-drawer', onClose },
    h('div', { className: 'cp-drawer-h' },
      h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { className: 'cp-muted cp-mono' }, `${task.id} · ${task.workspace}`), h('h2', { id: 'cp-dr-h' }, task.title), h('div', { style: { marginTop: 6 } }, h(Tag, { task }))),
      h('button', { type: 'button', className: 'cp-icon-btn', onClick: onClose, 'aria-label': '关闭详情', 'data-autofocus': true, 'data-testid': 'drawer-close' }, h(Icon, { name: 'close' }))),
    h('div', { className: 'cp-drawer-b', 'data-testid': 'drawer' },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(Primary, { task, act }),
        task.state !== 'running' && task.sessionId ? h(SessionLink, { task, label: '打开会话' }) : null,
        ['queued', 'running', 'waiting', 'paused'].includes(task.state) ? h('button', { type: 'button', className: 'cp-btn cp-danger', onClick: () => act.stop(task.id) }, '停止…') : null,
        task.state === 'done' ? h('button', { type: 'button', className: 'cp-btn', onClick: () => act.reopen(task.id) }, '重开…') : null),
      task.state === 'queued' ? h('div', null, h('h3', null, '排队'), h('p', { style: { margin: 0 } }, `${queueText(task)}。轮到时自动开始，不用你操作。`)) : null,
      task.state === 'waiting' && task.wait === 'approval' ? h('div', null, h('h3', null, '等你批准'), h('p', { className: 'cp-muted', style: { margin: 0 } }, '批准在会话页里做，打开会话查看要批准的内容。这里不显示仓库、分支和文件。')) : null,
      done
        ? h('div', null, h('h3', null, '结果'),
            href
              ? h('p', { style: { margin: '0 0 6px' } }, h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, task.prUrl))
              : task.prUrl
                ? h('p', { style: { margin: '0 0 6px' } }, h('span', { className: 'cp-mono' }, task.prUrl), h('span', { className: 'cp-muted' }, '（不是这个任务仓库的 PR 页面，没有当链接）'))
                : h('p', { className: 'cp-muted', style: { margin: '0 0 6px' } }, '没有 PR 链接。打开会话看它做了什么。'),
            view?.note ? h('div', { className: 'cp-material' }, view.note) : view ? h('p', { className: 'cp-muted', style: { margin: 0 } }, '没有回复文字。') : null,
            view?.note ? h('p', { className: 'cp-muted', style: { margin: '4px 0 0' } }, '执行会话写的，仅供参考。') : null)
        : null,
      task.state === 'failed' ? h('div', null, h('h3', null, '为什么失败'), h('p', { style: { margin: 0 } }, failedWhy(task))) : null,
      task.state === 'paused' ? h('div', null, h('h3', null, '为什么暂停'), h('p', { style: { margin: 0 } }, pausedWhy(task, act.usage))) : null,
      h('div', null, h('h3', null, '你的原话（建任务时冻结）'),
        view ? h('div', { className: 'cp-brief' }, view.brief) : h('p', { className: 'cp-muted', style: { margin: 0 } }, '读取中…'),
        view ? h('p', { className: 'cp-muted', style: { margin: '4px 0 0' } }, `校验 ${String(view.briefHash).slice(0, 8)} · 伴侣按这段做事，执行结果不会改它。`) : null),
      h('div', null, h('h3', null, '用量'),
        h('dl', { className: 'cp-kv' }, h('dt', null, '费用'), h('dd', null, fmtCost(task.usage.cost)), h('dt', null, 'token'), h('dd', null, fmtTokens(task.usage.tokens))),
        task.usage.cost === null || task.usage.tokens === null ? h('p', { className: 'cp-muted', style: { margin: '4px 0 0' } }, '“未知”是平台没报，不是零。') : null),
      h('div', null, h('h3', null, '会话'),
        h('dl', { className: 'cp-kv' },
          h('dt', null, '会话'), h('dd', { className: 'cp-mono' }, task.sessionId || '还没开'),
          h('dt', null, '第几代'), h('dd', null, String(task.generation + 1)),
          h('dt', null, '状态'), h('dd', null, task.session ? (SESSION_KIND[task.session.kind] ?? task.session.kind) : task.sessionState === 'missing' ? '找不到' : task.sessionState === 'unreadable' ? '读不到' : '—'),
          h('dt', null, '审批被拒'), h('dd', null, `${task.refusals} 次`))),
      h('div', null, h('h3', null, '记录'),
        view
          ? h(React.Fragment, null,
              view.compacted ? h('p', { className: 'cp-muted' }, `更早的 ${view.compacted.events} 条记录已合并。`) : null,
              h('ol', { className: 'cp-timeline' }, list(view.events).map((e, i) => h('li', { key: i }, h('time', { dateTime: e.at }, clock(e.at)), h('span', null, eventText(e))))))
          : h('p', { className: 'cp-muted', style: { margin: 0 } }, '读取中…'))))
}

function StopDialog({ task, onCancel, onConfirm }) {
  return h(Modal, { label: 'cp-dg-h', role: 'alertdialog', className: 'cp-dialog', onClose: onCancel },
    h('h2', { id: 'cp-dg-h' }, `停止 ${task.id}？`),
    h('p', null, `“${task.title}”会停下来并标为已放弃。已放弃的任务不能再重开，要做只能新建。本地已有的改动留在工作区里，不会推送。`),
    h('div', { className: 'cp-acts' },
      h('button', { type: 'button', className: 'cp-btn', onClick: onCancel, 'data-autofocus': true }, '不停'),
      h('button', { type: 'button', className: 'cp-btn cp-danger', onClick: onConfirm, 'data-testid': 'stop-confirm' }, '停止')))
}

function ReopenDialog({ task, onCancel, onSend }) {
  const [text, setText] = React.useState(task.state === 'failed' ? '按原来的要求再试一次。' : '')
  return h(Modal, { label: 'cp-dg-h', className: 'cp-dialog', onClose: onCancel },
    h('h2', { id: 'cp-dg-h' }, `${task.state === 'failed' ? '重试' : '重开'} ${task.id}`),
    h('p', null, '伴侣在原来的会话里接着做，范围不变。写一句要改什么。'),
    h('label', { className: 'cp-sr', htmlFor: 'cp-ro' }, '要改什么'),
    h('textarea', { id: 'cp-ro', value: text, onChange: (e) => setText(e.target.value), 'data-autofocus': true, maxLength: 4000 }),
    h('div', { className: 'cp-acts' },
      h('button', { type: 'button', className: 'cp-btn', onClick: onCancel }, '取消'),
      h('button', { type: 'button', className: 'cp-btn cp-primary', disabled: !text.trim(), onClick: () => onSend(text.trim()), 'data-testid': 'reopen-send' }, `发给 ${task.id}`)))
}

export function Desk({ services, openSettings }) {
  const [openId, setOpenId] = React.useState(null)
  const [dialog, setDialog] = React.useState(null)
  const [toasts, setToasts] = React.useState([])
  const { data, failed, reload, lastGood } = useDesk(services, openId)
  const submit = useSubmit(services, reload)
  const toast = React.useCallback((text) => {
    setToasts((items) => [...items, text])
    setTimeout(() => setToasts((items) => items.slice(1)), 3000)
  }, [])
  const run = async (input, done) => {
    const result = await submit(input)
    toast(result.ok ? done : result.text)
    return result
  }
  const all = React.useMemo(() => {
    const t = data?.tasks ?? {}
    return [...list(t.needsYou), ...list(t.running), ...list(t.queued).flatMap((g) => list(g.tasks)), ...list(t.paused), ...list(t.recent), ...list(t.older), ...list(t.unknown)]
  }, [data])
  const byId = (id) => all.find((t) => t.id === id)
  const unpair = async () => {
    try {
      const receipt = await services.effect('companion.unpair', {}, { operationId: crypto.randomUUID() })
      toast(receipt?.state === 'completed' || !receipt?.state ? '已解除配对' : `没有解除（${receipt.state}）`)
    } catch (error) {
      toast(`没有解除：${message(error)}`)
    } finally {
      await reload()
    }
  }
  const act = {
    detail: (id) => setOpenId(id),
    stop: (id) => setDialog({ kind: 'stop', id }),
    reopen: (id) => setDialog({ kind: 'reopen', id }),
    proceed: (id) => run({ kind: 'button', action: 'continue', taskId: id }, `已让 ${id} 继续`),
    pick: (card, pick) => run({ kind: 'choice', card, pick }, '已选，伴侣处理中'),
    usage: data?.usage,
  }
  if (!data)
    return h('section', { className: 'cp-desk', 'data-testid': 'desk' }, h('div', { className: 'cp-empty' }, failed ? h(React.Fragment, null, '读不到任务台。', h('button', { type: 'button', className: 'cp-btn', onClick: reload, style: { marginLeft: 8 } }, '重试')) : '读取中…'))
  const now = data.at ?? ''
  const problems = list(data.problems)
  const blocked = !data.running
  const T = data.tasks ?? {}
  const waits = list(T.needsYou)
  const paused = list(T.paused)
  const cards = list(data.cards)
  const attention = waits.length + paused.length + cards.length
  const active = [...list(T.running), ...list(T.queued).flatMap((g) => list(g.tasks)), ...list(T.unknown)]
  const recent = list(T.recent)
  const older = list(T.older)
  const anyTask = all.length > 0
  const rebound = data.submitBlock === 'rebound'
  const backoff = data.judge?.backoff
  const dialogTask = dialog ? byId(dialog.id) : null
  const openTask = openId ? byId(openId) : null
  return h(
    'section',
    { className: 'cp-desk', 'aria-labelledby': 'cp-title', 'data-testid': 'desk' },
    h('div', { className: 'cp-top' },
      h('h1', { id: 'cp-title' }, '任务台'),
      h('div', { className: 'cp-health', 'data-testid': 'health' },
        blocked ? h('span', { className: 'cp-bad' }, h(Icon, { name: 'alert' }), '伴侣没有运行') : h('span', { className: 'cp-ok' }, h(Icon, { name: 'check' }), '伴侣在运行'),
        failed ? h('span', { className: 'cp-clock' }, `读取失败，保留 ${clock(lastGood)} 的内容`) : h('span', { className: 'cp-clock' }, `${clock(data.at)} 更新`)),
      h('button', { type: 'button', className: 'cp-icon-btn', onClick: reload, 'aria-label': '立即刷新', title: '立即刷新', 'data-testid': 'refresh' }, h(Icon, { name: 'refresh' }))),
    h('div', { className: 'cp-scroll' },
      h('div', { className: 'cp-cols' },
        h('div', { className: 'cp-main' },
          problems.map((p, i) => h(Status, { key: `${p.kind}-${i}`, problem: p, openSettings })),
          !blocked && backoff && backoff.failures >= 3
            ? h('div', { className: 'cp-banner cp-warn', role: 'status', 'data-testid': 'status-judge' }, h(Icon, { name: 'alert' }), h('h3', null, `判断模型连续 ${backoff.failures} 次不可用，你的消息还在排队`), h('p', null, `${clock(backoff.until)} 再试。停止、继续、回复某个任务不经判断模型，照常生效。`))
            : null,
          blocked
            ? null
            : h(React.Fragment, null,
                attention || anyTask
                  ? h('section', { className: 'cp-sec', 'aria-labelledby': 'cp-att-h', 'data-testid': 'attention' },
                      h('h2', { id: 'cp-att-h' }, '需要你处理 ', attention ? h('span', { className: 'cp-n' }, String(attention)) : null),
                      attention
                        ? h('div', { className: 'cp-att' },
                            waits.filter((t) => t.wait === 'approval').map((t) => h(WaitingCard, { key: t.id, task: t, now, act })),
                            cards.map((c) => h(ChoiceCard, { key: c.key, card: c, now, act, disabled: rebound })),
                            waits.filter((t) => t.wait !== 'approval').map((t) => h(WaitingCard, { key: t.id, task: t, now, act })),
                            paused.map((t) => h(PausedCard, { key: t.id, task: t, now, act, usage: data.usage })))
                        : h('div', { className: 'cp-list' }, h('div', { className: 'cp-empty' }, '没有要你处理的事。')))
                  : null,
                h(Composer, { data, onSend: (input) => run(input, '已发给伴侣') }),
                anyTask
                  ? h(React.Fragment, null,
                      h('section', { className: 'cp-sec', 'aria-labelledby': 'cp-act-h', 'data-testid': 'active' },
                        h('h2', { id: 'cp-act-h' }, '进行中与排队 ', h('span', { className: 'cp-n' }, String(active.length))),
                        h('div', { className: 'cp-list', role: 'list' }, active.length ? active.map((t) => h(Row, { key: t.id, task: t, now, act })) : h('div', { className: 'cp-empty' }, '现在没有在做的任务。'))),
                      h('section', { className: 'cp-sec', 'aria-labelledby': 'cp-res-h', 'data-testid': 'recent' },
                        h('h2', { id: 'cp-res-h' }, '最近结果 ', h('span', { className: 'cp-n' }, `7 天内 ${recent.length}`)),
                        h('div', { className: 'cp-list', role: 'list' }, recent.length ? recent.map((t) => h(Row, { key: t.id, task: t, now, act })) : h('div', { className: 'cp-empty' }, '7 天内没有完成或失败的任务。'))),
                      older.length
                        ? h('details', { className: 'cp-more', 'data-testid': 'older' },
                            h('summary', null, h(Icon, { name: 'chev' }), `已结束 ${data.tasks?.olderTotal ?? older.length}（已放弃、7 天前）`),
                            h('div', { className: 'cp-list', role: 'list' }, older.map((t) => h(Row, { key: t.id, task: t, now, act }))))
                        : null)
                  : h('section', { className: 'cp-sec', 'data-testid': 'empty' }, h('div', { className: 'cp-list' }, h('div', { className: 'cp-empty' }, h('p', { style: { margin: '0 0 4px', fontWeight: 600 } }, '还没有任务'), '在上面写一句，或在手机聊天里发给伴侣。比如“给 docs 仓补一段安装说明并开 PR”。'))))),
        h('div', { className: 'cp-side' },
          blocked
            ? h('div', { className: 'cp-panel' }, h('h2', null, h(Icon, { name: 'info' }), '伴侣能做什么'), h('p', { className: 'cp-muted', style: { margin: 0 } }, '你在这里或手机聊天里说一句“给 api 仓修 README 错字并开 PR”，伴侣开会话去做；推送和开 PR 前会请你批准；做完把 PR 链接发回来。'))
            : h(React.Fragment, null, h(Usage, { usage: data.usage }), h(Engine, { data })),
          h(Pairing, { pairing: data.pairing, onUnpair: unpair })))),
    openTask ? h(Drawer, { key: openTask.id, task: openTask, detail: data.detail, now, act, onClose: () => setOpenId(null) }) : null,
    dialog && dialogTask && dialog.kind === 'stop'
      ? h(StopDialog, { task: dialogTask, onCancel: () => setDialog(null), onConfirm: async () => { setDialog(null); await run({ kind: 'button', action: 'stop', taskId: dialog.id }, `已让 ${dialog.id} 停止`) } })
      : null,
    dialog && dialogTask && dialog.kind === 'reopen'
      ? h(ReopenDialog, { task: dialogTask, onCancel: () => setDialog(null), onSend: async (text) => { setDialog(null); await run({ kind: 'message', text, replyTo: dialog.id }, `已发给 ${dialog.id}`) } })
      : null,
    h('div', { className: 'cp-toasts', role: 'status', 'aria-live': 'polite' }, toasts.map((t, i) => h('div', { key: i, className: 'cp-toast' }, t))),
  )
}
