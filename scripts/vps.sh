#!/usr/bin/env bash
# Manage the Fenix systemd service on a VPS over SSH.
# Usage: scripts/vps.sh <status|restart|stop|logs|logs:follow|deploy>
# Connection details come from .env.deploy (see .env.deploy.sample).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env.deploy ]]; then
  echo "Missing .env.deploy - copy .env.deploy.sample and fill in your VPS details." >&2
  exit 1
fi
# shellcheck disable=SC1091
source .env.deploy

: "${VPS_HOST:?VPS_HOST is required}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/id_ed25519}"
VPS_PATH="${VPS_PATH:-/opt/fenix-bot}"
SERVICE="${VPS_SERVICE:-fenix-bot}"
SERVICE_USER="${VPS_SERVICE_USER:-fenix-bot}"

SSH_OPTS=(-p "$VPS_PORT" -i "$VPS_KEY")
TARGET="$VPS_USER@$VPS_HOST"
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$1"; }

case "${1:-}" in
  status) remote "systemctl status $SERVICE" ;;
  restart) remote "systemctl restart $SERVICE && sleep 2 && systemctl status $SERVICE" ;;
  stop) remote "systemctl stop $SERVICE && echo stopped" ;;
  logs) remote "journalctl -u $SERVICE --no-pager -n 50" ;;
  logs:follow) remote "journalctl -u $SERVICE -f" ;;
  deploy)
    rsync -avz \
      --exclude='.env' --exclude='.env.deploy' --exclude='node_modules/' --exclude='.git/' \
      --exclude='.DS_Store' --exclude='.slack/' --exclude='.claude/' --exclude='data/' \
      --exclude='*.webp' --exclude='*.jpg' --exclude='tests/' --exclude='REVIEW-*.md' \
      -e "ssh -p $VPS_PORT -i $VPS_KEY" ./ "$TARGET:$VPS_PATH/"
    remote "cd $VPS_PATH && npm ci --omit=dev && chown -R $SERVICE_USER:$SERVICE_USER $VPS_PATH && systemctl restart $SERVICE && sleep 2 && systemctl status $SERVICE"
    ;;
  *)
    echo "Usage: $0 <status|restart|stop|logs|logs:follow|deploy>" >&2
    exit 1
    ;;
esac
