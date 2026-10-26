import { update } from 'claude-code'

import { colors } from '../colors'
import { clean, GUTTER, keepSpaces, newRange, parseHunks, rowsOf, sourcesOf } from '../diff'
import type { DiffRow, Hunk } from '../diff'
import { openIn, VSCODE, ZED } from '../editor'
import { NBSP } from '../util'
import type { FileView } from '../../types'
import type { Ctx } from './ctx'

// References to the plugin's state atoms, which are defined in register.tsx. The plugin loader reads
// the plugin and key off a literal in the file that reads or writes the atom, so each file spells its own.
const expanded = { plugin: 'multidiff', key: 'expanded' } as const
const pages = { plugin: 'multidiff', key: 'pages' } as const

// What an arrow adds, and the most that "..." is shown for instead of the arrows.
const EXPAND = 10
const ROWS_PER_PAGE = 500
const DOTS_MAX = 15

const drawRow = ({ Box, Text, tints }: Ctx, r: DiffRow, key: string) => {
  const background = r.moved ? (r.marker === '-' ? tints.from : tints.to) : r.marker === '+' ? colors.rowAdded : r.marker === '-' ? colors.rowRemoved : undefined
  const markerColor = r.moved
    ? r.marker === '-'
      ? colors.markerMovedFrom
      : colors.markerMovedTo
    : r.marker === '+'
      ? colors.markerAdded
      : r.marker === '-'
        ? colors.markerRemoved
        : undefined
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
function drawHunks($: any, ctx: Ctx, file: FileView, hunks: Hunk[]) {
  const { Box, Text, Button, words, showMoved, grown, morePages, fileLines } = ctx
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
      out.push(drawRow(ctx, r, key))
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
                <Text bold color={colors.accent}>...</Text>
              </Button>
            ) : (
              [
                <Button key={`up-${i}`} plain onPress={() => grow(key, 0, EXPAND)}>
                  <Text bold color={colors.accent}>↑ </Text>
                </Button>,
                <Button key={`down-${i}`} plain onPress={() => grow(key, EXPAND, 0)}>
                  <Text bold color={colors.accent}>↓</Text>
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
          <Text bold color={colors.accent}>{`Show ${Math.min(skipped, ROWS_PER_PAGE)} more of ${skipped} hidden lines`}</Text>
        </Button>
      </Box>,
    )
  }
  return out
}

// The open file's diff, drawn beside the tree.
export function diffPanel($: any, ctx: Ctx, file: FileView) {
  const { e, Box, Text, Button, Code } = ctx
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
          <Text bold color={colors.accent}> ⓥ </Text>
        </Button>
        <Button key="zed-file" plain onPress={() => openIn($, ZED, filePath)}>
          <Text bold color={colors.accent}>ⓩ </Text>
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
          : drawHunks($, ctx, file, hunks)}
      </Box>
    </Box>
  )
}
