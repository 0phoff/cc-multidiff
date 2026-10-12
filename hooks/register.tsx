import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, FileView, RepoInfo, Snapshot, WorktreeInfo } from '../types'

const PANE = 'multi-diff'
const ROOT = '__root__'
const snapshot = atom({ plugin: 'multi-diff', key: 'snapshot' } as const, null)
const focus = atom({ plugin: 'multi-diff', key: 'focus' } as const, null)
const view = atom({ plugin: 'multi-diff', key: 'view' } as const, null)
const error = atom({ plugin: 'multi-diff', key: 'error' } as const, null)
// Bumped on every pin change, so the sites that read the pins draw again.
const pinTick = atom({ plugin: 'multi-diff', key: 'pinTick' } as const, 0)
const expand = atom({ plugin: 'multi-diff', key: 'expand' } as const, {})

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

// Commits ahead/behind the branch's base (never its pushed copy): `uat` for a
// hotfix, otherwise `dev`, `main` or `master`, whichever the repo has. A checkout
// of one of those branches is compared with its own remote branch. `remote` says
// separately whether the branch is pushed and in sync.
const compare = async (run: Run, dir: string, branch: string, tracking: boolean) => {
  const exists = async (ref: string) => (await run(['git', 'rev-parse', '--verify', '--quiet', ref], dir)).exitCode === 0
  const bases = ['origin/dev', 'origin/main', 'origin/master']
  const candidates = ['dev', 'uat', 'prod', 'main', 'master'].includes(branch)
    ? [`origin/${branch}`]
    : branch.startsWith('hotfix/')
      ? ['origin/uat', ...bases]
      : bases
  let ref: string | null = null
  if (tracking) {
    // Root repos: whatever the checked-out branch tracks.
    const up = await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], dir)
    if (up.exitCode === 0 && up.stdout.trim()) ref = up.stdout.trim()
  }
  for (const base of tracking ? [] : candidates) {
    if (await exists(base)) {
      ref = base
      break
    }
  }
  const base = ref ? await countAgainst(run, dir, ref) : { ahead: 0, behind: 0 }
  const remote = branch && (await exists(`origin/${branch}`)) ? await countAgainst(run, dir, `origin/${branch}`) : null
  return { ref, ...base, remote }
}

const readRepo = async (run: Run, dir: string, name: string, withStats: boolean, tracking = false): Promise<RepoInfo> => {
  const [status, branch, stats] = await Promise.all([
    run(['git', 'status', '--porcelain=v1', '-uall'], dir),
    run(['git', 'branch', '--show-current'], dir),
    withStats ? run(['git', 'diff', 'HEAD', '--numstat'], dir) : Promise.resolve(null),
  ])
  const counts = new Map<string, [number, number]>()
  for (const line of stats?.stdout.split('\n') ?? []) {
    const [a, r, ...rest] = line.split('\t')
    if (rest.length) counts.set(rest.join('\t'), [Number(a) || 0, Number(r) || 0])
  }
  const changes: Change[] = status.stdout
    .split('\n')
    .filter(l => l.length > 3)
    .map(l => {
      const code = l.slice(0, 2)
      const raw = l.slice(3)
      const path = (raw.includes(' -> ') ? raw.split(' -> ')[1] : raw).replace(/^"|"$/g, '')
      const [added, removed] = counts.get(path) ?? [0, 0]
      return { code, path, added, removed }
    })
  const { ref, ahead, behind, remote } = await compare(run, dir, branch.stdout.trim(), tracking)
  return { name, dir, branch: branch.stdout.trim() || '(detached)', changes, ref, ahead, behind, remote }
}

const collect = async ($: any): Promise<Snapshot> => {
  // The session may have moved into a worktree: the helena folder is above `worktrees/`.
  const cwd: string = await $.session.cwd()
  const root = cwd.includes('/worktrees/') ? cwd.slice(0, cwd.indexOf('/worktrees/')) : cwd
  const run: Run = (argv, cwd) => $.process.run(argv, { cwd })

  const rootDirs = (await findRepos(run, root, '.', 4)).filter(p => !p.startsWith('./worktrees/'))
  const roots = await Promise.all(rootDirs.map(p => readRepo(run, `${root}/${p.slice(2)}`, p.slice(2), true, true)))

  const wtDirs = await findRepos(run, root, './worktrees', 5)
  const byWt = new Map<string, RepoInfo[]>()
  await Promise.all(
    wtDirs.map(async p => {
      const [, , wt, ...rest] = p.split('/')
      if (!rest.length) return
      const info = await readRepo(run, `${root}/${p.slice(2)}`, rest.join('/'), true)
      byWt.set(wt, [...(byWt.get(wt) ?? []), info])
    }),
  )
  const worktrees: WorktreeInfo[] = [...byWt.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, repos]) => ({ name, repos: repos.sort((a, b) => a.name.localeCompare(b.name)) }))

  return { root, roots, worktrees, at: Date.now() }
}

