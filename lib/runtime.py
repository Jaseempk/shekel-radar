"""Predictable paths, configuration and atomic output for Python commands."""
from pathlib import Path
import json
import os
import tempfile

ROOT = Path(__file__).resolve().parent.parent
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
    from dotenv import load_dotenv
    load_dotenv(ROOT / '.env', override=False)
    load_dotenv(ROOT / 'reddit-mining/.env', override=False)


def anthropic_client():
    load_credentials()
    from anthropic import Anthropic
    return Anthropic(timeout=60.0, max_retries=2)
