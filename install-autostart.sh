#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# install-autostart.sh
# Run this ONCE to make The Dispatch start automatically when you log in.
#
# Usage:   bash install-autostart.sh
# Undo:    bash install-autostart.sh --uninstall
# ─────────────────────────────────────────────────────────────────────────────

PLIST_LABEL="com.thedispatch.server"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$PLIST_LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(command -v node)"
LOG_DIR="$PROJECT_DIR/logs"

# ── Uninstall mode ────────────────────────────────────────────────────────────
if [ "$1" = "--uninstall" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null
  rm -f "$PLIST_PATH"
  echo "✓ Auto-start removed. The Dispatch will no longer start on login."
  exit 0
fi

# ── Check prerequisites ───────────────────────────────────────────────────────
if [ -z "$NODE_PATH" ]; then
  echo "✗ Node.js not found. Install from https://nodejs.org first."
  exit 1
fi

mkdir -p "$PLIST_DIR"
mkdir -p "$LOG_DIR"

# ── Write the LaunchAgent plist ───────────────────────────────────────────────
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${PROJECT_DIR}/server/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <!-- Start on login -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <true/>

  <!-- Logs -->
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.error.log</string>

  <!-- Throttle restarts to avoid boot loops -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
EOF

# ── Load it now (no need to log out) ─────────────────────────────────────────
launchctl unload "$PLIST_PATH" 2>/dev/null   # unload if already registered
launchctl load -w "$PLIST_PATH"

echo ""
echo "✓ Auto-start installed."
echo "  The Dispatch server will now start automatically when you log in."
echo "  It's also running right now — open http://localhost:3001 in your browser."
echo ""
echo "  Logs: $LOG_DIR/server.log"
echo "  To remove auto-start: bash $PROJECT_DIR/install-autostart.sh --uninstall"
