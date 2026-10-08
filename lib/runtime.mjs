import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Root .env is optional; the actual process environment always wins.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    const raw = match[2].trim();
    process.env[match[1]] = /^['"]/.test(raw) ? raw.slice(1, raw.indexOf(raw[0], 1)) : raw.split(/\s+#/)[0].trim();
  }
}
export const DATA_ROOT = path.resolve(process.env.INCOME_DATA_DIR || ROOT);
export const statePath = (...parts) => path.join(DATA_ROOT, 'state', ...parts);
export const exportPath = (...parts) => path.join(DATA_ROOT, 'exports', ...parts);
export const dayStamp = () => new Date().toISOString().slice(0, 10);
export const runStamp = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
export function option(flag, fallback, argv = process.argv.slice(2)) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
  return argv[i + 1];
}
export function integerOption(flag, fallback, min = 0, argv = process.argv.slice(2)) {
  const value = Number(option(flag, fallback, argv));
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${flag} must be an integer >= ${min}`);
  return value;
}
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function apiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const file of [path.join(ROOT, '.env'), path.join(ROOT, 'reddit-mining', '.env')]) {
    if (!fs.existsSync(file)) continue;
    const line = fs.readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim();
    if (line) return line.startsWith('"') || line.startsWith("'") ? line.slice(1, line.indexOf(line[0], 1)) : line.split(/\s+#/)[0].trim();
  }
  throw new Error('Set ANTHROPIC_API_KEY in the environment or project .env');
}

// Settings: committed defaults -> ignored local override -> supported environment variables.
// lib/runtime.py implements the same precedence, validation and messages.
export const DEFAULT_SETTINGS_FILE = path.join(ROOT, 'config', 'settings.json');
export function localSettingsFile(env = process.env) {
  const explicit = env.INCOME_SETTINGS_LOCAL;
  return [path.resolve(explicit || path.join(ROOT, 'config', 'settings.local.json')), Boolean(explicit)];
}
export const LOCAL_SETTINGS_FILE = localSettingsFile()[0];
export const SETTINGS_ENV = { INCOME_SOCIAL_MODEL: 'socialModel', INCOME_DRAFT_MODEL: 'draftModel' };
export const PROFILE_KEYS = ['profile.name', 'profile.website', 'profile.proof', 'profile.claimsRule'];
const SETTING_TYPES = {
  socialModel: 'model', draftModel: 'model', candidateLocation: 'string',
  minimumBuyerScore: 'score', rawRetentionDays: 'count', exportRetentionDays: 'count',
  maxRawMB: 'count', profile: 'object', ...Object.fromEntries(PROFILE_KEYS.map((key) => [key, 'string'])),
};
const TYPE_LABELS = { model: 'a non-empty string', string: 'a string', score: 'an integer from 0 to 100', count: 'a non-negative integer', object: 'an object' };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class SettingsError extends Error {
  constructor(message) { super(message); this.name = 'SettingsError'; }
}
function display(file) {
  const rel = path.relative(ROOT, path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.resolve(file);
}
function readSettings(file, required) {
  if (!fs.existsSync(file)) {
    if (required) throw new SettingsError(`Settings file not found: ${display(file)}`);
    return {};
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new SettingsError(`Settings file is not valid JSON: ${display(file)} (${e.message})`);
  }
  if (!isObject(value)) throw new SettingsError(`Settings file must contain a JSON object: ${display(file)}`);
  return value;
}
function merge(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = isObject(value) && isObject(merged[key]) ? merge(merged[key], value) : value;
  return merged;
}
function lookup(current, key) {
  let value = current;
  for (const part of key.split('.')) {
    if (!isObject(value) || !Object.hasOwn(value, part)) return null;
    value = value[part];
  }
  return value;
}
function check(key, value) {
  const kind = SETTING_TYPES[key];
  if (!kind) return value;
  const integer = typeof value === 'number' && Number.isInteger(value);
  const ok = { model: typeof value === 'string' && value.trim() !== '', string: typeof value === 'string',
    score: integer && value >= 0 && value <= 100, count: integer && value >= 0, object: isObject(value) }[kind];
  if (!ok) throw new SettingsError(`Invalid setting ${key}: must be ${TYPE_LABELS[kind]}`);
  return value;
}
export function loadSettings(env = process.env, defaultsFile = DEFAULT_SETTINGS_FILE) {
  const [localFile, explicit] = localSettingsFile(env);
  const merged = merge(readSettings(defaultsFile, true), readSettings(localFile, explicit));
  for (const [name, key] of Object.entries(SETTINGS_ENV)) if (env[name]) merged[key] = env[name];
  return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, check(key, value)]));
}
/** Return settings after checking that each dotted key is present, typed and non-empty. */
export function requireSettings(keys, current = settings) {
  const missing = [];
  for (const key of keys) {
    const value = lookup(current, key);
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) missing.push(key);
    else check(key, value);
  }
  if (missing.length) {
    throw new SettingsError(`Missing required settings: ${missing.join(', ')}. Add them to ${display(LOCAL_SETTINGS_FILE)} `
      + '(copy config/settings.local.example.json); drafting never invents sender facts.');
  }
  return current;
}
/** Approved sender facts for drafting; throws SettingsError naming anything missing. */
export const requireProfile = (current = settings) => requireSettings(PROFILE_KEYS, current).profile;
export const settings = loadSettings();

export function dateOption(flag = '--day') {
  const day = option(flag, dayStamp());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) {
    throw new Error(`${flag} must be a valid YYYY-MM-DD date`);
  }
  return day;
}
