#!/bin/sh
set -eu

/usr/sbin/sshd -t -f /etc/ssh/sshd_config
test -s /run/sshd/sshd.pid
kill -0 "$(cat /run/sshd/sshd.pid)"
test -r /workspace/.access/authorized_keys
test "$(stat -c %u /workspace/.access/authorized_keys)" = "0"
test "$(stat -c %a /workspace/.access/authorized_keys)" = "600"
test "$(stat -c %u /workspace/.access/ssh_host_ed25519_key)" = "0"
test "$(stat -c %a /workspace/.access/ssh_host_ed25519_key)" = "600"
test "$(stat -c %u /workspace/data)" = "1000"
test "$(stat -c %g /workspace/data)" = "1000"
su -s /bin/sh -c 'test -w /workspace/data' kai
nvidia-smi -L >/dev/null
