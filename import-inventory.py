"""Read the user's workbook; refresh the derived catalog without editing Excel."""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

base = Path(__file__).resolve().parent
source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(json.loads((base / 'camera-catalog.json').read_text())['source'])
workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
devices = []
sheets = []
for sheet in workbook:
    values = list(sheet.values)
    sheets.append({'name': sheet.title, 'address': sheet.calculate_dimension(), 'values': values})
    category = ''
    for row_number, row in enumerate(values, 1):
        if row[0]:
            category = str(row[0]).strip()
        if len(row) > 1 and row[1]:
            devices.append({'category': category, 'combination': str(row[1]).strip(), 'source_sheet': sheet.title, 'source_row': row_number})
if not devices:
    raise SystemExit('库存表未发现有效型号／组合，保留原目录')
catalog = {'source': str(source), 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'read_at': datetime.now(timezone.utc).isoformat(), 'devices': devices, 'sheets': sheets}
target = base / 'camera-catalog.json'
temp = target.with_suffix('.json.tmp')
temp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2))
os.chmod(temp, 0o600)
temp.replace(target)
print(json.dumps({'status': 'inventory_loaded', 'rows': len(devices), 'sheets': [s['name'] for s in sheets]}, ensure_ascii=False))
