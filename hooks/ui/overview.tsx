import { update } from 'claude-code'

import { colors } from '../colors'
import { focusOnRepo } from '../state'
import { toBold } from '../util'
import type { RepoInfo } from '../../types'
import type { Ctx } from './ctx'

// References to the plugin's state atoms, which are defined in register.tsx. The plugin loader reads
// the plugin and key off a literal in the file that reads or writes the atom, so each file spells its own.
const focus = { plugin: 'multidiff', key: 'focus' } as const
const focusRepo = { plugin: 'multidiff', key: 'focusRepo' } as const
const view = { plugin: 'multidiff', key: 'view' } as const

// The ahead/behind of a repo against the compared ref, as drawn in the overview and under a repo in the tree.
export const syncLabel = ({ Text }: Ctx, repo: RepoInfo) =>
  repo.missing ? (
    <Text color={colors.danger}>branch does not exist</Text>
  ) : repo.ref ? (
    <Text>
      <Text color={repo.ahead > 0 ? colors.ahead : undefined} dimColor={repo.ahead === 0}>↑{repo.ahead} </Text>
      <Text color={repo.behind > 0 ? colors.behind : undefined} dimColor={repo.behind === 0}>↓{repo.behind}</Text>
    </Text>
  ) : (
    <Text dimColor>no upstream</Text>
  )

// The banner of a worktree or of the root repos: click it to focus it.
export function section($: any, { Box, Text, Button }: Ctx, p: { id: string; title: string; summary: string; top?: number }) {
  const title = toBold(p.title.toUpperCase())
  // The Box draws the banner; the Button inside is the click
  // target, with an em dash between the title and the count.
  const press = async () => {
    await update($, view, () => null)
    await update($, focusRepo, () => null)
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
      borderColor={colors.banner}
      backgroundColor={colors.banner}
    >
      <Button key={`focus-${p.id}`} plain onPress={press}>
        <Text bold color={colors.bannerText}>{title}</Text>
        <Text dimColor>{'     —     '}{p.summary}</Text>
      </Button>
    </Box>
  )
}

// Columns: the name takes the room left and is cut at the end (never wraps); the branch and
// the stats are as wide as their longest entry in the same section (the branch capped), so
// the rows of a section line up and short branches do not pay for a long one elsewhere.
const syncOf = (r: RepoInfo) => (r.missing ? 'branch does not exist' : r.ref ? `↑${r.ahead} ↓${r.behind}` : 'no upstream')
const changedOf = (r: RepoInfo) => `${r.changes.length} changed`

export function repoRow($: any, ctx: Ctx, id: string, repo: RepoInfo, first: boolean, group: RepoInfo[]) {
  const { Box, Text, Button } = ctx
  const n = repo.changes.length
  const branchWidth = Math.min(24, Math.max(0, ...group.map(r => r.branch.length))) + 2
  const syncWidth = Math.max(0, ...group.map(r => syncOf(r).length)) + 2
  const changedWidth = Math.max(0, ...group.map(r => changedOf(r).length)) + 1
  return (
    <Box key={`${id}/${repo.name}`} flexDirection="column" marginTop={first ? 1 : 0}>
      <Box paddingX={1} width="100%">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Button key={`only-${id}-${repo.name}`} plain onPress={() => focusOnRepo($, id, repo.name)}>
            {toBold(repo.name)}
          </Button>
        </Box>
        <Box width={branchWidth} flexShrink={0} justifyContent="flex-end" paddingRight={2}>
          <Text dimColor wrap="truncate-end">{repo.branch}</Text>
        </Box>
        <Box width={syncWidth} flexShrink={0} justifyContent="center">
          {syncLabel(ctx, repo)}
        </Box>
        <Box width={changedWidth} flexShrink={0} justifyContent="flex-end">
          <Text color={n > 0 ? colors.changed : undefined} dimColor={n === 0}>{changedOf(repo)}</Text>
        </Box>
      </Box>
    </Box>
  )
}
