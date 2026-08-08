# ============================================================
# Opencode agent image — THIS PAD's own build file.
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

# Keep all of opencode's state under the mounted data dir. opencode follows the
# XDG spec (~/.config/opencode, ~/.local/share/opencode by default) — point it
# at /root/.opencode so the bind mount persists config, auth and workspace.
ENV XDG_CONFIG_HOME=/root/.opencode/config
ENV XDG_DATA_HOME=/root/.opencode/data
ENV XDG_CACHE_HOME=/root/.opencode/cache

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
RUN npm config set fund false && npm config set audit false && npm install -g opencode-ai

RUN mkdir -p /root/.opencode/workspace

# Default opencode config. opencode reads XDG_CONFIG_HOME/opencode.json
# (global scope). Edit freely once the agent is running.
RUN mkdir -p /root/.opencode/config && \
    cat > /root/.opencode/config/opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "snapshot": false
}
EOF

# ---- 8. OPTIONAL: extras/ drop-in (delete block if unused) -----
# Drop files into instances/<name>/build/extras/ then reference them.
COPY extras/ /opt/extras/
# Uncomment to run extra setup on build:
# RUN bash /opt/extras/setup.sh

# ---- 9. ENTRYPOINT ----------------------------------------------
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root/.opencode/workspace

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]
