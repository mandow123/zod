#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then echo "run as root" >&2; exit 77; fi
test -f ./src/server.mjs
install -d -m 0755 /opt/kai-h100-sidecar /etc/kai-h100-sidecar /var/lib/kai-h100-sidecar /srv/kai-h100-workspaces
cp -R ./src ./scripts ./workload ./package.json /opt/kai-h100-sidecar/
chown -R root:root /opt/kai-h100-sidecar /etc/kai-h100-sidecar /var/lib/kai-h100-sidecar /srv/kai-h100-workspaces
chmod 0700 /var/lib/kai-h100-sidecar
install -m 0644 ./deploy/kai-h100-sidecar.service /etc/systemd/system/kai-h100-sidecar.service
install -m 0755 ./deploy/kai-h100-sidecar-enroll /usr/local/sbin/kai-h100-sidecar-enroll
if [ ! -f /etc/kai-h100-sidecar/sidecar.env ]; then install -m 0600 ./.env.example /etc/kai-h100-sidecar/sidecar.env; fi
if [ ! -f /etc/kai-h100-sidecar/resource-policies.json ]; then
  install -m 0600 ./resource-policies.example.json /etc/kai-h100-sidecar/resource-policies.json
fi
systemctl daemon-reload
echo "Installed but not enabled or started. Fill real env/policy/TLS, run preflight, then enable explicitly." >&2
