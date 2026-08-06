FROM node:20-slim

ARG INSTALL_DOCKER=0

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

# Keep all of opencode's state under the mounted data dir. opencode follows the
# XDG spec (~/.config/opencode, ~/.local/share/opencode by default) — point it
# at /root/.opencode so the bind mount persists config, auth and workspace.
ENV XDG_CONFIG_HOME=/root/.opencode/config
ENV XDG_DATA_HOME=/root/.opencode/data
ENV XDG_CACHE_HOME=/root/.opencode/cache

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    git \
    curl \
    ca-certificates \
    tzdata \
    tmux \
    sqlite3 && \
    rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_DOCKER" = "1" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends docker.io && \
      rm -rf /var/lib/apt/lists/*; \
    fi

RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config

RUN npm config set fund false && npm config set audit false && npm install -g opencode-ai

RUN mkdir -p /root/.opencode/workspace

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root/.opencode/workspace

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/start.sh"]
