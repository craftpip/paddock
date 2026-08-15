# ============================================================
# Picoclaw agent image — THIS PAD's own build file.
# Lives in instances/<name>/build/ and builds only this PAD.
# Edit freely, then rebuild: Settings → Update.
# ============================================================
# ALPINE base — install tools with `apk add`, never apt-get.

# ---- 1. BASE -------------------------------------------------
FROM sipeed/picoclaw:v0.2.5-launcher

# ---- 2. BUILD ARGS (override values in build.env) ------------
# Each ARG here becomes a `build.args:` entry in the generated
# docker-compose.yml, fed from instances/<name>/build/build.env.
ARG INSTALL_DOCKER=0

# ---- 3. SYSTEM CONTEXT ----------------------------------------
ENV TZ=Asia/Kolkata

# ---- 4. SYSTEM TOOLS — add/remove package names here ----------
# tmux + sqlite are REQUIRED (the webui terminal relies on them and
# Alpine has no apt-get for a lazy install) — keep them installed.
# util-linux (setpriv) + sudo back the user-mode daemon drop (plan 43 P7).
RUN apk add --no-cache \
    bash \
    openssh \
    shadow \
    tzdata \
    tmux \
    sqlite \
    nodejs \
    npm \
    tini \
    util-linux \
    sudo

# ---- 5. OPTIONAL: docker CLI (build.env INSTALL_DOCKER=1) -----
# Set via Settings → "Allow docker" when the image has no CLI yet.
RUN if [ "$INSTALL_DOCKER" = "1" ]; then \
      apk add --no-cache docker-cli; \
    fi

# ---- 6. SSH (root login via ROOT_PASSWORD) ---------------------
RUN mkdir -p /var/run/sshd && \
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    ssh-keygen -A

# ---- 7. APP / CLI install --------------------------------------
RUN npm config set fund false && npm config set audit false && npm install -g mcporter

# ---- 8. OPTIONAL: extras/ drop-in (delete block if unused) -----
# Drop files into instances/<name>/build/extras/ then reference them.
COPY extras/ /opt/extras/
# Uncomment to run extra setup on build:
# RUN bash /opt/extras/setup.sh

# ---- 9. PAD USER (user-mode pads, plan 43 Phase 7) ---------------
# `pad` user at PUID:PGID (1000:1000) + passwordless sudo. `/root` chmod'd 755
# so a uid-1000 process can traverse into the bind-mounted /root/.picoclaw.
# Alpine uses busybox adduser (group first, then the user in it).
RUN addgroup -g 1000 pad 2>/dev/null; \
    adduser -D -u 1000 -G pad -h /home/pad -s /bin/bash pad 2>/dev/null || true; \
    chmod 755 /root; \
    if ! command -v sudo >/dev/null 2>&1; then apk add --no-cache sudo; fi; \
    echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pad && chmod 440 /etc/sudoers.d/pad

# ---- 10. ENTRYPOINT ---------------------------------------------
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

EXPOSE 22

ENTRYPOINT ["/sbin/tini", "-s", "--", "/usr/local/bin/start.sh"]
