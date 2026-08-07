FROM nousresearch/hermes-agent:latest

ARG INSTALL_DOCKER=0

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

# The official image runs as the `hermes` user via s6-overlay; our start.sh
# overrides that entrypoint and keeps the container as root so the terminal,
# sshd and bind-mounted /opt/data all behave like the other agent images.
ENV HERMES_ALLOW_ROOT_GATEWAY=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    tzdata \
    ca-certificates \
    nodejs \
    npm \
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

RUN npm config set fund false && npm config set audit false && npm install -g mcporter

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /opt/data

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/start.sh"]
