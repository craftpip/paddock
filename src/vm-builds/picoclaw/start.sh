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
# picoclaw needs config.json before the gateway can start. The webui runs
# `picoclaw onboard` at create time (driver.setupSteps); if that hasn't
# happened yet, stay alive in setup mode so the terminal is usable.
if [ ! -f /root/.picoclaw/config.json ]; then
    echo "picoclaw config missing at /root/.picoclaw/config.json"
    echo "container is in setup mode; configure then restart"
    tail -f /dev/null
fi
export PICOCLAW_GATEWAY_HOST=0.0.0.0
# Paddock web publishing: if the webui wrote a start-web.sh hook (bound via
# the data-dir bind mount), run it so the published web server survives
# recreates. The hook is idempotent and backgrounds itself. Runs after the
# config check, before the foreground gateway — the launcher coexists with it.
if [ -f /root/.picoclaw/start-web.sh ]; then
    bash /root/.picoclaw/start-web.sh || true
fi
picoclaw gateway -E || tail -f /dev/null
