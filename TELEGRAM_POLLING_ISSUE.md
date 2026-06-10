# Telegram Polling Conflict Issue

## Symptom

Telegram bot `@Jakepaul6353_bot` intermittently stops responding. User gets a "Conflict" error in chat. The bot auto-restarts within ~5-10 seconds but the user's message may be lost or fail during that window.

## Log Signature

```
[telegram] [default] channel exited: Conflict: terminated by other getUpdates request;
make sure that only one bot instance is running | Telegram ingress worker exited with code 1
```

Occurs every ~20-30 minutes, alternating between containers.

## Root Cause

**Both `vm-ozden` and `vm-ozden2` are configured with the same Telegram bot token** (`@Jakepaul6353_bot`). Telegram only allows one long-polling `getUpdates` connection per bot token at a time. When both containers poll simultaneously, one gets disconnected with the Conflict error.

Evidence:
- Both containers have a Telegram config directory under `instances/<vm>/openclaw/telegram/`
- Both have the same `command-hash-default-d1e9145b716bee55.txt` (same bot identity)
- `vm-ozden2` log at `18:01:45` — channel exited (stale-socket)
- `vm-ozden` log at `18:01:53` — channel exited (Conflict)

## Cascading Error (June 9, 2026 — 18:01-18:02)

At 18:01:45, `vm-ozden2`'s Telegram channel died (stale-socket → exit, auto-restart). While restarting, vm-ozden2 received an inbound message at 18:01:53. **vm-ozden2's OpenAI Codex OAuth token was expired**, causing all model fallback attempts to fail:

```
OAuth token refresh failed for openai-codex: OpenAI Codex token refresh failed (401):
token_expired
```

All 4 model candidates failed (gpt-5.5 → gpt-5.3-codex → gpt-5.2-codex → gpt-5.2), resulting in:

```
Embedded agent failed before reply: All models failed (4)
```

The user saw an error in chat because the message landed on the instance with stale auth credentials.

Chain of failure:
1. Telegram polling conflict kills connection
2. Message routes to the wrong container on reconnect
3. That container's OpenAI Codex token is expired → all models fail
4. User sees generic error

## GitHub Issue #89954 (Primary Tracking Issue)

**URL:** https://github.com/openclaw/openclaw/issues/89954
**Title:** *"Telegram getUpdates 409 cascade after IPv6→IPv4 transport fallback; rebuild loop self-perpetuates without canceling in-flight long-polls"*
**Filed:** Jun 3, 2026 by `serguninin-ai`
**Version observed:** OpenClaw 2026.4.24
**Severity:** High

### Summary

When the host network has degraded IPv6 (DNS returns AAAA records but routing fails — common with Tailscale/MagicDNS), every Telegram API request triggers fetch fallback. The sticky-IPv4 fallback is applied per-connection, not persistently — so each subsequent `getUpdates` retries IPv6 first. This creates a self-perpetuating loop:

1. `getUpdates` (long-poll) opens TCP via IPv6 → fails (EHOSTUNREACH).
2. OpenClaw enables sticky IPv4 for that fetch → opens new TCP via IPv4 → request goes through, but Telegram cloud still has the stale IPv6 long-poll registered as the "active" client (~30s TTL).
3. New `getUpdates` arrives → Telegram returns 409 Conflict.
4. OpenClaw logs `closing stale transport before rebuild` and `rebuilding transport for next polling cycle` — but the rebuild starts a new long-poll before the old one's TCP cleanup completes.
5. Loop repeats indefinitely. Backoff caps at 30s, same as Telegram's stale-poll TTL → no natural escape.

### Workaround Applied in Production (2026.6.1)

OpenClaw 2026.6.1 includes several sticky IPv4 patches that mitigate but don't fully fix the issue:

| Fix | PR/Issue |
|-----|----------|
| Reuse sticky IPv4 for `getMe` health checks | #76856 |
| Preserve sticky IPv4 across polling restarts | #48282 |
| Unified sticky IPv4 and pinned-IP fallback chain | #49148 |
| Inherit DNS result order; downgrade sticky IPv4 debug logs | #75904 |
| `deleteWebhook` IPv6 stalls; sticky fallback | #73255 |
| Inbound media IPv4 fallback | #44639 |
| DNS result ordering `ipv4first` for Telegram | #5405 |
| `autoSelectFamily` enabled by default on Node 22+ | #18272 |
| Remove startup persisted-offset `getUpdates` preflight | #69779 (fixes #69304) |
| Prevent duplicate in-process long pollers | #56230 |
| Abort in-flight `getUpdates` on shutdown/restart | PR #23950 |
| Rebuild HTTP transport after 409 conflicts | #69873 |
| Reset `webhookCleared` latch on 409 conflicts | #39205 |

**System-level workaround** (from issue): Disable IPv6 at OS level.
- macOS: `sudo networksetup -setv6off Ethernet` (and Wi-Fi)
- Linux: `sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1`
- Or try: `OPENCLAW_TELEGRAM_DNS_RESULT_ORDER=ipv4first`
- Or config: `channels.telegram.network.dnsResultOrder: ipv4first`

### Real Fix (Pending PR)

The issue has **no linked PR yet**. Suggested fixes from the issue:

1. **Cancel in-flight long-poll on rebuild** — Abort the in-flight `getUpdates` fetch via its `AbortController` and wait for socket destroy before starting new poll.
2. **Sticky IPv4 per-account, not per-request** — Once a Telegram account experiences sticky IPv4 fallback, persist it for the lifetime of the gateway process.
3. **Backoff aware of Telegram TTL** — When 409 Conflict is observed AND the gateway just rebuilt, wait at least Telegram stale-poll TTL (~30-45s) before next rebuild.
4. **Config knob** — Surface `channels.telegram.network.preferIPv4: true` or `OPENCLAW_TELEGRAM_FORCE_IPV4=1` so operators with broken IPv6 can opt out of Happy Eyeballs at startup.

### Log Pattern (from issue)

```
[telegram] fetch fallback: enabling sticky IPv4-only dispatcher (codes=ETIMEDOUT,EHOSTUNREACH)
[telegram] [diag] polling cycle error reason=getUpdates conflict ... err=409: Conflict
[telegram] getUpdates conflict: ...; retrying in 2.27s.
[telegram] [diag] closing stale transport before rebuild
[telegram] [diag] rebuilding transport for next polling cycle
[telegram] [diag] polling cycle error reason=getUpdates conflict ... err=409: Conflict  ← cycle repeats
```

## Containers Involved (vm-friends)

| Container | Bot Token | Codex Auth Status |
|-----------|-----------|-------------------|
| `vm-ozden` | `@Jakepaul6353_bot` | OK |
| `vm-ozden2` | `@Jakepaul6353_bot` | Token expired (401) |

## Fix Options

1. **Disable Telegram on one instance** — Remove or disable the Telegram plugin on either `vm-ozden` or `vm-ozden2` to prevent the conflict.
2. **Use separate bot tokens** — Configure each instance with a unique Telegram bot token.
3. **Re-authenticate Codex on `vm-ozden2`** — Run `openclaw auth login openai-codex` inside the container to refresh the OAuth token.
4. **Set DNS result order** — Add `channels.telegram.network.dnsResultOrder: ipv4first` to config.
