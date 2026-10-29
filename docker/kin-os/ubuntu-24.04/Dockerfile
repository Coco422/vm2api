FROM ubuntu:24.04
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
ENV PATH=/usr/local/lib/nodejs/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tzdata python3 bash procps xvfb xkb-data \
 && if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      curl --fail --show-error --location --proto '=https' --tlsv1.2 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/kin-audit-chrome.deb \
      && apt-get install -y --no-install-recommends /tmp/kin-audit-chrome.deb \
      && rm /tmp/kin-audit-chrome.deb; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 987 kincli \
 && useradd -u 999 -g 987 -d /home/kincli -m -s /bin/bash kincli \
 && echo "ubuntu-24.04" > /etc/kin-os \
 && echo "claude-code=2.1.293" > /etc/kin-claude
WORKDIR /home/kincli
USER kincli
CMD ["sleep", "infinity"]