const refresh = async ($: any) => {
  try {
    const snap = await collect($)
    await update($, snapshot, () => snap)
    await update($, error, () => null)
  } catch (err) {
    await update($, error, () => String(err))
  }
}


// The diff is read with the whole file as context, parsed into rows, and drawn as
// separate hunks: changed lines with a few lines around them, and a button for
// every run of unchanged lines left out, which reveals more when pressed.
type Row = { t: ' ' | '+' | '-'; text: string; o: number; n: number }
type Piece = { kind: 'code'; source: string } | { kind: 'hidden'; gap: number; count: number }

const CONTEXT = 3
const STEP = 20

const parseRows = (text: string): Row[] => {
  const rows: Row[] = []
  let o = 1
  let n = 1
  let inHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
      if (m) {
        o = Number(m[1])
        n = Number(m[2])
      }
      inHunk = true
    } else if (inHunk && (line[0] === ' ' || line[0] === '+' || line[0] === '-')) {
      const t = line[0] as Row['t']
      rows.push({ t, text: line.slice(1), o, n })
      if (t !== '+') o++
      if (t !== '-') n++
    }
  }
  return rows
}

const toSource = (rows: Row[]): string => {
  const oc = rows.filter(r => r.t !== '+').length
  const nc = rows.filter(r => r.t !== '-').length
  return [`@@ -${rows[0].o},${oc} +${rows[0].n},${nc} @@`, ...rows.map(r => r.t + r.text)].join('\n')
}

const layout = (rows: Row[], reveal: (gap: number) => number): Piece[] => {
  const near = rows.map(() => false)
  rows.forEach((r, i) => {
    if (r.t === ' ') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j++) near[j] = true
  })
  const visible = [...near]
  // The unchanged runs between the lines shown by default, each keyed by where it starts.
  for (let i = 0; i < rows.length; ) {
    if (near[i]) {
      i++
      continue
    }
    let end = i
    while (end < rows.length && !near[end]) end++
    const k = reveal(i)
    // Next to the hunk above reveals downwards, next to the hunk below upwards.
    if (i > 0) for (let j = i; j < Math.min(end, i + k); j++) visible[j] = true
    if (end < rows.length) for (let j = Math.max(i, end - k); j < end; j++) visible[j] = true
    i = end
  }
  const pieces: Piece[] = []
  let gap = -1
  for (let i = 0; i < rows.length; ) {
    let end = i
    if (visible[i]) {
      while (end < rows.length && visible[end]) end++
      pieces.push({ kind: 'code', source: toSource(rows.slice(i, end)) })
    } else {
      while (end < rows.length && !visible[end]) end++
      // The key is the start of the default gap this run belongs to.
      let start = i
      while (start > 0 && !near[start - 1]) start--
      gap = start
      pieces.push({ kind: 'hidden', gap, count: end - i })
    }
    i = end
  }
  return pieces
}

const diffOf = async ($: any, dir: string, path: string, code: string): Promise<string> => {
  const run: Run = (argv, cwd) => $.process.run(argv, { cwd })
  const out =
    code === '??'
      ? await run(['git', 'diff', '--no-index', '--no-color', '--unified=100000', '--', '/dev/null', path], dir)
      : await run(['git', 'diff', 'HEAD', '--no-color', '--unified=100000', '--', path], dir)
  return out.stdout || out.stderr
}

