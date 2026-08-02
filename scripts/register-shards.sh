#!/usr/bin/env bash
# Register N parallel 1xauto loop shards as systemd services on a VM.
# Each shard runs run-loop.js (login -> excel -> notify) with its own
# START_INDEX / END_INDEX / state / screenshots / summary / excel files, so
# they never clobber each other. Cooldown defaults to 60 min between loops.
#
# Usage (as root, on the VM):
#   SHARDS="1:149,150:276" sudo bash scripts/register-shards.sh
#   SHARDS="1:100,101:200,201:276" COOLDOWN_MINUTES=60 sudo bash scripts/register-shards.sh
#
# Overridable env:
#   SHARDS="start:end,..."     default "1:149,150:276"
#   COOLDOWN_MINUTES           default 60
#   RUN_USER                   default ${SUDO_USER:-azureuser}
#   APP_DIR                    default /opt/1xauto
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/1xauto}"
RUN_USER="${RUN_USER:-${SUDO_USER:-azureuser}}"
COOLDOWN_MINUTES="${COOLDOWN_MINUTES:-60}"
SHARDS="${SHARDS:-1:149,150:276}"
NODE_BIN="$(command -v node)"

log() { printf '\033[1;32m[shards]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "App dir $APP_DIR not found — run scripts/vm-setup.sh first." >&2
  exit 1
fi

shard_index=0
IFS=',' read -ra RANGES <<< "$SHARDS"

for range in "${RANGES[@]}"; do
  shard_index=$((shard_index + 1))
  start="${range%%:*}"
  end="${range##*:}"

  if [[ ! "$start" =~ ^[0-9]+$ ]] || [[ ! "$end" =~ ^[0-9]+$ ]] || (( start > end )); then
    echo "Invalid shard range: '$range' (expected start:end with start <= end)" >&2
    exit 1
  fi

  unit="/etc/systemd/system/1xauto-shard-$shard_index.service"
  state_file="$APP_DIR/state-shard-$shard_index.json"
  screenshots_dir="$APP_DIR/screenshots/shard-$shard_index"
  summary_file="$APP_DIR/run-summary-shard-$shard_index.json"
  excel_file="$APP_DIR/extracted_numbers-shard-$shard_index.xlsx"

  cat > "$unit" <<EOF
[Unit]
Description=1xauto batch shard $shard_index (accounts $start-$end)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=START_INDEX=$start
Environment=END_INDEX=$end
Environment=STATE_FILE=$state_file
Environment=SCREENSHOTS_DIR=$screenshots_dir
Environment=RUN_SUMMARY_FILE=$summary_file
Environment=EXCEL_FILE=$excel_file
Environment=COOLDOWN_MINUTES=$COOLDOWN_MINUTES
ExecStart=$NODE_BIN $APP_DIR/run-loop.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "1xauto-shard-$shard_index" >/dev/null
  systemctl restart "1xauto-shard-$shard_index"
  log "Registered 1xauto-shard-$shard_index (accounts $start-$end), cooldown ${COOLDOWN_MINUTES}min"
done

log "Done. Status: systemctl status '1xauto-shard-*' — logs: journalctl -u 1xauto-shard-1 -f"
