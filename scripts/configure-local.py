"""Render local paths without copying credentials or enabling any services."""
import os
from pathlib import Path
import plistlib
import shlex
import shutil

repo = Path(__file__).resolve().parent.parent
home = Path.home()
monitor = home / '.hermes/profiles/xhs-rental-monitor'
assistant = home / '.hermes/profiles/wecom-case-assistant'
xhs = Path(os.environ.get('XHS_MCP_HOME', home / '.local/share/duoyin-bot/xiaohongshu-mcp-v2.5.0')).expanduser().resolve()
for directory in [monitor / 'private', monitor / 'scripts', assistant / 'wecom-cli', home / 'Library/LaunchAgents', home / 'Library/Logs']:
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
node = shutil.which('node')
wecom = shutil.which('wecom-cli')
if not node or not wecom:
    raise SystemExit('Install node and wecom-cli before rendering local configuration.')
values = {
    'DUOYIN_HOME': str(repo), 'NODE_BIN': node,
    'DUOYIN_PYTHON': str(repo / '.venv/bin/python3'),
    'WECOM_CLI_BIN': wecom, 'WECOM_CLI_CONFIG_DIR': str(assistant / 'wecom-cli'),
    'HERMES_MONITOR_HOME': str(monitor), 'XHS_MCP_HOME': str(xhs),
    'HERMES_BIN': shutil.which('hermes') or str(home / '.local/bin/hermes'),
}
wrapper = '#!/bin/bash\nset -euo pipefail\n'
wrapper += ''.join(f'export {key}={shlex.quote(value)}\n' for key, value in values.items())
wrapper += 'export TZ=Asia/Shanghai\nexec "$NODE_BIN" "$DUOYIN_HOME/run-four-hour.cjs" "$@"\n'
target = monitor / 'scripts/xhs-rental-four-hour.sh'
target.write_text(wrapper)
target.chmod(0o700)
for name, profile in [('xhs-rental-monitor', monitor), ('wecom-case-assistant', assistant)]:
    target = profile / 'config.yaml'
    if not target.exists():
        shutil.copyfile(repo / f'hermes/{name}.config.example.yaml', target)
        target.chmod(0o600)
monitor_env = monitor / '.env'
if not monitor_env.exists():
    monitor_env.write_text('TZ=Asia/Shanghai\n')
    monitor_env.chmod(0o600)
assistant_env = assistant / '.env'
if not assistant_env.exists():
    assistant_env.write_text('DEEPSEEK_API_KEY=replace-locally\nHERMES_XHS_JOB_ID=replace-after-cron-create\n' +
                             ''.join(f'{key}={shlex.quote(value)}\n' for key, value in values.items()))
    assistant_env.chmod(0o600)
plist = plistlib.loads((repo / 'launchd/ai.duoyin.xhs-readonly-backend.plist.template').read_bytes())
plist['ProgramArguments'] = [node, str(repo / 'scripts/start-xhs-backend.cjs')]
plist['WorkingDirectory'] = str(repo)
plist['EnvironmentVariables'] = {'DUOYIN_HOME': str(repo), 'XHS_MCP_HOME': str(xhs)}
for key in ['StandardOutPath', 'StandardErrorPath']:
    plist[key] = str(home / 'Library/Logs/duoyin-xhs-backend.log')
target = home / 'Library/LaunchAgents/ai.duoyin.xhs-readonly-backend.plist'
target.write_bytes(plistlib.dumps(plist))
target.chmod(0o600)
print('Local templates rendered. No login, cron, gateway or backend was started.')
