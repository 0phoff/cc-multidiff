import type { Change, RepoInfo, Settings, Snapshot, WorktreeInfo } from '../types'

// Everything that talks to git or the file system: the repos found under the project, their
// status against the compared ref, and the diff of one file. No drawing, no plugin state.

export type Run = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export const findRepos = async (run: Run, cwd: string, base: string, depth: number): Promise<string[]> => {
  const found = await run(
    ['find', base, '-maxdepth', String(depth), '-name', '.git', '-not', '-path', '*/node_modules/*'],
    cwd,
  )
  return found.stdout
    .split('\n')
    .filter(Boolean)
    .map(p => p.replace(/\/\.git$/, ''))
    .sort()
}

export const countAgainst = async (run: Run, dir: string, ref: string) => {
  const counts = await run(['git', 'rev-list', '--left-right', '--count', `${ref}...HEAD`], dir)
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
  return { ahead: ahead || 0, behind: behind || 0 }
}

// The ref a repo is compared against, from the global diff setting: its upstream
// (`local`), its default branch (`default`) or a branch the person names (`branch`).
// `missing` is only ever true for a `branch` the repo does not have.
export const resolveRef = async (run: Run, dir: string, settings: Settings): Promise<{ ref: string | null; missing: boolean }> => {
  const exists = async (ref: string) => (await run(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir)).exitCode === 0
  if (settings.mode === 'local') {
    const up = await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], dir)
    return { ref: up.exitCode === 0 && up.stdout.trim() ? up.stdout.trim() : null, missing: false }
  }
  if (settings.mode === 'branch') {
    const name = settings.branch.trim()
    for (const ref of name ? [`origin/${name}`, name] : []) if (await exists(ref)) return { ref, missing: false }
    return { ref: null, missing: true }
  }
  const head = await run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], dir)
  const candidates = [head.exitCode === 0 ? head.stdout.trim() : '', 'origin/dev', 'origin/main', 'origin/master', 'dev', 'main', 'master']
  for (const ref of candidates.filter(Boolean)) if (await exists(ref)) return { ref, missing: false }
  return { ref: null, missing: false }
}

export const readRepo = async (run: Run, dir: string, name: string, settings: Settings): Promise<RepoInfo> => {
  const [branchOut, { ref, missing }] = await Promise.all([run(['git', 'branch', '--show-current'], dir), resolveRef(run, dir, settings)])
  const branch = branchOut.stdout.trim() || '(detached)'
  // Changes are the working tree against the point the branch left the ref (so commits
  // that arrived on the ref since are not shown reversed); with no ref, just what is uncommitted.
  let base = 'HEAD'
  if (ref) {
    const mb = await run(['git', 'merge-base', ref, 'HEAD'], dir)
    base = mb.exitCode === 0 && mb.stdout.trim() ? mb.stdout.trim() : ref
  }
  const [names, stats, untracked, counts] = await Promise.all([
    run(['git', 'diff', base, '--name-status', '-M', '-z'], dir),
    run(['git', 'diff', base, '--numstat', '-M', '-z'], dir),
    run(['git', 'ls-files', '--others', '--exclude-standard'], dir),
    ref ? countAgainst(run, dir, ref) : Promise.resolve({ ahead: 0, behind: 0 }),
  ])
  // NUL-separated, so paths come unquoted. A rename is `R<score> old new` and, in the
  // numstat, `a r <empty>` followed by the old and the new path.
  const numbers = new Map<string, [number, number]>()
  const stat = stats.stdout.split('\0')
  for (let i = 0; i < stat.length; ) {
    const [a, r, path] = stat[i++].split('\t')
    if (a === undefined || r === undefined) continue
    const key = path === '' ? (i++, stat[i++]) : path
    if (key) numbers.set(key, [Number(a) || 0, Number(r) || 0])
  }
  const tracked: Change[] = []
  const status = names.stdout.split('\0')
  for (let i = 0; i < status.length; ) {
    const code = status[i++]
    if (!code) continue
    const from = code[0] === 'R' ? status[i++] : undefined
    const path = status[i++]
    const [added, removed] = numbers.get(path) ?? [0, 0]
    tracked.push({ code: code[0], path, added, removed, ...(from ? { from } : {}) })
  }
  const fresh: Change[] = untracked.stdout
    .split('\n')
    .filter(Boolean)
    .map(path => ({ code: '??', path, added: 0, removed: 0 }))
  return { name, dir, branch, changes: [...tracked, ...fresh], ref, missing, base, ...counts }
}

