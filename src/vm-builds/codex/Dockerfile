FROM node:20-slim

ARG INSTALL_DOCKER=0

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    git \
    curl \
    ca-certificates \
    tzdata \
    tmux \
    sqlite3 \
    tini && \
    rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_DOCKER" = "1" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends docker.io && \
      rm -rf /var/lib/apt/lists/*; \
    fi

RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config

RUN npm config set fund false && npm config set audit false && npm install -g @openai/codex

RUN mkdir -p /root/.codex/workspace

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root/.codex/workspace

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]
