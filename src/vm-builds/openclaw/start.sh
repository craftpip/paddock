#!/bin/bash
if [ -n "$ROOT_PASSWORD" ]; then
    echo "root:$ROOT_PASSWORD" | chpasswd
fi
if [ -n "$TZ" ]; then
    ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi
# SSH_PORT (set by the Paddock compose when SSH is exposed) picks a custom
# sshd listen port — multiple agents sharing a network namespace can't ALL bind
# 22, so each gets its own.
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    sed -i "s/^#\?[[:space:]]*Port .*/Port $SSH_PORT/" /etc/ssh/sshd_config
fi
/usr/sbin/sshd &
# Paddock web publishing: if the webui wrote a start-web.sh hook (bound via
# the data-dir bind mount), run it BEFORE the gateway so a published web app
# is verified. The hook is idempotent and its early exit must not terminate
# this script.
if [ -f /root/.openclaw/start-web.sh ]; then
    bash /root/.openclaw/start-web.sh || true
fi
if [ -f /root/.openclaw/openclaw.json ] && grep -q '"gateway"' /root/.openclaw/openclaw.json 2>/dev/null; then
    openclaw gateway run || tail -f /dev/null
else
    openclaw gateway run --allow-unconfigured || tail -f /dev/null
fi
