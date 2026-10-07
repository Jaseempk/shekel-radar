import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
export const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));
