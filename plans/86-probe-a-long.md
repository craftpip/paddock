# 86-probe-a-long

PROBE ONLY — do exactly this and nothing else.

1. Run this shell command exactly and wait for it to finish:
   `for i in $(seq 1 18); do echo "probe tick $i"; sleep 10; done`
2. Then edit the queue file (`QUEUE.md`) to change THIS item's status from
   `in progress` to `done`.
3. Do NOT start any other item. Stop and wait.

Reply only with: `PROBE_A_DONE`
