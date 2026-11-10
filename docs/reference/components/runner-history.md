# Runner History

The Mission runner panel provides Queue and History views over the same runner.
History is a durable event journal of observed plan, input, control, quota, and
recovery transitions; it does not reconstruct pre-installation activity.

## Layout and Navigation

The runner state, current scheduler status, and current plan remain above the
Queue/History tabs. Tab selection is stored in `runnerTab=history` and does not
change the selected Mission session or remount its terminal. The history view is
the full runner-panel body when expanded; when the queue panel is collapsed,
history appears in a bounded-height scroll area above the terminal. At widths up
to 640px, History overlays the narrow Mission columns so timeline text remains
readable while the terminal stays mounted underneath.

History is newest-first and grouped by local calendar date. Its filters are All
activity, Plans, Input, Recovery, and Problems. Recovery/callback events sharing
an attempt id are grouped into an expandable row. Callback output is loaded only
on request from a runner-scoped endpoint. The output is owner-script text and is
presented separately from timeline metadata.

When new events arrive while the timeline is scrolled away from the top, the view
preserves its scroll position and offers a count of new updates. Older activity
uses cursor pagination. Empty history distinguishes “no events yet” from earlier
activity that was not recorded. Failed reads show a retry action and keep the last
successful page visible.

## Event Journal

`runner_history` records transitions independently of whether lifecycle callback
scripts are enabled. Events have a runner/session identity, type, category,
severity, actor, timestamp, optional group id, and deduplication key. Event details
are restricted to bounded metadata such as plan path, item id, reason, error code,
exit code, and character count; answer text, transcript content, terminal dumps,
and callback source are not copied into the journal.

The first observation adds a dated baseline. It explicitly says earlier activity
is not reconstructed. Plan transitions are emitted from observed queue changes;
start-plus-complete between polls is represented only by the completion that was
observed. Recovery groups preserve ordering across callback start/result, verified
container recreation, session restoration, continuation send/receipt, and final
queue outcome. An unconfirmed delivery is a distinct state; it is never displayed
as accepted or automatically resent.

`GET /api/mission/runners/:id/history` reads one authorized runner, filtered and
cursor-paged. `GET /api/mission/runners/:id/history/output/:eventId` returns a
single authorized callback's captured output. Both routes use the existing
runner permission resolver.

## See Also

- [Mission page](../pages/overview.md)
- [Backend services](../backend/services.md)
- [Paddock command](../operations/paddock-cli.md)
