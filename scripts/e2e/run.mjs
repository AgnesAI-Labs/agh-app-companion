#!/usr/bin/env node
// The companion on a real Agnes Harness daemon, end to end, in an isolated home with a loopback model.
//   AGNES_HARNESS=<checkout> node scripts/e2e/run.mjs [--runtime <dir>] [--keep] [--evidence <dir>] [--hold-after N]
//   node scripts/e2e/run.mjs --cleanup <root>
// See README.md, "Prove it on a real daemon".
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { history, startModel } from './model.mjs'

const companion = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const harness = resolve(process.env.AGNES_HARNESS ?? join(homedir(), 'agnes-harness'))
const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const keep = args.includes('--keep')
// --hold-after N runs steps 1..N and leaves the run up for `--cli <root> -- <agh args>`; `--cleanup <root>` ends it.
const holdAfter = flag('--hold-after') ? Number(flag('--hold-after')) : undefined
const PACKAGE = '@agh-apps/companion'
const SHARED_HOMES = [join(homedir(), '.agh'), join(homedir(), '.agh-dev')]
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function runtimeDir() {
  const dir = resolve(flag('--runtime') ?? process.env.AGNES_E2E_RUNTIME ?? join(harness, '.agnes-tmp/companion-e2e/runtime'))
  if (dir === join(harness, 'packages/cli/dist/local')) throw new Error('refusing packages/cli/dist/local: a live instance may run from it')
  if (!existsSync(join(dir, 'agnes.mjs'))) {
    console.log(`BUILD runtime into ${dir}`)
    execFileSync('mise', ['exec', '--', 'node', 'tools/toolchain/run.mjs', '--filter', '@agnes/cli', 'build:local', '--output-dir', dir], {
      cwd: harness,
      stdio: 'inherit',
    })
  }
  return dir
}

async function freePort() {
  for (;;) {
    const server = createServer()
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
    await new Promise((done) => server.close(done))
    if (port !== 4177) return port
  }
}

const portOpen = (port) =>
  new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => (socket.destroy(), done(true)))
    socket.once('error', () => done(false))
  })

const alive = (pid) => {
  try {
    return Boolean(pid) && process.kill(pid, 0)
  } catch {
    return false
  }
}

function processTable() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }))
}

/** Processes this run started: the serve tree, the daemon tree and runtime processes naming the root. */
function ownedPids(state) {
  const table = processTable()
  const ancestors = new Set()
  for (let pid = process.pid; pid > 1 && !ancestors.has(pid); pid = table.find((r) => r.pid === pid)?.ppid ?? 0) ancestors.add(pid)
  const owner = join(state.home, 'daemon', 'owner.json')
  const daemon = existsSync(owner) ? JSON.parse(readFileSync(owner, 'utf8')).pid : undefined
  const found = new Set([state.servePid, daemon].filter(alive))
  for (const row of table) if (row.command.includes(state.root) && /(agnes|daemon|worker)\.mjs/.test(row.command)) found.add(row.pid)
  for (let grew = true; grew; ) {
    grew = false
    for (const row of table) if (found.has(row.ppid) && !found.has(row.pid)) (found.add(row.pid), (grew = true))
  }
  return [...found].filter((pid) => !ancestors.has(pid))
}

/** A git workspace whose `origin` is a bare repository on this machine, reached through an ssh shim. */
function makeWorkspace(root) {
  const bin = join(root, 'bin')
  const remote = join(root, 'remote')
  mkdirSync(join(remote, 'e2e'), { recursive: true })
  writeFileSync(join(bin, 'fake-ssh'), `#!/bin/sh\nfor last; do :; done\ncd '${remote}' && exec /bin/sh -c "$last"\n`)
  chmodSync(join(bin, 'fake-ssh'), 0o755)
  const bare = join(remote, 'e2e', 'demo.git')
  const work = join(root, 'w', 'demo')
  mkdirSync(work, { recursive: true })
  const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8' })
  git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 'e2e@example.invalid')
  git(work, 'config', 'user.name', 'Companion E2E')
  writeFileSync(join(work, 'README.txt'), 'Synthetic workspace for the companion e2e run.\n')
  git(work, 'add', '.')
  git(work, 'commit', '-qm', 'Initial synthetic commit')
  git(work, 'remote', 'add', 'origin', 'git@localhost:e2e/demo.git')
  git(work, 'config', 'core.sshCommand', join(bin, 'fake-ssh'))
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'remote', 'set-head', 'origin', 'main')
  return { work, bare, git }
}

