import { read, update } from 'claude-code'

import { changedLines, collect, diffOf } from './git'
import type { Change, FileView, RepoInfo, Settings } from '../types'

// References to the plugin's state atoms, which are defined in register.tsx. The plugin loader reads
// the plugin and key off a literal in the file that reads or writes the atom, so each file spells its own.
const collapsed = { plugin: 'multidiff', key: 'collapsed' } as const
const error = { plugin: 'multidiff', key: 'error' } as const
const expanded = { plugin: 'multidiff', key: 'expanded' } as const
const focusRepo = { plugin: 'multidiff', key: 'focusRepo' } as const
const focus = { plugin: 'multidiff', key: 'focus' } as const
const menuOpen = { plugin: 'multidiff', key: 'menuOpen' } as const
const movedTick = { plugin: 'multidiff', key: 'movedTick' } as const
const pages = { plugin: 'multidiff', key: 'pages' } as const
const pinTick = { plugin: 'multidiff', key: 'pinTick' } as const
const settingsTick = { plugin: 'multidiff', key: 'settingsTick' } as const
const snapshot = { plugin: 'multidiff', key: 'snapshot' } as const
const view = { plugin: 'multidiff', key: 'view' } as const
const cleanTick = { plugin: 'multidiff', key: 'cleanTick' } as const
const wordTick = { plugin: 'multidiff', key: 'wordTick' } as const

// The plugin's state: the atoms the pane draws from, the settings kept across sessions, and
// the actions that change them (refresh, open a file, toggles, open or kill the pane).

export type ExpandedMap = Record<string, { up: number; down: number }>

export const PANE = 'multidiff'
export const ROOT = '__root__'
// The tree nodes (repo and folder keys) the person has folded.
// Whether the three dot menu of the toolbar is open.
// Bumped on every pin change, so the sites that read the pins draw again.
// Same for the word highlighting.
// Same for the moved line colours.
// Same for the diff setting.
// Lines of context added by the arrows between two hunks, by `<dir>/<path>@<first line of the hunk below>`.
// How many more pages of rows the open file shows beyond the first, by `<dir>/<path>`.

// A refresh reads every repo, which takes seconds: while one runs, further asks (every tool call
// of the agent asks) merge into a single run that starts right after it.
let refreshing: Promise<void> | null = null
let again = false
// Bumped by the kill button: a refresh that started before it drops its result.
let epoch = 0
export async function refresh($: any): Promise<void> {
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

export async function refreshOnce($: any) {
  const born = epoch
  try {
    const snap = await collect($, await getSettings($))
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

export async function openFile($: any, repo: RepoInfo, change: Change, origin: string) {
  const { text, moved } = await diffOf($, repo.dir, change.path, change.from, change.code, repo.base, changedLines(repo))
  const next: FileView = { origin, repo: repo.name, dir: repo.dir, path: change.path, from: change.from, code: change.code, base: repo.base, text, moved }
  await update($, view, () => next)
}

// Shows one repo of a section alone: its tree, and the diff of the file picked from it.
export async function focusOnRepo($: any, id: string, name: string) {
  await update($, view, () => null)
  await update($, focusRepo, () => name)
  await update($, focus, () => id)
}

// The global diff setting, kept across sessions.
export const SETTINGS = 'diffSettings'
export const MODES: Settings['mode'][] = ['local', 'default', 'branch']
export const EDIT_BRANCH = 'edit-branch'
export const MODE_LABELS: Record<Settings['mode'], string> = { local: 'local changes', default: 'default branch', branch: 'branch…' }
export async function getSettings($: any): Promise<Settings> {
  const v = await $.store.get(SETTINGS)
  return v && MODES.includes(v.mode) ? { mode: v.mode, branch: String(v.branch ?? '') } : { mode: 'local', branch: '' }
}
export async function setSettings($: any, next: Settings) {
  await $.store.set(SETTINGS, next)
  await update($, settingsTick, n => n + 1)
  // An open diff was cut against the old base.
  await update($, view, () => null)
  await refresh($)
}

// `branch…` asks for the branch in a popup: the last branch if known, `main` and `master` to click,
// anything else typed under "Other". Skipping it falls back to local changes and forgets the branch.
export async function pickMode($: any, cfg: Settings, mode: Settings['mode']) {
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
export const PINS = 'pinnedFolders'
export async function getPins($: any): Promise<string[]> {
  const list = await $.store.get(PINS)
  return Array.isArray(list) ? list : []
}
export async function togglePin($: any) {
  const cwd: string = await $.session.root()
  const pins = await getPins($)
  const next = pins.includes(cwd) ? pins.filter(p => p !== cwd) : [...pins, cwd]
  await $.store.set(PINS, next)
  await update($, pinTick, n => n + 1)
}

// Whether edited lines get their changed words highlighted, kept across sessions: off by default.
export const WORD_DIFF = 'wordDiff'
export async function getWordDiff($: any): Promise<boolean> {
  return (await $.store.get(WORD_DIFF)) === true
}
export async function toggleWordDiff($: any) {
  await $.store.set(WORD_DIFF, !(await getWordDiff($)))
  await update($, wordTick, n => n + 1)
}

// Whether the tree also lists the repos without changes, kept across sessions: off by default.
export const SHOW_CLEAN = 'showClean'
export async function getShowClean($: any): Promise<boolean> {
  return (await $.store.get(SHOW_CLEAN)) === true
}
export async function toggleShowClean($: any) {
  await $.store.set(SHOW_CLEAN, !(await getShowClean($)))
  await update($, cleanTick, n => n + 1)
}

// Whether moved lines get their own colours, kept across sessions: off by default.
export const MOVED_COLORS_KEY = 'movedColors'
export async function getMovedColors($: any): Promise<boolean> {
  return (await $.store.get(MOVED_COLORS_KEY)) === true
}
export async function toggleMovedColors($: any) {
  await $.store.set(MOVED_COLORS_KEY, !(await getMovedColors($)))
  await update($, movedTick, n => n + 1)
}

// Opens the pane, or closes it when it is up; the slash command and the button share it.
export async function togglePane($: any): Promise<boolean> {
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
export async function killPlugin($: any) {
  epoch++
  refreshing = null
  again = false
  await $.ui.close({ id: PANE })
  await update($, snapshot, () => null)
  await update($, focus, () => null)
  await update($, focusRepo, () => null)
  await update($, view, () => null)
  await update($, error, () => null)
  await update($, collapsed, () => [])
  await update($, pages, () => ({}))
  await update($, expanded, () => ({}))
  await update($, pinTick, () => 0)
  await update($, wordTick, () => 0)
  await update($, cleanTick, () => 0)
  await update($, movedTick, () => 0)
  await update($, menuOpen, () => false)
  await update($, settingsTick, () => 0)
  $.ui.toast('multidiff killed: run /multidiff to start fresh')
}
