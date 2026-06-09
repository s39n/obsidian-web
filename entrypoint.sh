#!/bin/sh
set -e

# Download Obsidian renderer bundles on first start (or if the volume is empty).
# Results are cached in the `obsidian_vendor` Docker volume — subsequent starts
# are instant because the files are already there.

if [ ! -f /app/vendor/obsidian/app.js ]; then
  echo "[docker] Downloading Obsidian desktop renderer (first run — this takes ~30s)..."
  node scripts/update-obsidian.js
fi

if [ ! -f /app/vendor/obsidian-mobile/app.js ]; then
  echo "[docker] Downloading Obsidian mobile renderer (first run — this takes ~30s)..."
  node scripts/update-obsidian-mobile.js
fi

exec "$@"
