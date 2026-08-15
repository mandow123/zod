#!/bin/sh
set -eu

test -x /usr/bin/nvidia-smi
test -r /workspace/.access/authorized_keys
test -d /workspace/data
test "$(stat -c %u /workspace/data)" = "1000"
test "$(stat -c %g /workspace/data)" = "1000"
test "$(stat -c %u /workspace/.access/authorized_keys)" = "0"
test "$(stat -c %a /workspace/.access/authorized_keys)" = "600"
test "$(stat -c %u /workspace/.access/ssh_host_ed25519_key)" = "0"
test "$(stat -c %a /workspace/.access/ssh_host_ed25519_key)" = "600"
nvidia-smi -L >/dev/null
mkdir -p /run/sshd
chmod 0755 /run/sshd
/usr/sbin/sshd -t -f /etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
