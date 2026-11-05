// Synthetic store, az and HTTPS. Never opens the user's store or a real vault.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncSecret } from '../helpers/hush-azure-sync.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-azure-test-'));
const value = 'SYNTHETIC-SECRET-NOT-FOR-LOGS\nsecond line "quoted"';
const token = 'SYNTHETIC-AUTH-NOT-FOR-LOGS';
const stateFile = path.join(tmp, 'remote.json');
const logFile = path.join(tmp, 'calls.log');
const fetchFile = path.join(tmp, 'fetch.cjs');
let checks = 0;
function check(label, test) { test(); checks++; console.log(`ok - ${label}`); }
const put = (file, content) => fs.writeFileSync(path.join(tmp, file), content, { mode: 0o700 });
const calls = () => fs.readFileSync(logFile, 'utf8');
const reset = (remote = {}) => { fs.writeFileSync(stateFile, JSON.stringify(remote)); fs.writeFileSync(logFile, ''); };

try {
  put('uname', '#!/bin/sh\nprintf "Darwin\\n"\n');
  put('security', `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'dump-keychain') {
  for (const name of ['test-a', 'test-b', 'local-only']) console.log('    "svce"<blob>="hush:' + name + '"');
} else if (args[0] === 'find-generic-password') {
  if (args[args.indexOf('-s') + 1].endsWith(':absent')) process.exit(44);
  if (args.includes('-w')) {
    require('fs').appendFileSync(process.env.TEST_LOG, 'fetch\\n');
    process.stdout.write(process.env.TEST_VALUE);
  }
} else process.exit(45);
`);
  put('az', `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(process.env.TEST_LOG, 'az ' + args.join(' ') + '\\n');
if (process.env.TEST_AZ_FAIL) { console.error(process.env.TEST_TOKEN); process.exit(1); }
const out = (value) => process.stdout.write(value + (process.env.TEST_AZ_CRLF ? '\\r\\n' : '\\n'));
if (args[0] === 'cloud') out('.vault.azure.net');
else if (args[1] === 'show') out('synthetic-account');
else if (args[1] === 'get-access-token') out(process.env.TEST_TOKEN);
else process.exit(2);
`);
  put('fetch.cjs', `
const fs = require('fs');
globalThis.fetch = async (url, opts) => {
  const name = new URL(url).pathname.split('/').pop();
  fs.appendFileSync(process.env.TEST_LOG, opts.method + ' ' + name + '\\n');
  if (opts.headers.Authorization !== 'Bearer ' + process.env.TEST_TOKEN) throw Error('wrong auth');
  if (opts.redirect !== 'error') throw Error('redirects must be refused');
  if (process.env.TEST_HTTP_FAIL === 'throw') throw Error(process.env.TEST_TOKEN + process.env.TEST_VALUE);
  const state = JSON.parse(fs.readFileSync(process.env.TEST_REMOTE, 'utf8'));
  if (process.env.TEST_HTTP_FAIL === opts.method) return new Response('ignored', {status:403});
  if (opts.method === 'GET') return new Response(JSON.stringify(state[name] || {}), {status:state[name] ? 200 : 404});
  state[name] = JSON.parse(opts.body);
  fs.writeFileSync(process.env.TEST_REMOTE, JSON.stringify(state));
  return new Response('{}', {status:200});
};
`);
  const run = (args, extra = {}) => {
    const result = spawnSync('bash', [path.join(root, 'hush'), 'sync', 'azurekv', '--vault', 'example-vault', ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH}`,
        HUSH_NS: 'hush', HUSH_AZURE_CLI: path.join(tmp, 'az'), HUSH_NODE: process.execPath,
        NODE_OPTIONS: `--require=${fetchFile}`, TEST_VALUE: value, TEST_TOKEN: token,
        TEST_LOG: logFile, TEST_REMOTE: stateFile, ...extra },
    });
    const output = `${result.stdout || ''}${result.stderr || ''}${calls()}`;
    assert(!output.includes(value.split('\n')[0]) && !output.includes(token), 'synthetic secret/token leaked');
    return result;
  };
  reset();
  check('dry-run reads no values, gets no token and sends no HTTP', () => {
    assert.equal(run(['--dry-run', 'test-a']).status, 0);
    assert(!/fetch|get-access-token|GET|PUT/.test(calls()));
  });
  for (const name of ['BadName', 'bad_name', 'bad/name', '', 'a'.repeat(128)]) {
    reset();
    check('noncanonical Azure name refuses before any remote call', () => {
      assert.notEqual(run([name]).status, 0); assert.equal(calls(), '');
    });
  }
  reset();
  check('all local names validate before writes', () => {
    assert.notEqual(run(['test-a', 'absent']).status, 0); assert.equal(calls(), '');
  });
  reset();
  check('creates missing value through the full Hush entrypoint', () => {
    assert.equal(run(['test-a']).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(stateFile))['test-a'].value, value);
  });
  check('repeat run makes no PUT', () => {
    fs.writeFileSync(logFile, ''); assert.equal(run(['test-a']).status, 0); assert(!calls().includes('PUT'));
  });
  check('changed value sends one PUT and preserves metadata', () => {
    reset({ 'test-a': { value: 'old', tags: { owner: 'test' }, contentType: 'text/plain', attributes: { enabled: true, exp: 123 } } });
    assert.equal(run(['test-a']).status, 0);
    const saved = JSON.parse(fs.readFileSync(stateFile))['test-a'];
    assert.equal(saved.value, value); assert.deepEqual(saved.tags, { owner: 'test' });
    assert.deepEqual(saved.attributes, { enabled: true, exp: 123 });
    assert.equal(saved.contentType, 'text/plain'); assert.equal(calls().match(/PUT/g)?.length, 1);
  });
  for (const method of ['GET', 'PUT']) {
    reset();
    check(`${method} failure refuses success and retries next run`, () => {
      assert.notEqual(run(['test-a'], { TEST_HTTP_FAIL: method }).status, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)), {});
      if (method === 'GET') assert(!calls().includes('PUT'));
      assert.equal(run(['test-a']).status, 0);
    });
  }
  reset();
  check('failed az authentication is visible without raw CLI output', () => {
    assert.notEqual(run(['test-a'], { TEST_AZ_FAIL: '1' }).status, 0); assert(!/GET|PUT/.test(calls()));
  });
  reset();
  check('bulk selection honors exclusions', () => {
    assert.equal(run(['--exclude', 'local-only']).status, 0);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile))).sort(), ['test-a', 'test-b']);
  });
  reset();
  check('fully excluded selection is a no-op', () => {
    assert.equal(run(['--exclude', 'test-a', 'test-a']).status, 0); assert.equal(calls(), '');
  });
  reset();
  check('network exceptions cannot print values or tokens', () => {
    assert.notEqual(run(['test-a'], { TEST_HTTP_FAIL: 'throw' }).status, 0);
  });
  reset();
  check('Windows-style Azure CLI CRLF does not change cloud or token', () => {
    assert.equal(run(['test-a'], { TEST_AZ_CRLF: '1' }).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(stateFile))['test-a'].value, value);
  });
  await assert.rejects(syncSecret('example.vault.azure.net', 'test-a', token, value,
    async () => new Response('{}', { status: 200 })), /no secret value/);
  checks++;
  console.log('ok - malformed provider response never overwrites');
  console.log(`# Azure sync checks: ${checks}, no real store, CLI or network used`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
