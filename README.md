# multidiff

A Claude Code plugin that shows the changes of a multi-repo project in a pane next to the chat. It lists every repo in the session folder and in its `worktrees/` folder with its branch, ahead/behind counts and number of changed files, and lets you browse the diffs without leaving Claude Code.

## Usage

Run `/multidiff` to open the pane, and again to close it.

### Overview

- One banner for the root repos and one per worktree, each with its number of changed files.
- Under a banner, one row per repo: name, branch, ↑ahead ↓behind and the changed file count.
- Click a **banner** to open the tree of all changed files of that section.
- Click a **repo name** to open the tree of only that repo.
- `←` in the toolbar goes back to the overview.

### Tree and diff

- The changed files of a repo are shown as a tree. Click a folder to fold it, a file to see its diff on the right.
- The diff shows line numbers, the changed words inside edited lines, and moved lines in their own color.
- The arrows between two hunks reveal more of the surrounding lines.
- The open diff follows the files: it refreshes after each tool call of the agent and on `↻`.

### Toolbar

| Button | Action |
| --- | --- |
| `←` | Back to the overview |
| `↻` | Refresh now |
| `✕` | Kill: reset all state and close the pane |
| `ⓥ` / `ⓩ` | Open the folder in VS Code / Zed (needs `code` / `zed` on the PATH) |
| selector | What to diff against: local changes, the default branch, or a branch of your choice |
| `⋮` | Pin the button above the prompt for this folder, toggle word highlighting, toggle moved line colors |

The selector, pins and toggles are remembered across sessions.

## Installing

The plugin is a local mod. Add this repo as a marketplace and install it:

```
/plugin marketplace add <path to this folder>
/plugin install multi-diff@local-mods
```

After editing the code, run `/reload-plugins`, then start a new session to use the new code.

## Development

See [AGENTS.md](AGENTS.md) for how the code is organised and for the rules that keep the plugin loading. Check every change with:

```
claude plugin validate .
```

Open ideas and known issues are in [TODO.md](TODO.md).
