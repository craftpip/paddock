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
# SSH_PORT (set by the Paddock compose when SSH is exposed) picks a custom
# sshd listen port — multiple agents sharing a network namespace can't ALL bind
# 22, so each gets its own.
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    sed -i "s/^#\?[[:space:]]*Port .*/Port $SSH_PORT/" /etc/ssh/sshd_config
fi
/usr/sbin/sshd &
# Run the hermes messaging gateway (keeps cron + platforms alive). If it exits
# for any reason, stay up so the terminal stays usable.
hermes gateway run || tail -f /dev/null
