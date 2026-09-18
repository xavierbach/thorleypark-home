#!/bin/bash
# Install (or reinstall) the LaunchAgent that keeps the timelapse server running on this Mac.
# Usage: ./scripts/install-launchagent.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.thorleypark.timelapse"
PLIST_SRC="$APP_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install with: brew install node" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "warning: ffmpeg not found on PATH. Install with: brew install ffmpeg" >&2
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/TimelapseData"
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__HOME__|$HOME|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $PLIST_DST"
echo "Logs: $HOME/Library/Logs/thorleypark-timelapse.log"
echo "Open: http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):3006"
