#!/bin/bash
if [ -n "$ROOT_PASSWORD" ]; then
    echo "root:$ROOT_PASSWORD" | chpasswd
fi
if [ -n "$TZ" ]; then
    ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi
/usr/sbin/sshd &
if [ -f /root/.openclaw/openclaw.json ] && grep -q '"gateway"' /root/.openclaw/openclaw.json 2>/dev/null; then
    openclaw gateway run || tail -f /dev/null
else
    openclaw gateway run --allow-unconfigured || tail -f /dev/null
fi
