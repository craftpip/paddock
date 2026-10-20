# Controlled runner verification queue

Work exactly one item per turn. Check QUEUE.paused before starting an item.
Read INDEX.md for the plan rules. Confine all work to this test directory.

<!-- paddock-queue:start -->
```json
{
  "version": 1,
  "items": [
    { "id": "proof-a", "plan": "a.md", "status": "done", "reason": "" },
    { "id": "proof-b", "plan": "b.md", "status": "done", "reason": "" }
  ]
}
```
<!-- paddock-queue:end -->
