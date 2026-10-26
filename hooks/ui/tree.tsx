import { colors, statusColor } from '../colors'
import { openFile, ROOT } from '../state'
import { toBold } from '../util'
import type { Change, RepoInfo } from '../../types'
import type { Ctx } from './ctx'
import { diffPanel } from './diffView.tsx'
import { syncLabel } from './overview.tsx'

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

// The tree of one folder level: folders first (click to fold), then its files (click to see the diff).
function treeRows($: any, ctx: Ctx, node: TreeNode, depth: number, repo: RepoInfo, origin: string): any[] {
  const { Box, Text, Button, closed, file, toggle } = ctx
  return [
    ...node.dirs.flatMap(d => {
      const isClosed = closed.includes(d.key)
      return [
        <Box key={`dir/${d.key}`} marginLeft={depth * 2}>
          <Button key={`fold/${d.key}`} plain onPress={() => toggle(d.key)}>
            {`${isClosed ? '▸' : '▾'} ${d.name}/`}
          </Button>
        </Box>,
        ...(isClosed ? [] : treeRows($, ctx, d, depth + 1, repo, origin)),
      ]
    }),
    ...node.files.map(c => {
      const selected = !!file && file.dir === repo.dir && file.path === c.path
      return (
        <Box key={`file/${repo.dir}/${c.path}`} alignSelf="flex-start" marginLeft={depth * 2} backgroundColor={selected ? colors.selected : undefined}>
          {/* Outside the Button: a Button label ignores the Text colors inside it. */}
          <Text bold color={statusColor(c.code)}>{(c.code.trim() || 'M').padEnd(2)}</Text>
          <Button key={`open/${repo.dir}/${c.path}`} plain onPress={() => openFile($, repo, c, origin)}>
            {c.path.split('/').pop() ?? c.path}
          </Button>
          {c.added > 0 && <Text color={colors.linesAdded}> +{c.added}</Text>}
          {c.removed > 0 && <Text color={colors.linesRemoved}> -{c.removed}</Text>}
        </Box>
      )
    }),
  ]
}

// A focused section: its repos with their changed files as a tree, the open file's diff beside it.
export function focusBody($: any, ctx: Ctx, id: string, all: RepoInfo[], only: string | null = null) {
  const { Box, Text, Button, closed, file, showClean, toggle } = ctx
  // Narrowed to one repo, only that one, changed or not; else every repo, or only the changed ones.
  const narrowed = all.find(r => r.name === only)
  const repos = narrowed ? [narrowed] : showClean ? all : all.filter(r => r.changes.length > 0)
  const origin = id === ROOT ? 'Repos' : id
  return (
    <Box key={`body-${id}`} width="100%" marginTop={1}>
      <Box width={36} flexShrink={0} flexDirection="column" paddingRight={1}>
        {repos.length === 0 && <Text dimColor>no changes</Text>}
        {repos.flatMap((repo, index) => {
          const key = `${id}/${repo.name}`
          const isClosed = closed.includes(key)
          return [
            <Box key={`repo/${key}`} marginTop={index > 0 ? 1 : 0}>
              <Button key={`fold/${key}`} plain onPress={() => toggle(key)}>
                {`${isClosed ? '▸' : '▾'} ${toBold(repo.name)}`}
              </Button>
            </Box>,
            <Box key={`info/${key}`} marginLeft={2}>
              <Text dimColor wrap="truncate-end">{repo.branch}</Text>
              <Text dimColor> · </Text>
              {syncLabel(ctx, repo)}
              <Text dimColor> · </Text>
              <Text color={repo.changes.length > 0 ? colors.changed : undefined} dimColor={repo.changes.length === 0}>{repo.changes.length} changed</Text>
            </Box>,
            ...(isClosed ? [] : treeRows($, ctx, buildTree(repo.changes, key), 1, repo, origin)),
          ]
        })}
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column" paddingLeft={1}>
        {file ? diffPanel($, ctx, file) : <Text dimColor>Select a file to see its diff.</Text>}
      </Box>
    </Box>
  )
}
