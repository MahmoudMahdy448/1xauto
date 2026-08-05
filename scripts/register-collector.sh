#!/usr/bin/env bash
# Register the combined collector service for a sharded-only VM.
#
# The new VM runs N shards of the same site with SKIP_NOTIFY=true. This service
# waits until every shard finishes its run, then sends ONE combined notification
# (unique numbers across all shards + combined/unique excels) to its own channel.
#
# Usage (as root, on the VM):
#   SHARD_COUNT=4 TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
#     TELEGRAM_CHANNEL_ID=... sudo bash scripts/register-collector.sh
#
# Overridable env:
#   SHARD_COUNT            number of shards (default 3); status files/dirs are derived
#   APP_DIR                default /opt/1xauto
#   RUN_USER               default ${SUDO_USER:-azureuser}
#   COLLECTOR_POLL_MS      poll interval (default 30000)
#   STATUS_FILE_PREFIX     default $APP_DIR/loop-status-shard-
#   SCREENSHOTS_PREFIX     default $APP_DIR/screenshots/shard-
#   TELEGRAM_BOT_TOKEN     new bot for the combined channel (required)
#   TELEGRAM_CHAT_ID       admin chat to receive too (required)
#   TELEGRAM_CHANNEL_ID    the new separate channel (required)
#   EXCEL_COMBINED_FILE    default $APP_DIR/extracted_numbers-combined.xlsx
#   EXCEL_UNIQUE_FILE      default $APP_DIR/extracted_numbers-unique.xlsx
#   SEEN_NUMBERS_FILE      default $APP_DIR/seen-numbers.json (shared ledger)
#   SEEN_NUMBERS_LOCK      default $APP_DIR/seen-numbers.json.lock
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/1xauto}"
RUN_USER="${RUN_USER:-${SUDO_USER:-azureuser}}"
SHARD_COUNT="${SHARD_COUNT:-3}"
COLLECTOR_POLL_MS="${COLLECTOR_POLL_MS:-30000}"
STATUS_FILE_PREFIX="${STATUS_FILE_PREFIX:-$APP_DIR/loop-status-shard-}"
SCREENSHOTS_PREFIX="${SCREENSHOTS_PREFIX:-$APP_DIR/screenshots/shard-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN required}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID required}"
TELEGRAM_CHANNEL_ID="${TELEGRAM_CHANNEL_ID:?TELEGRAM_CHANNEL_ID required}"
EXCEL_COMBINED_FILE="${EXCEL_COMBINED_FILE:-$APP_DIR/extracted_numbers-combined.xlsx}"
EXCEL_UNIQUE_FILE="${EXCEL_UNIQUE_FILE:-$APP_DIR/extracted_numbers-unique.xlsx}"
SEEN_NUMBERS_FILE="${SEEN_NUMBERS_FILE:-$APP_DIR/seen-numbers.json}"
SEEN_NUMBERS_LOCK="${SEEN_NUMBERS_LOCK:-$APP_DIR/seen-numbers.json.lock}"
NODE_BIN="$(command -v node)"

log() { printf '\033[1;32m[collector]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "App dir $APP_DIR not found — run scripts/vm-setup.sh first." >&2
  exit 1
fi

if ! [[ "$SHARD_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "SHARD_COUNT must be a positive integer (got '$SHARD_COUNT')." >&2
  exit 1
fi

# Build the comma-separated status files and screenshots dirs.
STATUS_FILES=()
SCREENSHOTS_DIRS=()
for (( i = 1; i <= SHARD_COUNT; i++ )); do
  STATUS_FILES+=("${STATUS_FILE_PREFIX}${i}.json")
  SCREENSHOTS_DIRS+=("${SCREENSHOTS_PREFIX}${i}")
done
STATUS_FILES_CSV="$(IFS=,; echo "${STATUS_FILES[*]}")"
SCREENSHOTS_DIRS_CSV="$(IFS=,; echo "${SCREENSHOTS_DIRS[*]}")"

UNIT="/etc/systemd/system/1xauto-collector.service"
cat > "$UNIT" <<EOF
[Unit]
Description=1xauto combined collector (waits for all shards, sends unique numbers)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=COLLECTOR_STATUS_FILES=$STATUS_FILES_CSV
Environment=SCREENSHOTS_DIRS=$SCREENSHOTS_DIRS_CSV
Environment=COLLECT_STATE_FILE=$APP_DIR/collect-state.json
Environment=POLL_MS=$COLLECTOR_POLL_MS
Environment=SEEN_NUMBERS_FILE=$SEEN_NUMBERS_FILE
Environment=SEEN_NUMBERS_LOCK=$SEEN_NUMBERS_LOCK
Environment=EXCEL_COMBINED_FILE=$EXCEL_COMBINED_FILE
Environment=EXCEL_UNIQUE_FILE=$EXCEL_UNIQUE_FILE
Environment=TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
Environment=TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
Environment=TELEGRAM_CHANNEL_ID=$TELEGRAM_CHANNEL_ID
ExecStart=$NODE_BIN $APP_DIR/scripts/collector.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable 1xauto-collector >/dev/null
systemctl restart 1xauto-collector

log "Registered 1xauto-collector (${SHARD_COUNT} shard(s)) → channel ${TELEGRAM_CHANNEL_ID}"
log "Status: systemctl status 1xauto-collector — logs: journalctl -u 1xauto-collector -f"
