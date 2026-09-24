# The Terminal

Every agent page has a terminal docked at the bottom. It is a real shell inside your helper's box. Anything you type there runs there — and stays running even if you reload the page or switch tabs.

## The one rule

**The buttons paste, they don't hide.** When you click a button in the Commands tab, it types the command into this terminal where you can see it. Nothing runs behind your back (the Vault is the one exception — secrets stay on the server on purpose).

## Everyday use

- Click the terminal and type. `Enter` runs, `Up arrow` recalls the last command.
- Drag the handle above the terminal to make it taller. The fullscreen button gives you the whole screen.
- If the text is stuck, the session menu lets you switch to a fresh shell or kill a frozen one.
- Closing the page never kills your shell. Only stopping the PAD does.

## See Also

- [Your PADs](agents.md) — tabs and lifecycle
- [Technical detail: Terminal](/reference/tabs/terminal) — tmux sessions, PTY, and the wire protocol, for readers who want depth
