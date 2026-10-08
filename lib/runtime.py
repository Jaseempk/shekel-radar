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
DEFAULT_SETTINGS_FILE = ROOT / 'config/settings.json'


def local_settings_file(env=None):
    """INCOME_SETTINGS_LOCAL names an override that must exist; otherwise the optional default."""
    explicit = (os.environ if env is None else env).get('INCOME_SETTINGS_LOCAL')
    # abspath, not resolve(): matches Node's path.resolve (no symlink expansion).
    return Path(os.path.abspath(explicit or ROOT / 'config/settings.local.json')), bool(explicit)


LOCAL_SETTINGS_FILE = local_settings_file()[0]
# Environment variables that may override a setting (applied last, when non-empty).
SETTINGS_ENV = {'INCOME_SOCIAL_MODEL': 'socialModel', 'INCOME_DRAFT_MODEL': 'draftModel'}
PROFILE_KEYS = ('profile.name', 'profile.website', 'profile.proof', 'profile.claimsRule')
SETTING_TYPES = {
    'socialModel': 'model', 'draftModel': 'model', 'candidateLocation': 'string',
    'minimumBuyerScore': 'score', 'rawRetentionDays': 'count', 'exportRetentionDays': 'count',
    'maxRawMB': 'count', 'profile': 'object', **{key: 'string' for key in PROFILE_KEYS},
}
TYPE_LABELS = {'model': 'a non-empty string', 'string': 'a string', 'score': 'an integer from 0 to 100',
               'count': 'a non-negative integer', 'object': 'an object'}


class SettingsError(ValueError):
    """Configuration is missing or invalid; the message says what to fix."""


def _display(file):
    file = Path(os.path.abspath(file))
    return file.relative_to(ROOT).as_posix() if file.is_relative_to(ROOT) else str(file)


def _read_settings(file, required):
    file = Path(file)
    if not file.exists():
        if required:
            raise SettingsError(f'Settings file not found: {_display(file)}')
        return {}
    try:
        value = json.loads(file.read_text(encoding='utf-8'))
    except ValueError as e:
        raise SettingsError(f'Settings file is not valid JSON: {_display(file)} ({e})') from None
    if not isinstance(value, dict):
        raise SettingsError(f'Settings file must contain a JSON object: {_display(file)}')
    return value


def _merge(base, override):
    merged = dict(base)
    for key, value in override.items():
        merged[key] = _merge(merged[key], value) if isinstance(value, dict) and isinstance(merged.get(key), dict) else value
    return merged


def _lookup(settings, key):
    value = settings
    for part in key.split('.'):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _check(key, value):
    kind = SETTING_TYPES.get(key)
    if kind is None:
        return value
    integer = isinstance(value, (int, float)) and not isinstance(value, bool) and float(value).is_integer()
    ok = {'model': isinstance(value, str) and value.strip() != '', 'string': isinstance(value, str),
          'score': integer and 0 <= value <= 100, 'count': integer and value >= 0,
          'object': isinstance(value, dict)}[kind]
    if not ok:
        raise SettingsError(f'Invalid setting {key}: must be {TYPE_LABELS[kind]}')
    return int(value) if kind in ('score', 'count') else value


def load_settings(env=None, defaults_file=DEFAULT_SETTINGS_FILE):
    """Committed defaults -> ignored local override -> supported environment variables.

    Objects merge key by key; other values replace. Only general settings are
    validated here, so collection works without sender facts (see require_profile).
    """
    env = os.environ if env is None else env
    local_file, explicit = local_settings_file(env)
    settings = _merge(_read_settings(defaults_file, True), _read_settings(local_file, explicit))
    for name, key in SETTINGS_ENV.items():
        if env.get(name):
            settings[key] = env[name]
    return {key: _check(key, value) for key, value in settings.items()}


def require_settings(keys, settings=None):
    """Return settings after checking that each dotted key is present, typed and non-empty."""
    settings = SETTINGS if settings is None else settings
    missing = []
    for key in keys:
        value = _lookup(settings, key)
        if value is None or (isinstance(value, str) and not value.strip()):
            missing.append(key)
        else:
            _check(key, value)
    if missing:
        raise SettingsError(
            f"Missing required settings: {', '.join(missing)}. Add them to {_display(LOCAL_SETTINGS_FILE)} "
            '(copy config/settings.local.example.json); drafting never invents sender facts.')
    return settings


def require_profile(settings=None):
    """Approved sender facts for drafting; raises SettingsError naming anything missing."""
    return require_settings(PROFILE_KEYS, settings)['profile']


SETTINGS = load_settings()


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
