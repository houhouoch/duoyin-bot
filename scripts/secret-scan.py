"""Check publishable worktree and index bytes; never print matched secret text."""
from pathlib import Path
import re
import subprocess
import sys

repo = Path(__file__).resolve().parent.parent
patterns = [
    ('personal path', re.compile(r'/' + r'Users/(?!yourname(?:/|\b))[^/\s\'"<>]+/')),
    ('API key', re.compile(r'\bsk-[A-Za-z0-9_-]{16,}')),
    ('bearer credential', re.compile(r'Bearer\s+[A-Za-z0-9._-]{16,}', re.I)),
    ('platform identifier', re.compile(r'\b(?:[a-f0-9]{24}|a1_[A-Za-z0-9]{18,})\b')),
    ('private key', re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ('GitHub credential', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})')),
]
allowed_values = {'REPLACE_ON_LOCAL_MACHINE', 'replace-locally', 'fixture', 'test-only', 'test-only-placeholder'}
key_pattern = re.compile(r'''["']api_key["']\s*:\s*["']([^"']*)["']''')
forbidden = re.compile(r'(?:^|/)(?:private|backups|node_modules|\.venv|smartpage|output)/|(?:^|/)(?:watchlist|leads-history|four-hour-delivery|monitor-config|camera-catalog|merchant-registry|deepseek)\.json$|\.xlsx?$|\.pdf$|\.jsonl$|\.log$|(?:^|/)\.env(?:\.|$)')
files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=repo).decode().split('\0')
findings = []
for name in sorted(set(filter(None, files))):
    if forbidden.search(name) and not name.endswith('.env.example'):
        findings.append(f'{name}: forbidden runtime/private file')
        continue
    versions = []
    path = repo / name
    if path.is_file():
        versions.append(('worktree', path.read_bytes()))
    staged = subprocess.run(['git', 'show', ':' + name], cwd=repo, capture_output=True)
    if staged.returncode == 0:
        versions.append(('index', staged.stdout))
    for origin, raw in versions:
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            findings.append(f'{name} ({origin}): unexpected binary file')
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for label, pattern in patterns:
                if pattern.search(line):
                    findings.append(f'{name}:{number} ({origin}): {label}')
            if any(value not in allowed_values for value in key_pattern.findall(line)):
                findings.append(f'{name}:{number} ({origin}): literal API credential')
            if re.search(r'^DEEPSEEK_API_KEY=(?!replace-locally\s*$)', line):
                findings.append(f'{name}:{number} ({origin}): environment credential')
if findings:
    print('\n'.join(findings), file=sys.stderr)
    raise SystemExit(1)
print(f'Publishable-file scan passed ({len(set(filter(None, files)))} files, worktree and index). No matching values printed.')
