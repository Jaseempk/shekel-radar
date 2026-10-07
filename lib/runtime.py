"""Predictable paths, configuration and atomic output for Python commands."""
from pathlib import Path
import json
import os
import tempfile
import re

ROOT = Path(__file__).resolve().parent.parent
def load_env_file(file):
    if not file.exists():
        return
    for line in file.read_text().splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not match or match[1] in os.environ:
            continue
        raw = match[2].strip()
        if raw.startswith(('"', "'")):
            raw = raw[1:raw.find(raw[0], 1)]
        else:
            raw = re.split(r"\s+#", raw)[0].strip()
        os.environ[match[1]] = raw


load_env_file(ROOT / '.env')
DATA_ROOT = Path(os.environ.get('INCOME_DATA_DIR', ROOT)).resolve()
SETTINGS = json.loads((ROOT / 'config/settings.json').read_text())


def atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=path.name + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def write_json(path, value):
    atomic_write(path, json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def load_credentials():
    if os.environ.get('ANTHROPIC_API_KEY'):
        return
    os.environ.pop('ANTHROPIC_API_KEY', None)
    load_env_file(ROOT / 'reddit-mining/.env')


def anthropic_client():
    load_credentials()
    from anthropic import Anthropic
    return Anthropic(timeout=60.0, max_retries=2)
