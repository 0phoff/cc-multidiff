import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, FileView, RepoInfo, Settings, Snapshot, WorktreeInfo } from '../types'

const PANE = 'multi-diff'
const ROOT = '__root__'
const snapshot = atom({ plugin: 'multi-diff', key: 'snapshot' } as const, null)
const focus = atom({ plugin: 'multi-diff', key: 'focus' } as const, null)
const view = atom({ plugin: 'multi-diff', key: 'view' } as const, null)
const error = atom({ plugin: 'multi-diff', key: 'error' } as const, null)
// The tree nodes (repo and folder keys) the person has folded.
const collapsed = atom({ plugin: 'multi-diff', key: 'collapsed' } as const, [] as string[])
// Whether the three dot menu of the toolbar is open.
const menuOpen = atom({ plugin: 'multi-diff', key: 'menuOpen' } as const, false)
// Bumped on every pin change, so the sites that read the pins draw again.
const pinTick = atom({ plugin: 'multi-diff', key: 'pinTick' } as const, 0)
// Same for the word highlighting.
const wordTick = atom({ plugin: 'multi-diff', key: 'wordTick' } as const, 0)
// Same for the moved line colours.
const movedTick = atom({ plugin: 'multi-diff', key: 'movedTick' } as const, 0)
// Same for the diff setting.
const settingsTick = atom({ plugin: 'multi-diff', key: 'settingsTick' } as const, 0)
// Lines of context added by the arrows between two hunks, by `<dir>/<path>@<first line of the hunk below>`.
// How many more pages of rows the open file shows beyond the first, by `<dir>/<path>`.
const pages = atom({ plugin: 'multi-diff', key: 'pages' } as const, {} as Record<string, number>)
const expanded = atom({ plugin: 'multi-diff', key: 'expanded' } as const, {} as Record<string, { up: number; down: number }>)

// Unicode stand-ins: the Button label ignores nested Text styles, so bold is
// carried by the glyphs themselves.
const toBold = (text: string) =>
  [...text]
    .map(ch => {
      const c = ch.codePointAt(0) ?? 0
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + c - 65)
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + c - 97)
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + c - 48)
      return ch
    })
    .join('')

// Plain spaces are collapsed or trimmed by the surface; non-breaking ones keep the width.
const NBSP = '\u00a0'