// Runs `fn` over `items` a few at a time: every repo costs about eight git processes, and
// reading them all at once buries the machine (security scanners look at each spawn).
export const POOL = 4
export const mapLimited = async <T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(POOL, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

export async function collect($: any, settings: Settings): Promise<Snapshot> {
  // The session root, not the shell cwd (a `cd` moves that); inside a worktree the helena folder is above `worktrees/`.
  const cwd: string = await $.session.root()
  const root = cwd.includes('/worktrees/') ? cwd.slice(0, cwd.indexOf('/worktrees/')) : cwd
  const run: Run = (argv, cwd) => $.process.run(argv, { cwd })

  const rootDirs = (await findRepos(run, root, '.', 4)).filter(p => !p.startsWith('./worktrees/'))
  // A project root that is itself a repo shows up as `.`.
  const roots = await mapLimited(
    rootDirs,
    p => readRepo(run, p === '.' ? root : `${root}/${p.slice(2)}`, p === '.' ? root.split('/').pop() || root : p.slice(2), settings),
  )

  const wtDirs = await findRepos(run, root, './worktrees', 5)
  const byWt = new Map<string, RepoInfo[]>()
  await mapLimited(wtDirs, async p => {
    const [, , wt, ...rest] = p.split('/')
    if (!rest.length) return
    const info = await readRepo(run, `${root}/${p.slice(2)}`, rest.join('/'), settings)
    byWt.set(wt, [...(byWt.get(wt) ?? []), info])
  })
  const worktrees: WorktreeInfo[] = [...byWt.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, repos]) => ({ name, repos: repos.sort((a, b) => a.name.localeCompare(b.name)) }))

  return { root, roots, worktrees, at: Date.now() }
}

export async function readLines($: any, path: string): Promise<string[] | null> {
  try {
    return String(await $.fs.read(path)).split('\n').map(line => line.replace(/\r$/, ''))
  } catch {
    return null
  }
}

// git's own detection of moved lines needs the whole diff (a block can move between
// files), so the file's diff is cut out of the repo's, with the moved colours pinned to
// magenta to tell them from the rest. The settings of the person (prefixes, colours) are overridden.
export const ANSI = /\x1b\[[0-9;]*m/g
export const MOVED_COLORS = ['oldMoved', 'newMoved', 'oldMovedAlternative', 'newMovedAlternative', 'oldMovedDimmed', 'newMovedDimmed', 'oldMovedAlternativeDimmed', 'newMovedAlternativeDimmed']
export const GIT_DIFF = [
  'git',
  '-c', 'core.quotePath=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.noprefix=false',
  '-c', 'color.diff.old=red',
  '-c', 'color.diff.new=green',
  ...MOVED_COLORS.flatMap(name => ['-c', `color.diff.${name}=magenta`]),
  'diff',
]
export const MOVED_START = '\x1b[35m'

// The file's section of a coloured repo diff, as plain text and the indexes of its moved lines.
export const sectionOf = (all: string, path: string): { text: string; moved: number[] } | null => {
  const lines: string[] = []
  const moved: number[] = []
  let take = false
  let inHunk = false
  for (const raw of all.split('\n')) {
    const plain = raw.replace(ANSI, '')
    if (plain.startsWith('diff --git ')) {
      take = plain.endsWith(` b/${path}`)
      inHunk = false
    }
    if (!take) continue
    if (plain.startsWith('@@')) inHunk = true
    if (inHunk && (plain[0] === '+' || plain[0] === '-') && raw.startsWith(MOVED_START)) moved.push(lines.length)
    lines.push(plain)
  }
  return lines.length ? { text: lines.join('\n'), moved } : null
}

export type FileDiff = { text: string; moved: number[] }
// The repo's whole diff is read to find moved lines only while the repo has a moderate number
// of changed lines: reading and scanning a huge one on every refresh stalls the pane.
export const MOVED_SCAN_MAX_LINES = 4000
export const changedLines = (repo: RepoInfo | undefined) => (repo ? repo.changes.reduce((n, c) => n + c.added + c.removed, 0) : 0)

export async function diffOf($: any, dir: string, path: string, from: string | undefined, code: string, base: string, repoLines: number): Promise<FileDiff> {
  const run: Run = (argv, cwd) => $.process.run(argv, { cwd })
  if (code === '??') {
    const out = await run(['git', 'diff', '--no-index', '--no-color', '--', '/dev/null', path], dir)
    return { text: out.stdout || out.stderr, moved: [] }
  }
  if (repoLines <= MOVED_SCAN_MAX_LINES) {
    const all = await run([...GIT_DIFF, base, '-M', '--color=always', '--color-moved=blocks'], dir)
    const section = all.exitCode === 0 ? sectionOf(all.stdout, path) : null
    if (section) return section
  }
  // Without the repo's diff, the file's own: no moved lines, a rename only when both paths are named.
  const out = await run(['git', 'diff', base, '-M', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--', ...(from ? [from, path] : [path])], dir)
  return { text: out.stdout || out.stderr, moved: [] }
}
