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
# Paddock post-start hook (plan 41): if the webui wrote a post-start.sh (bound
# via the build-dir /build mount), run it on EVERY container start. It is
# re-runnable and must never terminate this script.
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
    exec su -s /bin/bash pad -c "$*"
  fi
}
DAEMON_ARGS=""
if [ -f /root/.openclaw/openclaw.json ] && grep -q '"gateway"' /root/.openclaw/openclaw.json 2>/dev/null; then
    DAEMON_ARGS=""
else
    DAEMON_ARGS="--allow-unconfigured"
fi
if [ "$USER_MODE" = "user" ]; then
    # Data dir is bind-mounted from the host, where Paddock keeps it
    # PUID:PGID-owned — re-chown anything the root boot recreated (workspace
    # dirs, etc.) so the dropped daemon can write everywhere it needs.
    chown -R 1000:1000 /root/.openclaw 2>/dev/null || true
    drop_to_pad openclaw gateway run $DAEMON_ARGS || tail -f /dev/null
else
    openclaw gateway run $DAEMON_ARGS || tail -f /dev/null
fi
