#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$repo/scripts/secret-scan.py"
