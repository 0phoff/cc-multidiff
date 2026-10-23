# Multidiff TODO

## Known issues
- [x] Lines don't wrap in the diff view (desktop row renderer: single spaces stay breakable; line number stays on the first wrapped row).
- [x] Lines are only shown as fully removed vs. fully added. For modified lines, highlight which part of the line changed (intra-line / word-level diff) to make changes easier to spot.

## Future work
- [ ] When viewing the diff of a file, show a collapsible tree view next to it.
- [ ] Don't list files in the main overview, only repos and their status. Clicking a root repo or a worktree opens the tree view, where files can be clicked to view their diff.
- [ ] Option to view the lines of code in between the changed hunks (expand context).
- [ ] Option to click a line or block to add feedback for the agent.

## Blocked
- [ ] Use a mono font for line numbers and text in the desktop diff view. Blocked: `Text` has no font prop, and `Code` (the only mono element) draws a code card with a copy button on desktop, with no row backgrounds or line numbers for `format="diff"`. Needs a mono/font prop on `Text` from Claude Code.
