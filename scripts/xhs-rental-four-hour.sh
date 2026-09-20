#!/bin/bash
set -euo pipefail

repo="${DUOYIN_HOME:-__DUOYIN_HOME__}"
[ "$repo" != "__DUOYIN_HOME__" ] || { echo "DUOYIN_HOME is required" >&2; exit 1; }
node_bin="${NODE_BIN:-$(command -v node)}"
export DUOYIN_HOME="$repo"
export DUOYIN_PYTHON="${DUOYIN_PYTHON:-$repo/.venv/bin/python3}"
export WECOM_CLI_BIN="${WECOM_CLI_BIN:-__WECOM_CLI_BIN__}"
exec "$node_bin" "$repo/run-four-hour.cjs"
