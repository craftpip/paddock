#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Strip embedded git repos that would become submodules
sudo find instances/ -name '.git' -type d -exec rm -rf {} + 2>/dev/null || true

# Add everything and commit
sudo git add -A
sudo git diff --cached --quiet || sudo git commit --author="boniface <boniface@users.noreply.github.com>" -m "Daily auto-commit: $(date -u +"%Y-%m-%d %H:%M UTC")"
sudo git push origin master
