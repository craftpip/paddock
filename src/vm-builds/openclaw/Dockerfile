# ============================================================
# OpenClaw agent image — THIS PAD's own build file.
# Lives in instances/<name>/build/ and builds only this PAD.
# Edit freely, then rebuild: Settings → Update.
# ============================================================
# The base image already ships `tini -s --` as ENTRYPOINT, so
# start.sh is launched via CMD (not a second ENTRYPOINT).

# ---- 1. BASE -------------------------------------------------
FROM ghcr.io/openclaw/openclaw:latest

# ---- 2. BUILD ARGS (override values in build.env) ------------
# Each ARG here becomes a `build.args:` entry in the generated
# docker-compose.yml, fed from instances/<name>/build/build.env.
ARG INSTALL_DOCKER=0

# ---- 3. SYSTEM CONTEXT ----------------------------------------
USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

# ---- 4. SYSTEM TOOLS — add/remove package names here ----------
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    cmake \
    make \
    build-essential \
    jq \
    python3 \
    tmux \
    sudo \
    # ^ ADD or REMOVE package lines above this point
    && rm -rf /var/lib/apt/lists/*

# ---- 5. OPTIONAL: docker CLI (build.env INSTALL_DOCKER=1) -----
# Set via Settings → "Allow docker" when the image has no CLI yet.
RUN if [ "$INSTALL_DOCKER" = "1" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends docker.io && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# ---- 6. SSH (root login via ROOT_PASSWORD) ---------------------
RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config

# ---- 7. APP / CLI install --------------------------------------
RUN npm config set fund false && npm config set audit false && npm install -g mcporter

# ---- 8. OPTIONAL: extras/ drop-in (delete block if unused) -----
# Drop files into instances/<name>/build/extras/ then reference them.
COPY extras/ /opt/extras/
# Uncomment to run extra setup on build:
# RUN bash /opt/extras/setup.sh

# ---- 9. PAD USER (user-mode pads, plan 43 Phase 7) ---------------
# A `pad` user at PUID:PGID (1000:1000) + passwordless sudo, so a pad can run
# its daemon as a non-root user (`USER_MODE=user`; start.sh drops via setpriv).
# `/root` is chmod'd 755 so a uid-1000 process can traverse into the bind-
# mounted /root/.openclaw config — the mount CONTENTS are PUID-owned (webui
# chowns on create + the boot sweep heals), so the pad user owns its files.
# `-o` tolerates base images that already ship a uid-1000 account.
RUN groupadd -g 1000 pad 2>/dev/null || true; \
    (id pad >/dev/null 2>&1 || useradd -m -o -u 1000 -g 1000 -s /bin/bash pad 2>/dev/null) || useradd -m -o -u 1000 -s /bin/bash pad 2>/dev/null || true; \
    chmod 755 /root; \
    if ! command -v sudo >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo; fi; \
    echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pad && chmod 440 /etc/sudoers.d/pad

# ---- 10. ENTRYPOINT ---------------------------------------------
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

EXPOSE 22

# Override the base image's inherited HEALTHCHECK (probes the gateway at
# 18789). A fresh PAD has no gateway until it's onboarded, so the inherited
# check reports a false unhealthy state. We report real health ourselves.
HEALTHCHECK NONE

CMD ["/usr/local/bin/start.sh"]
