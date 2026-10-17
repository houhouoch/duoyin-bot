#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
copy_if_missing(){ [ -e "$repo/$2" ] || cp "$repo/$1" "$repo/$2"; }
copy_if_missing monitor-config.example.json monitor-config.json
copy_if_missing camera-catalog.example.json camera-catalog.json
copy_if_missing merchant-registry.example.json merchant-registry.json
[ -e "$repo/watchlist.json" ] || printf '%s\n' '{"version":1,"paused":null,"notes":{},"seen_comments":{},"outbox":{},"suppressed":{},"pending_details":{},"query_rotation":0,"diversity_round":0,"hot_pools":{}}' > "$repo/watchlist.json"
[ -e "$repo/leads-history.json" ] || printf '%s\n' '{"version":1,"sent":{}}' > "$repo/leads-history.json"
[ -e "$repo/four-hour-delivery.json" ] || printf '%s\n' '{"version":1,"batches":{},"reports":{},"documents":{}}' > "$repo/four-hour-delivery.json"
chmod 600 "$repo"/{monitor-config.json,camera-catalog.json,merchant-registry.json,watchlist.json,leads-history.json,four-hour-delivery.json}
