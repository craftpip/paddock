# Keeping Secrets

The **Vault** page stores your secrets — API keys, bot tokens, passwords — in one locked place. Values are scrambled before they are saved, so nobody reading the database can use them.

## Everyday use

1. Open the **Vault** page from the top bar. Only an admin has it.
2. The first time, set a short PIN (4 or 6 digits). Paddock asks for this PIN every time you add, change, delete, or paste a secret — there is no "stay unlocked" mode, on purpose.
3. Click **Add**, give the secret a name, paste the value, enter your PIN. Done.
4. To use a secret in an agent, pick it from the **Vault dropdown** in the Commands tab — it pastes straight into the terminal without ever showing on screen.

## Rules that keep you safe

- Never paste a secret into chat or a config file you share.
- **Change PIN** keeps all your secrets. It asks for your current PIN and your login password, then the new PIN.
- If you forget the PIN, open **Change PIN** and click **Forgot the PIN?**. That path erases every secret (they can't be recovered without the PIN) and starts again with a new one. The page warns you loudly first and asks for your login password.
- Five wrong PINs in a row make you wait before you can try again: 30 seconds at first, longer each time it happens.
- Losing the PIN means losing the secrets. Write it down somewhere safe.

## See Also

- [Getting started](getting-started.md) — where secrets fit in
- [Technical detail: Vault](/reference/backend/vault) — encryption and API routes, for readers who want depth
