#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const hush = path.resolve(here, '../hush');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-adoption-'));
const env = { ...process.env, HUSH_NS: `hush-adoption-${process.pid}`, HUSH_PROMPT: 'pipe', MODE: 'development' };
const names = ['adopt-existing', 'adopt-session', 'adopt-user'];
const secrets = ['fixture-existing-only', 'fixture-user-only'];
const call = (args, input) => {
  const r = spawnSync('bash', [hush, ...args], { cwd: root, env, input, encoding: 'utf8' });
  for (const value of secrets) assert.ok(!`${r.stdout}${r.stderr}`.includes(value), 'plaintext in command output');
  return r;
};
try {
  fs.cpSync(path.join(here, 'fixtures/adoption'), root, { recursive: true });
  fs.renameSync(path.join(root, '.dev.vars.example'), path.join(root, '.dev.vars'));
  const existing = /^EXISTING_TOKEN=(.+)$/m.exec(fs.readFileSync(path.join(root, '.dev.vars'), 'utf8'))[1];
  assert.equal(call(['set', names[0]], existing).status, 0, 'derive existing secret');
  assert.equal(call(['mint', names[1]]).status, 0, 'mint random secret');
  const manifest = `EXISTING_TOKEN=${names[0]}\nSESSION_KEY=${names[1]}\nUSER_TOKEN=${names[2]}\n`;
  fs.writeFileSync(path.join(root, '.hush'), manifest);
  fs.writeFileSync(path.join(root, '.gitignore'), '.dev.vars\n');
  assert.ok(!call(['list']).stdout.split(/\r?\n/).includes(names[2]), 'user-only secret must not be invented');
  assert.notEqual(call(['exec', '--', process.execPath, 'app.mjs']).status, 0, 'missing user token must stop execution');
  assert.ok(!fs.existsSync(path.join(root, 'consumer-ran')), 'consumer ran despite missing token');
  assert.equal(call(['set', names[2]], secrets[1]).status, 0, 'explicit synthetic user answer');
  assert.equal(call(['exec', '--', process.execPath, 'app.mjs']).status, 0, 'mapped values injected');
  assert.equal(fs.readFileSync(path.join(root, 'consumer-ran'), 'utf8'), 'ok');
  for (const secret of secrets) assert.ok(!manifest.includes(secret), 'manifest contains a value');
  assert.ok(!manifest.includes('MODE'), 'ordinary configuration should not be secretized');
  console.log('ok   - cold adoption: derive, mint, stop for user, inject, never print');
} finally {
  for (const name of names) call(['rm', name]);
  fs.rmSync(root, { recursive: true, force: true });
}
