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
    sqlite3 \
    tini && \
    rm -rf /var/lib/apt/lists/*

# The base image's /etc/profile resets PATH to base dirs for login shells,
# dropping the hermes bin dirs that only live in the image's ENV PATH. The
# webui terminal and tmux spawn login shells (/bin/bash), so `hermes` would
# not be found there. Re-append the hermes dirs from profile.d.
RUN printf '%s\n' \
    'if [ -n "${HERMES_HOME:-}" ] || [ -d /opt/hermes/bin ]; then' \
    '  export PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:$PATH"' \
    'fi' > /etc/profile.d/hermes-path.sh && \
    chmod +x /etc/profile.d/hermes-path.sh

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

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]
