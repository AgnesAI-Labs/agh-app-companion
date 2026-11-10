/**
 * Copy and small formatters for the task desk. Pure functions of the `companion.desk` result: no
 * host imports, so the page's text can be tested without a DOM.
 */

export const STATE = {
  waiting: { text: '等你', tone: 'warn', icon: 'hand' },
  running: { text: '进行中', tone: 'info', icon: 'play' },
  queued: { text: '排队中', tone: 'neutral', icon: 'clock' },
  done: { text: '完成', tone: 'ok', icon: 'check' },
  failed: { text: '失败', tone: 'bad', icon: 'x' },
  paused: { text: '已暂停', tone: 'warn', icon: 'pause' },
  abandoned: { text: '已放弃', tone: 'neutral', icon: 'slash' },
}
const UNKNOWN_STATE = { text: '状态未知', tone: 'neutral', icon: 'info' }
export const REASON = {
  approvalExpired: '审批过期',
  sessionFailed: '会话失败',
  budget: '超预算',
  hops: '超跳数',
  sessionLost: '会话丢失',
  turnInterrupted: '回合中断',
  refused: '审批多次未见批准',
  platform: '平台拒绝',
}
export const ENDED = ['done', 'failed', 'abandoned']

export const stateOf = (task) => STATE[task.state] ?? UNKNOWN_STATE
export const stateLabel = (task) => `${stateOf(task).text}${task.reason && REASON[task.reason] ? `（${REASON[task.reason]}）` : ''}`

