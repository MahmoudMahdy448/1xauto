#!/usr/bin/env bash
# Register systemd services for the Linebet and Melbet apps on the VM.
# Each runs run-loop.js (login -> notify) with its own state/screenshots/ledger.
#
# Usage (as root, on the VM):
#   APP_DIR=/opt/linebet SERVICE_PREFIX=linebet sudo bash scripts/register-app.sh
#   APP_DIR=/opt/melbet  SERVICE_PREFIX=melbet  sudo bash scripts/register-app.sh
#
# Overridable env:
#   APP_DIR          app directory (required)
#   SERVICE_PREFIX   unit prefix (required)
#   RUN_GROUP        A or B (alternation group)
#   LEASE_FILE       shared lease for group alternation (default /opt/1xauto/group-lease.json)
#   COOLDOWN_MINUTES default 60
#   RUN_USER         default ${SUDO_USER:-azureuser}
set -euo pipefail

APP_DIR="${APP_DIR:?APP_DIR required (e.g. /opt/linebet)}"
SERVICE_PREFIX="${SERVICE_PREFIX:?SERVICE_PREFIX required (e.g. linebet)}"
RUN_USER="${RUN_USER:-${SUDO_USER:-azureuser}}"
COOLDOWN_MINUTES="${COOLDOWN_MINUTES:-60}"
RUN_GROUP="${RUN_GROUP:-B}"
LEASE_FILE="${LEASE_FILE:-/opt/1xauto/group-lease.json}"
NODE_BIN="$(command -v node)"

log() { printf '\033[1;32m[app]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "App dir $APP_DIR not found." >&2
  exit 1
fi

unit="/etc/systemd/system/${SERVICE_PREFIX}.service"
state_file="$APP_DIR/state.json"
screenshots_dir="$APP_DIR/screenshots"
summary_file="$APP_DIR/run-summary.json"
status_file="$APP_DIR/loop-status.json"
ledger_file="$APP_DIR/seen-numbers.json"
ledger_lock="$APP_DIR/seen-numbers.json.lock"

cat > "$unit" <<EOF
[Unit]
Description=$SERVICE_PREFIX 24/7 loop (group $RUN_GROUP)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=STATE_FILE=$state_file
Environment=SCREENSHOTS_DIR=$screenshots_dir
Environment=RUN_SUMMARY_FILE=$summary_file
Environment=STATUS_FILE=$status_file
Environment=SEEN_NUMBERS_FILE=$ledger_file
Environment=SEEN_NUMBERS_LOCK=$ledger_lock
Environment=RUN_GROUP=$RUN_GROUP
Environment=LEASE_FILE=$LEASE_FILE
Environment=COOLDOWN_MINUTES=$COOLDOWN_MINUTES
ExecStart=$NODE_BIN $APP_DIR/run-loop.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_PREFIX" >/dev/null
systemctl restart "$SERVICE_PREFIX"
log "Registered $SERVICE_PREFIX (group $RUN_GROUP, app $APP_DIR), cooldown ${COOLDOWN_MINUTES}min"
log "Done. Logs: journalctl -u $SERVICE_PREFIX -f"
