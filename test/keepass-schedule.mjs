#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = join(repo, 'helpers', 'hush-keepass-schedule.mjs');
const root = mkdtempSync(join(tmpdir(), 'hush-keepass-schedule-'));
const log = join(root, 'commands.log');
const secretState = join(root, 'hush.db-secret-stored');
const launchState = join(root, 'launch.loaded');
const hush = join(root, 'hush');
const keepassxc = join(root, 'keepassxc-cli');
const launchctl = join(root, 'launchctl');

function script(path, content) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${content}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

script(hush, `
printf 'hush:%s\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  list) [ -f "$HUSH_TEST_SECRET_STATE" ] && printf 'hush-keepass-master-password\n'; exit 0 ;;
  set) : > "$HUSH_TEST_SECRET_STATE" ;;
  sync)
    previous=''
    for arg in "$@"; do
      if [ "$previous" = '--database' ] && [ ! -f "$arg" ]; then database=$arg; fi
      previous=$arg
    done
    case " $* " in *' --init '*) : > "$database" ;; esac
    exit "\${HUSH_TEST_SYNC_RC:-0}" ;;
  *) exit 42 ;;
esac`);

script(keepassxc, 'exit 0');

script(launchctl, `
printf 'launchctl:%s\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  bootstrap) : > "$HUSH_TEST_LAUNCH_STATE" ;;
  bootout) rm -f "$HUSH_TEST_LAUNCH_STATE" ;;
  print) [ -f "$HUSH_TEST_LAUNCH_STATE" ] ;;
  *) exit 43 ;;
esac`);

const env = {
  ...process.env,
  HUSH_KEEPASS_SCHEDULE_HOME: root,
  HUSH_KEEPASS_SCHEDULE_PLATFORM: 'darwin',
  HUSH_KEEPASS_SCHEDULE_HUSH: hush,
  HUSH_KEEPASS_SCHEDULE_KEEPASSXC: keepassxc,
  HUSH_KEEPASS_SCHEDULE_LAUNCHCTL: launchctl,
  HUSH_TEST_LOG: log,
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
  const database = join(root, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'hush', 'hush.kdbx');
  let result = invoke([
    'install', '--every', '6h', '--group', 'hush', '--exclude', 'local-only', 'selected-a',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(database), true);
  ok('cold install creates and populates the iCloud-path database');

  const configPath = join(root, 'Library', 'Application Support', 'hush', 'keepass-schedule.json');
  const plistPath = join(root, 'Library', 'LaunchAgents', 'com.royashbrook.hush.keepass-sync.plist');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.database, database);
  assert.equal(config.dbSecret, 'hush-keepass-master-password');
  assert.deepEqual(config.excludes, ['local-only']);
  assert.deepEqual(config.names, ['selected-a']);
  assert.equal(config.seconds, 21600);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.ok(!readFileSync(configPath, 'utf8').includes('database-password-value'));
  ok('config is mode 0600 metadata only');

  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<integer>21600<\/integer>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.ok(!plist.includes('hush-keepass-master-password'));
  assert.ok(!plist.includes(database));
  ok('LaunchAgent contains only runner and config paths');

  let commands = readFileSync(log, 'utf8');
  assert.match(commands, /hush:set hush-keepass-master-password/);
  assert.match(commands, /hush:sync keepass --database .*hush\.kdbx --db-secret hush-keepass-master-password --group hush --exclude local-only --init selected-a/);
  assert.match(commands, /launchctl:bootstrap gui\/\d+ /);
  assert.ok(!commands.includes('database-password-value'));
  ok('install stores the password, initializes once, then loads launchd');

  writeFileSync(log, '');
  result = invoke(['run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  commands = readFileSync(log, 'utf8');
  assert.match(commands, /hush:sync keepass --database .*hush\.kdbx --db-secret hush-keepass-master-password --group hush --exclude local-only selected-a/);
  assert.match(result.stdout, /sync ok/);
  ok('scheduled run upserts without exposing secret material');

  result = invoke(['status']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /loaded, every 6h/);
  ok('status reports loaded schedule');

  result = invoke(['remove']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(plistPath), false);
  assert.equal(existsSync(configPath), true);
  assert.equal(existsSync(database), true);
  ok('remove unloads launchd and retains config plus database');

  writeFileSync(log, '');
  result = invoke(['install', '--every', '1d']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  commands = readFileSync(log, 'utf8');
  assert.match(commands, /hush:sync keepass .* --dry-run/);
  assert.ok(!commands.includes('hush:set'));
  assert.ok(!commands.includes(' --init'));
  ok('existing database is validated without recreation or another password prompt');

  process.stdout.write('# KeePass schedule tests done. failures: 0\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
