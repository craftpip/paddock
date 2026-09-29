# Plans

One markdown file per piece of work. This folder is the durable record; a
conversation is not — a session ends, a plan does not.

## Writing one

Use `plan_write {agent, path, content, session?}`:

The folder is created on the first plan, and only then.

- `path` is a file name relative to this folder, e.g. `64-plans-facility.md`. A
  number prefix keeps the folder readable in order; it is not enforced.
- `content` is the body. Frontmatter is managed for you: `created` is stamped on
  the first write and never moves, `last_activity` moves on every write, and `session` / `started` are
  stamped when you pass a session id.
- `session` is the agent's own conversation id, so the plan can be joined to that
  conversation later with `plan_activity {agent, session_id}`.

## Keeping one honest

- The body carries a `## Status:` line using this repo's vocabulary: `Complete`, `In progress`, `Proposed`, `Blocked`, `Draft`.
- Update the plan when the work moves, not at the end. A plan written once and
  never touched is a note.
- One plan is one piece of work. If it needs an "and also", it is two plans.

## Ending one

Rewrite it with its final state, then move the file into `archive/`. Read the
ended ones with `plan_list {agent, archive: true}`; an archive that still turns up in
the working list is a plan nobody closed.
