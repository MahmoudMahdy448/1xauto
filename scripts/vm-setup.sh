#!/usr/bin/env bash
# Provision an Oracle Cloud Always Free Ubuntu VM (VM.Standard.A1.Flex, 2 OCPU/12 GB)
# to run the 1xauto batch via cron. Idempotent — safe to re-run.
#
# Usage (on the VM, as a sudo user):
#   sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/MahmoudMahdy448/1xauto/main/scripts/vm-setup.sh -o /tmp/vm-setup.sh && bash /tmp/vm-setup.sh'
# Or copy the script up and run it.
#
# After this script: upload secrets and start the service:
#   scp .env accounts.csv ubuntu@<vm-ip>:~
#   ssh ubuntu@<vm-ip> 'sudo mv ~/.env ~/accounts.csv /opt/1xauto/ && sudo systemctl enable --now 1xauto-batch'
set -euo pipefail

APP_DIR="/opt/1xauto"
REPO_URL="https://github.com/MahmoudMahdy448/1xauto.git"
RUN_USER="${SUDO_USER:-ubuntu}"

log() { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

log "Updating apt and installing prerequisites..."
apt-get update -y
apt-get install -y curl git unzip ca-certificates gnupg

log "Adding swap (2 GiB) for low-RAM instances (B2ats_v2 = 1 GiB)..."
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
log "Swap: $(free -h | awk '/^Swap:/ { print $2 }')"

log "Installing Node.js 22 (NodeSource)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "node: $(node --version)  npm: $(npm --version)"

log "Cloning 1xauto into ${APP_DIR}..."
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
log "Installing npm dependencies..."
npm install

log "Installing Chromium + OS deps for Playwright..."
npx playwright install --with-deps chromium

log "Adding cron job (every 60 min)..."
CRON_LINE="0 * * * * cd $APP_DIR && LOW_MEMORY=true $(command -v node) $APP_DIR/scripts/scheduled-run.mjs >> $APP_DIR/logs/cron.log 2>&1"
( crontab -u "$RUN_USER" -l 2>/dev/null || true; echo "$CRON_LINE" ) | crontab -u "$RUN_USER" -
log "Cron installed for $RUN_USER: $CRON_LINE"

log "Reminding about secrets..."
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "  [!] .env not present yet — upload it, e.g.:  scp .env $RUN_USER@<vm-ip>:~"
  echo "  [!] accounts.csv likewise. Then: sudo mv ~/.env ~/accounts.csv $APP_DIR/"
fi

log "Done. Verify with:  crontab -l -u $RUN_USER"
log "First live run (after .env + accounts.csv are in place):"
log "  cd $APP_DIR && ALLOW_LIVE_RUN=true HEADLESS=true LOW_MEMORY=true node scripts/scheduled-run.mjs"
