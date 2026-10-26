// Every colour the pane uses, in one place. Theme keys follow the user's colour scheme; the hex
// tints are fixed and picked for a dark or a light theme.

// Theme keys, by what they colour.
export const colors = {
  // Buttons and links.
  accent: 'suggestion',
  // The kill button, error messages, a repo whose branch is missing.
  danger: 'error',
  // Diff rows and their `+` / `-` markers.
  rowAdded: 'diffAddedDimmed',
  rowRemoved: 'diffRemovedDimmed',
  markerAdded: 'success',
  markerRemoved: 'error',
  // The marker of a moved line: where it left, where it arrived (its row is a hex tint, below).
  markerMovedFrom: 'warning',
  markerMovedTo: 'suggestion',
  // The banner of a section (fill, border and title), the open file in the tree, the three dot menu.
  banner: 'promptBorder',
  bannerText: 'text',
  selected: 'promptBorder',
  menuBorder: 'promptBorder',
  // Ahead and behind counts, the changed file count, and a file's +/- counts.
  ahead: 'success',
  behind: 'warning',
  changed: 'warning',
  linesAdded: 'success',
  linesRemoved: 'error',
}

// A file's status letter in the tree: added, deleted, renamed, conflicted, otherwise modified.
export const statusColor = (code: string) =>
  code === '??' || code.includes('A')
    ? 'success'
    : code.includes('D')
      ? 'error'
      : code.includes('R')
        ? 'suggestion'
        : code.includes('U')
          ? 'permission'
          : 'warning'

// The letter drawn for a status code: untracked is `U` and a conflict `!`, as in VS Code.
export const statusLabel = (code: string) => (code === '??' ? 'U' : code.includes('U') ? '!' : code.trim() || 'M')

// `added` and `removed` tint the changed words of an edited line, a step stronger than the row.
// Moved lines are drawn orange where they left and blue where they arrived: the marker
// is a theme key, the row a tint picked for the theme (no theme key is a dim orange or blue).
export const TINTS = {
  dark: { from: '#4a3315', to: '#1c3050', added: '#2f5a37', removed: '#6a3239' },
  light: { from: '#ffe3c2', to: '#d4e4ff', added: '#b8e5c2', removed: '#f4bfc4' },
}
export type Tints = typeof TINTS.dark

// Any theme with `light` in its name (light, light-daltonized, light-ansi); `auto` counts as dark.
export async function tintsFor($: any): Promise<Tints> {
  try {
    const row = (await $.config.list()).find((r: { key: string }) => r.key === 'theme')
    return typeof row?.value === 'string' && /light/i.test(row.value) ? TINTS.light : TINTS.dark
  } catch {
    return TINTS.dark
  }
}
