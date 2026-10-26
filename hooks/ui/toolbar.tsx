import { update } from 'claude-code'

import { colors } from '../colors'
import { openIn, VSCODE, ZED } from '../editor'
import { EDIT_BRANCH, killPlugin, MODE_LABELS, MODES, pickMode, refresh, toggleMovedColors, togglePin, toggleWordDiff } from '../state'
import type { Settings } from '../../types'
import type { Ctx } from './ctx'

// References to the plugin's state atoms, which are defined in register.tsx. The plugin loader reads
// the plugin and key off a literal in the file that reads or writes the atom, so each file spells its own.
const focus = { plugin: 'multi-diff', key: 'focus' } as const
const menuOpen = { plugin: 'multi-diff', key: 'menuOpen' } as const
const view = { plugin: 'multi-diff', key: 'view' } as const

type ToolbarProps = {
  isFocusing: boolean
  err: string | null
  cfg: Settings
  isPinned: boolean
  menuIsOpen: boolean
  // The folder the editor buttons open.
  contextPath: string
}

// The row of buttons on top, the diff selector and the three dot menu with its panel of toggles.
export function toolbar($: any, ctx: Ctx, { isFocusing, err, cfg, isPinned, menuIsOpen, contextPath }: ToolbarProps) {
  const { Box, Text, Button, Select, words, showMoved } = ctx
  return [
    <Box key="toolbar" width="100%">
      {isFocusing && (
        <Button key="back" plain onPress={async () => { await update($, view, () => null); await update($, focus, () => null) }}>
          <Text bold color={colors.accent}>← </Text>
        </Button>
      )}
      <Button key="refresh" plain onPress={() => refresh($)}>
        <Text bold color={colors.accent}>↻ </Text>
      </Button>
      <Button key="kill" plain onPress={() => killPlugin($)}>
        <Text bold color={colors.danger}>✕ </Text>
      </Button>
      <Button key="code" plain onPress={() => openIn($, VSCODE, contextPath)}>
        <Text bold color={colors.accent}>ⓥ </Text>
      </Button>
      <Button key="zed" plain onPress={() => openIn($, ZED, contextPath)}>
        <Text bold color={colors.accent}>ⓩ </Text>
      </Button>
      {err && <Text color={colors.danger}> {err}</Text>}
      <Box flexGrow={1} />
      <Select
        key="diff-mode"
        label=""
        value={cfg.mode}
        options={[
          ...MODES.map(value => ({ value, label: value === 'branch' && cfg.mode === 'branch' && cfg.branch ? `branch: ${cfg.branch}` : MODE_LABELS[value] })),
          // Picking the mode that is already set fires nothing, so editing the branch is its own entry.
          ...(cfg.mode === 'branch' ? [{ value: EDIT_BRANCH, label: 'change branch…' }] : []),
        ]}
        onSelect={v => pickMode($, cfg, v === EDIT_BRANCH ? 'branch' : (v as Settings['mode']))}
      />
      <Button key="menu" plain onPress={() => update($, menuOpen, open => !open)}>
        <Text bold color={colors.accent}>⋮</Text>
      </Button>
    </Box>,
    menuIsOpen && (
      <Box key="menu-panel" width="100%" justifyContent="flex-end" marginTop={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={colors.menuBorder} paddingX={1}>
          <Button key="menu-pin" plain onPress={() => togglePin($)}>
            {`${isPinned ? '☑' : '☐'} Pin plugin for this folder`}
          </Button>
          <Button key="menu-words" plain onPress={() => toggleWordDiff($)}>
            {`${words ? '☑' : '☐'} Highlight changed words`}
          </Button>
          <Button key="menu-moved" plain onPress={() => toggleMovedColors($)}>
            {`${showMoved ? '☑' : '☐'} Show moved lines in a different color`}
          </Button>
        </Box>
      </Box>
    ),
  ]
}