const openFile = async ($: any, repo: RepoInfo, change: Change, origin: string) => {
  const text = await diffOf($, repo.dir, change.path, change.code)
  const next: FileView = { origin, repo: repo.name, dir: repo.dir, path: change.path, code: change.code, text }
  await update($, expand, () => ({}))
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

// Refresh the lists and re-read the diff that is open.
const refreshFile = async ($: any, file: FileView) => {
  await refresh($)
  const text = await diffOf($, file.dir, file.path, file.code)
  await update($, view, cur => (cur && cur.dir === file.dir && cur.path === file.path ? { ...cur, text } : cur))
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

// The folders the prompt button is pinned for, kept across sessions.
const PINS = 'pinnedFolders'
const getPins = async ($: any): Promise<string[]> => {
  const list = await $.store.get(PINS)
  return Array.isArray(list) ? list : []
}
const togglePin = async ($: any) => {
  const cwd: string = await $.session.cwd()
  const pins = await getPins($)
  const next = pins.includes(cwd) ? pins.filter(p => p !== cwd) : [...pins, cwd]
  await $.store.set(PINS, next)
  await update($, pinTick, n => n + 1)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'multidiff',
      description: 'Toggle the Multidiff pane (root repos + worktrees)',
    })
    await $.command.register({
      name: 'multi-diff',
      description: 'Same as /multidiff',
    })
    return next(e)
  })

  on('command.run', { command: 'multidiff' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Multidiff pane opened.' : 'Multidiff pane closed.' }
  })

  on('command.run', { command: 'multi-diff' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Multidiff pane opened.' : 'Multidiff pane closed.' }
  })

  // The button above the prompt, shown in the folders the pane was pinned for.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, pinTick)
    if (e.props.hasSurvey || !(await getPins($)).includes(await $.session.cwd())) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="multi-diff" plain onPress={() => togglePane($)}>
          <Text bold color="cyan">⎇ multidiff</Text>
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    await read($, pinTick)
    const isPinned = (await getPins($)).includes(await $.session.cwd())
    const pinButton = (
      <Button key="pin" plain onPress={() => togglePin($)}>
        <Text bold color="cyan">{isPinned ? '⚑ ' : '⚐ '}</Text>
      </Button>
    )
    const snap = await read($, snapshot)
    const focused = await read($, focus)
    const file = await read($, view)
    const err = await read($, error)

    if (file) {
      const rows = parseRows(file.text)
      // A deleted file has nothing to open: open its repo folder instead.
      const filePath = file.code.includes('D') ? file.dir : `${file.dir}/${file.path}`
      const opened = await read($, expand)
      const slot = (gap: number) => `${file.dir}::${file.path}::${gap}`
      const pieces = rows.length ? layout(rows, gap => opened[slot(gap)] ?? 0) : []
      return (
        <Box flexDirection="column" width="100%">
          <Box width="100%">
            <Button key="back" plain onPress={() => update($, view, () => null)}>
              <Text bold color="cyan">← </Text>
            </Button>
            <Button key="refresh-file" plain onPress={() => refreshFile($, file)}>
              <Text bold color="cyan">↻ </Text>
            </Button>
            <Button key="code-file" plain onPress={() => openIn($, VSCODE, filePath)}>
              <Text bold color="cyan">ⓥ </Text>
            </Button>
            <Button key="zed-file" plain onPress={() => openIn($, ZED, filePath)}>
              <Text bold color="cyan">ⓩ </Text>
            </Button>
            <Box flexGrow={1} />
            {pinButton}
          </Box>
          <Box marginTop={1}>
            <Text bold>{file.origin}</Text>
            <Text dimColor> › {file.repo}: {file.path}</Text>
          </Box>
          {pieces.length === 0 && (
            <Text dimColor>{file.text.trim() || 'No textual changes (binary or mode change).'}</Text>
          )}
          {pieces.map((piece, i) =>
            piece.kind === 'code' ? (
              <Box key={`code-${i}`} width="100%">
                <Code source={piece.source} format="diff" path={file.path} wrap="truncate-end" />
              </Box>
            ) : (
              <Box key={`hidden-${i}`}>
                <Button
                  key={`more-${piece.gap}-${i}`}
                  plain
                  onPress={() => update($, expand, cur => ({ ...cur, [slot(piece.gap)]: (cur[slot(piece.gap)] ?? 0) + STEP }))}
                >
                  <Text color="cyan">⋯ {piece.count} unchanged lines · click to show more</Text>
                </Button>
              </Box>
            ),
          )}
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
      const press = () => update($, focus, cur => (cur === p.id ? null : p.id))
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

    // Whether the branch has a copy on the remote and how it stands against it.
    const remoteMarker = (repo: RepoInfo) => {
      const r = repo.remote
      if (!r) return <Text dimColor>not pushed</Text>
      if (r.ahead === 0 && r.behind === 0) return <Text color="success">pushed ✓ in sync</Text>
      const parts = [r.ahead > 0 ? `↑${r.ahead} unpushed` : '', r.behind > 0 ? `↓${r.behind} behind` : '']
      return <Text color="warning">pushed ✗ {parts.filter(Boolean).join(' ')}</Text>
    }

    const files = (p: { id: string; repo: RepoInfo; summary?: boolean; list?: boolean }) => (
      <Box key={`${p.id}/${p.repo.name}`} flexDirection="column" paddingX={1} marginTop={1}>
        <Box>
          <Text bold>{p.repo.name} </Text>
          <Text dimColor>{p.repo.branch}</Text>
        </Box>
        {p.summary && (
          <Box>
            <Text dimColor>  </Text>
            {p.repo.ref ? (
              <Box>
                <Text color={p.repo.ahead > 0 ? 'success' : undefined} dimColor={p.repo.ahead === 0}>↑{p.repo.ahead} </Text>
                <Text color={p.repo.behind > 0 ? 'warning' : undefined} dimColor={p.repo.behind === 0}>↓{p.repo.behind} </Text>
                {p.id !== ROOT && <Text dimColor>vs {p.repo.ref}</Text>}
              </Box>
            ) : (
              <Text dimColor>no upstream</Text>
            )}
            <Text dimColor> · </Text>
            <Text color={p.repo.changes.length > 0 ? 'warning' : undefined} dimColor={p.repo.changes.length === 0}>
              {p.repo.changes.length} uncommitted
            </Text>
            {p.id !== ROOT && <Text dimColor> · </Text>}
            {p.id !== ROOT && remoteMarker(p.repo)}
          </Box>
        )}
        {p.list !== false && p.repo.changes.length === 0 && (
          <Box marginLeft={2}>
            <Text dimColor>  no changes</Text>
          </Box>
        )}
        {(p.list === false ? [] : p.repo.changes).map(c => (
          <Box key={`${p.id}/${p.repo.name}/${c.path}`} marginLeft={2}>
            {/* Outside the Button: a Button label ignores the Text colors inside it. */}
            <Text bold color={codeColor(c.code)}>{'  ' + (c.code.trim() || 'M').padEnd(2)}</Text>
            <Button key={`open/${p.id}/${p.repo.name}/${c.path}`} plain onPress={() => openFile($, p.repo, c, p.id === ROOT ? 'Root repos' : p.id)}>
              {c.path}
            </Button>
            {c.added > 0 && <Text color="success"> +{c.added}</Text>}
            {c.removed > 0 && <Text color="error"> -{c.removed}</Text>}
          </Box>
        ))}
      </Box>
    )

    // The folder the editor buttons open: the focused worktree, else the helena folder.
    const contextPath = activeWt ? `${snap.root}/worktrees/${activeWt.name}` : snap.root
    const rootTotal = snap.roots.reduce((n, r) => n + r.changes.length, 0)

    return (
      <Box flexDirection="column">
        <Box width="100%">
          {isFocusing && (
            <Button key="back" plain onPress={() => update($, focus, () => null)}>
              <Text bold color="cyan">← </Text>
            </Button>
          )}
          <Button key="refresh" plain onPress={() => refresh($)}>
            <Text bold color="cyan">↻ </Text>
          </Button>
          <Button key="code" plain onPress={() => openIn($, VSCODE, contextPath)}>
            <Text bold color="cyan">ⓥ </Text>
          </Button>
          <Button key="zed" plain onPress={() => openIn($, ZED, contextPath)}>
            <Text bold color="cyan">ⓩ </Text>
          </Button>
          {err && <Text color="red"> {err}</Text>}
          <Box flexGrow={1} />
          {pinButton}
        </Box>

        {(isRoot || !isFocusing) &&
          section({
            id: ROOT,
            title: 'Root repos',
            summary: `${rootTotal} changed`,
            tone: rootTotal === 0 ? 'success' : 'error',
          })}
        {!isFocusing && (
          <Box flexDirection="column" marginTop={1}>
            {snap.roots.map(r => (
              <Box key={`root-${r.name}`} paddingX={1}>
                <Text color={r.changes.length === 0 ? 'green' : 'red'} bold>
                  {String(r.changes.length).padStart(3)}{' '}
                </Text>
                <Text>{r.name} </Text>
                <Text dimColor>{r.branch}</Text>
              </Box>
            ))}
          </Box>
        )}
        {isRoot && (
          <Box flexDirection="column" marginTop={1}>
            {snap.roots.map(r => files({ id: ROOT, repo: r, summary: true }))}
          </Box>
        )}

        {!isRoot && visible.length === 0 && <Text dimColor>No worktrees.</Text>}
        {visible.map(wt => {
          const total = wt.repos.reduce((n, r) => n + r.changes.length, 0)
          return (
            <Box key={`wt-${wt.name}`} flexDirection="column">
              {section({ id: wt.name, title: wt.name, summary: `${total} changed`, tone: 'inactive', top: isFocusing ? 1 : 2 })}
              {wt.repos.map(repo => (
                files({ id: wt.name, repo, summary: true, list: isFocusing })
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
