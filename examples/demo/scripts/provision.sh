#!/bin/sh
# Creates the demo tenants on first boot, migrates everyone on later boots, then starts the app.
set -eu
TENANTS=./node_modules/.bin/tenants
for slug in acme globex initech; do
  if ! "$TENANTS" list --json | grep -q "\"slug\": \"$slug\""; then
    "$TENANTS" create "$slug"
  fi
done
"$TENANTS" migrate --all --concurrency 3
exec node dist/main.js
