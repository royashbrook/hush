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
  *) exit 41 ;;
esac`);

script(hush, `
printf 'hush:%s\\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
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
  writeFileSync(lpassState, '');
  let result = invoke([
    'install', '--every', '6h', '--group', 'team/hush', 'selected-a',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  ok('logged-in schedule installs');

  const configPath = join(root, 'Library', 'Application Support', 'hush', 'lastpass-schedule.json');
  const plistPath = join(root, 'Library', 'LaunchAgents', 'com.royashbrook.hush.lastpass-sync.plist');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.names, ['selected-a']);
  assert.equal(config.seconds, 21600);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!readFileSync(configPath, 'utf8').includes('master-password-value'));
  ok('config contains metadata only and is mode 0600');

  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<integer>21600<\/integer>/);
  assert.match(plist, /<string>run<\/string>/);
  ok('LaunchAgent contains only runner and config paths');

  let commands = readFileSync(log, 'utf8');
  assert.match(commands, /lpass:status --quiet --color=never/);
  assert.match(commands, /hush:sync lastpass --group team\/hush --dry-run selected-a/);
  assert.match(commands, /launchctl:bootstrap gui\/\d+ /);
  ok('install checks login, previews, then loads');

  unlinkSync(lpassState);
  writeFileSync(log, '');
  result = invoke(['run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LastPass is logged out/);
  commands = readFileSync(log, 'utf8');
  assert.ok(!commands.includes('hush:sync'));
  ok('logged-out run fails before sync');

  writeFileSync(lpassState, '');
  writeFileSync(log, '');
  result = invoke(['run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  commands = readFileSync(log, 'utf8');
  assert.match(commands, /hush:sync lastpass --group team\/hush selected-a/);
  ok('logged-in run syncs selected names');

  result = invoke(['status']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /loaded, every 6h/);
  ok('status reports loaded schedule');

  result = invoke(['remove']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(plistPath), false);
  assert.equal(existsSync(configPath), true);
  ok('remove unloads schedule and retains non-secret config');

  result = invoke(['install', '--auto-login', '--every', '6h']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option '--auto-login'/);
  ok('unsupported auto-login is rejected');

  process.stdout.write('# LastPass schedule tests done. failures: 0\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
