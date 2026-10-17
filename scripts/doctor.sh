#!/bin/bash
set -u
failed=0
repo="$(cd "$(dirname "$0")/.." && pwd)"
check(){ if "$@" >/dev/null 2>&1; then printf 'OK  %s\n' "$*"; else printf 'FAIL %s\n' "$*"; failed=1; fi; }
check node --version
check python3 --version
check wecom-cli --version
check hermes --version
xhs_platform=linux-amd64
[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] && xhs_platform=darwin-arm64
check test -x "${XHS_MCP_HOME:-$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0}/xiaohongshu-mcp-$xhs_platform"
check curl -fsS "${XHS_BACKEND_URL:-http://127.0.0.1:18061}/health"
check test -f "${XHS_MCP_HOME:-$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0}/private/api-token"
check test -f "${DEEPSEEK_CONFIG:-$HOME/.hermes/profiles/xhs-rental-monitor/private/deepseek.json}"
check env WECOM_CLI_CONFIG_DIR="${WECOM_CLI_CONFIG_DIR:-$HOME/.hermes/profiles/wecom-case-assistant/wecom-cli}" wecom-cli auth show --status
check "$repo/.venv/bin/python3" -c 'import mcp, openpyxl, pypdf'
check node -e "require('$repo/node_modules/playwright')"
check test -f "$repo/monitor-config.json"
check test -f "$repo/camera-catalog.json"
exit "$failed"
