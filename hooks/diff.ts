import { NBSP } from './util'

// The diff is read as git prints it (three lines of context) and drawn as the
// built-in /diff draws it: one `Code` block a hunk, with line numbers and colours.
// `moved[i]` is true when `lines[i]` is a line git reports as moved, not added or removed.
export type Hunk = { oldStart: number; newStart: number; lines: string[]; moved: boolean[] }

// A `Code` source holds at most 10000 characters; leave room for the header.
export const MAX_SOURCE_CHARS = 9000

// Controls, format and invisible characters are dropped (tabs stay), so nothing
// can reorder or hide a line.
export const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
export const clean = (line: string) => line[0] + line.slice(1).replace(UNSAFE, '')

export const parseHunks = (text: string, moved: number[] = []): Hunk[] => {
  const hunks: Hunk[] = []
  const movedAt = new Set(moved)
  text.split('\n').forEach((line, index) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
    if (m) hunks.push({ oldStart: Number(m[1]), newStart: Number(m[2]), lines: [], moved: [] })
    else if (hunks.length && (line[0] === ' ' || line[0] === '+' || line[0] === '-')) {
      hunks.at(-1)!.lines.push(clean(line))
      hunks.at(-1)!.moved.push(movedAt.has(index))
    }
  })
  return hunks
}

// A hunk as unified-diff text, its header counted off its lines so a split hunk still parses.
// A side with no lines names the line before its start, as git writes it.
export const hunkSource = ({ oldStart, newStart, lines }: Hunk): string => {
  const oc = lines.filter(l => l[0] !== '+').length
  const nc = lines.filter(l => l[0] !== '-').length
  const o = oc === 0 ? Math.max(0, oldStart - 1) : oldStart
  const n = nc === 0 ? Math.max(0, newStart - 1) : newStart
  return [`@@ -${o},${oc} +${n},${nc} @@`, ...lines].join('\n')
}

// The sources to draw: a hunk too long for one `Code` block is split in several.
export const sourcesOf = (text: string): string[] =>
  parseHunks(text).flatMap(hunk => {
    const parts: string[] = []
    let { oldStart, newStart } = hunk
    let lines: string[] = []
    let chars = 0
    const flush = () => {
      if (!lines.length) return
      parts.push(hunkSource({ oldStart, newStart, lines }))
      oldStart += lines.filter(l => l[0] !== '+').length
      newStart += lines.filter(l => l[0] !== '-').length
      lines = []
      chars = 0
    }
    for (const line of hunk.lines) {
      if (chars + line.length + 1 > MAX_SOURCE_CHARS) flush()
      lines.push(line.slice(0, MAX_SOURCE_CHARS))
      chars += line.length + 1
    }
    flush()
    return parts
  })

// Surfaces that do not draw a `Code` diff themselves get the rows drawn here: a gutter
// numbered from the hunk's header, the marker, add and remove colours.
// Plain spaces are collapsed by the surface, so indentation and space runs are non-breaking.
// Line numbers are right-aligned in a column this many characters wide (the surface's
// text is not monospace, so the width comes from a Box, not from padding), so every hunk lines up.
export const GUTTER = 4
export type Part = { text: string; changed: boolean }
export type DiffRow = { marker: ' ' | '+' | '-'; number: number; moved: boolean; parts: Part[] }

// Words, runs of spaces and single symbols: the units a changed line is compared in.
export const tokenize = (text: string) => text.match(/\s+|\w+|[^\w\s]/g) ?? []

// Which tokens of each side are not part of the longest common run of tokens.
// A line too long to compare token by token only gets its common start and end kept.
export const MAX_CELLS = 40000
export const changedTokens = (a: string[], b: string[]): [boolean[], boolean[]] => {
  const ca = a.map(() => true)
  const cb = b.map(() => true)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++
  for (let i = 0; i < head; i++) ca[i] = cb[i] = false
  for (let i = 1; i <= tail; i++) {
    ca[a.length - i] = false
    cb[b.length - i] = false
  }
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  if (x.length && y.length && x.length * y.length <= MAX_CELLS) {
    const w = y.length + 1
    const len = new Uint16Array((x.length + 1) * w)
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        ca[head + i] = cb[head + j] = false
        i++
        j++
      } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++
      else j++
    }
  }
  return [ca, cb]
}

// A line split into runs that are changed or not, from its tokens' flags. Nothing is
// marked when no word is shared: the whole line is then just a different line.
export const partsOf = (tokens: string[], changed: boolean[], other: string[], otherChanged: boolean[]): Part[] => {
  const shared = (list: string[], flags: boolean[]) => list.some((t, i) => !flags[i] && /\S/.test(t))
  if (!shared(tokens, changed) || !shared(other, otherChanged)) return [{ text: tokens.join(''), changed: false }]
  const parts: Part[] = []
  tokens.forEach((token, i) => {
    const last = parts.at(-1)
    if (last && last.changed === changed[i]) last.text += token
    else parts.push({ text: token, changed: changed[i] })
  })
  return parts
}

// Only indentation and runs of spaces are non-breaking: a lone space stays a plain
// one, so the surface can break the line there. Same length, so parts are cut from it after.
export const keepSpaces = (text: string) => text.replace(/^ +| {2,}/g, run => NBSP.repeat(run.length))

export const rowsOf = (hunk: Hunk, words: boolean, showMoved: boolean): DiffRow[] => {
  let o = hunk.oldStart
  let n = hunk.newStart
  const rows = hunk.lines.map((line, index) => {
    const marker = line[0] as DiffRow['marker']
    const raw = line.slice(1).replace(/\t/g, '    ')
    const number = marker === '-' ? o : n
    if (marker !== '+') o++
    if (marker !== '-') n++
    return { marker, number, raw, moved: showMoved && hunk.moved[index], parts: [{ text: raw, changed: false }] as Part[] }
  })
  // A run of removed lines right before a run of added ones: line i of one is the
  // edit of line i of the other, so the part that differs is marked.
  for (let i = 0; i < rows.length; ) {
    if (rows[i].marker !== '-') {
      i++
      continue
    }
    let mid = i
    while (mid < rows.length && rows[mid].marker === '-') mid++
    let end = mid
    while (end < rows.length && rows[end].marker === '+') end++
    for (let k = 0; k < Math.min(mid - i, end - mid); k++) {
      const del = rows[i + k]
      const add = rows[mid + k]
      // A moved line is the same line somewhere else: nothing inside it changed.
      if (del.moved || add.moved || !words) continue
      const a = tokenize(del.raw)
      const b = tokenize(add.raw)
      const [ca, cb] = changedTokens(a, b)
      del.parts = partsOf(a, ca, b, cb)
      add.parts = partsOf(b, cb, a, ca)
    }
    i = end
  }
  return rows.map(({ marker, number, moved, raw, parts }) => {
    const kept = keepSpaces(raw)
    let at = 0
    return {
      marker,
      number,
      moved,
      parts: parts.map(part => ({ changed: part.changed, text: kept.slice(at, (at += part.text.length)) })),
    }
  })
}

// The lines of the new side a hunk shows: its context and added lines.
export const newRange = (hunk: Hunk) => {
  const count = hunk.lines.filter(l => l[0] !== '-').length
  const first = count > 0 ? hunk.newStart : hunk.newStart + 1
  return { first, last: first + count - 1 }
}
