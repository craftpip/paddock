# Sharing on the Web

Some helpers come with a built-in web page — a control screen, a chat view, or an API. The **Web & Ports** tab puts it on your network so you can open it in a browser.

## Publish in 3 steps

1. Open your PAD and go to the **Web & Ports** tab.
2. Fill in the port fields (the defaults are usually right) and set a password if the page asks for one.
3. Click **Publish**. Paddock restarts the box with the page switched on and shows you the link.

To take it down again, come back and click **Unpublish**.

## SSH and extra ports

The same tab can expose SSH (so you can log into the box with a terminal app) and map extra ports for other services. Each mapping is just "this port out there → that port in here".

## If the link doesn't open

- Make sure the PAD is **running** first.
- Check the password — some consoles need the exact token from the tab.
- If you changed networks recently, unpublish and publish again.

## See Also

- [Your PADs](agents.md) — tabs and lifecycle
- [Technical detail: Web & Ports](/reference/tabs/web) — publish flow, boot hooks, and the socat door, for readers who want depth
