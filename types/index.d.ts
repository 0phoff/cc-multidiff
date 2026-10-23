export type Change = { code: string; path: string; added: number; removed: number }
export type RepoInfo = { name: string; dir: string; branch: string; changes: Change[]; ref: string | null; missing: boolean; base: string; ahead: number; behind: number }
export type Settings = { mode: 'local' | 'default' | 'branch'; branch: string }
export type WorktreeInfo = { name: string; repos: RepoInfo[] }
export type Snapshot = { root: string; roots: RepoInfo[]; worktrees: WorktreeInfo[]; at: number }
export type FileView = { origin: string; repo: string; dir: string; path: string; code: string; base: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'multi-diff': {
      snapshot: Snapshot | null
      focus: string | null
      view: FileView | null
      error: string | null
      pinTick: number
      settingsTick: number
    }
  }
}
