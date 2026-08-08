# ============================================================
# Hermes agent image — THIS PAD's own build file.
# Lives in instances/<name>/build/ and builds only this PAD.
# Edit freely, then rebuild: Settings → Update.
# ============================================================

# ---- 1. BASE -------------------------------------------------
FROM nousresearch/hermes-agent:latest

# ---- 2. BUILD ARGS (override values in build.env) ------------
# Each ARG here becomes a `build.args:` entry in the generated
# docker-compose.yml, fed from instances/<name>/build/build.env.
ARG INSTALL_DOCKER=0

# ---- 3. SYSTEM CONTEXT ----------------------------------------
USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

# The official image runs as the `hermes` user via s6-overlay; our start.sh
# overrides that entrypoint and keeps the container as root so the terminal,
# sshd and bind-mounted /opt/data all behave like the other agent images.
ENV HERMES_ALLOW_ROOT_GATEWAY=1

# ---- 4. SYSTEM TOOLS — add/remove package names here ----------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    tzdata \
    ca-certificates \
    nodejs \
    npm \
    tmux \
    sqlite3 \
    tini \
    # ^ ADD or REMOVE package lines above this point
    && rm -rf /var/lib/apt/lists/*

# The base image's /etc/profile resets PATH to base dirs for login shells,
# dropping the hermes bin dirs that only live in the image's ENV PATH. The
# webui terminal and tmux spawn login shells (/bin/bash), so `hermes` would
# not be found there. Re-append the hermes dirs from profile.d.
RUN printf '%s\n' \
    'if [ -n "${HERMES_HOME:-}" ] || [ -d /opt/hermes/bin ]; then' \
    '  export PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:$PATH"' \
    'fi' > /etc/profile.d/hermes-path.sh && \
    chmod +x /etc/profile.d/hermes-path.sh

# ---- 5. OPTIONAL: docker CLI (build.env INSTALL_DOCKER=1) -----
# Set via Settings → "Allow docker" when the image has no CLI yet.
# NOTE: the base image already ships the docker CLI, so this is a no-op.
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

# ---- 9. ENTRYPOINT ----------------------------------------------
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /opt/data

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]