/** Tokens and cost as the engine reports them; null is "未知", never 0. Cost carries no currency unit. */
export const fmtTokens = (n) => (typeof n !== 'number' ? '未知' : n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))
export const fmtCost = (n) => (typeof n !== 'number' ? '未知' : n.toFixed(2))

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Relative age against the server's own clock, so a skewed browser clock cannot lie. */
export function ago(at, now) {
  const d = Date.parse(now) - Date.parse(at)
  if (!Number.isFinite(d) || d < MIN) return '刚刚'
  if (d < HOUR) return `${Math.round(d / MIN)} 分钟前`
  if (d < DAY) return `${Math.round(d / HOUR)} 小时前`
  return `${Math.round(d / DAY)} 天前`
}
export function clock(at) {
  const d = new Date(Date.parse(at))
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The only value that becomes an href besides the session link: the server's checked PR page. */
export const prHref = (task) => (typeof task.prLink === 'string' && /^https:\/\//.test(task.prLink) ? task.prLink : null)
/** The session page the host renders, approvals included. */
export const sessionHref = (task) => (task.sessionId ? `/?session=${encodeURIComponent(task.sessionId)}` : null)

export const SESSION_KIND = { active: '在跑', idle: '空闲', notLoaded: '未载入', systemError: '出错' }

const SETTING_NAMES = {
  ownerName: '称呼',
  workspaces: '可用工作区（短名=路径）',
  dedicatedWorkspace: '专用工作区（主脑判断用）',
  channelInstance: '手机聊天渠道实例',
}
const ALL_SETTINGS = Object.keys(SETTING_NAMES)

/**
 * One problem from the engine's `status()` as one status with at most one action. `blocking`
 * statuses replace the page's body; the rest sit above it.
 * @returns {{ id: string, tone: 'bad' | 'warn' | 'info', icon: string, title: string, body: string, tech: string | null,
 *   checklist?: { label: string, done: boolean }[], action: null | { label: string, to: 'settings' } }}
 */
export function problemView(problem) {
  const text = typeof problem.text === 'string' ? problem.text : ''
  switch (problem.kind) {
    case 'capability':
      return {
        id: 'capability', tone: 'bad', icon: 'shield',
        title: /not granted/.test(text) ? '伴侣没有被授予托管会话' : '这台 AGH 缺少伴侣需要的能力',
        body: /not granted/.test(text)
          ? '平台拒绝了伴侣开会话。信任并启用伴侣插件后再来。'
          : '伴侣要靠插件托管会话来开判断会话和执行会话。缺了它，伴侣不接活。升级 AGH 后再来。',
        tech: text, action: null,
      }
    case 'settings': {
      const missing = Array.isArray(problem.missing) ? problem.missing : []
      return {
        id: 'settings', tone: 'warn', icon: 'alert',
        title: `还差 ${missing.length} 项设置，伴侣才能接活`,
        body: '设好之后，你在这里或手机聊天里说一句，伴侣就去做。',
        checklist: ALL_SETTINGS.map((key) => ({ label: SETTING_NAMES[key], done: !missing.includes(key) })),
        tech: null, action: { label: '去伴侣设置', to: 'settings' },
      }
    }
    case 'model':
      return {
        id: 'model', tone: 'warn', icon: 'alert', title: '设置里的模型路由伴侣还不能用',
        body: '平台要路由和模型名两样，伴侣的设置里只有路由。清空它，就用部署的默认模型。',
        tech: text, action: { label: '去伴侣设置', to: 'settings' },
      }
    case 'owner':
      return {
        id: 'owner', tone: 'bad', icon: 'shield', title: '这份伴侣数据属于另一位主人',
        body: '数据是给另一个手机聊天账号记的，现在渠道绑定的是别人。为了不把任务和结果给错人，伴侣没有读写它。换回原来的绑定，或清空伴侣的数据从头开始。',
        tech: text, action: null,
      }
    case 'channel':
      return channelView(text)
    case 'refusal':
      return {
        id: 'refusal', tone: 'warn', icon: 'alert', title: '平台拒绝了伴侣的会话请求',
        body: text || '平台拒绝了一次会话请求。',
        tech: [problem.code, problem.workspace].filter((v) => typeof v === 'string' && v).join(' · ') || null, action: null,
      }
    default: {
      const newer = /is newer than this build/.test(text)
      return {
        id: 'engine', tone: 'bad', icon: 'shield',
        title: newer ? '伴侣数据比这个版本新' : problem.unavailable ? '伴侣服务没有运行' : '伴侣服务出错',
        body: newer
          ? '数据是更新的伴侣写的，这个版本读不了。升级伴侣插件后再用。什么都没改动。'
          : problem.unavailable
            ? '页面读不到伴侣服务。它起来之后这里会自动恢复。'
            : '伴侣的上一轮处理出了错，下一轮会再试。',
        tech: text, action: null,
      }
    }
  }
}

function channelView(text) {
  const base = { id: 'channel', tech: text, action: null }
  if (/gateway is not available/.test(text))
    return { ...base, tone: 'info', icon: 'info', title: '手机聊天渠道还没接上', body: '平台上还没有聊天渠道插件。伴侣照常在这里接活，回复先存着，渠道接上后再发。' }
  if (/was rebound to another owner/.test(text))
    return { ...base, tone: 'bad', icon: 'shield', title: '手机聊天渠道换了绑定的人，伴侣已停止收发', body: '为了不把消息发给别人，新消息不收，结果不发。任务照常在电脑上跑，你可以在这里看。确认新绑定是你本人后，重启伴侣服务。' }
  if (/has no bound owner/.test(text))
    return { ...base, tone: 'warn', icon: 'alert', title: '手机聊天渠道还没绑定你的账号', body: '渠道在运行，但没有绑定主人。伴侣收不到你的消息，也发不出结果。先去渠道那边完成绑定，或换一个渠道实例。', action: { label: '去伴侣设置', to: 'settings' } }
  if (/is not set|is not a channel instance id/.test(text))
    return { ...base, tone: 'warn', icon: 'alert', title: '还没选手机聊天渠道', body: '在伴侣设置里填渠道实例。', action: { label: '去伴侣设置', to: 'settings' } }
  if (/not available|not running/.test(text))
    return { ...base, tone: 'warn', icon: 'alert', title: '手机聊天渠道没在运行', body: '伴侣现在收不到手机消息，也发不出结果。渠道恢复后会自动接上。', action: { label: '去伴侣设置', to: 'settings' } }
  return { ...base, tone: 'warn', icon: 'alert', title: '手机聊天渠道有问题', body: '原因见技术详情。' }
}

/** Why the composer is off, shown under it. */
export const SUBMIT_BLOCK = {
  'not-running': '伴侣服务没有运行，这里先不能发。',
  rebound: '渠道换绑后伴侣暂停收消息，这里也先不能发。',
  'store-full': '存储快满了，先不新建任务。清理旧任务后再试。',
}

/** The sentence under a paused task, computed from usage against the caps, not from the reason alone. */
export function pausedWhy(task, usage) {
  const caps = usage?.caps ?? {}
  switch (task.reason) {
    case 'budget': {
      const since = typeof task.usage.cost === 'number' ? task.usage.cost - (task.budgetBase.cost ?? 0) : null
      if (caps.taskCost != null && since !== null && since > caps.taskCost)
        return `这个任务已用 ${fmtCost(since)}，超过单任务上限 ${fmtCost(caps.taskCost)}。继续后从现在起重新计这个任务的上限。`
      if (caps.dailyCost != null && typeof usage?.today?.cost === 'number' && usage.today.cost > caps.dailyCost)
        return `今天的费用 ${fmtCost(usage.today.cost)} 超过每日上限 ${fmtCost(caps.dailyCost)}。继续不会重置每日上限，今天会马上再停。`
      return '暂停时超过了当时的上限，现在已不设上限。点继续接着做。'
    }
    case 'refused':
      return `审批连续 ${task.refusals} 次没有看到批准，伴侣先停下，免得它换着法子再试。`
    case 'sessionLost':
      return '找不到原来的会话（可能被归档或删了）。继续会开一个新会话，按原话从头做。'
    case 'turnInterrupted':
      return '回合中断了两次，伴侣已停下。'
    case 'hops':
      return `这个任务派生的步数超过 ${caps.maxHops ?? 8}，先停下。`
    case 'platform':
      return '平台拒绝了这个任务的会话请求，原因见页面上方的状态。继续会再试一次。'
    default:
      return '已暂停。'
  }
}

export function failedWhy(task) {
  return task.reason === 'approvalExpired'
    ? '推送的审批过了时限没人批，会话没有推送。点“重试”会在原会话里再来一次，到时要你重新批。'
    : '会话出错停了，没有留下错误说明。打开会话看日志，或点“重试”。'
}

const DISPOSITION = {
  created: '已建任务',
  appended: '已接到任务',
  control: '已处理',
  answered: '已回答',
  asked: '请你在上面选一下',
  rejected: '没有处理',
  ignored: '没有需要做的',
  fallback: '没处理好',
  returned: '退回了',
}
export const dispositionText = (state, taskIds) =>
  `${DISPOSITION[state] ?? state}${Array.isArray(taskIds) && taskIds.length ? ` ${taskIds.join('、')}` : ''}`

/** The timeline line for one record of a task. */
export function eventText(event) {
  if (event.kind === 'created') return '你派的活，任务建好'
  if (event.kind === 'message') return `你发了一条消息${event.unquoted ? '（没引用，伴侣按编号接上）' : ''}`
  if (event.note) return event.note
  const name = (s) => (STATE[s] ?? { text: s ?? '?' }).text
  return `${name(event.from)} → ${name(event.to)}${event.reason && REASON[event.reason] ? `（${REASON[event.reason]}）` : ''}`
}

export function queueText(task) {
  if (!task.queue) return ''
  return task.queue.holder
    ? `排在 ${task.queue.holder} 后，第 ${task.queue.position} 个（同一工作区一次只做一个）`
    : '排队中，马上开始'
}
