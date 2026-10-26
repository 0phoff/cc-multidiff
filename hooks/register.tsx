import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { colors, tintsFor } from './colors'
import { readLines } from './git'
import {
  getMovedColors,
  getPins,
  getSettings,
  getShowClean,
  getWordDiff,
  killPlugin,
  PANE,
  refresh,
  ROOT,
  togglePane,
} from './state'
import type { ExpandedMap } from './state'
import type { Ctx } from './ui/ctx'
import { focusBody } from './ui/tree.tsx'
import { repoRow, section } from './ui/overview.tsx'
import { toolbar } from './ui/toolbar.tsx'
import type { WorktreeInfo } from '../types'

// The state atoms, with their starting values. The other modules spell the reference of the ones they use.
const snapshot = atom({ plugin: 'multidiff', key: 'snapshot' } as const, null)
const focus = atom({ plugin: 'multidiff', key: 'focus' } as const, null)
// The repo the focused section is narrowed to (its name), or null for all of the section's repos.
const focusRepo = atom({ plugin: 'multidiff', key: 'focusRepo' } as const, null)
const view = atom({ plugin: 'multidiff', key: 'view' } as const, null)
const error = atom({ plugin: 'multidiff', key: 'error' } as const, null)
// The tree nodes (repo and folder keys) the person has folded.
const collapsed = atom({ plugin: 'multidiff', key: 'collapsed' } as const, [] as string[])
// Whether the three dot menu of the toolbar is open.
const menuOpen = atom({ plugin: 'multidiff', key: 'menuOpen' } as const, false)
// Bumped on every pin change, so the sites that read the pins draw again.
const pinTick = atom({ plugin: 'multidiff', key: 'pinTick' } as const, 0)
// Same for the word highlighting.
const wordTick = atom({ plugin: 'multidiff', key: 'wordTick' } as const, 0)
// Same for showing repos without changes in the tree.
const cleanTick = atom({ plugin: 'multidiff', key: 'cleanTick' } as const, 0)
// Same for the moved line colours.
const movedTick = atom({ plugin: 'multidiff', key: 'movedTick' } as const, 0)
// Same for the diff setting.
const settingsTick = atom({ plugin: 'multidiff', key: 'settingsTick' } as const, 0)
// How many more pages of rows the open file shows beyond the first, by `<dir>/<path>`.
const pages = atom({ plugin: 'multidiff', key: 'pages' } as const, {} as Record<string, number>)
// Lines of context added by the arrows between two hunks, by `<dir>/<path>@<first line of the hunk below>`.
const expanded = atom({ plugin: 'multidiff', key: 'expanded' } as const, {} as ExpandedMap)

// The Multidiff pane's drawing: reads what it draws from, then lays out the toolbar and the
// overview, or the tree and the diff of a focused section.
const paneRender = async ($: any, e: any) => {
  const { Box, Text, Button, Code, Select } = $.ui.resolve(e)
  await read($, pinTick)
  await read($, wordTick)
  await read($, cleanTick)
  await read($, movedTick)
  await read($, settingsTick)
  const cfg = await getSettings($)
  const isPinned = (await getPins($)).includes(await $.session.root())
  const menuIsOpen = await read($, menuOpen)
  const snap = await read($, snapshot)
  const focused = await read($, focus)
  const only = await read($, focusRepo)
  const file = await read($, view)
  const err = await read($, error)

  const grown = await read($, expanded)
  const fileLines = file && Object.keys(grown).some(k => k.startsWith(`${file.dir}/${file.path}@`)) ? await readLines($, `${file.dir}/${file.path}`) : null
  const ctx: Ctx = {
    e,
    Box,
    Text,
    Button,
    Code,
    Select,
    tints: await tintsFor($),
    words: await getWordDiff($),
    showClean: await getShowClean($),
    showMoved: await getMovedColors($),
    file,
    closed: await read($, collapsed),
    grown,
    morePages: await read($, pages),
    fileLines,
    toggle: (key: string) => update($, collapsed, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key])),
  }

  if (!snap) return <Text dimColor>{err ?? 'Loading…'}</Text>

  const isRoot = focused === ROOT
  const activeWt = snap.worktrees.find(w => w.name === focused)
  const isFocusing = isRoot || !!activeWt
  const visible: WorktreeInfo[] = activeWt ? [activeWt] : isRoot ? [] : snap.worktrees

  // The folder the editor buttons open: the focused worktree, else the helena folder.
  const contextPath = activeWt ? `${snap.root}/worktrees/${activeWt.name}` : snap.root
  const rootTotal = snap.roots.reduce((n, r) => n + r.changes.length, 0)

  return (
    <Box flexDirection="column">
      {toolbar($, ctx, { isFocusing, err, cfg, isPinned, menuIsOpen, contextPath })}

      {(isRoot || !isFocusing) && snap.roots.length > 0 && section($, ctx, { id: ROOT, title: `Repositories: ${snap.root.split('/').filter(Boolean).pop() ?? snap.root}`, summary: `${rootTotal} changed` })}
      {(isRoot || !isFocusing) && (isRoot ? [focusBody($, ctx, ROOT, snap.roots, only)] : snap.roots.map((r, i) => repoRow($, ctx, ROOT, r, i === 0, snap.roots)))}

      {snap.roots.length === 0 && snap.worktrees.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>No repositories found.</Text>
        </Box>
      )}
      {visible.map(wt => {
        const total = wt.repos.reduce((n, r) => n + r.changes.length, 0)
        return (
          <Box key={`wt-${wt.name}`} flexDirection="column">
            {section($, ctx, { id: wt.name, title: `Worktree: ${wt.name}`, summary: `${total} changed`, top: isFocusing ? 1 : 2 })}
            {isFocusing ? focusBody($, ctx, wt.name, wt.repos, only) : wt.repos.map((repo, i) => repoRow($, ctx, wt.name, repo, i === 0, wt.repos))}
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
        <Button key="multidiff" plain onPress={() => togglePane($)}>
          <Text bold color={colors.accent}>⎇ multidiff</Text>
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

