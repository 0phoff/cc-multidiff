export type Change = { code: string; path: string; added: number; removed: number }
export type RepoInfo = { name: string; dir: string; branch: string; changes: Change[]; ref: string | null; ahead: number; behind: number; remote: { ahead: number; behind: number } | null; merged: boolean }
export type WorktreeInfo = { name: string; repos: RepoInfo[] }
export type Snapshot = { root: string; roots: RepoInfo[]; worktrees: WorktreeInfo[]; at: number }
export type FileView = { origin: string; repo: string; dir: string; path: string; code: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'multi-diff': {
      snapshot: Snapshot | null
      focus: string | null
      view: FileView | null
      error: string | null
      pinTick: number
    }
  }
}
