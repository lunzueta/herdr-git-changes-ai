# Git Changes + AI

A git panel for the Herdr app, laid out like Zed's git panel: stage files with
checkboxes, commit, amend, stash, pull and push, and browse the history as a
commit graph. The commit box can write its message with AI, from exactly what
the commit will contain.

This is a fork of [aBER0724/herdr-git-changes](https://github.com/aBER0724/herdr-git-changes).
It is MIT too: `LICENSE` carries the copyright notices, `LICENSES/` the licenses
of the parts that come from elsewhere, and `NOTICE` says which file each of them
covers. The AI part, `mods/git-changes-ai/ai.js`, is this fork's own code.

## What this fork adds

- A sparkles button beside Commit: writes the subject and a short body from the
  staged diff (or every tracked change, for `commit -a`), and fills the box.
- A model button: the agents you already have (Claude Code, Pi, Codex, Gemini,
  Copilot), or the providers in `settings.json` under `"ai"`.
- The AI work is in `mods/git-changes-ai/ai.js`; the panel calls it from `panel.js`.
- The mod's folder is `git-changes-ai`, so the folder does not clash with the
  original. The shared state does: both use `git-changes.pick`,
  `git-changes.view`, `git-changes.layout` and `ai-commit.selected`, so do not
  put this fork and the original in the same window.

## Install

Either copy `mods/git-changes-ai/` into `~/.config/herdr-app/mods/`, or download
`git-changes-ai-<version>.zip` from the
[releases](https://github.com/lunzueta/herdr-git-changes-ai/releases) and unzip
it there: both leave `~/.config/herdr-app/mods/git-changes-ai/`.

Then point a layout's `changes` block at it:

```json
{ "id": "changes", "type": "block", "content": { "mod": "git-changes-ai" } }
```

`herdr-app do mod.open --name git-changes-ai` opens the same panel as a floating
one, to try it before touching a layout (again closes it).

The mod ships no `keys.json`, and there is no keyboard command for the sparkles
button: it is a click. The commit box takes Enter as a new line; the Commit
button commits.

Settings for the AI part are in `~/.config/herdr-app/settings.json`. With no
`"ai"` section it asks the first agent installed on the machine, with the login
that agent already has.

## Big diffs

An agent CLI gets the prompt as **one command-line argument**, and on Windows that argument tops out
near 8,000 characters (`cmd.exe`), so a large change is cut. The mod keeps the heaviest files
first, sends the **file list** whole (name, `+a −d`), and the grey note says how much of how much
arrived — so the message can still name every file, even ones whose diff it never saw. Read it
before committing. To send everything: commit in groups, or put an API provider under `"ai"` in
`settings.json` (those get up to 60,000 characters).

## Development

```sh
npm test
```

`tests/git.test.mjs` runs the git plumbing against throwaway repositories (with a
bare remote); `tests/ui.test.mjs` renders the panel, the diff tab and the menus
under node with a stand-in for Herdr, which `herdr-app check` does not draw.
`herdr-app check mods/git-changes-ai` loads the mod once in the app.

## Status

Tested on Windows: staging, commit, the AI message from the staged diff.
The panel carries amend, stash, pull, push and history, but this fork has not
tested them on Windows; `npm test` covers their git plumbing (`git.js`,
`lanes.js`, `history.js`) and the render paths (`panel.js`, `diff.js`, `menu.js`).
