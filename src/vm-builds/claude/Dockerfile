# ============================================================
# Claude agent image — THIS PAD's own build file.
# Lives in instances/<name>/build/ and builds only this PAD.
# Edit freely, then rebuild: Settings → Update.
# ============================================================

# ---- 1. BASE -------------------------------------------------
FROM node:20-slim

# ---- 2. BUILD ARGS (override values in build.env) ------------
# Each ARG here becomes a `build.args:` entry in the generated
# docker-compose.yml, fed from instances/<name>/build/build.env.
ARG INSTALL_DOCKER=0

# ---- 3. SYSTEM CONTEXT ----------------------------------------
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

# Keep all of claude's state under the mounted data dir. Claude Code writes
# config, settings and credentials to CLAUDE_CONFIG_DIR, so pointing it at
# /root/.claude makes the bind mount persist everything.
ENV CLAUDE_CONFIG_DIR=/root/.claude
# No auto-update / telemetry churn inside a throwaway container.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# ---- 4. SYSTEM TOOLS — add/remove package names here ----------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    git \
    curl \
    ca-certificates \
    tzdata \
    tmux \
    sqlite3 \
    tini \
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
RUN npm config set fund false && npm config set audit false && npm install -g @anthropic-ai/claude-code

RUN mkdir -p /root/.claude/workspace

# ---- 8. OPTIONAL: extras/ drop-in (delete block if unused) -----
# Drop files into instances/<name>/build/extras/ then reference them.
COPY extras/ /opt/extras/
# Uncomment to run extra setup on build:
# RUN bash /opt/extras/setup.sh

# ---- 9. PAD USER (user-mode pads, plan 43 Phase 7) ---------------
# `pad` user at PUID:PGID (1000:1000) + passwordless sudo. `/root` chmod'd 755
# so a uid-1000 process can traverse into the bind-mounted /root/.claude.
# node base images already ship a uid-1000 account (`node`) — `-o` tolerates it.
RUN groupadd -g 1000 pad 2>/dev/null || true; \
    (id pad >/dev/null 2>&1 || useradd -m -o -u 1000 -g 1000 -s /bin/bash pad 2>/dev/null) || useradd -m -o -u 1000 -s /bin/bash pad 2>/dev/null || true; \
    chmod 755 /root; \
    if ! command -v sudo >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo; fi; \
    echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pad && chmod 440 /etc/sudoers.d/pad

# ---- 10. ENTRYPOINT ---------------------------------------------
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root/.claude/workspace

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]
