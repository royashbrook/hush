#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = join(repo, 'helpers', 'hush-lastpass-schedule.mjs');
const root = mkdtempSync(join(tmpdir(), 'hush-lastpass-schedule-'));
const log = join(root, 'commands.log');
const lpassState = join(root, 'lpass.logged-in');
const secretState = join(root, 'hush.auth-stored');
const launchState = join(root, 'launch.loaded');
const hush = join(root, 'hush');
const lpass = join(root, 'lpass');
const launchctl = join(root, 'launchctl');

function script(path, content) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${content}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

script(lpass, `
printf 'lpass:%s\\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  status) [ -f "$HUSH_TEST_LPASS_STATE" ] ;;
  login) : > "$HUSH_TEST_LPASS_STATE" ;;
  *) exit 41 ;;
esac`);

script(hush, `
printf 'hush:%s\\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  list) [ -f "$HUSH_TEST_SECRET_STATE" ] && printf 'hush-lastpass-master-password\\n'; exit 0 ;;
  set) : > "$HUSH_TEST_SECRET_STATE" ;;
  pipe)
    printf 'login-env:%s:%s\\n' "\${LPASS_AGENT_TIMEOUT:-}" "\${LPASS_DISABLE_PINENTRY:-}" >> "$HUSH_TEST_LOG"
    exit "\${HUSH_TEST_PIPE_RC:-0}" ;;
  sync) exit "\${HUSH_TEST_SYNC_RC:-0}" ;;
  *) exit 42 ;;
esac`);

script(launchctl, `
printf 'launchctl:%s\\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  bootstrap) : > "$HUSH_TEST_LAUNCH_STATE" ;;
  bootout) rm -f "$HUSH_TEST_LAUNCH_STATE" ;;
  print) [ -f "$HUSH_TEST_LAUNCH_STATE" ] ;;
  *) exit 43 ;;
esac`);

const env = {
  ...process.env,
  HUSH_LASTPASS_SCHEDULE_HOME: root,
  HUSH_LASTPASS_SCHEDULE_PLATFORM: 'darwin',
  HUSH_LASTPASS_SCHEDULE_HUSH: hush,
  HUSH_LASTPASS_SCHEDULE_LPASS: lpass,
  HUSH_LASTPASS_SCHEDULE_LAUNCHCTL: launchctl,
  HUSH_TEST_LOG: log,
  HUSH_TEST_LPASS_STATE: lpassState,
  HUSH_TEST_SECRET_STATE: secretState,
  HUSH_TEST_LAUNCH_STATE: launchState,
};

function invoke(args, extraEnv = {}) {
  return spawnSync(process.execPath, [helper, ...args], {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
}

function ok(label) { process.stdout.write(`ok   - ${label}\n`); }

try {
  let result = invoke([
    'install', '--auto-login', '--email', 'user@example.com', '--every', '6h',
    '--group', 'team/hush', 'selected-a',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  ok('auto-login schedule installs');

  const configPath = join(root, 'Library', 'Application Support', 'hush', 'lastpass-schedule.json');
  const plistPath = join(root, 'Library', 'LaunchAgents', 'com.royashbrook.hush.lastpass-sync.plist');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.autoLogin, true);
  assert.equal(config.email, 'user@example.com');
  assert.equal(config.authSecret, 'hush-lastpass-master-password');
  assert.deepEqual(config.names, ['selected-a']);
  assert.equal(config.seconds, 21600);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!readFileSync(configPath, 'utf8').includes('master-password-value'));
  ok('config contains metadata only and is mode 0600');

  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<integer>21600<\/integer>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.ok(!plist.includes('user@example.com'));
  assert.ok(!plist.includes('hush-lastpass-master-password'));
  ok('LaunchAgent contains only runner and config paths');

  let commands = readFileSync(log, 'utf8');
  assert.match(commands, /lpass:login --trust user@example\.com/);
  assert.match(commands, /hush:set hush-lastpass-master-password/);
  assert.match(commands, /hush:sync lastpass --group team\/hush --exclude hush-lastpass-master-password --dry-run selected-a/);
  assert.match(commands, /launchctl:bootstrap gui\/\d+ /);
  ok('install performs trusted login, stores auth, previews, then loads');

  unlinkSync(lpassState);
  writeFileSync(log, '');
  result = invoke(['run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  commands = readFileSync(log, 'utf8');
  assert.match(commands, /hush:pipe hush-lastpass-master-password -- .*lpass login --trust user@example\.com/);
  assert.match(commands, /login-env:0:1/);
  assert.match(commands, /hush:sync lastpass --group team\/hush --exclude hush-lastpass-master-password selected-a/);
  assert.ok(!commands.includes('master-password-value'));
  ok('logged-out run reauthenticates from hush and excludes auth secret');

  result = invoke(['status']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /loaded, every 6h, auto-login enabled/);
  ok('status reports loaded schedule');

  result = invoke(['remove']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(plistPath), false);
  assert.equal(existsSync(configPath), true);
  ok('remove unloads schedule and retains non-secret config');

  result = invoke(['install', '--auto-login', '--every', '6h']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--email is required/);
  ok('auto-login requires explicit email opt-in');

  process.stdout.write('# LastPass schedule tests done. failures: 0\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
