FROM ghcr.io/openclaw/openclaw:latest

USER root

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    cmake \
    make \
    build-essential \
    python3 && \
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
openclaw gateway run --allow-unconfigured || tail -f /dev/null
EOF
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

EXPOSE 22

CMD ["/usr/local/bin/start.sh"]
