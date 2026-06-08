FROM sipeed/picoclaw:v0.2.5-launcher

ENV TZ=Asia/Kolkata

RUN apk add --no-cache \
    bash \
    openssh \
    shadow \
    tzdata \
    nodejs \
    npm

RUN mkdir -p /var/run/sshd && \
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    ssh-keygen -A

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
export PICOCLAW_GATEWAY_HOST=0.0.0.0
/usr/sbin/sshd &
if [ ! -f /root/.picoclaw/config.json ]; then
    echo "picoclaw config missing at /root/.picoclaw/config.json"
    echo "container is in setup mode; configure then restart"
    tail -f /dev/null
fi
picoclaw gateway -E || tail -f /dev/null
EOF
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/start.sh"]
