#!/bin/bash
set -euo pipefail

version="v2.5.0"
root="${XHS_MCP_HOME:-$HOME/.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform="darwin-arm64"; mcp_sha="3e32e08c3403d22a5efef2f06aa52630b458819fc54474cba23e896c7092c38e"; login_sha="db5d07c03933b8192dab726d896a028721b096ea452f6e9967ef63a30618ba99" ;;
  Linux-x86_64) platform="linux-amd64"; mcp_sha="2695820af3a924412c0e555042b81a2598d144342539d4ebea18b17d56c85fbf"; login_sha="367c865f3adc4dfa3407417401a911da313765da12680d1d8f46cae3ea124393" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$root/private"
chmod 700 "$root" "$root/private"
for name in xiaohongshu-mcp xiaohongshu-login; do
  file="$name-$platform"
  curl -fL "https://github.com/xpzouying/xiaohongshu-mcp/releases/download/$version/$file" -o "$root/$file"
  expected="$mcp_sha"; [ "$name" = xiaohongshu-login ] && expected="$login_sha"
  actual="$(shasum -a 256 "$root/$file" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || { echo "SHA-256 mismatch: $file" >&2; exit 1; }
  chmod 700 "$root/$file"
done
echo "$root"
