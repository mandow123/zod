ARG BASE_IMAGE
FROM ${BASE_IMAGE}

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 kai \
  && useradd --uid 1000 --gid 1000 --home-dir /workspace/data --shell /bin/bash --no-create-home kai \
  && password="$(head -c 48 /dev/urandom | base64)" \
  && printf 'kai:%s\n' "$password" | chpasswd \
  && unset password \
  && passwd -l root \
  && rm -f /etc/ssh/ssh_host_* /etc/ssh/sshd_config.d/*

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/sbin/kai-workload-entrypoint
COPY healthcheck.sh /usr/local/sbin/kai-workload-healthcheck
RUN chmod 0755 /usr/local/sbin/kai-workload-entrypoint /usr/local/sbin/kai-workload-healthcheck

EXPOSE 22
WORKDIR /workspace/data
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["/usr/local/sbin/kai-workload-healthcheck"]
ENTRYPOINT ["/usr/local/sbin/kai-workload-entrypoint"]
