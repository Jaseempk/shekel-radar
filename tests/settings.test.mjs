import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, SettingsError, loadSettings, requireProfile, requireSettings } from '../lib/runtime.mjs';

function temp(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  const file = path.join(dir, 'local.json');
  fs.writeFileSync(file, typeof local === 'string' ? local : JSON.stringify(local));
  return { dir, file };
}

test('local override and environment layer over committed defaults', () => {
  const { file } = temp({ socialModel: 'local-social', minimumBuyerScore: 60, profile: { name: 'Test Sender' } });
  const s = loadSettings({ INCOME_SETTINGS_LOCAL: file, INCOME_SOCIAL_MODEL: 'env-social' });
  assert.equal(s.socialModel, 'env-social');
  assert.equal(s.minimumBuyerScore, 60);
  assert.equal(s.profile.name, 'Test Sender');
  assert.ok(s.profile.claimsRule, 'default claims rule survives the object merge');
});

test('committed defaults load without a local override and do not satisfy drafting', () => {
  const { file } = temp({});
  const s = loadSettings({ INCOME_SETTINGS_LOCAL: file });
  assert.equal(typeof s.candidateLocation, 'string');
  assert.throws(() => requireProfile(s), (e) => e instanceof SettingsError && /profile\.name, profile\.website, profile\.proof\./.test(e.message));
  assert.throws(() => requireSettings(['draftModel', 'profile.website'], s), SettingsError);
  assert.equal(requireSettings(['draftModel'], s), s);
});

test('invalid override values are rejected with the setting name', () => {
  const { file } = temp({ maxRawMB: '1GB' });
  assert.throws(() => loadSettings({ INCOME_SETTINGS_LOCAL: file }), /Invalid setting maxRawMB: must be a non-negative integer/);
  assert.throws(() => loadSettings({ INCOME_SETTINGS_LOCAL: path.join(os.tmpdir(), 'no-such-settings.json') }), /Settings file not found/);
});

test('collectors print help without a profile or credentials', () => {
  const { dir, file } = temp({});
  for (const script of ['x-radar/radar.mjs', 'fb-radar/radar.mjs']) {
    const env = { ...process.env, INCOME_DATA_DIR: dir, INCOME_SETTINGS_LOCAL: file };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync(process.execPath, [path.join(ROOT, script), '--help'], { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  }
});
