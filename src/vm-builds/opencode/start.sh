#!/bin/bash
if [ -n "$ROOT_PASSWORD" ]; then
    echo "root:$ROOT_PASSWORD" | chpasswd
fi
if [ -n "$TZ" ]; then
    ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi
/usr/sbin/sshd &
# Paddock web publishing: if the webui wrote a start-web.sh hook (bound via
# the data-dir bind mount), source it so the published web server survives
# recreates. The hook backgrounds itself and is idempotent.
if [ -f /root/.opencode/start-web.sh ]; then
    bash /root/.opencode/start-web.sh || true
fi
# opencode has no gateway daemon — keep the container alive so the terminal
# stays usable.
tail -f /dev/null