type Run = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const findRepos = async (run: Run, cwd: string, base: string, depth: number): Promise<string[]> => {
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

const countAgainst = async (run: Run, dir: string, ref: string) => {
  const counts = await run(['git', 'rev-list', '--left-right', '--count', `${ref}...HEAD`], dir)
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
  return { ahead: ahead || 0, behind: behind || 0 }
}

// The ref a repo is compared against, from the global diff setting: its upstream
// (`local`), its default branch (`default`) or a branch the person names (`branch`).
// `missing` is only ever true for a `branch` the repo does not have.
const resolveRef = async (run: Run, dir: string, settings: Settings): Promise<{ ref: string | null; missing: boolean }> => {
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

const readRepo = async (run: Run, dir: string, name: string, settings: Settings): Promise<RepoInfo> => {
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
const POOL = 4
const mapLimited = async <T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> => {
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

const collect = async ($: any): Promise<Snapshot> => {
  const settings = await getSettings($)
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

// A refresh reads every repo, which takes seconds: while one runs, further asks (every tool call
// of the agent asks) merge into a single run that starts right after it.
let refreshing: Promise<void> | null = null
let again = false
// Bumped by the kill button: a refresh that started before it drops its result.
let epoch = 0
const refresh = async ($: any): Promise<void> => {
  if (refreshing) {
    again = true
    return refreshing
  }
  refreshing = (async () => {
    do {
      again = false
      await refreshOnce($)
    } while (again)
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

const refreshOnce = async ($: any) => {
  const born = epoch
  try {
    const snap = await collect($)
    if (born !== epoch) return
    await update($, snapshot, () => snap)
    await update($, error, () => null)
    // The diff that is open follows the files.
    const open = await read($, view)
    if (open) {
      // Same inputs as clicking the file: the change status and base come from the fresh snapshot,
      // since both can move under an open diff (a `git add`, a commit, a new merge-base).
      const repo = [...snap.roots, ...snap.worktrees.flatMap(w => w.repos)].find(r => r.dir === open.dir)
      const change = repo?.changes.find(c => c.path === open.path)
      const code = change?.code ?? open.code
      const from = change ? change.from : open.from
      const base = repo?.base ?? open.base
      const { text, moved } = await diffOf($, open.dir, open.path, from, code, base, changedLines(repo))
      await update($, view, cur => (cur && cur.dir === open.dir && cur.path === open.path ? { ...cur, code, from, base, text, moved } : cur))
    }
  } catch (err) {
    await update($, error, () => String(err))
  }
}

// The diff is read as git prints it (three lines of context) and drawn as the
// built-in /diff draws it: one `Code` block a hunk, with line numbers and colours.
// `moved[i]` is true when `lines[i]` is a line git reports as moved, not added or removed.
type Hunk = { oldStart: number; newStart: number; lines: string[]; moved: boolean[] }

// A `Code` source holds at most 10000 characters; leave room for the header.
const MAX_SOURCE_CHARS = 9000

// Controls, format and invisible characters are dropped (tabs stay), so nothing
// can reorder or hide a line.
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
const clean = (line: string) => line[0] + line.slice(1).replace(UNSAFE, '')

const parseHunks = (text: string, moved: number[] = []): Hunk[] => {
  const hunks: Hunk[] = []
  const movedAt = new Set(moved)
  text.split('\n').forEach((line, index) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
    if (m) hunks.push({ oldStart: Number(m[1]), newStart: Number(m[2]), lines: [], moved: [] })
    else if (hunks.length && (line[0] === ' ' || line[0] === '+' || line[0] === '-')) {
      hunks.at(-1)!.lines.push(clean(line))
      hunks.at(-1)!.moved.push(movedAt.has(index))
    }
  })
  return hunks
}

// A hunk as unified-diff text, its header counted off its lines so a split hunk still parses.
// A side with no lines names the line before its start, as git writes it.
const hunkSource = ({ oldStart, newStart, lines }: Hunk): string => {
  const oc = lines.filter(l => l[0] !== '+').length
  const nc = lines.filter(l => l[0] !== '-').length
  const o = oc === 0 ? Math.max(0, oldStart - 1) : oldStart
  const n = nc === 0 ? Math.max(0, newStart - 1) : newStart
  return [`@@ -${o},${oc} +${n},${nc} @@`, ...lines].join('\n')
}

// The sources to draw: a hunk too long for one `Code` block is split in several.
const sourcesOf = (text: string): string[] =>
  parseHunks(text).flatMap(hunk => {
    const parts: string[] = []
    let { oldStart, newStart } = hunk
    let lines: string[] = []
    let chars = 0
    const flush = () => {
      if (!lines.length) return
      parts.push(hunkSource({ oldStart, newStart, lines }))
      oldStart += lines.filter(l => l[0] !== '+').length
      newStart += lines.filter(l => l[0] !== '-').length
      lines = []
      chars = 0
    }
    for (const line of hunk.lines) {
      if (chars + line.length + 1 > MAX_SOURCE_CHARS) flush()
      lines.push(line.slice(0, MAX_SOURCE_CHARS))
      chars += line.length + 1
    }
    flush()
    return parts
  })

// Surfaces that do not draw a `Code` diff themselves get the rows drawn here: a gutter
// numbered from the hunk's header, the marker, add and remove colours.
// Plain spaces are collapsed by the surface, so indentation and space runs are non-breaking.
// Line numbers are right-aligned in a column this many characters wide (the surface's
// text is not monospace, so the width comes from a Box, not from padding), so every hunk lines up.
const GUTTER = 4
type Part = { text: string; changed: boolean }
type DiffRow = { marker: ' ' | '+' | '-'; number: number; moved: boolean; parts: Part[] }

// Words, runs of spaces and single symbols: the units a changed line is compared in.
const tokenize = (text: string) => text.match(/\s+|\w+|[^\w\s]/g) ?? []

// Which tokens of each side are not part of the longest common run of tokens.
// A line too long to compare token by token only gets its common start and end kept.
const MAX_CELLS = 40000
const changedTokens = (a: string[], b: string[]): [boolean[], boolean[]] => {
  const ca = a.map(() => true)
  const cb = b.map(() => true)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++
  for (let i = 0; i < head; i++) ca[i] = cb[i] = false
  for (let i = 1; i <= tail; i++) {
    ca[a.length - i] = false
    cb[b.length - i] = false
  }
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (x.length && y.length && x.length * y.length <= MAX_CELLS) {
    const w = y.length + 1
    const len = new Uint16Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        ca[head + i] = cb[head + j] = false
        i++
        j++
      } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++
      else j++
    }
  }
  return [ca, cb]
}

// A line split into runs that are changed or not, from its tokens' flags. Nothing is
// marked when no word is shared: the whole line is then just a different line.
const partsOf = (tokens: string[], changed: boolean[], other: string[], otherChanged: boolean[]): Part[] => {
  const shared = (list: string[], flags: boolean[]) => list.some((t, i) => !flags[i] && /\S/.test(t))
  if (!shared(tokens, changed) || !shared(other, otherChanged)) return [{ text: tokens.join(''), changed: false }]
  const parts: Part[] = []
  tokens.forEach((token, i) => {
    const last = parts.at(-1)
    if (last && last.changed === changed[i]) last.text += token
    else parts.push({ text: token, changed: changed[i] })
  })
  return parts
}

// Only indentation and runs of spaces are non-breaking: a lone space stays a plain
// one, so the surface can break the line there. Same length, so parts are cut from it after.
const keepSpaces = (text: string) => text.replace(/^ +| {2,}/g, run => NBSP.repeat(run.length))

const rowsOf = (hunk: Hunk, words: boolean, showMoved: boolean): DiffRow[] => {
  let o = hunk.oldStart
  let n = hunk.newStart
  const rows = hunk.lines.map((line, index) => {
    const marker = line[0] as DiffRow['marker']
    const raw = line.slice(1).replace(/\t/g, '    ')
    const number = marker === '-' ? o : n
    if (marker !== '+') o++
    if (marker !== '-') n++
    return { marker, number, raw, moved: showMoved && hunk.moved[index], parts: [{ text: raw, changed: false }] as Part[] }
  })
  // A run of removed lines right before a run of added ones: line i of one is the
  // edit of line i of the other, so the part that differs is marked.
  for (let i = 0; i < rows.length; ) {
    if (rows[i].marker !== '-') {
      i++
      continue
    }
    let mid = i
    while (mid < rows.length && rows[mid].marker === '-') mid++
    let end = mid
    while (end < rows.length && rows[end].marker === '+') end++
    for (let k = 0; k < Math.min(mid - i, end - mid); k++) {
      const del = rows[i + k]
      const add = rows[mid + k]
      // A moved line is the same line somewhere else: nothing inside it changed.
      if (del.moved || add.moved || !words) continue
      const a = tokenize(del.raw)
      const b = tokenize(add.raw)
      const [ca, cb] = changedTokens(a, b)
      del.parts = partsOf(a, ca, b, cb)
      add.parts = partsOf(b, cb, a, ca)
    }
    i = end
  }
  return rows.map(({ marker, number, moved, raw, parts }) => {
    const kept = keepSpaces(raw)
    let at = 0
    return {
      marker,
      number,
      moved,
      parts: parts.map(part => ({ changed: part.changed, text: kept.slice(at, (at += part.text.length)) })),
    }
  })
}

// The lines of the new side a hunk shows: its context and added lines.
const newRange = (hunk: Hunk) => {
  const count = hunk.lines.filter(l => l[0] !== '-').length
  const first = count > 0 ? hunk.newStart : hunk.newStart + 1
  return { first, last: first + count - 1 }
}

// What an arrow adds, and the most that "..." is shown for instead of the arrows.
const EXPAND = 10
const ROWS_PER_PAGE = 500
const DOTS_MAX = 15

const readLines = async ($: any, path: string): Promise<string[] | null> => {
  try {
    return String(await $.fs.read(path)).split('\n').map(line => line.replace(/\r$/, ''))
  } catch {
    return null
  }
}

// git's own detection of moved lines needs the whole diff (a block can move between
// files), so the file's diff is cut out of the repo's, with the moved colours pinned to
// magenta to tell them from the rest. The settings of the person (prefixes, colours) are overridden.
const ANSI = /\x1b\[[0-9;]*m/g
const MOVED_COLORS = ['oldMoved', 'newMoved', 'oldMovedAlternative', 'newMovedAlternative', 'oldMovedDimmed', 'newMovedDimmed', 'oldMovedAlternativeDimmed', 'newMovedAlternativeDimmed']
const GIT_DIFF = [
  'git',
  '-c', 'core.quotePath=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.noprefix=false',
  '-c', 'color.diff.old=red',
  '-c', 'color.diff.new=green',
  ...MOVED_COLORS.flatMap(name => ['-c', `color.diff.${name}=magenta`]),
  'diff',
]
const MOVED_START = '\x1b[35m'
// `added` and `removed` tint the changed words of an edited line, a step stronger than the row.
// Moved lines are drawn orange where they left and blue where they arrived: the marker
// is a theme key, the row a tint picked for the theme (no theme key is a dim orange or blue).
const MOVED_TINTS = {
  dark: { from: '#4a3315', to: '#1c3050', added: '#2f5a37', removed: '#6a3239' },
  light: { from: '#ffe3c2', to: '#d4e4ff', added: '#b8e5c2', removed: '#f4bfc4' },
}
// Any theme with `light` in its name (light, light-daltonized, light-ansi); `auto` counts as dark.
const isLightTheme = async ($: any): Promise<boolean> => {
  try {
    const row = (await $.config.list()).find((r: { key: string }) => r.key === 'theme')
    return typeof row?.value === 'string' && /light/i.test(row.value)
  } catch {
    return false
  }
}

// The file's section of a coloured repo diff, as plain text and the indexes of its moved lines.
const sectionOf = (all: string, path: string): { text: string; moved: number[] } | null => {
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

type FileDiff = { text: string; moved: number[] }
// The repo's whole diff is read to find moved lines only while the repo has a moderate number
// of changed lines: reading and scanning a huge one on every refresh stalls the pane.
const MOVED_SCAN_MAX_LINES = 4000
const changedLines = (repo: RepoInfo | undefined) => (repo ? repo.changes.reduce((n, c) => n + c.added + c.removed, 0) : 0)

const diffOf = async ($: any, dir: string, path: string, from: string | undefined, code: string, base: string, repoLines: number): Promise<FileDiff> => {
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

const openFile = async ($: any, repo: RepoInfo, change: Change, origin: string) => {
  const { text, moved } = await diffOf($, repo.dir, change.path, change.from, change.code, repo.base, changedLines(repo))
  const next: FileView = { origin, repo: repo.name, dir: repo.dir, path: change.path, from: change.from, code: change.code, base: repo.base, text, moved }
  await update($, view, () => next)
}

// Opens a folder or file in an editor through its CLI.
type Editor = { cli: string; name: string; args: string[] }
const VSCODE: Editor = { cli: 'code', name: 'VS Code', args: ['-n'] }
// -n opens a new window; without it both editors reuse the one that is already up.
const ZED: Editor = { cli: 'zed', name: 'Zed', args: ['-n'] }

const openIn = async ($: any, editor: Editor, path: string) => {
  try {
    const out = await $.process.run([editor.cli, ...editor.args, path])
    if (out.exitCode === 0) return
    await $.ui.toast(`${editor.name}: ${out.stderr.trim() || `exit ${out.exitCode}`}`)
  } catch {
    await $.ui.toast(`${editor.name}: \`${editor.cli}\` not found on the PATH`)
  }
}

// A repo's changed files as folders: a folder holding only one folder is shown joined to it (a/b/c).
type TreeNode = { name: string; key: string; dirs: TreeNode[]; files: Change[] }
const buildTree = (changes: Change[], prefix: string): TreeNode => {
  const top: TreeNode = { name: '', key: prefix, dirs: [], files: [] }
  for (const change of changes) {
    const parts = change.path.split('/')
    let node = top
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.find(d => d.name === part)
      if (!next) {
        next = { name: part, key: `${node.key}/${part}`, dirs: [], files: [] }
        node.dirs.push(next)
      }
      node = next
    }
    node.files.push(change)
  }
  const tidy = (node: TreeNode): TreeNode => {
    node.dirs = node.dirs.map(d => {
      let cur = d
      while (cur.files.length === 0 && cur.dirs.length === 1) cur = { ...cur.dirs[0], name: `${cur.name}/${cur.dirs[0].name}` }
      return tidy(cur)
    })
    node.dirs.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.path.localeCompare(b.path))
    return node
  }
  return tidy(top)
}

// Theme keys, so the markers follow the color scheme.
const codeColor = (code: string) =>
  code === '??' || code.includes('A')
    ? 'success'
    : code.includes('D')
      ? 'error'
      : code.includes('R')
        ? 'suggestion'
        : code.includes('U')
          ? 'permission'
          : 'warning'

// The global diff setting, kept across sessions.
const SETTINGS = 'diffSettings'
const MODES: Settings['mode'][] = ['local', 'default', 'branch']
const EDIT_BRANCH = 'edit-branch'
const MODE_LABELS: Record<Settings['mode'], string> = { local: 'local changes', default: 'default branch', branch: 'branch…' }
const getSettings = async ($: any): Promise<Settings> => {
  const v = await $.store.get(SETTINGS)
  return v && MODES.includes(v.mode) ? { mode: v.mode, branch: String(v.branch ?? '') } : { mode: 'local', branch: '' }
}
const setSettings = async ($: any, next: Settings) => {
  await $.store.set(SETTINGS, next)
  await update($, settingsTick, n => n + 1)
  // An open diff was cut against the old base.
  await update($, view, () => null)
  await refresh($)
}

// `branch…` asks for the branch in a popup: the last branch if known, `main` and `master` to click,
// anything else typed under "Other". Skipping it falls back to local changes and forgets the branch.
const pickMode = async ($: any, cfg: Settings, mode: Settings['mode']) => {
  if (mode !== 'branch') return setSettings($, { ...cfg, mode })
  try {
    const answer: string = await $.ui.ask('Which branch should diffs be taken against?', {
      header: 'Diff branch',
      options: [...new Set([cfg.branch, 'main', 'master'].filter(Boolean))],
    })
    // Skip comes back as the text "[No preference]".
    if (answer.trim() && !/^\[no preference\]$/i.test(answer.trim())) return await setSettings($, { mode, branch: answer.trim() })
  } catch {}
  await setSettings($, { mode: 'local', branch: '' })
}

// The folders the prompt button is pinned for, kept across sessions.
const PINS = 'pinnedFolders'
const getPins = async ($: any): Promise<string[]> => {
  const list = await $.store.get(PINS)
  return Array.isArray(list) ? list : []
}
const togglePin = async ($: any) => {
  const cwd: string = await $.session.root()
  const pins = await getPins($)
  const next = pins.includes(cwd) ? pins.filter(p => p !== cwd) : [...pins, cwd]
  await $.store.set(PINS, next)
  await update($, pinTick, n => n + 1)
}

// Whether edited lines get their changed words highlighted, kept across sessions: on by default.
const WORD_DIFF = 'wordDiff'
const getWordDiff = async ($: any): Promise<boolean> => (await $.store.get(WORD_DIFF)) !== false
const toggleWordDiff = async ($: any) => {
  await $.store.set(WORD_DIFF, !(await getWordDiff($)))
  await update($, wordTick, n => n + 1)
}

// Whether moved lines get their own colours, kept across sessions: on by default.
const MOVED_COLORS_KEY = 'movedColors'
const getMovedColors = async ($: any): Promise<boolean> => (await $.store.get(MOVED_COLORS_KEY)) !== false
const toggleMovedColors = async ($: any) => {
  await $.store.set(MOVED_COLORS_KEY, !(await getMovedColors($)))
  await update($, movedTick, n => n + 1)
}

// Opens the pane, or closes it when it is up; the slash command and the button share it.
const togglePane = async ($: any): Promise<boolean> => {
  const isUp = (await $.ui.panes()).some((p: { id: string }) => p.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    return false
  }
  await $.ui.open({ id: PANE, title: 'multidiff', focus: true, closeOnEscape: true, rows: 30, columns: 110 })
  await refresh($)
  return true
}

// Kill switch: drops any running refresh, resets every value the pane draws from and closes the
// pane, so the next /multidiff starts clean. Pins and diff-mode settings (the store) are kept.
const killPlugin = async ($: any) => {
  epoch++
  refreshing = null
  again = false
  await $.ui.close({ id: PANE })
  await update($, snapshot, () => null)
  await update($, focus, () => null)
  await update($, view, () => null)
  await update($, error, () => null)
  await update($, collapsed, () => [])
  await update($, pages, () => ({}))
  await update($, expanded, () => ({}))
  await update($, pinTick, () => 0)
  await update($, wordTick, () => 0)
  await update($, movedTick, () => 0)
  await update($, menuOpen, () => false)
  await update($, settingsTick, () => 0)
  $.ui.toast('multidiff killed: run /multidiff to start fresh')
}

// The Multidiff pane's drawing.
const paneRender = async ($: any, e: any) => {
  const { Box, Text, Button, Code, Select } = $.ui.resolve(e)
  await read($, pinTick)
  await read($, wordTick)
  await read($, movedTick)
  await read($, settingsTick)
  const cfg = await getSettings($)
  const tints = MOVED_TINTS[(await isLightTheme($)) ? 'light' : 'dark']
  const isPinned = (await getPins($)).includes(await $.session.root())
  const words = await getWordDiff($)
  const showMoved = await getMovedColors($)
  const menuIsOpen = await read($, menuOpen)
  const snap = await read($, snapshot)
  const focused = await read($, focus)
  const file = await read($, view)
  const err = await read($, error)

  const closed = await read($, collapsed)
  const grown = await read($, expanded)
  const morePages = await read($, pages)
  const fileLines = file && Object.keys(grown).some(k => k.startsWith(`${file.dir}/${file.path}@`)) ? await readLines($, `${file.dir}/${file.path}`) : null
  const toggle = (key: string) => update($, collapsed, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))

  const drawRow = (r: DiffRow, key: string) => {
    const background = r.moved ? (r.marker === '-' ? tints.from : tints.to) : r.marker === '+' ? 'diffAddedDimmed' : r.marker === '-' ? 'diffRemovedDimmed' : undefined
    const markerColor = r.moved ? (r.marker === '-' ? 'warning' : 'suggestion') : r.marker === '+' ? 'success' : r.marker === '-' ? 'error' : undefined
    return (
      <Box key={key} width="100%" alignItems="flex-start" backgroundColor={background}>
        <Box width={GUTTER + 1} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{r.number}</Text>
        </Box>
        <Box width={3} flexShrink={0} paddingLeft={1}>
          <Text bold color={markerColor}>
            {r.marker === ' ' ? NBSP : r.marker}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="wrap">
            {/* Only a changed word gets a (bold) Text of its own: a nested Text per row (and per unchanged
                stretch) makes the surface stall once a file has a hundred or so rows. */}
            {!r.parts.some(part => part.changed)
              ? r.parts.map(part => part.text).join('') || NBSP
              : r.parts.map((part, k) =>
                  part.changed ? (
                    <Text key={`part-${k}`} bold backgroundColor={r.marker === '+' ? tints.added : tints.removed}>
                      {part.text}
                    </Text>
                  ) : (
                    part.text
                  ),
                )}
          </Text>
        </Box>
      </Box>
    )
  }

  // The hunks of a file, and between two of them the lines the arrows revealed and what is still hidden:
  // `↓` adds context under the hunk above, `↑` over the hunk below, `...` (a few lines left) shows the rest.
  const drawHunks = (file: FileView, hunks: Hunk[]) => {
    const grow = (key: string, down: number, up: number) =>
      update($, expanded, cur => ({ ...cur, [key]: { down: (cur[key]?.down ?? 0) + down, up: (cur[key]?.up ?? 0) + up } }))
    const out: unknown[] = []
    // Drawing thousands of rows stalls the pane: a page of them at a time.
    const pageKey = `${file.dir}/${file.path}`
    const limit = ROWS_PER_PAGE * (1 + (morePages[pageKey] ?? 0))
    let drawn = 0
    let skipped = 0
    const draw = (r: DiffRow, key: string) => {
      if (drawn >= limit) skipped++
      else {
        drawn++
        out.push(drawRow(r, key))
      }
    }
    hunks.forEach((hunk, i) => {
      if (drawn >= limit) {
        skipped += hunk.lines.length
        return
      }
      rowsOf(hunk, words, showMoved).forEach((r, j) => draw(r, `row-${i}-${j}`))
      const next = hunks[i + 1]
      if (!next) return
      const above = newRange(hunk).last
      const below = newRange(next).first
      const gap = below - above - 1
      if (gap <= 0) return
      const key = `${file.dir}/${file.path}@${below}`
      const down = fileLines ? Math.min(grown[key]?.down ?? 0, gap) : 0
      const up = fileLines ? Math.min(grown[key]?.up ?? 0, gap - down) : 0
      const context = (n: number): DiffRow => ({ marker: ' ', number: n, moved: false, parts: [{ text: keepSpaces(clean(' ' + (fileLines?.[n - 1] ?? '').replace(/\t/g, '    ')).slice(1)), changed: false }] })
      for (let n = above + 1; n <= above + down; n++) draw(context(n), `down-${i}-${n}`)
      const hidden = gap - down - up
      if (hidden > 0) {
        out.push(
          <Box key={`gap-${i}`} width="100%">
            <Box width={GUTTER + 1} flexShrink={0} justifyContent="flex-end">
              {hidden <= DOTS_MAX ? (
                <Button key={`rest-${i}`} plain onPress={() => grow(key, hidden, 0)}>
                  <Text bold color="suggestion">...</Text>
                </Button>
              ) : (
                [
                  <Button key={`up-${i}`} plain onPress={() => grow(key, 0, EXPAND)}>
                    <Text bold color="suggestion">↑ </Text>
                  </Button>,
                  <Button key={`down-${i}`} plain onPress={() => grow(key, EXPAND, 0)}>
                    <Text bold color="suggestion">↓</Text>
                  </Button>,
                ]
              )}
            </Box>
          </Box>,
        )
      }
      for (let n = below - up; n < below; n++) draw(context(n), `up-${i}-${n}`)
    })
    if (skipped > 0) {
      out.push(
        <Box key="more-rows" width="100%" marginTop={1}>
          <Button key="more-rows-button" plain onPress={() => update($, pages, cur => ({ ...cur, [pageKey]: (cur[pageKey] ?? 0) + 1 }))}>
            <Text bold color="suggestion">{`Show ${Math.min(skipped, ROWS_PER_PAGE)} more of ${skipped} hidden lines`}</Text>
          </Button>
        </Box>,
      )
    }
    return out
  }

  // The open file's diff, drawn beside the tree.
  const diffPanel = (file: FileView) => {
    const sources = sourcesOf(file.text)
    const hunks = parseHunks(file.text, file.moved)
    // A deleted file has nothing to open: open its repo folder instead.
    const filePath = file.code.includes('D') ? file.dir : `${file.dir}/${file.path}`
    return (
      <Box flexDirection="column" width="100%">
        <Box width="100%">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text>
              <Text dimColor>{file.repo}: </Text>
              <Text bold>{file.path}</Text>
              {file.from && <Text dimColor>  ← renamed from {file.from}</Text>}
            </Text>
          </Box>
          <Button key="code-file" plain onPress={() => openIn($, VSCODE, filePath)}>
            <Text bold color="suggestion"> ⓥ </Text>
          </Button>
          <Button key="zed-file" plain onPress={() => openIn($, ZED, filePath)}>
            <Text bold color="suggestion">ⓩ </Text>
          </Button>
        </Box>
        <Box marginTop={1} flexDirection="column" width="100%">
          {sources.length === 0 && (
            <Text dimColor>{file.from && !/^Binary/m.test(file.text) ? 'Renamed without changes.' : file.text.trim() || 'No textual changes (binary or mode change).'}</Text>
          )}
          {e.surface === 'terminal'
            ? sources.map((source, i) => (
                <Box key={`code-${i}`} width="100%">
                  <Code source={source} format="diff" path={file.path} />
                </Box>
              ))
            : drawHunks(file, hunks)}
        </Box>
      </Box>
    )
  }

  if (!snap) return <Text dimColor>{err ?? 'Loading…'}</Text>

  const isRoot = focused === ROOT
  const activeWt = snap.worktrees.find(w => w.name === focused)
  const isFocusing = isRoot || !!activeWt
  const visible: WorktreeInfo[] = activeWt ? [activeWt] : isRoot ? [] : snap.worktrees

  const section = (p: { id: string; title: string; summary: string; tone: string; top?: number }) => {
    const title = toBold(p.title.toUpperCase())
    // The Box draws the banner; the Button inside is the click
    // target, with an em dash between the title and the count.
    const press = async () => {
      await update($, view, () => null)
      await update($, focus, cur => (cur === p.id ? null : p.id))
    }
    return (
      <Box
        key={`sec-${p.id}`}
        width="100%"
        marginTop={p.top ?? 1}
        paddingX={2}
        // Border in the fill's own color: only the corners read as rounded.
        borderStyle="round"
        borderColor="promptBorder"
        backgroundColor="promptBorder"
      >
        <Button key={`focus-${p.id}`} plain onPress={press}>
          <Text bold color="text">{title}</Text>
          <Text dimColor>{'     —     '}{p.summary}</Text>
        </Button>
      </Box>
    )
  }

  // Columns: the name takes the room left and is cut at the end (never wraps); the branch and
  // the stats are as wide as their longest entry in the same section (the branch capped), so
  // the rows of a section line up and short branches do not pay for a long one elsewhere.
  const statsOf = (r: RepoInfo) => `${r.missing ? 'branch does not exist' : r.ref ? `↑${r.ahead} ↓${r.behind}` : 'no upstream'} · ${r.changes.length} changed`

  const repoRow = (id: string, repo: RepoInfo, first: boolean, group: RepoInfo[]) => {
    const n = repo.changes.length
    const branchWidth = Math.min(24, Math.max(0, ...group.map(r => r.branch.length))) + 2
    const statsWidth = Math.max(0, ...group.map(r => statsOf(r).length)) + 1
    return (
      <Box key={`${id}/${repo.name}`} flexDirection="column" marginTop={first ? 1 : 0}>
        <Box paddingX={1} width="100%">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">{repo.name}</Text>
          </Box>
          <Box width={branchWidth} flexShrink={0} justifyContent="flex-end" paddingRight={2}>
            <Text dimColor wrap="truncate-end">{repo.branch}</Text>
          </Box>
          <Box width={statsWidth} flexShrink={0}>
            <Text>
              {repo.missing ? (
                <Text color="error">branch does not exist</Text>
              ) : repo.ref ? (
                <Text>
                  <Text color={repo.ahead > 0 ? 'success' : undefined} dimColor={repo.ahead === 0}>↑{repo.ahead} </Text>
                  <Text color={repo.behind > 0 ? 'warning' : undefined} dimColor={repo.behind === 0}>↓{repo.behind}</Text>
                </Text>
              ) : (
                <Text dimColor>no upstream</Text>
              )}
              <Text dimColor> · </Text>
              <Text color={n > 0 ? 'warning' : undefined} dimColor={n === 0}>{n} changed</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    )
  }

  // The tree of one folder level: folders first (click to fold), then its files (click to see the diff).
  const treeRows = (node: TreeNode, depth: number, repo: RepoInfo, origin: string): any[] => [
    ...node.dirs.flatMap(d => {
      const isClosed = closed.includes(d.key)
      return [
        <Box key={`dir/${d.key}`} marginLeft={depth * 2}>
          <Button key={`fold/${d.key}`} plain onPress={() => toggle(d.key)}>
            {`${isClosed ? '▸' : '▾'} ${d.name}/`}
          </Button>
        </Box>,
        ...(isClosed ? [] : treeRows(d, depth + 1, repo, origin)),
      ]
    }),
    ...node.files.map(c => {
      const selected = !!file && file.dir === repo.dir && file.path === c.path
      return (
        <Box key={`file/${repo.dir}/${c.path}`} alignSelf="flex-start" marginLeft={depth * 2} backgroundColor={selected ? 'promptBorder' : undefined}>
          {/* Outside the Button: a Button label ignores the Text colors inside it. */}
          <Text bold color={codeColor(c.code)}>{(c.code.trim() || 'M').padEnd(2)}</Text>
          <Button key={`open/${repo.dir}/${c.path}`} plain onPress={() => openFile($, repo, c, origin)}>
            {c.path.split('/').pop() ?? c.path}
          </Button>
          {c.added > 0 && <Text color="success"> +{c.added}</Text>}
          {c.removed > 0 && <Text color="error"> -{c.removed}</Text>}
        </Box>
      )
    }),
  ]

  // A focused section: the changed files of its repos as a tree, the open file's diff beside it.
  const focusBody = (id: string, repos: RepoInfo[]) => {
    const changed = repos.filter(r => r.changes.length > 0)
    const clean = repos.length - changed.length
    const origin = id === ROOT ? 'Repos' : id
    return (
      <Box key={`body-${id}`} width="100%" marginTop={1}>
        <Box width={36} flexShrink={0} flexDirection="column" paddingRight={1}>
          {changed.length === 0 && <Text dimColor>no changes</Text>}
          {changed.flatMap(repo => {
            const key = `${id}/${repo.name}`
            const isClosed = closed.includes(key)
            return [
              <Box key={`repo/${key}`}>
                <Button key={`fold/${key}`} plain onPress={() => toggle(key)}>
                  {`${isClosed ? '▸' : '▾'} ${repo.name}`}
                </Button>
                <Text dimColor> {repo.changes.length}</Text>
              </Box>,
              ...(isClosed ? [] : treeRows(buildTree(repo.changes, key), 1, repo, origin)),
            ]
          })}
          {clean > 0 && changed.length > 0 && (
            <Box marginTop={1}>
              <Text dimColor>{clean} without changes</Text>
            </Box>
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column" paddingLeft={1}>
          {file ? diffPanel(file) : <Text dimColor>Select a file to see its diff.</Text>}
        </Box>
      </Box>
    )
  }


  // The folder the editor buttons open: the focused worktree, else the helena folder.
  const contextPath = activeWt ? `${snap.root}/worktrees/${activeWt.name}` : snap.root
  const rootTotal = snap.roots.reduce((n, r) => n + r.changes.length, 0)

  return (
    <Box flexDirection="column">
      <Box width="100%">
        {isFocusing && (
          <Button key="back" plain onPress={async () => { await update($, view, () => null); await update($, focus, () => null) }}>
            <Text bold color="suggestion">← </Text>
          </Button>
        )}
        <Button key="refresh" plain onPress={() => refresh($)}>
          <Text bold color="suggestion">↻ </Text>
        </Button>
        <Button key="kill" plain onPress={() => killPlugin($)}>
          <Text bold color="error">✕ </Text>
        </Button>
        <Button key="code" plain onPress={() => openIn($, VSCODE, contextPath)}>
          <Text bold color="suggestion">ⓥ </Text>
        </Button>
        <Button key="zed" plain onPress={() => openIn($, ZED, contextPath)}>
          <Text bold color="suggestion">ⓩ </Text>
        </Button>
        {err && <Text color="error"> {err}</Text>}
        <Box flexGrow={1} />
        <Select
          key="diff-mode"
          label=""
          value={cfg.mode}
          options={[
            ...MODES.map(value => ({ value, label: value === 'branch' && cfg.mode === 'branch' && cfg.branch ? `branch: ${cfg.branch}` : MODE_LABELS[value] })),
            // Picking the mode that is already set fires nothing, so editing the branch is its own entry.
            ...(cfg.mode === 'branch' ? [{ value: EDIT_BRANCH, label: 'change branch…' }] : []),
          ]}
          onSelect={v => pickMode($, cfg, v === EDIT_BRANCH ? 'branch' : (v as Settings['mode']))}
        />
        <Button key="menu" plain onPress={() => update($, menuOpen, open => !open)}>
          <Text bold color="suggestion">⋮</Text>
        </Button>
      </Box>
      {menuIsOpen && (
        <Box width="100%" justifyContent="flex-end" marginTop={1}>
          <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
            <Button key="menu-pin" plain onPress={() => togglePin($)}>
              {`${isPinned ? '☑' : '☐'} Pin plugin for this folder`}
            </Button>
            <Button key="menu-words" plain onPress={() => toggleWordDiff($)}>
              {`${words ? '☑' : '☐'} Show changed words in bold`}
            </Button>
            <Button key="menu-moved" plain onPress={() => toggleMovedColors($)}>
              {`${showMoved ? '☑' : '☐'} Show moved lines in a different color`}
            </Button>
          </Box>
        </Box>
      )}

      {(isRoot || !isFocusing) && snap.roots.length > 0 &&
        section({
          id: ROOT,
          title: 'Repos',
          summary: `${rootTotal} changed`,
          tone: rootTotal === 0 ? 'success' : 'error',
        })}
      {(isRoot || !isFocusing) && (isRoot ? [focusBody(ROOT, snap.roots)] : snap.roots.map((r, i) => repoRow(ROOT, r, i === 0, snap.roots)))}

      {snap.roots.length === 0 && snap.worktrees.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>No repositories found.</Text>
        </Box>
      )}
      {visible.map(wt => {
        const total = wt.repos.reduce((n, r) => n + r.changes.length, 0)
        return (
          <Box key={`wt-${wt.name}`} flexDirection="column">
            {section({ id: wt.name, title: wt.name, summary: `${total} changed`, tone: 'inactive', top: isFocusing ? 1 : 2 })}
            {isFocusing ? focusBody(wt.name, wt.repos) : wt.repos.map((repo, i) => repoRow(wt.name, repo, i === 0, wt.repos))}
          </Box>
        )
      })}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'multidiff',
      description: 'Toggle the Multidiff pane (repos + worktrees); `--kill` resets it and closes the pane',
      argumentHint: '[--kill]',
    })
    return next(e)
  })

  on('command.run', { command: 'multidiff' }, async ($, e) => {
    if (e.args.trim() === '--kill') {
      await killPlugin($)
      return { text: 'Multidiff killed. Run /multidiff to start fresh.' }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Multidiff pane opened.' : 'Multidiff pane closed.' }
  })

  // The button above the prompt, shown in the folders the pane was pinned for.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, pinTick)
    if (e.props.hasSurvey || !(await getPins($)).includes(await $.session.root())) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="multi-diff" plain onPress={() => togglePane($)}>
          <Text bold color="suggestion">⎇ multidiff</Text>
        </Button>
      </Box>
    )
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (['Bash', 'Edit', 'Write', 'NotebookEdit'].includes(e.tool)) {
      if ((await $.ui.panes()).some(p => p.id === PANE)) void refresh($)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => paneRender($, e))
}
