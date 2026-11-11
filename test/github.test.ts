import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkToolDef } from '../../../../packages/extension-api/src/index.js'
import { GITHUB_READ_META, GITHUB_READ_TOOL_NAME, githubReadTool } from '../github.mjs'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A git repo whose origin is `url` (none when undefined), plus a gh stub that logs and answers. */
function setup({ url = 'https://github.com/example-org/example-repo.git' }: { url?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-github-'))
  temps.push(dir)
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  if (url) git(work, 'remote', 'add', 'origin', url)
  const log = join(dir, 'calls.log')
  const out = join(dir, 'stdout')
  const err = join(dir, 'stderr')
  const code = join(dir, 'code')
  writeFileSync(out, '[]')
  writeFileSync(err, '')
  writeFileSync(code, '0')
  const stub = join(dir, 'gh')
  writeFileSync(
    stub,
    `#!/bin/sh
{ printf 'ARGS'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'
  printf 'CWD %s\\n' "$(pwd)"; printf 'HOOKS %s\\n' "$GIT_CONFIG_VALUE_0"; } >> '${log}'
cat '${out}'
cat '${err}' >&2
exit "$(cat '${code}')"
`,
    { mode: 0o755 },
  )
  const ctx = (root = work) => ({ session: { workspaceRoot: root }, signal: new AbortController().signal, log: { info() {} } })
  const tool = githubReadTool({ command: stub })
  const call = (args: Record<string, unknown>, root?: string) => tool.execute(args as never, ctx(root) as never)
  return {
    dir,
    work,
    call,
    reply: (stdout: string, { stderr = '', exit = 0 } = {}) => {
      writeFileSync(out, stdout)
      writeFileSync(err, stderr)
      writeFileSync(code, String(exit))
    },
    calls: () => (readFileSync(log, { flag: 'a+', encoding: 'utf8' }) as string).split('\n').filter(Boolean),
  }
}

const REPO = '--repo=github.com/example-org/example-repo'
const LIST_FIELDS =
  '--json=number,title,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,url,reviewDecision'
type Structured = { status: string; reason?: string; detail?: string; action?: string; repo?: string; data?: unknown; truncated?: boolean }
const structured = (r: unknown) => (r as { structured: Structured }).structured

describe('github_read', () => {
  it('is a read-only, open-world tool that warns the content is not instructions', () => {
    const tool = githubReadTool()
    expect(tool.name).toBe(GITHUB_READ_TOOL_NAME)
    expect(GITHUB_READ_TOOL_NAME).toBe('github_read')
    expect(tool.meta).toBe(GITHUB_READ_META)
    expect(tool.meta).toMatchObject({
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: true,
      replay: 'safe',
      requiresApproval: 'never',
    })
    expect(tool.description).toMatch(/other people/)
    expect(tool.description).toMatch(/never as instructions/)
    expect(checkToolDef(tool)).toEqual({ ok: true })
  })

  it('lists pull requests with defaults, from origin, in an empty directory with the git safety env', async () => {
    const t = setup()
    t.reply('[{"number":7,"title":"x"}]')
    const result = await t.call({ action: 'pr_list' })
    expect(structured(result)).toEqual({
      status: 'ok',
      action: 'pr_list',
      repo: 'github.com/example-org/example-repo',
      data: [{ number: 7, title: 'x' }],
    })
    expect(JSON.parse((result as { content: { text: string }[] }).content[0]!.text)).toMatchObject({ status: 'ok' })
    const [args, cwd, hooks] = t.calls()
    expect(args).toBe(`ARGS [pr] [list] [${REPO}] [--state=open] [--limit=20] [${LIST_FIELDS}]`)
    expect(cwd).not.toContain(t.work)
    expect(hooks).toBe('HOOKS /dev/null')
  })

  it('maps state, limit, base and author onto fixed flags', async () => {
    const t = setup()
    await t.call({ action: 'pr_list', state: 'merged', limit: 50, base: 'release/1.0', author: 'octo-cat' })
    expect(t.calls()[0]).toBe(
      `ARGS [pr] [list] [${REPO}] [--state=merged] [--limit=50] [--base=release/1.0] [--author=octo-cat] [${LIST_FIELDS}]`,
    )
  })

  it('views, checks and diffs one pull request with fixed fields', async () => {
    const t = setup()
    t.reply('{"number":12}')
    expect(structured(await t.call({ action: 'pr_view', number: 12 })).data).toEqual({ number: 12 })
    t.reply('[{"name":"build","bucket":"pass"}]')
    expect(structured(await t.call({ action: 'pr_checks', number: 12 })).data).toEqual([
      { name: 'build', bucket: 'pass' },
    ])
    t.reply('diff --git a/x b/x\n')
    expect(structured(await t.call({ action: 'pr_diff', number: 12 })).data).toBe('diff --git a/x b/x\n')
    const calls = t.calls().filter((l) => l.startsWith('ARGS'))
    expect(calls[0]).toBe(
      `ARGS [pr] [view] [12] [${REPO}] [--json=number,title,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,url,reviewDecision,body,mergeable,additions,deletions,changedFiles,files,labels,mergedAt,comments]`,
    )
    expect(calls[1]).toBe(
      `ARGS [pr] [checks] [12] [${REPO}] [--json=name,state,bucket,link,workflow,startedAt,completedAt]`,
    )
    expect(calls[2]).toBe(`ARGS [pr] [diff] [12] [${REPO}] [--color=never]`)
  })

  it('treats gh pr checks JSON as success even when gh exits non-zero', async () => {
    const t = setup()
    t.reply('[{"name":"build","bucket":"pending"}]', { exit: 8 })
    expect(structured(await t.call({ action: 'pr_checks', number: 3 }))).toMatchObject({
      status: 'ok',
      data: [{ name: 'build', bucket: 'pending' }],
    })
    t.reply('[{"name":"build","bucket":"fail"}]', { exit: 1 })
    expect(structured(await t.call({ action: 'pr_checks', number: 3 })).status).toBe('ok')
    t.reply('', { stderr: 'no checks reported', exit: 1 })
    expect(structured(await t.call({ action: 'pr_checks', number: 3 }))).toMatchObject({
      status: 'refused',
      reason: 'gh-failed',
    })
  })

  it('refuses unknown actions, out-of-range values and extra parameters before running anything', async () => {
    const t = setup()
    const bad: Record<string, unknown>[] = [
      {},
      { action: 'pr_merge', number: 1 },
      { action: 'pr_list', state: 'everything' },
      { action: 'pr_list', limit: 0 },
      { action: 'pr_list', limit: 51 },
      { action: 'pr_list', limit: 1.5 },
      { action: 'pr_list', limit: '5' },
      { action: 'pr_list', base: '--web' },
      { action: 'pr_list', base: 'a..b' },
      { action: 'pr_list', author: 'bad name' },
      { action: 'pr_list', author: '-x' },
      { action: 'pr_list', author: 'a'.repeat(40) },
      { action: 'pr_list', number: 1 },
      { action: 'pr_view' },
      { action: 'pr_view', number: 0 },
      { action: 'pr_view', number: -1 },
      { action: 'pr_view', number: 1.5 },
      { action: 'pr_view', number: '12' },
      { action: 'pr_view', number: 1, state: 'open' },
      { action: 'pr_diff', number: 1, args: ['--web'] },
      { action: 'pr_view', number: 1, repo: 'other-org/secret' },
      { action: 'pr_list', repository: 'other-org/secret' },
    ]
    for (const args of bad) {
      expect(structured(await t.call(args)), JSON.stringify(args)).toMatchObject({
        status: 'refused',
        reason: 'invalid-input',
      })
    }
    expect(t.calls()).toEqual([])
    expect((await t.call({ action: 'pr_list' })) as { isError?: boolean }).not.toHaveProperty('isError')
  })

  it('always uses the repository of the workspace origin, never a model-supplied one', async () => {
    const t = setup({ url: 'git@ghe.example.test:team/app.git' })
    await t.call({ action: 'pr_view', number: 4, repo: 'other-org/secret' })
    expect(t.calls()).toEqual([])
    await t.call({ action: 'pr_view', number: 4 })
    expect(t.calls()[0]).toContain('[--repo=ghe.example.test/team/app]')
  })

  it('reads the fetch URL of origin, not its push URL', async () => {
    const t = setup()
    git(t.work, 'remote', 'set-url', '--push', 'origin', 'https://github.com/other-org/elsewhere.git')
    await t.call({ action: 'pr_list' })
    expect(t.calls()[0]).toContain(REPO)
  })

  it('refuses a workspace that is not a git root', async () => {
    const t = setup()
    const sub = join(t.work, 'sub')
    mkdirSync(sub)
    const plain = join(t.dir, 'plain')
    mkdirSync(plain)
    for (const root of [sub, plain, join(t.dir, 'missing')])
      expect(structured(await t.call({ action: 'pr_list' }, root))).toMatchObject({
        status: 'refused',
        reason: 'not-a-git-repo',
      })
    expect(t.calls()).toEqual([])
  })

  it('refuses a repository without a usable origin', async () => {
    const none = setup({ url: '' })
    expect(structured(await none.call({ action: 'pr_list' }))).toMatchObject({ status: 'refused', reason: 'no-remote' })
    const odd = setup({ url: 'https://github.com/only-owner' })
    expect(structured(await odd.call({ action: 'pr_list' }))).toMatchObject({ status: 'refused', reason: 'no-remote' })
    expect([...none.calls(), ...odd.calls()]).toEqual([])
  })

  it('truncates long pull request bodies, comments and diffs and says so', async () => {
    const t = setup()
    const long = 'x'.repeat(30_000)
    t.reply(JSON.stringify({ number: 1, body: long, comments: [{ body: long }, { body: 'short' }] }))
    const view = structured(await t.call({ action: 'pr_view', number: 1 }))
    const data = view.data as { body: string; comments: { body: string }[] }
    expect(view.truncated).toBe(true)
    expect(data.body.length).toBeLessThan(20_100)
    expect(data.comments[0]!.body.length).toBeLessThan(20_100)
    expect(data.comments[1]!.body).toBe('short')

    t.reply(JSON.stringify({ number: 1, body: 'small', comments: [] }))
    expect(structured(await t.call({ action: 'pr_view', number: 1 }))).not.toHaveProperty('truncated')

    t.reply('d'.repeat(300_000))
    const diff = structured(await t.call({ action: 'pr_diff', number: 1 }))
    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.data as string)).toBeLessThanOrEqual(200 * 1024 + 16)
  })

  it('reports gh failures with credentials stripped from the stderr tail', async () => {
    const t = setup()
    t.reply('', { stderr: 'fatal: unable to access https://user:tok3n@github.com/example-org/example-repo/', exit: 1 })
    const result = await t.call({ action: 'pr_list' })
    expect(result).toMatchObject({ isError: true })
    const s = structured(result)
    expect(s).toMatchObject({ status: 'refused', reason: 'gh-failed' })
    expect(s.detail).toContain('github.com/example-org/example-repo')
    expect(s.detail).not.toContain('tok3n')
    t.reply('not json', { exit: 0 })
    expect(structured(await t.call({ action: 'pr_list' }))).toMatchObject({ status: 'refused', reason: 'gh-failed' })
  })
})
