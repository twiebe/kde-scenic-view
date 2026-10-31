#!/bin/bash
# SPDX-License-Identifier: MIT
# Installs (or upgrades) the KWin script for the current user and enables it.
# No root needed. Usage: ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
ID=scenicview

reconfigure() { busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure; }

if ! kpackagetool6 --type=KWin/Script --install package 2>/dev/null; then
  # Already installed: upgrade. A running script is not reloaded on upgrade,
  # so disable it and enable it again below.
  kpackagetool6 --type=KWin/Script --upgrade package
  kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" false
  reconfigure
fi
kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true
reconfigure
echo "Scenic View installed and enabled."
echo "Settings: System Settings > Window Management > KWin Scripts > Scenic View (gear icon)"
echo "Shortcut: Meta+Alt+S (System Settings > Keyboard > Shortcuts > KWin)"
echo "Note: after changing settings, reload the script (uncheck, Apply, check, Apply) or run ./install.sh again."
