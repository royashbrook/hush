#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-backup-test-'));
const home = path.join(root, 'home');
const bin = path.join(root, 'bin');
const dest = path.join(root, 'encrypted');
const cloud = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs');
const config = path.join(home, 'Library/Application Support/hush/backup-schedule.json');
const plist = path.join(home, 'Library/LaunchAgents/com.royashbrook.hush.backup.plist');
fs.mkdirSync(bin, { recursive: true });
function fake(name, source) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  return file;
}
const hush = fake('hush', `
const a = process.argv.slice(2);
if (a[0] === 'list') { if (process.env.FAIL_LIST) process.exit(1); console.log('hush-backup-key\\nalpha'); }
else if (a[0] === 'pipe') {
  if (a[1] === 'hush-backup-key' && process.env.FAIL_KEY) process.exit(1);
  const value = a[1] === 'hush-backup-key' ? (process.env.EMPTY_KEY ? '' : 'fixture-backup-key') : 'fixture-backup-value';
  process.stdout.write(a[3] === 'base64' ? Buffer.from(value).toString('base64') : value);
} else process.exit(1);
`);
const gpg = fake('gpg', `
const fs = require('node:fs');
const a = process.argv.slice(2);
const pass = fs.readFileSync(3, 'utf8').trim();
const bundle = fs.readFileSync(0, 'utf8');
if (pass !== 'fixture-backup-key' || !bundle.includes('alpha\\t' + Buffer.from('fixture-backup-value').toString('base64'))) process.exit(2);
fs.writeFileSync(a[a.indexOf('-o') + 1], 'FAKE-CIPHERTEXT');
if (process.env.FAIL_GPG) { console.error('fixture-backup-value'); process.exit(1); }
`);
const ctl = fake('launchctl', `
const fs = require('node:fs');
const a = process.argv.slice(2), state = process.env.TEST_STATE, once = process.env.TEST_FAIL_ONCE;
if (a[0] === 'print') process.exit(a[1].endsWith('/com.hush-backup') ? 1 : fs.existsSync(state) ? 0 : 1);
if (a[0] === 'bootout') { fs.rmSync(state, {force:true}); process.exit(0); }
if (a[0] === 'bootstrap') {
  if (once && fs.existsSync(once)) { fs.rmSync(once); process.exit(1); }
  if (!fs.existsSync(a[2])) process.exit(1);
  fs.writeFileSync(state, 'loaded'); process.exit(0);
}
process.exit(1);
`);
const env = { ...process.env, HUSH_NS: 'synthetic-backup-test', HUSH_BACKUP_SCHEDULE_HOME: home,
  HUSH_BACKUP_SCHEDULE_PLATFORM: 'darwin', HUSH_BACKUP_HUSH: hush, HUSH_BACKUP_GPG: gpg,
  HUSH_BACKUP_SCHEDULE_LAUNCHCTL: ctl, TEST_STATE: path.join(root, 'loaded'),
  TEST_FAIL_ONCE: path.join(root, 'fail-once'), HUSH_BACKUP_DIR: dest,
  PATH: `${bin}${path.delimiter}${process.env.PATH}` };
const secrets = ['fixture-backup-key', 'fixture-backup-value'];
function check(result, status = 0) {
  for (const value of secrets) assert.ok(!`${result.stdout}${result.stderr}`.includes(value), 'value leaked to output');
  assert.equal(result.status, status, result.stderr);
  return result;
}
const schedule = (args, status = 0, extra = {}) => check(spawnSync(process.execPath, [path.join(repo, 'helpers/hush-backup-schedule.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' }), status);
const backup = (args, status = 0, extra = {}) => check(spawnSync('bash', [path.join(repo, 'helpers/hush-backup'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' }), status);
const files = () => fs.existsSync(dest) ? fs.readdirSync(dest).filter((name) => name.endsWith('.gpg')) : [];
try {
  schedule(['--help']);
  backup(['--help']);
  backup(['--auto', 'unexpected'], 1);
  backup(['--dry-run', 'unexpected'], 1);
  backup(['--restore'], 1);
  schedule(['install'], 1); // Missing iCloud must not be invented by mkdir.
  assert.ok(!fs.existsSync(config));
  backup(['--dry-run']);
  assert.ok(!fs.existsSync(dest), 'dry-run must not create destination');
  backup(['--auto'], 1, { FAIL_KEY: '1' });
  backup(['--auto'], 1, { EMPTY_KEY: '1' });
  backup(['--auto'], 1, { FAIL_LIST: '1' });
  backup(['--auto'], 1, { FAIL_GPG: '1' });
  assert.deepEqual(files(), [], 'failed encryption must not publish');
  assert.deepEqual(fs.readdirSync(dest), [], 'failed encryption cleans staging ciphertext');
  for (const keep of ['0', '-1', 'wat', '10001']) backup(['--auto'], 1, { HUSH_BACKUP_KEEP: keep });
  backup(['--auto'], 0, { SHELLOPTS: 'xtrace', HUSH_BACKUP_KEEP: '02' });
  backup(['--auto'], 0, { HUSH_BACKUP_KEEP: '2' });
  assert.equal(files().length, 2, 'same-second backups do not overwrite');
  backup(['--auto'], 0, { HUSH_BACKUP_KEEP: '2' });
  assert.equal(files().length, 2, 'retention bounded');
  fs.writeFileSync(path.join(dest, 'unrelated.gpg'), 'keep');
  backup(['--auto'], 0, { HUSH_BACKUP_KEEP: '1' });
  assert.ok(fs.existsSync(path.join(dest, 'unrelated.gpg')), 'retention preserves unrelated files');
  schedule(['install', '--directory', dest], 1, { FAIL_LIST: '1' });
  assert.ok(!fs.existsSync(config), 'failed dry-run cannot install');
  schedule(['install', '--directory', dest, '--every', '7h'], 1);
  schedule(['install', '--directory', dest, '--keep', '0'], 1);
  fs.mkdirSync(cloud, { recursive: true });
  schedule(['install', '--directory', dest, '--keep', '2']);
  const original = fs.readFileSync(config, 'utf8');
  assert.equal(JSON.parse(original).namespace, env.HUSH_NS);
  assert.ok(fs.readFileSync(plist, 'utf8').includes('StartCalendarInterval'));
  assert.ok(!fs.readFileSync(plist, 'utf8').includes('StartInterval'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  for (const value of secrets) assert.ok(!original.includes(value), 'config contains secret');
  schedule(['status']);
  schedule(['run']);
  schedule(['run'], 1, { FAIL_GPG: '1' });
  fs.writeFileSync(env.TEST_FAIL_ONCE, 'fail next bootstrap');
  schedule(['install', '--directory', dest, '--every', '12h'], 1);
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'failed reinstall restores previous config');
  schedule(['status']);
  const legacy = path.join(home, 'Library/LaunchAgents/com.hush-backup.plist');
  fs.writeFileSync(legacy, 'legacy');
  schedule(['install', '--directory', dest], 1);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy', 'legacy schedule unchanged');
  schedule(['remove']);
  schedule(['remove']);
  schedule(['status'], 1);
  assert.ok(fs.existsSync(config) && fs.existsSync(dest) && fs.existsSync(legacy), 'remove preserves data and legacy schedule');
  assert.ok(!fs.existsSync(plist));
  console.log('ok   - backup helper and scheduler: dry-run, no leaks, failures, retention, rollback, removal');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
