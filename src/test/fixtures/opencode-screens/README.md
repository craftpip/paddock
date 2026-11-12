# opencode screens (real captures)

Captured by the live suite (`LIVE_SAVE_SCREENS=1 npm run test:live`, see
`live/opencode.live.test.js`) on `pad-dev`, opencode 1.19.5, 2026-11-13.
`test/opencode-screens.test.js` pins what each detector must say about each one.
When opencode's TUI changes, re-run the live suite with screen saving on and
copy the new captures here; a red offline test then names the detector to fix.

| File | State |
|---|---|
| ready.txt | TUI idle after launch |
| busy.txt | a turn running (`esc interrupt` in the status line) |
| plain-done.txt | idle after a reply |
| shell-after-exit.txt | the TUI exited, the pane is a bare shell |
