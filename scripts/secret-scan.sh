#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"
patterns='(/Users/houhou|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|sk-[A-Za-z0-9_-]{16,}|DEEPSEEK_API_KEY=(?!replace-locally)|"api_key"[[:space:]]*:[[:space:]]*"(?!REPLACE_ON_LOCAL_MACHINE))'
if git grep -nPI "$patterns" -- ':!scripts/secret-scan.sh' ':!docs/SECURITY.md'; then
  echo "Potential secret or machine-specific value found." >&2
  exit 1
fi
echo "Tracked-file secret scan passed. This is a guardrail, not a complete security audit."
