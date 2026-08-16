# CLAUDE.md

## The backlog lives outside the repository

The product backlog is an Obsidian note:

```
/Users/mowmow/Documents/Frulko/Projets/Jukebox/Todo.md
```

It is the source of truth for what to build next. `TODO.md` at the root of this
repository is the *technical* plan and is a different list; neither replaces the
other.

### Scope

**Only the lines ending in `- front` are in scope.** Everything else in that file
belongs to someone else, or to later — do not start it, do not tick it, do not
"helpfully" do it along the way. If a `- front` item cannot be done without a
change elsewhere (server, SDK, satellite), make that change as small as the front
item needs and say so in the commit.

### Reading an item

A todo owns everything written under it until the next `- [ ]` line: screenshots,
notes, pasted errors, a second paragraph. That content is part of the item, not
of the file. An image under an item is usually the bug report itself — look at it
before deciding what the item means.

### Closing an item

When the work is committed, edit the note in place:

```markdown
- [x] problème d'affichage des lignes, padding bizarre - front
  **Fait** — one or two sentences on what the cause actually was and what
  changed. Not a restatement of the title. `243167e`
```

Three parts, always: the box ticked, the explanation, the commit id. The
explanation is for the person reading the backlog in three months, so it says
the *cause*, not the symptom that was already in the title. If several commits
were needed, list them all. If an item turns out to be already fixed, or wrong,
say that instead of ticking it silently.

Never tick an item that has not been verified running — a passing build is not a
verified item.

## Working alongside another session

More than one Claude session works in this checkout at a time. Two rules follow:

- `git add` explicit paths, never `-A`, never `.`. Commit only files you changed.
- Before editing a file that belongs to another session's current task, check
  `git status` and tell them (`ListAgents` → `SendMessage`). Append to the end of
  a shared file rather than editing through the middle of it when you can.
