// `from` is the old path of a renamed file (code `R`).
export type Change = { code: string; path: string; added: number; removed: number; from?: string }
export type RepoInfo = { name: string; dir: string; branch: string; changes: Change[]; ref: string | null; missing: boolean; base: string; ahead: number; behind: number }
export type Settings = { mode: 'local' | 'default' | 'branch'; branch: string }
export type WorktreeInfo = { name: string; repos: RepoInfo[] }
export type Snapshot = { root: string; roots: RepoInfo[]; worktrees: WorktreeInfo[]; at: number }
// `moved` holds the indexes of the lines of `text` that git reports as moved, not added or removed.
export type FileView = { origin: string; repo: string; dir: string; path: string; from?: string; code: string; base: string; text: string; moved: number[] }

declare module 'claude-code' {
  interface PluginState {
    'multidiff': {
      snapshot: Snapshot | null
      focus: string | null
      focusRepo: string | null
      view: FileView | null
      collapsed: string[]
      error: string | null
      menuOpen: boolean
      pinTick: number
      wordTick: number
      cleanTick: number
      movedTick: number
      settingsTick: number
      expanded: Record<string, { up: number; down: number }>
      pages: Record<string, number>
    }
  }
}
