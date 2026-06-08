FROM smanx/nanobot:latest

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    nodejs \
    npm \
    tzdata \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/sshd && \
    sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config

RUN npm config set fund false && npm config set audit false && npm install -g mcporter

RUN cat > /usr/local/bin/start.sh <<'EOF'
#!/bin/bash
if [ -n "$ROOT_PASSWORD" ]; then
    echo "root:$ROOT_PASSWORD" | chpasswd
fi
if [ -n "$TZ" ]; then
    ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi
/usr/sbin/sshd &
if [ ! -f /root/.nanobot/config.json ]; then
    echo "nanobot config missing at /root/.nanobot/config.json"
    echo "container is in setup mode; configure then restart"
    tail -f /dev/null
fi
nanobot gateway --config /root/.nanobot/config.json || tail -f /dev/null
EOF
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/start.sh"]
