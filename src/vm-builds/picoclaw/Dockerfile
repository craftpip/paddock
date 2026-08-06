FROM sipeed/picoclaw:v0.2.5-launcher

ARG INSTALL_DOCKER=0

ENV TZ=Asia/Kolkata

RUN apk add --no-cache \
    bash \
    openssh \
    shadow \
    tzdata \
    tmux \
    sqlite \
    nodejs \
    npm

RUN if [ "$INSTALL_DOCKER" = "1" ]; then \
      apk add --no-cache docker-cli; \
    fi

RUN mkdir -p /var/run/sshd && \
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    ssh-keygen -A

RUN npm config set fund false && npm config set audit false && npm install -g mcporter

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/start.sh"]
