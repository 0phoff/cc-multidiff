# Multidiff plugin: notes for agents

## Validate every change

If the engine refuses the module, `/multidiff` silently does not exist: no error in the session, and `/reload-plugins` still says "re-read". Sessions that were already open keep the old code and seem fine.

```bash
claude plugin validate /Users/too7qfn/Documents/code/cc-mods/cc-multidiff
```

Run it after every change to `hooks/`. A refusal shows as `✘ Found 1 error` mentioning `modules../register.tsx`; the README/LICENSE/icon complaints can be ignored. esbuild and type-checks do not catch these.

## Rules for `$` (the plugin context)

`$` is analysed statically:

- **Past an import, `$` is only followed into a `function` declaration** (`function foo($, ...)`, `export async function foo($, ...)`). Never into `export const foo = ($, ...) => ...`; that is why `repoRow` once broke the plugin.
- **Write `$` as `$.noun.event(...)` at call sites** and `on` as `on('<event>', hook)`. Don't alias or destructure them.

So UI functions that need `$` (`section`, `repoRow`, `toolbar`, `focusBody`) take it first and are `function` declarations. Action logic lives in `state.ts` as `export async function`s that the UI calls with `$`. UI state needing no `$` can go through `Ctx` (`ui/ctx.ts`), like `toggle`.

## State atoms

- Each file that reads or writes a value spells its own `{ plugin: 'multidiff', key: '...' } as const` literal.
- The atom is defined once, with its starting value, in `register.tsx`.
- A new value also needs its type in `types/index.d.ts` and a reset in `killPlugin` (`state.ts`).
- Render code only reads; writes go in handlers.

## Working on it

- `/reload-plugins` reads this folder, uncommitted edits included. Check in a new session; open ones keep the old code.
- No TypeScript compiler here, so types are unchecked.
- If loading breaks and the validator is silent, bisect with `git stash`.
