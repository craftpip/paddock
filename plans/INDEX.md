# Plans

One markdown file per piece of work. This folder is the durable record; a
conversation is not — a session ends, a plan does not.

## Who we are

- Project: paddock
- PAD: pad-opencode-proj (opencode)
- Project folder: /www2/paddock
- Plans folder: /www2/paddock/plans

## Writing one

Use `plan_write {agent, project_id, path, content, session?}`:

The folder is created on the first plan, and only then.

- `path` is a file name relative to this folder, e.g. `64-plans-facility.md`. A
  number prefix keeps the folder readable in order; it is not enforced.
- `content` is the body. Frontmatter is managed for you: `created` is stamped on
  the first write and never moves, `last_activity` moves on every write, and `session` / `started` are
  stamped when you pass a session id.
- `session` is the agent's own conversation id, so the plan can be joined to that
  conversation later with `plan_activity {agent, session_id}`.

## Statuses

The body's `## Status:` line carries one of five lifecycle states, and they are
the only five:

- `new` — recently added; pick it up in queue order.
- `in progress` — being worked; keep going.
- `blocked` — needs intervention. **STOP**: do not proceed to the next
  queue item.
- `need clarification` — a question must be asked or sorted. Surface it
  and wait.
- `done` — the task is done; move it to review/next.

Update the status when the work moves, not at the end. A plan written once and
never touched is a note. `blocked` and `need clarification` are stop states — record the
reason and stop.

## The queue

Execution order, parser format and the runner's instructions live in
`QUEUE.md` in this folder when it exists. A plan that is `blocked` or needs
clarification must be reflected there as `need input` with its reason. Do not keep
a second queue here.

## Ending one

Rewrite it with its final state, then move the file into `archive/`. Read the
ended ones with `plan_list {agent, project_id, archive: true}`; an archive that still
turns up in the working list is a plan nobody closed.
