#!/usr/bin/env node
// Opt-in macOS integration test: real Keychain, GPG, and a uniquely labelled launchd job.
// Uses synthetic data, a disposable namespace/directory, and removes the job and entries afterward.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.env.HUSH_BACKUP_TEST_PACKAGE || path.resolve(here, '..');
const hush = path.join(repo, 'hush');
const runner = path.join(repo, 'helpers/hush-backup-schedule.mjs');
if (process.argv[2] === '--verify') {
  const gpg = spawn('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '3', '--quiet', '-d', process.argv[3]], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  gpg.stdio[3].end(`${process.env.TEST_KEY}\n`);
  let bundle = '';
  gpg.stdout.on('data', (data) => { bundle += data; });
  gpg.stderr.resume();
  gpg.on('close', (code) => {
    const rows = new Map(bundle.trim().split('\n').map((line) => line.split('\t')));
    if (code !== 0 || rows.size !== 2 || Buffer.from(rows.get('sample') || '', 'base64').toString() !== 'synthetic-backup-live'
      || Buffer.from(rows.get('backup-key') || '', 'base64').toString() !== process.env.TEST_KEY) process.exitCode = 1;
    else console.log('ok: raw GPG roundtrip, exact two-entry bundle');
  });
} else {
  assert.equal(process.platform, 'darwin', 'live test requires macOS');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-backup-live-'));
  const label = `com.royashbrook.hush.backup.test-${process.pid}`;
  const env = { ...process.env, HUSH_NS: `hush-backup-live-${process.pid}`, HUSH_PROMPT: 'pipe',
    HUSH_BACKUP_SCHEDULE_HOME: root, HUSH_BACKUP_SCHEDULE_LABEL: label };
  const dest = path.join(root, 'ciphertext');
  const run = (exe, args, input) => {
    const result = spawnSync(exe, args, { env, input, encoding: 'utf8', timeout: 30000 });
    assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-backup-live'), 'value leaked');
    return result;
  };
  try {
    assert.equal(run(hush, ['set', 'sample'], 'synthetic-backup-live').status, 0, 'store synthetic sample');
    assert.equal(run(hush, ['mint', 'backup-key']).status, 0, 'mint isolated key');
    assert.equal(run(process.execPath, [runner, 'install', '--directory', dest, '--key-secret', 'backup-key', '--keep', '2']).status, 0, 'load disposable job');
    const logfile = path.join(root, 'Library/Logs/hush-backup.log');
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !(fs.existsSync(logfile) && fs.readFileSync(logfile, 'utf8').includes('backup ok'))) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(fs.existsSync(logfile) && fs.readFileSync(logfile, 'utf8').includes('backup ok'), 'launchd RunAtLoad must complete a backup');
    assert.equal(run(process.execPath, [runner, 'status']).status, 0);
    const files = fs.readdirSync(dest).filter((name) => name.endsWith('.gpg'));
    assert.equal(files.length, 1);
    const checked = run(hush, ['run', 'TEST_KEY=backup-key', '--', process.execPath, fileURLToPath(import.meta.url), '--verify', path.join(dest, files[0])]);
    assert.equal(checked.status, 0, 'raw GPG must verify the exact original values without printing them');
    assert.ok(!fs.readFileSync(logfile, 'utf8').includes('synthetic-backup-live'));
    assert.equal(run(process.execPath, [runner, 'remove']).status, 0);
    assert.notEqual(run(process.execPath, [runner, 'status']).status, 0);
    assert.ok(fs.existsSync(path.join(dest, files[0])), 'removal must preserve ciphertext');
    console.log('ok: real launchd RunAtLoad + Keychain + GPG roundtrip + retained ciphertext on remove');
  } finally {
    run('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
    run(hush, ['rm', 'sample']);
    run(hush, ['rm', 'backup-key']);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
