import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkToolDef } from '../../../../packages/extension-api/src/index.js'
import { GIT_READ_META, GIT_READ_TOOL_NAME, gitReadTool } from '../git-read.mjs'

vi.setConfig({ testTimeout: 30_000 })

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada Dev',
  GIT_AUTHOR_EMAIL: 'ada@example.test',
  GIT_COMMITTER_NAME: 'Ada Dev',
  GIT_COMMITTER_EMAIL: 'ada@example.test',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05+0800',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05+0800',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim()
const commit = (cwd: string, message: string) => git(cwd, 'commit', '-q', '-m', message)

/** A repo with two commits on main: `a.txt` (one then two lines) and `src/b.txt`. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-git-read-'))
  temps.push(dir)
  const work = join(dir, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  writeFileSync(join(work, 'a.txt'), 'one\n')
  mkdirSync(join(work, 'src'))
  writeFileSync(join(work, 'src', 'b.txt'), 'bee\n')
  git(work, 'add', '.')
  commit(work, 'first commit')
  const first = git(work, 'rev-parse', 'HEAD')
  writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')
  git(work, 'add', '.')
  commit(work, 'second commit')
  const second = git(work, 'rev-parse', 'HEAD')
  const ctx = (root = work) => ({ session: { workspaceRoot: root }, signal: new AbortController().signal, log: { info() {} } })
  const tool = gitReadTool()
  const call = (args: Record<string, unknown>, root?: string) => tool.execute(args as never, ctx(root) as never)
  const read = async (args: Record<string, unknown>, root?: string) => structured(await call(args, root))
  return { dir, work, first, second, call, read }
}

type Structured = { status: string; reason?: string; detail?: string; action?: string; data?: any; truncated?: boolean }
const structured = (r: unknown) => (r as { structured: Structured }).structured
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true

describe('git_read', () => {
  it('is a read-only, closed-world tool', () => {
    const tool = gitReadTool()
    expect(tool.name).toBe(GIT_READ_TOOL_NAME)
    expect(GIT_READ_TOOL_NAME).toBe('git_read')
    expect(tool.meta).toBe(GIT_READ_META)
    expect(tool.meta).toMatchObject({
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      requiresApproval: 'never',
    })
    expect(() => checkToolDef(tool)).not.toThrow()
  })

  describe('status', () => {
    it('reports the branch and each kind of change', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'a.txt'), 'one\ntwo\nthree\n')
      writeFileSync(join(t.work, 'new.txt'), 'x\n')
      git(t.work, 'mv', 'src/b.txt', 'src/c.txt')
      const s = await t.read({ action: 'status' })
      expect(s).toMatchObject({ status: 'ok', action: 'status' })
      expect(s.data.branch).toMatchObject({ oid: t.second, head: 'main' })
      expect(s.data.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'changed', xy: '.M', path: 'a.txt' }),
          expect.objectContaining({ kind: 'renamed', path: 'src/c.txt', from: 'src/b.txt' }),
          expect.objectContaining({ kind: 'untracked', path: 'new.txt' }),
        ]),
      )
      expect(s.truncated).toBeUndefined()
    })

    it('reports ahead and behind of the upstream', async () => {
      const t = setup()
      git(t.work, 'remote', 'add', 'origin', join(t.dir, 'nowhere'))
      git(t.work, 'update-ref', 'refs/remotes/origin/main', t.first)
      git(t.work, 'config', 'branch.main.remote', 'origin')
      git(t.work, 'config', 'branch.main.merge', 'refs/heads/main')
      const s = await t.read({ action: 'status' })
      expect(s.data.branch).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0 })
    })

    it('does not write the index even when it is stale', async () => {
      const t = setup()
      const index = join(t.work, '.git', 'index')
      execFileSync('touch', [join(t.work, 'a.txt')])
      const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs }
      await new Promise((resolve) => setTimeout(resolve, 20))
      await t.read({ action: 'status' })
      expect(readFileSync(index).equals(before.bytes)).toBe(true)
      expect(statSync(index).mtimeMs).toBe(before.mtime)
      expect(existsSync(`${index}.lock`)).toBe(false)
    })

    it('cuts at 2000 entries', async () => {
      const t = setup()
      mkdirSync(join(t.work, 'many'))
      for (let i = 0; i < 2005; i++) writeFileSync(join(t.work, 'many', `f${i}.txt`), '')
      git(t.work, 'config', 'status.showUntrackedFiles', 'all')
      const s = await t.read({ action: 'status' })
      expect(s.status).toBe('ok')
      expect(s.data.entries).toHaveLength(2000)
      expect(s.truncated).toBe(true)
    })

    it('does not descend into a submodule', async () => {
      const t = setup()
      const sub = join(t.dir, 'sub')
      execFileSync('git', ['init', '-q', '-b', 'main', sub])
      writeFileSync(join(sub, 's.txt'), 's\n')
      git(sub, 'add', '.')
      commit(sub, 'sub')
      git(t.work, 'submodule', 'add', '-q', sub, 'mod')
      commit(t.work, 'add submodule')
      writeFileSync(join(t.work, 'mod', 's.txt'), 'changed\n')
      writeFileSync(join(t.work, 'mod', 'extra.txt'), 'x\n')
      const s = await t.read({ action: 'status' })
      expect(s.data.entries.filter((e: { path: string }) => e.path.startsWith('mod'))).toEqual([])
      const d = await t.read({ action: 'diff' })
      expect(d.data).toBe('')
    })
  })

  describe('log', () => {
    it('lists hash, author name, ISO date and subject, newest first, without an email', async () => {
      const t = setup()
      const s = await t.read({ action: 'log' })
      expect(s.data).toEqual([
        { hash: t.second, author: 'Ada Dev', date: '2026-01-02T03:04:05+08:00', subject: 'second commit' },
        { hash: t.first, author: 'Ada Dev', date: '2026-01-02T03:04:05+08:00', subject: 'first commit' },
      ])
      expect(JSON.stringify(s)).not.toContain('example.test')
    })

    it('defaults to 20, honours limit, and filters by ref and path', async () => {
      const t = setup()
      for (let i = 0; i < 23; i++) {
        writeFileSync(join(t.work, 'src', 'b.txt'), `v${i}\n`)
        git(t.work, 'commit', '-q', '-a', '-m', `bump ${i}`)
      }
      expect((await t.read({ action: 'log' })).data).toHaveLength(20)
      expect((await t.read({ action: 'log', limit: 3 })).data).toHaveLength(3)
      expect((await t.read({ action: 'log', ref: t.first })).data.map((c: { hash: string }) => c.hash)).toEqual([t.first])
      const onA = await t.read({ action: 'log', path: 'a.txt' })
      expect(onA.data.map((c: { subject: string }) => c.subject)).toEqual(['second commit', 'first commit'])
      expect((await t.read({ action: 'log', path: '*.txt' })).data).toEqual([])
    })

    it.each([
      [{ limit: 0 }],
      [{ limit: 101 }],
      [{ limit: 1.5 }],
      [{ limit: '5' }],
    ])('refuses limit %j', async (extra) => {
      const t = setup()
      const r = await t.call({ action: 'log', ...extra })
      expect(structured(r)).toMatchObject({ status: 'refused', reason: 'invalid-input' })
      expect(isError(r)).toBe(true)
    })

    it('refuses a ref git cannot resolve', async () => {
      const t = setup()
      expect(await t.read({ action: 'log', ref: 'no-such-branch' })).toMatchObject({ status: 'refused', reason: 'git-failed' })
    })
  })

  describe('diff', () => {
    it('compares the working tree with HEAD by default, staged changes included', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'a.txt'), 'one\ntwo\nthree\n')
      git(t.work, 'add', 'a.txt')
      writeFileSync(join(t.work, 'src', 'b.txt'), 'bee\nsting\n')
      const d = await t.read({ action: 'diff' })
      expect(d.data).toContain('+three')
      expect(d.data).toContain('+sting')
      expect(d.truncated).toBeUndefined()
    })

    it('shows only the index with staged, and narrows to a path', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'a.txt'), 'one\ntwo\nthree\n')
      git(t.work, 'add', 'a.txt')
      writeFileSync(join(t.work, 'src', 'b.txt'), 'bee\nsting\n')
      const staged = await t.read({ action: 'diff', staged: true })
      expect(staged.data).toContain('+three')
      expect(staged.data).not.toContain('+sting')
      const path = await t.read({ action: 'diff', path: 'src/b.txt' })
      expect(path.data).toContain('+sting')
      expect(path.data).not.toContain('+three')
    })

    it('compares two commits with from and to', async () => {
      const t = setup()
      const d = await t.read({ action: 'diff', from: t.first, to: 'HEAD' })
      expect(d.data).toContain('+two')
      const back = await t.read({ action: 'diff', from: 'HEAD', to: 'HEAD~1' })
      expect(back.data).toContain('-two')
    })

    it.each([
      [{ staged: true, from: 'HEAD', to: 'HEAD' }],
      [{ from: 'HEAD' }],
      [{ to: 'HEAD' }],
      [{ staged: 'yes' }],
      [{ ref: 'HEAD' }],
    ])('refuses the combination %j', async (extra) => {
      const t = setup()
      expect(await t.read({ action: 'diff', ...extra })).toMatchObject({ status: 'refused', reason: 'invalid-input' })
    })

    it('cuts a diff over 200 KB and marks it truncated', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'a.txt'), `${'y'.repeat(79)}\n`.repeat(4000))
      const d = await t.read({ action: 'diff' })
      expect(d.status).toBe('ok')
      expect(d.truncated).toBe(true)
      expect(Buffer.byteLength(d.data)).toBeLessThan(200 * 1024 + 64)
      expect(d.data).toContain('[truncated]')
    })

    it('falls back to a stat when the diff is too large to hold at all', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'a.txt'), `${'z'.repeat(99)}\n`.repeat(14_000))
      const d = await t.read({ action: 'diff' })
      expect(d.status).toBe('ok')
      expect(d.truncated).toBe(true)
      expect(d.data).toContain('a.txt')
      expect(Buffer.byteLength(d.data)).toBeLessThan(200 * 1024 + 64)
    })
  })

  describe('show', () => {
    it('gives the commit fields and its diff, without an email', async () => {
      const t = setup()
      const s = await t.read({ action: 'show', ref: 'HEAD' })
      expect(s.data).toMatchObject({ hash: t.second, author: 'Ada Dev', date: '2026-01-02T03:04:05+08:00', message: 'second commit' })
      expect(s.data.diff).toContain('+two')
      expect(JSON.stringify(s)).not.toContain('example.test')
      const old = await t.read({ action: 'show', ref: t.first.slice(0, 8) })
      expect(old.data.hash).toBe(t.first)
      expect(old.data.diff).toContain('+bee')
    })

    it('resolves an annotated tag to its commit', async () => {
      const t = setup()
      git(t.work, 'tag', '-a', 'v1', '-m', 'release', t.first)
      const s = await t.read({ action: 'show', ref: 'v1' })
      expect(s.data.hash).toBe(t.first)
      expect(JSON.stringify(s)).not.toContain('example.test')
    })

    it('requires a ref and refuses one that names no commit', async () => {
      const t = setup()
      expect(await t.read({ action: 'show' })).toMatchObject({ status: 'refused', reason: 'invalid-input' })
      expect(await t.read({ action: 'show', ref: 'nope' })).toMatchObject({ status: 'refused', reason: 'git-failed' })
    })

    it('cuts the diff over 200 KB', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'a.txt'), `${'q'.repeat(79)}\n`.repeat(4000))
      git(t.work, 'commit', '-q', '-a', '-m', 'big')
      const s = await t.read({ action: 'show', ref: 'HEAD' })
      expect(s.truncated).toBe(true)
      expect(Buffer.byteLength(s.data.diff)).toBeLessThan(200 * 1024 + 64)
    })
  })

  describe('blame', () => {
    it('attributes each line of a file at HEAD', async () => {
      const t = setup()
      const b = await t.read({ action: 'blame', path: 'a.txt' })
      expect(b.data).toEqual([
        { line: 1, hash: t.first, author: 'Ada Dev', date: '2026-01-02T03:04:05+08:00', summary: 'first commit', text: 'one' },
        { line: 2, hash: t.second, author: 'Ada Dev', date: '2026-01-02T03:04:05+08:00', summary: 'second commit', text: 'two' },
      ])
      expect(JSON.stringify(b)).not.toContain('example.test')
      expect(b.truncated).toBeUndefined()
    })

    it('honours ref and the line range', async () => {
      const t = setup()
      const old = await t.read({ action: 'blame', path: 'a.txt', ref: t.first })
      expect(old.data).toHaveLength(1)
      const one = await t.read({ action: 'blame', path: 'a.txt', startLine: 2, endLine: 2 })
      expect(one.data.map((l: { line: number }) => l.line)).toEqual([2])
      const from = await t.read({ action: 'blame', path: 'a.txt', startLine: 2 })
      expect(from.data.map((l: { line: number }) => l.line)).toEqual([2])
    })

    it('stops at 500 lines and says so', async () => {
      const t = setup()
      writeFileSync(join(t.work, 'long.txt'), Array.from({ length: 600 }, (_, i) => `l${i + 1}`).join('\n') + '\n')
      git(t.work, 'add', '.')
      commit(t.work, 'long')
      const b = await t.read({ action: 'blame', path: 'long.txt' })
      expect(b.data).toHaveLength(500)
      expect(b.truncated).toBe(true)
      const part = await t.read({ action: 'blame', path: 'long.txt', startLine: 501 })
      expect(part.data).toHaveLength(100)
      expect(part.truncated).toBeUndefined()
    })

    it.each([
      [{ startLine: 1, endLine: 501 }],
      [{ startLine: 0 }],
      [{ startLine: 3, endLine: 2 }],
      [{ endLine: 2 }],
      [{ startLine: 1.5 }],
    ])('refuses the range %j', async (extra) => {
      const t = setup()
      expect(await t.read({ action: 'blame', path: 'a.txt', ...extra })).toMatchObject({ status: 'refused', reason: 'invalid-input' })
    })

    it('requires a path, and refuses one git does not know', async () => {
      const t = setup()
      expect(await t.read({ action: 'blame' })).toMatchObject({ status: 'refused', reason: 'invalid-input' })
      expect(await t.read({ action: 'blame', path: 'missing.txt' })).toMatchObject({ status: 'refused', reason: 'git-failed' })
    })

    it('reads a symlink as its target text, not the file it points to', async () => {
      const t = setup()
      const secret = join(t.dir, 'secret.txt')
      writeFileSync(secret, 'top secret\n')
      symlinkSync(secret, join(t.work, 'link'))
      git(t.work, 'add', 'link')
      commit(t.work, 'link')
      const b = await t.read({ action: 'blame', path: 'link' })
      expect(JSON.stringify(b)).not.toContain('top secret')
    })
  })

  describe('a worker-made symlink in the workspace', () => {
    /** `dir/a.txt` is committed; `dir` is then replaced by a link to a directory outside the workspace. */
    function linked() {
      const t = setup()
      mkdirSync(join(t.work, 'dir'))
      writeFileSync(join(t.work, 'dir', 'a.txt'), 'inside\n')
      git(t.work, 'add', 'dir')
      commit(t.work, 'dir')
      const outside = join(t.dir, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'a.txt'), 'SECRET-MARKER\n')
      rmSync(join(t.work, 'dir'), { recursive: true })
      symlinkSync(outside, join(t.work, 'dir'))
      return t
    }

    it('is never read by blame without a ref: the answer is the one at HEAD', async () => {
      const t = linked()
      const none = await t.read({ action: 'blame', path: 'dir/a.txt' })
      expect(JSON.stringify(none)).not.toContain('SECRET-MARKER')
      expect(none).toMatchObject({ status: 'ok', data: [{ text: 'inside' }] })
      expect(none).toEqual(await t.read({ action: 'blame', path: 'dir/a.txt', ref: 'HEAD' }))
    })

    it('is never read by blame when the file itself becomes the link', async () => {
      const t = setup()
      const outside = join(t.dir, 'outside.txt')
      writeFileSync(outside, 'SECRET-MARKER\n')
      const before = await t.read({ action: 'blame', path: 'a.txt' })
      rmSync(join(t.work, 'a.txt'))
      symlinkSync(outside, join(t.work, 'a.txt'))
      const after = await t.read({ action: 'blame', path: 'a.txt' })
      expect(JSON.stringify(after)).not.toContain('SECRET-MARKER')
      expect(after).toEqual(before)
    })

    it('is not read by diff', async () => {
      const t = linked()
      const d = await t.read({ action: 'diff', path: 'dir/a.txt' })
      expect(JSON.stringify(d)).not.toContain('SECRET-MARKER')
    })
  })

  describe('a bare-repository layout written into the workspace', () => {
    it('is not a repository: its config is never read', async () => {
      const t = setup()
      const bare = join(t.dir, 'bare')
      mkdirSync(join(bare, 'objects'), { recursive: true })
      mkdirSync(join(bare, 'refs'))
      writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(bare, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${bare}\n`)
      expect(await t.read({ action: 'status' }, bare)).toMatchObject({ status: 'refused', reason: 'not-a-git-repo' })
    })
  })

  describe('what git is never allowed to run', () => {
    it('does not start an external diff or textconv program from the repository config', async () => {
      const t = setup()
      const marker = join(t.dir, 'marker')
      const script = join(t.dir, 'ext.sh')
      writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat "$1" 2>/dev/null\n`, { mode: 0o755 })
      git(t.work, 'config', 'diff.external', script)
      git(t.work, 'config', 'diff.conv.textconv', script)
      writeFileSync(join(t.work, '.gitattributes'), '*.txt diff=conv\n')
      git(t.work, 'add', '.')
      commit(t.work, 'attrs')
      writeFileSync(join(t.work, 'a.txt'), 'changed\n')
      await t.read({ action: 'diff' })
      await t.read({ action: 'diff', from: 'HEAD~1', to: 'HEAD' })
      await t.read({ action: 'show', ref: 'HEAD' })
      await t.read({ action: 'show', ref: 'HEAD~1' })
      await t.read({ action: 'blame', path: 'a.txt' })
      await t.read({ action: 'log', path: 'a.txt' })
      expect(existsSync(marker)).toBe(false)
    })

    it('does not run a pager or the optional-lock index refresh', async () => {
      const t = setup()
      const marker = join(t.dir, 'pager')
      const script = join(t.dir, 'pager.sh')
      writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 })
      git(t.work, 'config', 'core.pager', script)
      await t.read({ action: 'log' })
      await t.read({ action: 'diff' })
      await t.read({ action: 'show', ref: 'HEAD' })
      expect(existsSync(marker)).toBe(false)
    })
  })

  describe('refs', () => {
    const BAD_REFS = [
      '-p',
      '--output=/tmp/x',
      '--end-of-options',
      'main..HEAD',
      'main...HEAD',
      'HEAD@{1}',
      '@{u}',
      'main:a.txt',
      ':/message',
      'HEAD^^',
      'HEAD~',
      'HEAD~1~1',
      'HEAD^{commit}',
      'a b',
      'a\nb',
      '',
      '/abs/path',
      'main.lock',
      'feature//x',
      'x'.repeat(101),
    ]

    it.each(BAD_REFS)('refuses %j in every action that takes a ref', async (ref) => {
      const t = setup()
      for (const args of [
        { action: 'log', ref },
        { action: 'show', ref },
        { action: 'diff', from: ref, to: 'HEAD' },
        { action: 'diff', from: 'HEAD', to: ref },
        { action: 'blame', path: 'a.txt', ref },
      ]) {
        const r = await t.call(args)
        expect(structured(r), JSON.stringify(args)).toMatchObject({ status: 'refused', reason: 'invalid-input' })
        expect(isError(r)).toBe(true)
      }
    })

    it('refuses a ref that is not a string', async () => {
      const t = setup()
      for (const ref of [5, null, ['HEAD'], { a: 1 }])
        expect(await t.read({ action: 'show', ref })).toMatchObject({ status: 'refused', reason: 'invalid-input' })
    })

    it.each(['HEAD', 'HEAD~1', 'HEAD^', 'main', 'feature/x-1.2'])('accepts %s as a ref shape', async (ref) => {
      const t = setup()
      git(t.work, 'branch', 'feature/x-1.2')
      expect((await t.read({ action: 'log', ref, limit: 1 })).status).toBe('ok')
    })

    it('accepts a 4 to 64 digit commit id and nothing shorter', async () => {
      const t = setup()
      expect((await t.read({ action: 'show', ref: t.first.slice(0, 4) })).status).toBe('ok')
      expect((await t.read({ action: 'show', ref: t.first })).status).toBe('ok')
    })
  })

  describe('paths', () => {
    const BAD_PATHS = [
      '/etc/passwd',
      '../outside',
      'a/../../outside',
      '..',
      '.git',
      '.git/config',
      'a/../.git/config',
      'src/.git/config',
      '.GIT/config',
      'a\nb',
      'a\tb',
      'a\u0000b',
      'a\u007fb',
      '',
    ]

    it.each(BAD_PATHS)('refuses %j in every action that takes a path', async (path) => {
      const t = setup()
      for (const action of ['log', 'diff', 'blame']) {
        const r = await t.call({ action, path })
        expect(structured(r), action).toMatchObject({ status: 'refused', reason: 'invalid-input' })
        expect(isError(r)).toBe(true)
      }
    })

    it('refuses a path that is not a string', async () => {
      const t = setup()
      expect(await t.read({ action: 'log', path: 5 })).toMatchObject({ status: 'refused', reason: 'invalid-input' })
    })

    it('normalizes a path that stays inside the workspace', async () => {
      const t = setup()
      const b = await t.read({ action: 'blame', path: './src/../a.txt' })
      expect(b.data).toHaveLength(2)
    })
  })

  describe('arguments and workspace', () => {
    it('refuses a key the action does not take, an unknown action and non-object arguments', async () => {
      const t = setup()
      for (const args of [
        { action: 'status', path: 'a.txt' },
        { action: 'log', staged: true },
        { action: 'show', ref: 'HEAD', limit: 3 },
        { action: 'blame', path: 'a.txt', from: 'HEAD' },
        { action: 'status', extra: 1 },
        { action: 'push' },
        { action: 'config' },
        {},
      ])
        expect(await t.read(args), JSON.stringify(args)).toMatchObject({ status: 'refused', reason: 'invalid-input' })
      expect(structured(await t.call(null as never))).toMatchObject({ status: 'refused', reason: 'invalid-input' })
    })

    it('refuses a workspace that is not the git top level, or does not exist', async () => {
      const t = setup()
      expect(await t.read({ action: 'status' }, join(t.work, 'src'))).toMatchObject({ status: 'refused', reason: 'not-a-git-repo' })
      expect(await t.read({ action: 'status' }, join(t.dir, 'gone'))).toMatchObject({ status: 'refused', reason: 'not-a-git-repo' })
      const plain = join(t.dir, 'plain')
      mkdirSync(plain)
      expect(await t.read({ action: 'log' }, plain)).toMatchObject({ status: 'refused', reason: 'not-a-git-repo' })
    })

    it('reports a repository with no commits instead of failing silently', async () => {
      const t = setup()
      const empty = join(t.dir, 'empty')
      execFileSync('git', ['init', '-q', '-b', 'main', empty])
      expect((await t.read({ action: 'status' }, empty)).data.branch.head).toBe('main')
      expect(await t.read({ action: 'log' }, empty)).toMatchObject({ status: 'refused', reason: 'git-failed' })
    })
  })
})
