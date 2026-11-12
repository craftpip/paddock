# Runner Prompt Templates

Every message an infinite runner types into its worker's conversation is rendered from an editable
template. This page covers the template kinds, the variable catalogue, the engine's rules, storage,
the preview routes and how a rendered prompt reaches the terminal. Runner scheduling and delivery
are in [Mission Queue and Runner](mission-queue.md).

> Last updated: 2026-11-12

## Template Kinds

`src/services/prompt-templates.js` holds the engine and the five shipped defaults.
`src/services/mission/runner-prompts.js` binds them to runners.

| Key | Sent when |
|---|---|
| `start` | Run on a paused, held or complete runner |
| `resume` | Run after a `current_task` pause; `current_plan` is the paused plan |
| `continue` | The watcher dispatches the next plan or a nudge |
| `recovery` | The worker pane died and the runner restarts it in the same conversation |
| `pause` | Pause current task asks the worker to checkpoint and stop |

`resume` is a full template, not a suffix appended to `start`: what is sent is exactly what the
user saved. A blocker answer is not a template; Resolve sends `Resolution for "<plan>": <answer>`.

## Variables

Templates use `{{ name }}` only. Paths are the worker's own (container) paths from the project's
path resolver, never host paths.

| Variable | Value | Required |
|---|---|---|
| `runner_name` | Runner name | yes |
| `project_name` | Mission project name | yes |
| `project_path` | Project folder | yes |
| `plans_path` | Plans folder | yes |
| `queue_path` | The runner's queue file | yes |
| `index_path` | `INDEX.md` in the plans folder | yes |
| `paused_path` | `QUEUE.paused` in the plans folder | yes |
| `current_plan` | Plan of the first in-progress item | yes, where referenced |
| `current_item_status` | Status word of that item | no (empty string) |
| `blocker_reason` | Reason of the first need-input item | no (empty string) |

A required variable that has no value at dispatch fails with `prompt_missing_context` and nothing
is sent; it is never rendered as an empty hole or `undefined`. An optional one renders as an empty
string.

## Engine Rules

The engine is a single-pass parser with an allowlisted token walk. No dependency is used, and
nothing is evaluated.

- `{{ name }}` with optional inner spaces; a name may repeat.
- Unknown variables, an unclosed `{{`, and Mustache sections, partials, comments, triple braces
  and delimiter changes (`#`, `^`, `/`, `>`, `!`, `=`, `&`, `{`) are rejected with the line and
  column.
- A lone `{` or `}` and a stray `}}` are literal text, so JSON inside a prompt survives.
- Output is plain text: `&`, quotes and `<` pass through unescaped.
- A substituted value is never re-scanned, so a value containing `{{x}}` renders literally.
- Limits (UTF-8 bytes): 16 KiB per source, 16 KiB per rendered prompt, 80 KiB for the whole set.
  An empty or whitespace-only template is rejected.

## Persistence and API

`infinite_runners.prompt_templates_json` holds a custom set. `NULL` means the shipped defaults, and
the migration never rewrites existing rows. Stored JSON that fails to parse or validate is an
explicit error (`prompt_templates_corrupt` or the validator's code), never a silent fallback to
the defaults.

`PATCH /api/mission/runners/:id` takes `promptTemplates`:

| Value | Effect |
|---|---|
| omitted | Keep the saved set |
| `null` | Reset to the shipped defaults |
| object | Replace; must have exactly the five keys, each a valid string |

Rejections are field-specific 400s: `prompt_unknown_key`, `prompt_missing_key`,
`prompt_not_string`, `prompt_unknown_variable` and the parser codes. Create validates the set
before any session is minted, so a bad set leaves no runner behind.

Runner responses carry the effective `promptTemplates`, `promptTemplateVersion` (SHA-256 of the
set), `promptTemplatesCustom` and `promptTemplatesError`.

| Route | Purpose |
|---|---|
| `GET /api/mission/runners/:id/prompts` | Keys, catalogue, limits, defaults, effective set, version |
| `POST /api/mission/runners/:id/prompts/preview` | Validate and render drafts against the runner's real context |
| `GET /api/mission/projects/:id/prompts` | Catalogue and defaults for the create dialog (no runner yet) |
| `POST /api/mission/projects/:id/prompts/preview` | Preview for a runner that does not exist yet |

Preview persists nothing, sends nothing and starts nothing. It returns `rendered` (the exact
submitted text), `errors` (per key, with line and column), `normalizedKeys` (kinds whose text the
one-line normalization changed) and `contextSources`, which labels each variable `real`, `sample`
(a caller override) or `empty`. A queue read failure degrades the item variables to empty; the
paths still preview.

Saving templates never dispatches. A running runner uses the new set at its next eligible send.

## Rendering a Dispatch

`renderRunnerPrompt` is the only producer of runner-to-worker text:

1. Load the effective set. A corrupt set refuses with `runner_prompts_misconfigured`, naming
   Configure → Prompts as the repair. Run checks this before the idle gate, so an idle worker is
   not blamed with `runner_worker_not_idle`.
2. Render the kind against fresh context: real paths, plus the current and blocked items from the
   canonical queue.
3. Append the queue's custom instructions, when set, between
   `=== QUEUE CUSTOM INSTRUCTIONS ===` and `=== END QUEUE CUSTOM INSTRUCTIONS ===`. The text is
   inserted literally, never interpolated.
4. Append the queue protocol, which is not editable: the exact `runner_id`, the item this dispatch
   owns, the two `paddock_runner_agent_queue_*` tools, and the rule that `QUEUE.md` is read-only
   output. A user who rewrites the templates cannot remove it, so an older saved set cannot send
   the worker back to editing the file.
5. Normalize to one logical line (`normalizePromptForSend`): split on line breaks, trim, drop
   blank lines, join with single spaces.

The pane submits each line with its own Enter, so multiline text would arrive as several user
messages, and none would match the receipt hash the operation recorded. The version hash travels
with the operation (`operation_prompt_hash`), so an outstanding send stays identifiable after an
edit, and an edit mid-turn can neither confirm nor duplicate it.

When the `pause` template cannot render, Pause still stops dispatch and writes the marker; only
the cooperative stop message is withheld, and the runner's reason says why.

## Setup Dialog

`RunnerDialog.jsx` is built on the reusable `SettingsDialog` shell: Settings, Prompts and
Callbacks sections, a bounded scrolling body (about 1040px wide, `90dvh` tall), focus trap and
opener restoration, and a dirty-close confirmation. `PromptTemplateEditor.jsx` is a pure
controlled editor: a monospace textarea, the variable list with insert-at-caret, server-returned
errors with line and column, the rendered preview and a per-prompt reset. It knows nothing about
runners or the API. The dialog previews the active kind after a short debounce, and Save stays
disabled while a preview is pending, stale or failing. Reset all saves an explicit `null`. The
full set is sent only when a prompt changed; otherwise the field is omitted.

## See Also

- [Mission Queue and Runner](mission-queue.md)
- [Runner Callback Scripts](runner-callbacks.md)
- [Mission page](../pages/overview.md)
