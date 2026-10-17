#!/bin/bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || { echo "This bootstrap supports Apple Silicon macOS." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js >=20 required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "Python 3 required" >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)'
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python >=3.10 required"'

python3 -m venv "$repo/.venv"
"$repo/.venv/bin/python3" -m pip install -r "$repo/requirements.txt"
(cd "$repo" && npm ci --ignore-scripts && npx playwright install chromium)
npm install -g @wecom/cli@1.2.1
npx skills add WeComTeam/wecom-cli -y -g

if ! command -v hermes >/dev/null; then
  hermes_commit=b52b725f625d4bd380201b7f655dae0f6cf87ffa
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/$hermes_commit/scripts/install.sh" -o "$installer"
  bash "$installer" --commit "$hermes_commit" --skip-setup --skip-browser --skip-computer-use
fi

XHS_MCP_HOME="${XHS_MCP_HOME:-$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0}" bash "$repo/scripts/install-xhs-mcp.sh"
python3 "$repo/scripts/configure-local.py"
bash "$repo/scripts/init-example-state.sh"

echo "Bootstrap complete. Continue with docs/MIGRATION.md; credentials and group name were not configured."
