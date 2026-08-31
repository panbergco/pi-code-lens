/**
 * A decision a person makes must outlive the session that made it, and a
 * hand-edited file must never be able to break a session.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadSettings, saveSettings } from '../dist/core/settings.js';

const dir = mkdtempSync(join(tmpdir(), 'lens-settings-'));
const path = join(dir, 'settings.json');

assert.deepEqual(loadSettings(path), DEFAULTS, 'a first run gets the measured defaults');

assert.equal(saveSettings({ ...DEFAULTS, augment: false }, path), true);
assert.equal(loadSettings(path).augment, false, 'switching it off is remembered');

writeFileSync(path, '{ not json');
assert.deepEqual(loadSettings(path), DEFAULTS, 'a corrupt file falls back, it does not throw');

writeFileSync(path, JSON.stringify({ maxSubjects: 500, budgetTokens: 1, timeoutMs: -9, augment: 'yes' }));
const s = loadSettings(path);
assert.equal(s.maxSubjects, 5, 'an absurd cap is clamped, not obeyed');
assert.equal(s.budgetTokens, 60, 'a budget too small to say anything is raised to the floor');
assert.equal(s.timeoutMs, 500, 'a negative deadline becomes the minimum');
writeFileSync(path, JSON.stringify({ repeatAfterMinutes: 99999 }));
assert.equal(loadSettings(path).repeatAfterMinutes, 24 * 60, 'a repeat window longer than a day is clamped');
assert.equal(s.augment, DEFAULTS.augment, 'a wrong type falls back to the default');

assert.equal(saveSettings(DEFAULTS, '/etc/passwd/nope/settings.json'), false,
  'an unwritable location is reported, never thrown');

rmSync(dir, { recursive: true, force: true });
console.log('ok — settings persist, clamp what is absurd, and survive a bad hand edit');
