# Paddock Command

Use `paddock` inside the control-plane container or a callback script to manage PADs
and runners. It calls the same lifecycle services as Paddock; scripts do not need
internal JavaScript paths.

## Recovery Script

```bash
#!/usr/bin/env bash
set -euo pipefail

/www1/test/log-arguments.sh --rotate testing
paddock pad recreate "$PADDOCK_AGENT_NAME"

# Run any other commands here.
exit 0
```

In the runner's **Callbacks → usage_exhausted** settings, enable the script and
**Resume queue after recovery script succeeds**. The script controls rotation and
recreation. Paddock restores the saved conversation after exit `0`, verifies the
continuation's exact input receipt, and enables supervision. Exit `75` holds the
queue; errors and timeouts stop recovery. An unchanged container is not considered
a successful recreation. Saving the script does not run it.

Automatic detection runs the callback once per exhaustion episode. Pressing **Run
queue** while stopped for quota explicitly requests another recovery attempt;
concurrent clicks reuse the in-flight attempt. This does not reset automatic
episode deduplication. If the script leaves quota exhausted, dispatch stops again
rather than repeatedly rotating or recreating in a loop.

Instruction receipt matching ignores OpenCode's trailing paste separator whitespace.
A late matching receipt can settle an unconfirmed recovery without repeating the
script or the continuation. A fresh quota notice still withholds dispatch.

`PADDOCK_AGENT_NAME` and `PADDOCK_RUNNER_ID` are supplied by the callback environment.
Use explicit names when running commands outside callbacks.

## Commands

```bash
paddock --help
paddock pad list
paddock pad status pad-opencode-proj
paddock pad start pad-opencode-proj
paddock pad stop pad-opencode-proj
paddock pad restart pad-opencode-proj
paddock pad recreate pad-opencode-proj

paddock runner status run_example
paddock runner pause run_example
paddock runner resume run_example
```

PAD commands accept the container name, exact bare name, or unambiguous display
name. Unknown names and ambiguous display names fail before performing an action.
Runner commands require the exact runner id.

Recreate preserves data and includes managed forwarding doors. It ends terminal
processes on that PAD. The command itself does not restore conversations: quota
recovery handles its saved session after the script succeeds. Runner resume is an
explicit instruction to start work; a recovery script normally leaves this to its
exit result rather than issuing a second resume.

## Results and Exit Codes

```bash
paddock pad status "$PADDOCK_AGENT_NAME" --json
```

`--json` writes one JSON result to stdout. Progress and failures go to stderr.
Exit `0` means success, `1` means an operation failed, and `2` means invalid usage.
With `set -e`, a failed lifecycle command stops the script before it can report
successful recovery.

The CLI is installed by the control-plane image. Callback PATH includes `/app/bin`
so source-mounted installations also resolve it. It uses the control plane's local
permissions and Docker socket; it is not a remotely authenticated client.

## See Also

- [Backend services](../backend/services.md)
- [Operations overview](overview.md)
