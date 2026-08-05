#!/usr/bin/env bash
# Register the push-to-collector systemd service + timer on the new 1xauto VM.
#
# Usage (as root, on the new VM):
#   COLLECTOR_HOST=<sa-vm-host> sudo bash scripts/register-push.sh
#
# Overridable env:
#   COLLECTOR_HOST       ssh alias or host of the collector VM (required)
#   COLLECTOR_USER       default ${SUDO_USER:-azureuser}
#   COLLECTOR_APP_DIR    default /opt/1xauto
#   APP_DIR              default /opt/1xauto
#   SHARD_OFFSET         default 2
#   SHARD_COUNT          default 2
#   PUSH_EVERY           timer interval (default 30s)
#   RUN_USER             default ${SUDO_USER:-azureuser}
set -euo pipefail

COLLECTOR_HOST="${COLLECTOR_HOST:?COLLECTOR_HOST required (ssh alias or host of collector VM)}"
COLLECTOR_USER="${COLLECTOR_USER:-${SUDO_USER:-azureuser}}"
COLLECTOR_APP_DIR="${COLLECTOR_APP_DIR:-/opt/1xauto}"
APP_DIR="${APP_DIR:-/opt/1xauto}"
SHARD_OFFSET="${SHARD_OFFSET:-2}"
SHARD_COUNT="${SHARD_COUNT:-2}"
PUSH_EVERY="${PUSH_EVERY:-30s}"
RUN_USER="${RUN_USER:-${SUDO_USER:-azureuser}}"

log() { printf '\033[1;33m[push-register]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

SERVICE="/etc/systemd/system/push-to-collector.service"
TIMER="/etc/systemd/system/push-to-collector.timer"

cat > "$SERVICE" <<EOF
[Unit]
Description=Push shard status + screenshots to collector VM
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Type=oneshot
WorkingDirectory=$APP_DIR
Environment=COLLECTOR_HOST=$COLLECTOR_HOST
Environment=COLLECTOR_USER=$COLLECTOR_USER
Environment=COLLECTOR_APP_DIR=$COLLECTOR_APP_DIR
Environment=APP_DIR=$APP_DIR
Environment=SHARD_OFFSET=$SHARD_OFFSET
Environment=SHARD_COUNT=$SHARD_COUNT
ExecStart=$APP_DIR/scripts/push-to-collector.sh
EOF

cat > "$TIMER" <<EOF
[Unit]
Description=Push shard status + screenshots to collector VM

[Timer]
OnBootSec=30
OnUnitActiveSec=$PUSH_EVERY
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now push-to-collector.timer >/dev/null
log "Registered push-to-collector.timer (every ${PUSH_EVERY}) → $COLLECTOR_HOST"
log "Status: systemctl status push-to-collector.timer — logs: journalctl -u push-to-collector -f"
