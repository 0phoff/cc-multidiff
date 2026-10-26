import type { Tints } from '../colors'
import type { FileView } from '../../types'
import type { ExpandedMap } from '../state'

// What the drawing functions share: the surface's elements and the values read once per draw.
export type Ctx = {
  e: any
  Box: any
  Text: any
  Button: any
  Code: any
  Select: any
  tints: Tints
  words: boolean
  showClean: boolean
  showMoved: boolean
  file: FileView | null
  closed: string[]
  grown: ExpandedMap
  morePages: Record<string, number>
  fileLines: string[] | null
  toggle: (key: string) => unknown
}
