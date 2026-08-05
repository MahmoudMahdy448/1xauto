#!/usr/bin/env bash
# Push this VM's shard status files and screenshots to the collector VM
# (the SA VM that runs scripts/collector.mjs with SHARD_COUNT=4).
#
# The new 1xauto VM runs shards 3 and 4 (SHARD_OFFSET=2). The collector on the
# SA VM needs to see ALL shards' loop-status files and screenshots in one place,
# so this rsyncs:
#   loop-status-shard-3.json, loop-status-shard-4.json
#   screenshots/shard-3/,       screenshots/shard-4/
# into /opt/1xauto/ on the collector VM. Run it every ~30s via systemd timer or
# cron. Idempotent — rsync only copies what changed.
#
# Env:
#   COLLECTOR_HOST    ssh alias or host of the collector VM (required)
#   COLLECTOR_USER    default ${SUDO_USER:-azureuser}
#   COLLECTOR_APP_DIR default /opt/1xauto (target dir on the collector)
#   APP_DIR           default /opt/1xauto (source on this VM)
#   SHARD_OFFSET      default 3 (FIRST shard number on this VM; loop-status-shard-N.json)
#   SHARD_COUNT       default 2 (shards on this VM)
set -euo pipefail

COLLECTOR_HOST="${COLLECTOR_HOST:?COLLECTOR_HOST required (ssh alias or host of collector VM)}"
COLLECTOR_USER="${COLLECTOR_USER:-${SUDO_USER:-azureuser}}"
COLLECTOR_APP_DIR="${COLLECTOR_APP_DIR:-/opt/1xauto}"
APP_DIR="${APP_DIR:-/opt/1xauto}"
SHARD_OFFSET="${SHARD_OFFSET:-3}"
SHARD_COUNT="${SHARD_COUNT:-2}"

log() { printf '\033[1;33m[push]\033[0m %s\n' "$*"; }

DEST="$COLLECTOR_USER@$COLLECTOR_HOST:$COLLECTOR_APP_DIR"

for (( i = 0; i < SHARD_COUNT; i++ )); do
  n=$((SHARD_OFFSET + i))
  status_src="$APP_DIR/loop-status-shard-$n.json"
  shots_src="$APP_DIR/screenshots/shard-$n/"

  if [[ -f "$status_src" ]]; then
    rsync -az "$status_src" "$DEST/loop-status-shard-$n.json"
  else
    log "status file not present yet: $status_src"
  fi

  if [[ -d "$shots_src" ]]; then
    rsync -az --delete "$shots_src" "$DEST/screenshots/shard-$n/"
  fi
done

log "Pushed shard $SHARD_OFFSET..$((SHARD_OFFSET + SHARD_COUNT - 1)) status + screenshots to $COLLECTOR_HOST"
