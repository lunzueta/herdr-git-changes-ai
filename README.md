# Git Changes + AI

A git panel for the Herdr app, laid out like Zed's git panel: stage files with
checkboxes, commit, amend, stash, pull and push, and browse the history as a
commit graph. The commit box can write its message with AI, from exactly what
the commit will contain.

This is a fork of [aBER0724/herdr-git-changes](https://github.com/aBER0724/herdr-git-changes)
(MIT). Its copyright notice and license are kept in `LICENSE` and `LICENSES/`.
The AI part is from [ai-commit](https://github.com/lunzueta/ai-commit) (0BSD).

## What this fork adds

- A sparkles button beside Commit: writes the subject and a short body from the
  staged diff (or every tracked change, for `commit -a`), and fills the box.
- A model button: the agents you already have (Claude Code, Pi, Codex, Gemini,
  Copilot), or the providers in `settings.json` under `"ai"`.
- The AI work is in `mods/git-changes-ai/ai.js`; the panel calls it from `panel.js`.
- The mod's folder is `git-changes-ai`, so it does not clash with the original.

## Install

Copy `mods/git-changes-ai/` into `~/.config/herdr-app/mods/`, then point a
layout's `changes` block at it:

```json
{ "id": "changes", "type": "block", "content": { "mod": "git-changes-ai" } }
```

Settings for the AI part are in `settings.json`, as in ai-commit. With no `"ai"`
section it uses the agents installed on the machine.

## Status

Tested on Windows: staging, commit, the AI message from the staged diff.
Not tested: stash, push, amend, history on this fork.
