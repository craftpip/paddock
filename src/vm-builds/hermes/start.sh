#!/bin/bash
# The hermes gateway drops to the `hermes` user even when started as root, so
# /opt/data (our bind mount) must be owned by hermes or it cannot write its
# config/logs on first boot.
chown -R hermes:hermes /opt/data
if [ -n "$ROOT_PASSWORD" ]; then
    echo "root:$ROOT_PASSWORD" | chpasswd
fi
if [ -n "$TZ" ]; then
    ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi
/usr/sbin/sshd &
# Run the hermes messaging gateway (keeps cron + platforms alive). If it exits
# for any reason, stay up so the terminal stays usable.
hermes gateway run || tail -f /dev/null
