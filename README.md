# MultiDiff
A Claude Code plugin that shows the changes of a multi-repo project in a pane next to the chat.
It lists every (nested) repository and allows to see local changes, changes against the default branch or against a chosen branch.
It also has a dedicated feature to show worktrees, explained in the [usage section](###).

## Installing
Run the following command in your claude code chat to install the plugin:
```
/plugin install multi-diff --marketplace 0phoff/cc-multidiff
```

## Usage
Run `/multidiff` to open the pane, and again to close it. You can also pin it per folder so it adds a button above the prompt.

### Overview
- One banner for the root repos and one per worktree, each with its number of changed files.
- Under a banner, one row per repo: name, branch, ↑ahead ↓behind and the changed file count.
- Click a **banner** to open the tree of all changed files of that section.
- Click a **repo name** to open the tree of only that repo.
- `←` in the toolbar goes back to the overview.

### Toolbar
| Button | Action |
| --- | --- |
| `←` | Back to the overview |
| `↻` | Refresh now |
| `✕` | Kill: reset all state and close the pane |
| `ⓥ` / `ⓩ` | Open the folder in VS Code / Zed (needs `code` / `zed` on the PATH) |
| selector | What to diff against: local changes, the default branch, or a branch of your choice |
| `⋮` | Various settings for the plugin which are remembered |

#### Worktrees
This plugin has a dedicated feature to show worktrees.
The intended scenario is to have a folder `worktrees/` with one folder per feature/bugfix, each containing a worktree folder of the various repos you are working on.
The plugin will detect these worktrees and show them in the overview, with their changed files in the tree.

### Tree and diff
- The changed files of a repo are shown as a tree. Click a folder to fold it, a file to see its diff on the right.
- The diff shows line numbers, the changed words inside edited lines, and moved lines in their own color.
- The arrows between two hunks reveal more of the surrounding lines.
- The open diff follows the files: it refreshes after each tool call of the agent and on `↻`.


## Development
See [AGENTS.md](AGENTS.md) for how the code is organised and for the rules that keep the plugin loading. Check every change with:

```
claude plugin validate .
```
