# Multidiff TODO

## Known issues
- [x] Lines don't wrap in the diff view (desktop row renderer: single spaces stay breakable; line number stays on the first wrapped row).
- [x] Lines are only shown as fully removed vs. fully added. For modified lines, highlight which part of the line changed (intra-line / word-level diff) to make changes easier to spot.

## New Features
- [x] When viewing the diff of a file, show a collapsible tree view next to it.
- [x] Don't list files in the main overview, only repos and their status. Clicking a root repo or a worktree opens the tree view, where files can be clicked to view their diff.
- [x] Option to view the lines of code in between the changed hunks (expand context).
- [ ] Option to click a line or block to add feedback for the agent.
- [ ] Sliding window for long diffs. Today "Show N more" only grows the drawn rows (500 per press, nothing is hidden at the top), so a huge diff ends up as heavy as the one that used to hang the pane. Idea: draw at most ~500 rows; the bottom button moves the window down by ~100 (dropping the top 100) and a matching button at the top moves it back up. Open questions: step size (100 vs larger), whether windows start mid-hunk or at hunk boundaries, and whether this is wanted at all.

## Blocked
- [ ] Use a mono font for line numbers and text in the desktop diff view. Blocked: `Text` has no font prop, and `Code` (the only mono element) draws a code card with a copy button on desktop, with no row backgrounds or line numbers for `format="diff"`. Needs a mono/font prop on `Text` from Claude Code.
