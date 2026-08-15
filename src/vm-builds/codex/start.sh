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
# codex has no gateway daemon — keep the container alive so the terminal
# stays usable. PAD USER drop (plan 43 Phase 7): USER_MODE=user pads run the
# keeper as the `pad` user so terminal-created files are user-owned.
# __PAD_USER_MODE__
drop_to_pad() {
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid 1000 --regid 1000 --clear-groups -- "$@"
  else
    exec su -s /bin/bash pad -c "$*"
  fi
}
if [ "$USER_MODE" = "user" ]; then
    chown -R 1000:1000 /root/.codex 2>/dev/null || true
    drop_to_pad tail -f /dev/null || tail -f /dev/null
else
    tail -f /dev/null
fi
