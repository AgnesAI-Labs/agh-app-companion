import { bindNavigationHistory, mountSidebarRegion } from '@agnes/web/presentation-renderers'
import React from 'react'

const h = React.createElement
const ENGINE = 'companion'
const MODEL_ROLES = [
  ['judge', '主脑判断'],
  ['worker', '任务执行'],
]

function Desk() {
  return h(
    'section',
    { style: { padding: 24 } },
    h('h1', null, '任务台'),
    h('p', null, '任务引擎还没有接上。设置好「伴侣设置」后，这里会列出派给伴侣的任务。'),
  )
}

const workspacesText = (list) => list.map((w) => `${w.shortName}=${w.path}`).join('\n')
const workspacesFrom = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=')
      return { shortName: line.slice(0, at).trim(), path: line.slice(at + 1).trim() }
    })

function field(label, input) {
  return h('label', { style: { display: 'block', margin: '12px 0' } }, h('div', null, label), input)
}

function Settings({ services }) {
  const [draft, setDraft] = React.useState(undefined)
  const [note, setNote] = React.useState('')
  React.useEffect(() => {
    let live = true
    services
      .query(`${ENGINE}.configuration`, {})
      .then((config) => live && setDraft(config))
      .catch((error) => live && setNote(`读取失败：${error?.message ?? error}`))
    return () => {
      live = false
    }
  }, [services])
  if (!draft) return h('section', { style: { padding: 24 } }, note || '读取中…')
  const set = (patch) => setDraft({ ...draft, ...patch })
  const setModel = (role, patch) => set({ models: { ...draft.models, [role]: { ...draft.models[role], ...patch } } })
  const save = async () => {
    setNote('保存中…')
    try {
      const receipt = await services.effect(`${ENGINE}.configure`, draft, { operationId: crypto.randomUUID() })
      setNote(
        receipt?.state === 'approval-required' ? '需要你在「审批」里批准这次修改，批准后再点一次保存。' : `已提交：${receipt?.state}`,
      )
    } catch (error) {
      setNote(`保存失败：${error?.message ?? error}`)
    }
  }
  return h(
    'section',
    { style: { padding: 24, maxWidth: 640 } },
    h('h1', null, '伴侣设置'),
    field('称呼', h('input', { value: draft.ownerName, onChange: (e) => set({ ownerName: e.target.value }) })),
    field(
      '可用工作区（每行一个：短名=绝对路径）',
      h('textarea', {
        rows: 4,
        defaultValue: workspacesText(draft.workspaces),
        onBlur: (e) => set({ workspaces: workspacesFrom(e.target.value) }),
      }),
    ),
    field(
      '专用工作区（主脑判断用，不能是上面的工作区）',
      h('input', { value: draft.dedicatedWorkspace, onChange: (e) => set({ dedicatedWorkspace: e.target.value }) }),
    ),
    field(
      '聊天渠道实例',
      h('input', { value: draft.channelInstance, onChange: (e) => set({ channelInstance: e.target.value }) }),
    ),
    ...MODEL_ROLES.map(([role, label]) =>
      field(
        `${label}的模型路由（留空用部署默认）`,
        h(
          'span',
          null,
          h('input', { value: draft.models[role].route, onChange: (e) => setModel(role, { route: e.target.value }) }),
          h(
            'label',
            { style: { marginLeft: 12 } },
            h('input', {
              type: 'checkbox',
              checked: draft.models[role].local,
              onChange: (e) => setModel(role, { local: e.target.checked }),
            }),
            ' 我确认这个路由在本机',
          ),
        ),
      ),
    ),
    h('button', { type: 'button', onClick: save }, '保存'),
    note && h('p', null, note),
  )
}

export function apply(ctx) {
  const services = ctx.profile.services
  const disposers = [
    ctx.homeEntries.register({ id: 'desk', placement: 'primary', icon: 'list', order: 1, component: Desk }),
    ctx.homeEntries.register({
      id: 'settings',
      placement: 'primary',
      icon: 'settings',
      order: 2,
      component: () => h(Settings, { services }),
    }),
    // Placeholder: keeps the official sidebar until task navigation has task data to show.
    ctx.presentationRoles.register({
      role: 'navigation',
      priority: 100,
      mount(scope) {
        const port = scope.presentation.navigation
        if (!port) return () => {}
        const stopHistory = bindNavigationHistory(port.history)
        const view = mountSidebarRegion(scope.slots, port.container, port.initial, scope.locale)
        const detach = port.attach(view)
        return () => {
          detach()
          view.dispose()
          stopHistory()
        }
      },
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