async function main() {
  const runtime = runtimeDir()
  const root = realpathSync(mkdtempSync('/tmp/agh-e2e-'))
  if (SHARED_HOMES.some((h) => root.startsWith(h))) throw new Error('refusing a shared home')
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(root)}`
  // Outside the companion folder: `agh plugins add <folder>` copies the whole folder into the home.
  const evidence = resolve(flag('--evidence') ?? join(harness, '.agnes-tmp', 'companion-e2e', 'evidence'), runId)
  for (const dir of [evidence, join(evidence, 'cli'), join(evidence, 'shots'), join(root, 'h'), join(root, 'bin'), join(root, 'w', 'judge'), join(root, '.ssh')])
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  const port = await freePort()
  const state = { runId, root, home: join(root, 'h'), port, url: `http://127.0.0.1:${port}`, runtime, evidence, servePid: 0 }
  const secret = `E2E-SECRET-${randomBytes(12).toString('hex')}`
  writeFileSync(join(root, '.ssh', 'id_test'), `${secret}\n`, { mode: 0o600 })
  // gh after a push must never reach a forge: this stub answers instead and records what it was asked.
  writeFileSync(join(root, 'bin', 'gh'), `#!/bin/sh\necho "gh $*" >> '${join(root, 'gh-calls.log')}'\necho "e2e: gh has no network here" >&2\nexit 1\n`)
  chmodSync(join(root, 'bin', 'gh'), 0o755)
  const env = {
    PATH: `${join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: root,
    TMPDIR: '/tmp',
    AGH_HOME: state.home,
    AGNES_PROFILE: 'local-dev',
    AGNES_WEB_ORIGIN: state.url,
    AGNES_LOCALE: 'en',
  }
  const model = await startModel({ log: join(evidence, 'model.jsonl') })
  const steps = []
  let cliCount = 0
  const save = (name, value) => writeFileSync(join(evidence, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)

  /** `agh <args>` under the isolated environment; every call leaves a transcript. */
  const agh = (argv, { cwd = join(root, 'w', 'demo'), timeout = 120_000 } = {}) =>
    new Promise((done) => {
      const child = execFile(process.execPath, [join(runtime, 'agnes.mjs'), ...argv], { cwd, env, timeout, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
        const code = error ? (error.code ?? 1) : 0
        const name = `${String(++cliCount).padStart(3, '0')}-${argv.join('_').replace(/[^\w.-]+/g, '-').slice(0, 60)}.txt`
        const transcript = `$ agh ${argv.join(' ')}\n(cwd ${cwd})\nexit ${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`
        writeFileSync(join(evidence, 'cli', name), transcript.replaceAll(model.apiKey, '<loopback-key>'))
        done({ code, stdout, stderr })
      })
      child.stdin?.end()
    })
  const api = async (method, params) => {
    const r = await agh(['api', method, '--params', JSON.stringify(params), '--json'])
    if (r.code !== 0) throw new Error(`agh api ${method} exit ${r.code}: ${r.stderr.trim().slice(0, 600)}`)
    return JSON.parse(r.stdout)
  }
  /** A companion profile service, called the way the local Web calls it. */
  const service = async (name, input = {}) => {
    const result = await api('extension.callScoped', { extension, service: name, input })
    return result?.output ?? result?.result ?? result
  }
  const desk = (taskId) => service('companion.desk', taskId ? { taskId } : {})
  const allTasks = (d) => Object.values(d?.tasks ?? {}).flatMap((g) => (Array.isArray(g) ? g.flatMap((x) => (x?.tasks ? x.tasks : [x])) : []))
  const task = async (id) => allTasks(await desk()).find((t) => t.id === id)
  const until = async (label, read, ok, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs
    let last
    for (;;) {
      last = await read().catch((error) => ({ error: String(error) }))
      if (ok(last)) return last
      if (Date.now() > deadline) throw Object.assign(new Error(`timed out waiting for ${label}`), { last })
      await sleep(1500)
    }
  }
  const modelLog = () =>
    existsSync(join(evidence, 'model.jsonl'))
      ? readFileSync(join(evidence, 'model.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []
  const workerCalls = (taskId) => {
    const requests = modelLog().filter((r) => r.role === 'worker' && JSON.stringify(r.request.messages).includes(`任务编号：${taskId}`))
    return requests.length ? history(requests.at(-1).request.messages) : []
  }

  /** One scenario step: its evidence goes to steps[] whether it passes, fails or is skipped. */
  const step = async (n, name, body, needs = []) => {
    const record = { n, name, ok: false, notes: [], evidence: [] }
    steps.push(record)
    console.log(`STEP ${n} ${name}`)
    const missing = needs.filter((m) => !steps.find((s) => s.n === m)?.ok)
    if (missing.length || (holdAfter !== undefined && n > holdAfter)) {
      record.skipped = missing.length ? `needs step ${missing.join(', ')}` : `after --hold-after ${holdAfter}`
      console.log(`SKIP ${n}: ${record.skipped}`)
      save('result.json', { runId, root, model: model.baseUrl, steps })
      return false
    }
    try {
      await body(record)
      record.ok = true
      console.log(`PASS ${n}`)
    } catch (error) {
      record.error = String(error?.stack ?? error)
      if (error?.last !== undefined) record.last = error.last
      console.log(`FAIL ${n}: ${error?.message ?? error}`)
    }
    save('result.json', { runId, root, model: model.baseUrl, steps })
    return record.ok
  }
  const check = (ok, message) => {
    if (!ok) throw new Error(message)
  }

  let browser
  let page
  /** @type {string | undefined} the companion's client module name, the extension id its services answer to */
  let extension
  let ws
  const demoTask = { id: 'T-0001' }
  const rejectTask = { id: 'T-0002' }
  try {
    const { chromium } = createRequire(join(harness, 'package.json'))('@playwright/test')
    const shot = async (label, record) => {
      const file = join(evidence, 'shots', `${String(Date.now())}-${label}.png`)
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
      writeFileSync(file.replace(/\.png$/, '.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => ''))
      record?.evidence.push(file)
    }
    const openDesk = async () => {
      await page.goto(`${state.url}/?page=desk&pagePackage=${encodeURIComponent(PACKAGE)}`)
      await page.getByTestId('desk').waitFor({ timeout: 60_000 })
    }
    const sendFromDesk = async (text) => {
      await openDesk()
      await page.locator('#cp-cmp').fill(text)
      await page.getByTestId('send').click()
      await page.getByTestId('replies').getByText(text.slice(0, 20)).waitFor({ timeout: 30_000 })
    }

    await step(1, 'fresh isolated home, loopback model registered, daemon ready', async (r) => {
      ws = makeWorkspace(root)
      const log = join(root, 'serve.log')
      const serve = spawn(process.execPath, [join(runtime, 'agnes.mjs'), 'serve', '--port', String(port)], {
        cwd: ws.work, env, detached: true, stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
      })
      serve.unref()
      state.servePid = serve.pid ?? 0
      save('state.json', state)
      writeFileSync(join(root, 'state.json'), JSON.stringify(state))
      await until('serve ready', () => fetch(state.url).then((res) => res.text()), (html) => typeof html === 'string' && html.includes('data-ws='), 90_000)
      const before = await api('config.get', {})
      save('config-before.json', before)
      const account = { providerId: 'deepseek', baseUrl: model.baseUrl, apiKey: model.apiKey }
      const tested = await api('config.test', account)
      save('config-test.json', tested)
      const chosen = tested.models?.[0]?.id
      check(chosen, 'config.test listed no model')
      save('config-save.json', await api('config.save', { ...account, model: chosen, expectedRevision: before.revision }))
      save('config-get.json', await api('config.get', {}))
      r.notes.push(`model ${chosen} at ${model.baseUrl}; daemon home ${state.home}`)
      const status = await agh(['daemon', 'status'])
      check(status.code === 0, `daemon status exit ${status.code}`)
    })

    await step(2, 'workspace with a local bare origin, fake secret planted, workspaces registered, L1 probed', async (r) => {
      check(ws.git(ws.work, 'ls-remote', 'origin').includes('refs/heads/main'), 'origin is not reachable through the ssh shim')
      for (const dir of [ws.work, join(root, 'w', 'judge')]) {
        const warm = await agh(['-p', 'Say hello for the e2e warm-up.'], { cwd: dir })
        check(warm.code === 0, `warm-up session in ${dir} exit ${warm.code}: ${warm.stderr.slice(0, 400)}`)
      }
      const doctor = await agh(['doctor', '--json'])
      check(doctor.code === 0, `doctor exit ${doctor.code}`)
      const runtimeView = await api('sessionSelection.runtime', {})
      save('02-security.json', runtimeView.security ?? null)
      const level = runtimeView.security?.platform?.l1?.level ?? 'not reported'
      r.notes.push(`platform.l1.level: ${level} (sessionSelection.runtime security.platform.l1)`)
      state.l1 = level
    }, [1])

    browser = await chromium.launch({
      headless: true,
      ...(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') && !process.env.AGH_CHROMIUM_PATH
        ? { channel: 'chrome' }
        : process.env.AGH_CHROMIUM_PATH
          ? { executablePath: process.env.AGH_CHROMIUM_PATH }
          : {}),
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
    await context.addInitScript(() => localStorage.setItem('agnes-theme', localStorage.getItem('agnes-theme') ?? 'light'))
    const external = []
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname
      if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return route.continue()
      external.push(route.request().url())
      return route.abort('blockedbyclient')
    })
    page = await context.newPage()

    await step(3, 'install the companion, configure it in its Web settings page, the engine runs', async (r) => {
      const add = await agh(['plugins', 'add', companion, '--yes'])
      check(add.code === 0, `plugins add exit ${add.code}: ${add.stderr.slice(0, 600)}`)
      const rows = await api('clientModules.list', { profile: 'local-dev' })
      extension = (rows.rows ?? []).find((row) => row.rowId === `web:${PACKAGE}`)?.moduleName
      check(extension, 'the companion client row is not listed')
      // The plugin row is not the engine's settings: the engine reads only what companion.configure saved.
      await agh(['plugins', 'config', 'get', PACKAGE])
      const judgeDir = join(root, 'w', 'judge')
      await page.goto(`${state.url}/?page=settings&pagePackage=${encodeURIComponent(PACKAGE)}`)
      await page.getByRole('heading', { name: '伴侣设置' }).waitFor({ timeout: 60_000 })
      await page.getByLabel('称呼').fill('E2E owner')
      await page.getByLabel('可用工作区（每行一个：短名=绝对路径）').fill(`demo=${ws.work}`)
      await page.getByLabel('专用工作区（主脑判断用，不能是上面的工作区）').fill(judgeDir)
      await page.getByLabel('聊天渠道实例').fill('none')
      await page.getByRole('button', { name: '保存' }).click()
      const review = page.getByRole('dialog', { name: 'Review operation' })
      await review.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 30_000 })
      await shot('03-settings-approval', r)
      await review.getByRole('button', { name: 'Allow once' }).click()
      await page.getByRole('button', { name: '保存' }).click()
      await page.getByText('已提交：completed').waitFor({ timeout: 30_000 })
      await shot('03-settings-saved', r)
      const saved = await service('companion.configuration')
      save('03-configuration.json', saved)
      check(saved.workspaces?.[0]?.path === ws.work && saved.dedicatedWorkspace === judgeDir, 'the saved settings differ from what was typed')
      const grant = await agh(['plugins', 'grants', 'grant', PACKAGE, judgeDir])
      check(grant.code === 0, `granting the judge's dedicated workspace exit ${grant.code}: ${grant.stderr}`)
      r.notes.push('the dedicated judge workspace is granted here: every managed start, the judge included, needs a grant')
      save('03-companion-status.json', await service('companion.status'))
      const running = await until('the engine runs', () => desk(), (d) => d?.running === true, 60_000)
      save('03-desk.json', running)
      r.notes.push(`desk problems: ${running.problems.map((p) => p.kind).join(', ')}`)
    }, [1])

    await step(4, 'before the grant the worker start is refused WORKSPACE_NOT_AUTHORIZED and the desk shows it', async (r) => {
      await sendFromDesk('[e2e:publish] 加一个说明文件，然后发布成一个分支。')
      await shot('04-submitted', r)
      const judged = await until('the judge request at the model', async () => modelLog().filter((x) => x.role === 'judge'), (list) => list.length > 0, 90_000).catch(
        (error) => error,
      )
      if (judged instanceof Error) {
        const sessions = await agh(['sessions', '--json'])
        const judge = JSON.parse(sessions.stdout || '{"items":[]}').items.find((s) => s.preset === 'companion-judge')
        save('04-desk.json', await desk())
        if (judge) {
          save('04-judge-session-view.json', await api('session.view', { sessionId: judge.sessionId }))
          await page.goto(`${state.url}/?session=${encodeURIComponent(judge.sessionId)}`)
          await page.getByRole('region', { name: 'Messages to send' }).waitFor({ timeout: 30_000 }).catch(() => {})
          await shot('04-judge-session-queued', r)
        }
        r.notes.push(`judge session ${judge?.sessionId ?? 'none'} opened, but its opening input never ran a turn`)
        throw new Error(
          'F1: the managed judge session was created and its input queued ("Messages to send"), but no turn ran and the model got no judge request',
        )
      }
      const paused = await until(`${demoTask.id} paused`, () => task(demoTask.id), (t) => t?.state === 'paused', 60_000).catch((error) => error)
      const view = await desk()
      save('04-desk-refused.json', view)
      if (paused instanceof Error) {
        await openDesk()
        await shot('04-desk-not-refused', r)
        const t = allTasks(view).find((x) => x.id === demoTask.id)
        r.notes.push(`task ${t?.id} state ${t?.state} session ${t?.sessionId}; problems ${view.problems.map((p) => p.kind).join(', ')}`)
        throw new Error('F2: the ungranted worker start did not reach the companion as WORKSPACE_NOT_AUTHORIZED; the task stays running with no session and no notice')
      }
      const refusal = view.problems.find((p) => p.kind === 'refusal')
      check(paused.reason === 'platform', `paused for ${paused.reason}, not platform`)
      check(refusal?.code === 'WORKSPACE_NOT_AUTHORIZED', `refusal is ${JSON.stringify(refusal)}`)
      await openDesk()
      await page.getByTestId(`paused-${demoTask.id}`).waitFor()
      await shot('04-desk-refused', r)
    }, [3])

    await step(5, 'grant the workspace, continue from the desk: the worker session starts with full access', async (r) => {
      check(await task(demoTask.id), `${demoTask.id} was never created`)
      const grant = await agh(['plugins', 'grants', 'grant', PACKAGE, ws.work])
      check(grant.code === 0, `grant exit ${grant.code}: ${grant.stderr}`)
      const list = await agh(['plugins', 'grants', 'list', PACKAGE, '--json'])
      save('05-grants.json', list.stdout)
      const items = JSON.parse(list.stdout).items
      check(items.some((i) => i.packageId === PACKAGE && realpathSync(i.workspace) === realpathSync(ws.work)), 'grants list does not show the workspace by package name')
      r.notes.push(`grants list: ${items.map((i) => `${i.packageId} ${i.workspace}`).join('; ')}`)
      await openDesk()
      const proceed = page.getByTestId(`continue-${demoTask.id}`)
      if (await proceed.isVisible()) await proceed.click()
      else r.notes.push(`${demoTask.id} was not paused, so there was no 继续 to press; the companion retries the start by itself`)
      const started = await until(
        `${demoTask.id} worker session`,
        () => desk(),
        (d) => {
          const t = allTasks(d).find((x) => x.id === demoTask.id)
          return Boolean(t?.sessionId) || (t?.state === 'paused' && d.problems.some((p) => p.kind === 'refusal' && p.code !== 'WORKSPACE_NOT_AUTHORIZED'))
        },
        120_000,
      )
      save('05-desk.json', started)
      const t = allTasks(started).find((x) => x.id === demoTask.id)
      demoTask.sessionId = t.sessionId
      if (!t.sessionId) {
        const refusal = started.problems.find((p) => p.kind === 'refusal')
        r.notes.push(`worker refused: ${JSON.stringify(refusal)}`)
        throw new Error(`worker start refused ${refusal?.code} missing ${refusal?.missing}`)
      }
      r.notes.push(`worker session ${t.sessionId}`)
      const view = await api('session.view', { sessionId: t.sessionId })
      save('05-worker-session-view.json', view)
      const runtimeView = await api('session.runtime', { sessionId: t.sessionId }).catch((error) => ({ error: String(error) }))
      save('05-worker-runtime.json', runtimeView)
      r.notes.push(`worker policy: ${JSON.stringify(runtimeView.policy?.permission ?? runtimeView.error ?? null)}`)
      await shot('05-desk-running', r)
    }, [3])

    await step(6, 'in the worker, cat ~/.ssh/id_test does not reveal the secret; a local command runs without approval', async (r) => {
      check(demoTask.sessionId, 'no worker session')
      const calls = await until('worker shell calls', async () => workerCalls(demoTask.id), (c) => c.filter((x) => x.name === 'shell' && x.result !== null).length >= 2, 120_000)
      save('06-worker-calls.json', calls)
      const cat = calls.find((c) => c.name === 'shell' && c.args.command?.includes('id_test'))
      const write = calls.find((c) => c.name === 'shell' && c.args.command?.includes('e2e-change'))
      check(cat && !cat.result.includes(secret), 'the secret reached the worker')
      check(!/No such file/i.test(cat.result), `cat saw no file, so the boundary was not exercised: ${cat.result}`)
      check(!modelLog().some((x) => JSON.stringify(x.request ?? null).includes(secret)), 'the secret appears in a model request')
      check(write && /wrote/.test(write.result), `the local command did not run: ${write?.result}`)
      check(existsSync(join(ws.work, `e2e-change-${demoTask.id.toLowerCase()}.txt`)), 'the local command left no file')
      const view = await api('session.view', { sessionId: demoTask.sessionId })
      save('06-session-view.json', view)
      const approvals = (view.timeline?.nodes ?? []).filter((n) => n.kind === 'approval')
      const tools = (view.timeline?.nodes ?? []).filter((n) => n.kind === 'tool').map((n) => n.name)
      r.notes.push(`cat result: ${cat.result.replace(/\s+/g, ' ').slice(0, 200)}`)
      r.notes.push(`tools so far ${tools.join(', ')}; approvals before publish: ${approvals.filter((a) => a.toolName !== 'publish').length}`)
      // Under full access the platform still records each shell call as an approval, decided at once by the policy.
      const shellAsks = approvals.filter((a) => a.toolName === 'shell')
      r.notes.push(`shell approvals: ${shellAsks.map((a) => `${a.state} via ${a.decision?.via}`).join('; ')}`)
      check(shellAsks.every((a) => a.state === 'decided' && a.decision?.via !== 'human'), 'a shell command waited for a person')
    }, [5])

    await step(7, 'publish stops for a person; the owner approves in the Web session; the branch reaches the bare remote', async (r) => {
      check(demoTask.sessionId, 'no worker session')
      await until(`${demoTask.id} waits for approval`, () => task(demoTask.id), (t) => t?.state === 'waiting', 120_000)
      await openDesk()
      await page.getByTestId(`wait-${demoTask.id}`).waitFor()
      await shot('07-desk-waiting', r)
      await page.getByTestId(`go-${demoTask.id}`).click()
      const card = page.getByTestId('approval-card')
      await card.waitFor({ timeout: 60_000 })
      const actions = await page.locator('[data-approval-action]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-approval-action'), label: e.textContent })))
      save('07-approval-actions.json', actions)
      await shot('07-approval-card', r)
      const allow = actions.find((a) => /allow|approve|once/i.test(a.id ?? '')) ?? actions[0]
      r.notes.push(`approval actions ${JSON.stringify(actions)}; clicked ${allow.id}`)
      await page.locator(`[data-approval-action="${allow.id}"]`).click()
      const done = await until(`${demoTask.id} done`, () => task(demoTask.id), (t) => t?.state === 'done' || t?.state === 'failed' || t?.state === 'paused', 120_000)
      save('07-task.json', await desk(demoTask.id))
      await shot('07-session-after', r)
      const branches = ws.git(ws.bare, 'branch', '--list')
      save('07-remote-branches.txt', branches)
      const publish = workerCalls(demoTask.id).find((c) => c.name === 'publish')
      save('07-publish-call.json', publish ?? null)
      r.notes.push(`task ${done.state}; remote branches: ${branches.replace(/\s+/g, ' ').trim()}`)
      r.notes.push(`publish result: ${publish?.result?.slice(0, 400)}`)
      r.notes.push(`gh calls: ${existsSync(join(root, 'gh-calls.log')) ? readFileSync(join(root, 'gh-calls.log'), 'utf8').trim() : 'none'}`)
      const view = await api('session.view', { sessionId: demoTask.sessionId })
      save('07-session-view.json', view)
      const decided = (view.timeline?.nodes ?? []).filter((n) => n.kind === 'approval').map((n) => ({ seq: n.seq, state: n.state, decidedSeq: n.decidedSeq, decision: n.decision }))
      save('07-approval-nodes.json', decided)
      r.notes.push(`approval nodes ${JSON.stringify(decided)}`)
      check(branches.includes(`companion/${demoTask.id.toLowerCase()}`), 'the branch did not reach the bare remote')
      check(decided.some((d) => d.decision?.via === 'human'), 'no approval decided by a human')
    }, [5])

    await step(8, 'a second task: three Web rejections of publish pause it (only person rejections count)', async (r) => {
      await sendFromDesk('[e2e:reject] 再加一个文件，然后发布。')
      const running = await until(`${rejectTask.id} worker session`, () => task(rejectTask.id), (t) => Boolean(t?.sessionId) || t?.state === 'paused', 180_000)
      check(running.sessionId, `no worker session: ${JSON.stringify(running)}`)
      rejectTask.sessionId = running.sessionId
      for (let round = 1; round <= 3; round++) {
        await until(`${rejectTask.id} approval ${round}`, () => task(rejectTask.id), (t) => t?.state === 'waiting' || t?.state === 'paused', 120_000)
        await page.goto(`${state.url}/?session=${encodeURIComponent(rejectTask.sessionId)}`)
        await page.getByTestId('approval-card').waitFor({ timeout: 60_000 })
        const actions = await page.locator('[data-approval-action]').evaluateAll((els) => els.map((e) => ({ id: e.getAttribute('data-approval-action'), label: e.textContent })))
        const reject = actions.find((a) => /reject|deny|decline/i.test(a.id ?? ''))
        check(reject, `no reject action in ${JSON.stringify(actions)}`)
        if (round === 1) await shot('08-reject-card', r)
        await page.locator(`[data-approval-action="${reject.id}"]`).click()
        const after = await until(
          `${rejectTask.id} after rejection ${round}`,
          () => task(rejectTask.id),
          (t) => t && (t.refusals >= round || t.state === 'paused'),
          60_000,
        ).catch((error) => error.last)
        r.notes.push(`after rejection ${round}: state ${after?.state} reason ${after?.reason} refusals ${after?.refusals}`)
        if (!after || (after.refusals < round && after.state !== 'paused')) {
          const view = await api('session.view', { sessionId: rejectTask.sessionId })
          save('08-session-view.json', view)
          throw new Error(`rejection ${round} did not count: the companion saw no person rejection`)
        }
      }
      const paused = await until(`${rejectTask.id} paused`, () => task(rejectTask.id), (t) => t?.state === 'paused', 60_000)
      save('08-task.json', await desk(rejectTask.id))
      const view = await api('session.view', { sessionId: rejectTask.sessionId })
      save('08-session-view.json', view)
      save('08-approval-nodes.json', (view.timeline?.nodes ?? []).filter((n) => n.kind === 'approval').map((n) => ({ seq: n.seq, state: n.state, decision: n.decision })))
      check(paused.reason === 'refused', `paused for ${paused.reason}, not refused`)
      check(!ws.git(ws.bare, 'branch', '--list').includes(`companion/${rejectTask.id.toLowerCase()}`), 'a rejected publish reached the remote')
    }, [5])

    await step(9, 'the desk groups the tasks; light and dark screenshots', async (r) => {
      const view = await desk()
      save('09-desk.json', view)
      const ids = (group) => (view.tasks[group] ?? []).map((t) => t.id)
      r.notes.push(`recent ${ids('recent')}; paused ${ids('paused')}; needsYou ${ids('needsYou')}; running ${ids('running')}`)
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => localStorage.setItem('agnes-theme', t), theme)
        await openDesk()
        await shot(`09-desk-${theme}`, r)
      }
      check(ids('recent').includes(demoTask.id) || ids('paused').includes(demoTask.id), `${demoTask.id} is in no expected group`)
      check(ids('paused').includes(rejectTask.id), `${rejectTask.id} is not in paused`)
      check(!external.length, `the page asked for non-loopback addresses: ${external.join(', ')}`)
    }, [3])
  } finally {
    await browser?.close().catch(() => {})
    if (holdAfter !== undefined) {
      writeFileSync(join(root, 'env.json'), JSON.stringify({ env, runtime, apiKey: model.apiKey }))
      console.log(`HOLD ${root}; the loopback model stops with this process. agh: node scripts/e2e/run.mjs --cli ${root} -- <args>`)
      await new Promise(() => {})
    }
    await step(10, 'cleanup the isolated run', async (r) => {
      const pids = ownedPids(state)
      if (alive(state.servePid)) process.kill(state.servePid, 'SIGTERM')
      const stop = await agh(['daemon', 'stop'], { cwd: root, timeout: 30_000 })
      r.notes.push(`daemon stop exit ${stop.code}`)
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(250)
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL')
      await model.close()
      if (existsSync(join(root, 'serve.log'))) save('serve.log', readFileSync(join(root, 'serve.log'), 'utf8'))
      check(!(await portOpen(port)), `port ${port} still answers`)
      if (!keep) rmSync(root, { recursive: true, force: true })
      r.notes.push(keep ? `kept ${root}` : `removed ${root}`)
    })
  }
  const failed = steps.filter((s) => !s.ok)
  console.log(`EVIDENCE ${evidence}`)
  console.log(failed.length ? `FAILED steps ${failed.map((s) => s.n).join(', ')}` : 'ALL STEPS PASSED')
  process.exitCode = failed.length ? 1 : 0
}

