#!/bin/bash
if [ -n "$ROOT_PASSWORD" ]; then
    echo "root:$ROOT_PASSWORD" | chpasswd
fi
if [ -n "$TZ" ]; then
    ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi
/usr/sbin/sshd &
# picoclaw needs config.json before the gateway can start. The webui runs
# `picoclaw onboard` at create time (driver.setupSteps); if that hasn't
# happened yet, stay alive in setup mode so the terminal is usable.
if [ ! -f /root/.picoclaw/config.json ]; then
    echo "picoclaw config missing at /root/.picoclaw/config.json"
    echo "container is in setup mode; configure then restart"
    tail -f /dev/null
fi
export PICOCLAW_GATEWAY_HOST=0.0.0.0
picoclaw gateway -E || tail -f /dev/null
