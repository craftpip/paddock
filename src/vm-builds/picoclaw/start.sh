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
# PAD HOME OWNERSHIP (plan 79): early pass — give the pad user the whole
# home BEFORE the root-run hooks (start-web, post-start) below can find it
# root-owned, so a session started mid-boot is already writable. The USER_MODE
# branch re-runs it after the hooks in case one wrote into the home.
if [ "$USER_MODE" = "user" ]; then
    chown -R 1000:1000 /root 2>/dev/null || true
fi
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
# Paddock post-start hook (plan 41): if the webui wrote a post-start.sh (bound
# via the build-dir /build mount), run it on EVERY container start.
if [ -f /build/post-start.sh ]; then
    bash /build/post-start.sh || true
fi
# PAD USER drop (plan 43 Phase 7): USER_MODE=user pads run the foreground
# daemon as the `pad` user (PUID:PGID=1000:1000) so every file the agent
# writes is user-owned. The root boot above is unaffected; only the daemon
# drops. setpriv when available, else su. __PAD_USER_MODE__
drop_to_pad() {
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid 1000 --regid 1000 --clear-groups -- "$@"
  else
    exec su -s /bin/sh pad -c "$*"
  fi
}
if [ "$USER_MODE" = "user" ]; then
    # PAD HOME OWNERSHIP (plan 79): the agent runs as uid 1000 with
    # HOME=/root, so give it the whole home — tools write under $HOME, not
    # just the data dir.
    chown -R 1000:1000 /root 2>/dev/null || true
    drop_to_pad picoclaw gateway -E || tail -f /dev/null
else
    picoclaw gateway -E || tail -f /dev/null
fi
