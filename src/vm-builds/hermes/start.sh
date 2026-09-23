#!/bin/bash
# The hermes gateway drops to the `hermes` user even when started as root, so
# /opt/data (our bind mount) must be owned by hermes or it cannot write its
# config/logs on first boot. chmod 755 the top dir: the Paddock webui (uid
# 1000) must still read /opt/data (web start-hook, config.yaml, workspace) —
# the dir is 700 in the base image and chown alone would lock it out.
chown -R hermes:hermes /opt/data
chmod 755 /opt/data
# Hermes re-locks the data dir to 0700 on gateway boot (secure_parent_dir in
# hermes_constants.py). Watchdog keeps it traversable for the webui; it is
# otherwise a no-op and self-heals any future re-lock.
(
  while true; do
    [ "$(stat -c %a /opt/data 2>/dev/null)" != "755" ] && chmod 755 /opt/data 2>/dev/null
    sleep 5
  done
) &
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
# the data-dir bind mount), run it so the published web server survives
# recreates. The hook is idempotent and backgrounds itself (the dashboard is a
# separate process from the gateway below).
if [ -f /opt/data/start-web.sh ]; then
    bash /opt/data/start-web.sh || true
fi
# Paddock post-start hook (plan 41): if the webui wrote a post-start.sh (bound
# via the build-dir /build mount), run it on EVERY container start.
if [ -f /build/post-start.sh ]; then
    bash /build/post-start.sh || true
fi
# Run the hermes messaging gateway (keeps cron + platforms alive). If it exits
# for any reason, stay up so the terminal stays usable.
hermes gateway run || tail -f /dev/null
