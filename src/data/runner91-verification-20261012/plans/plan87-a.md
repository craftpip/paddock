# Plan 87 A - controlled pause proof

## Status: new

This is a controlled browser-test task. Print `PLAN87_A_STARTED`, wait for 90
seconds, then print `PLAN87_A_FINISHED`. Do not edit any file and do not start
another queue item. At a pause request, stop at the next safe checkpoint and
report the exact checkpoint reached.
