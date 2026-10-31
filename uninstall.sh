#!/bin/bash
# SPDX-License-Identifier: MIT
# Disables and removes the KWin script. Usage: ./uninstall.sh
set -euo pipefail
ID=scenicview
kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" false
busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure
kpackagetool6 --type=KWin/Script --remove "$ID"
echo "Scenic View removed. Windows keep their current geometry until moved or re-maximized."
