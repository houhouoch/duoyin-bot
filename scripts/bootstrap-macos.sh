#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
command -v node >/dev/null || { echo "Node.js >=20 required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "Python 3 required" >&2; exit 1; }

python3 -m venv "$repo/.venv"
"$repo/.venv/bin/python3" -m pip install -r "$repo/requirements.txt"
npm install -g @wecom/cli@1.2.1
npx skills add WeComTeam/wecom-cli -y -g

if ! command -v hermes >/dev/null; then
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
fi

XHS_MCP_HOME="${XHS_MCP_HOME:-$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0}" bash "$repo/scripts/install-xhs-mcp.sh"
mkdir -p "$HOME/.hermes/profiles/xhs-rental-monitor/private" "$HOME/.hermes/profiles/wecom-case-assistant/wecom-cli" "$HOME/.hermes/profiles/xhs-rental-monitor/scripts" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME/.hermes/profiles/xhs-rental-monitor/private"
wecom_bin="$(command -v wecom-cli)"
sed -e "s|__DUOYIN_HOME__|$repo|g" -e "s|__WECOM_CLI_BIN__|$wecom_bin|g" "$repo/scripts/xhs-rental-four-hour.sh" > "$HOME/.hermes/profiles/xhs-rental-monitor/scripts/xhs-rental-four-hour.sh"
chmod 700 "$HOME/.hermes/profiles/xhs-rental-monitor/scripts/xhs-rental-four-hour.sh"

node_bin="$(command -v node)"
sed -e "s|__DUOYIN_HOME__|$repo|g" -e "s|__HOME__|$HOME|g" -e "s|__NODE_BIN__|$node_bin|g" "$repo/launchd/ai.duoyin.xhs-readonly-backend.plist.template" > "$HOME/Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist"
chmod 600 "$HOME/Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist"
bash "$repo/scripts/init-example-state.sh"

echo "Bootstrap complete. Continue with docs/MIGRATION.md; credentials and group name were not configured."
