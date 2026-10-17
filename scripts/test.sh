#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/duoyin-tests.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT
python3 - "$repo" "$test_root" <<'PY'
import pathlib, shutil, subprocess, sys
repo, target = map(pathlib.Path, sys.argv[1:])
names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=repo).decode().split('\0')
for name in set(filter(None, names)):
    source = repo / name
    if source.is_file():
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
for name in ['node_modules', '.venv']:
    if (repo / name).exists():
        (target / name).symlink_to(repo / name, target_is_directory=True)
PY
bash "$test_root/scripts/init-example-state.sh"
export DUOYIN_PYTHON="${DUOYIN_PYTHON:-$repo/.venv/bin/python3}"
export NODE_PATH="$repo/node_modules"
unset WECOM_CLI_BIN WECOM_CLI_CONFIG_DIR DEEPSEEK_CONFIG DUOYIN_HOME XHS_BACKEND_URL
cd "$test_root"
node scan.cjs --selftest
node --test --test-concurrency=1 ./*.test.cjs
"$DUOYIN_PYTHON" -m unittest patrol_control_test.py