/** Stops whatever a stopped or crashed run left behind and removes its root. */
async function cleanupOnly(root) {
  const real = realpathSync(root)
  if (dirname(real) !== realpathSync('/tmp') || !basename(real).startsWith('agh-e2e-')) throw new Error(`refusing ${root}: not an /tmp/agh-e2e-* root`)
  const file = join(real, 'state.json')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { root: real, home: join(real, 'h'), servePid: 0 }
  const pids = ownedPids(state)
  for (const pid of pids.filter(alive)) process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(250)
  for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL')
  rmSync(real, { recursive: true, force: true })
  console.log(`CLEAN ${real} (stopped ${pids.length} processes)`)
}

/** `agh` against a run held with --until. */
function cliOnly(root, argv) {
  const { env, runtime } = JSON.parse(readFileSync(join(root, 'env.json'), 'utf8'))
  try {
    process.stdout.write(execFileSync(process.execPath, [join(runtime, 'agnes.mjs'), ...argv], { cwd: join(root, 'w', 'demo'), env, encoding: 'utf8' }))
  } catch (error) {
    process.stdout.write(error.stdout ?? '')
    process.stderr.write(error.stderr ?? String(error))
    process.exitCode = 1
  }
}

if (flag('--cleanup')) await cleanupOnly(/** @type {string} */ (flag('--cleanup')))
else if (flag('--cli')) cliOnly(/** @type {string} */ (flag('--cli')), args.slice(args.indexOf('--') + 1))
else await main()
