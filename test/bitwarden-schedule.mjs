#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const helper = join(repo, 'helpers', 'hush-bitwarden-schedule.mjs');
const root = mkdtempSync(join(tmpdir(), 'hush-bitwarden-schedule-'));
const log = join(root, 'commands.log');
const names = join(root, 'hush-names');
const authState = join(root, 'bw-authenticated');
const launchState = join(root, 'launch-loaded');
const hush = join(root, 'hush');
const bw = join(root, 'bw');
const launchctl = join(root, 'launchctl');

function script(path, content) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${content}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

script(hush, `
printf 'hush:%s\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  list) cat "$HUSH_TEST_NAMES" ;;
  set) printf '%s\n' "$2" >> "$HUSH_TEST_NAMES" ;;
  run)
    shift
    while [ "$1" != -- ]; do
      key="\${1%%=*}"; name="\${1#*=}"
      case "$name" in
        bitwarden-client-id) value='client-value' ;;
        bitwarden-client-secret) value='secret-value' ;;
        bitwarden-master-password) value='master-value' ;;
        *) exit 41 ;;
      esac
      export "$key=$value"
      shift
    done
    shift
    "$@" ;;
  sync)
    printf 'sync-env:session=%s:credentials=%s\n' "\${BW_SESSION:+present}" "\${BW_PASSWORD:+present}\${BW_CLIENTID:+present}\${BW_CLIENTSECRET:+present}" >> "$HUSH_TEST_LOG"
    exit "\${HUSH_TEST_SYNC_RC:-0}" ;;
  *) exit 42 ;;
esac`);

script(bw, `
printf 'bw:%s\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  status)
    if [ -f "$HUSH_TEST_AUTH_STATE" ]; then printf '{"status":"locked"}\n'; else printf '{"status":"unauthenticated"}\n'; fi ;;
  login)
    [ "\${BW_CLIENTID:-}" = client-value ] && [ "\${BW_CLIENTSECRET:-}" = secret-value ] || exit 51
    : > "$HUSH_TEST_AUTH_STATE" ;;
  unlock)
    [ "\${BW_PASSWORD:-}" = master-value ] || exit 52
    printf 'session-value\n' ;;
  lock) : ;;
  *) exit 53 ;;
esac`);

script(launchctl, `
printf 'launchctl:%s\n' "$*" >> "$HUSH_TEST_LOG"
case "\${1:-}" in
  bootstrap) : > "$HUSH_TEST_LAUNCH_STATE" ;;
  bootout) rm -f "$HUSH_TEST_LAUNCH_STATE" ;;
  print) [ -f "$HUSH_TEST_LAUNCH_STATE" ] ;;
  *) exit 54 ;;
esac`);

writeFileSync(names, 'bitwarden-client-id\nbitwarden-client-secret\n');
const env = {
  ...process.env,
  HUSH_BITWARDEN_SCHEDULE_HOME: root,
  HUSH_BITWARDEN_SCHEDULE_PLATFORM: 'darwin',
  HUSH_BITWARDEN_SCHEDULE_HUSH: hush,
  HUSH_BITWARDEN_SCHEDULE_BW: bw,
  HUSH_BITWARDEN_SCHEDULE_LAUNCHCTL: launchctl,
  HUSH_TEST_LOG: log,
  HUSH_TEST_NAMES: names,
  HUSH_TEST_AUTH_STATE: authState,
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
  let result = invoke(['install', '--every', '6h', '--folder', 'hush', '--exclude', 'local-only', 'selected-a']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  ok('cold schedule install authenticates, unlocks, previews, and loads');

  const configPath = join(root, 'Library', 'Application Support', 'hush', 'bitwarden-schedule.json');
  const plistPath = join(root, 'Library', 'LaunchAgents', 'com.royashbrook.hush.bitwarden-sync.plist');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.clientIdSecret, 'bitwarden-client-id');
  assert.equal(config.clientSecretSecret, 'bitwarden-client-secret');
  assert.equal(config.masterSecret, 'bitwarden-master-password');
  assert.deepEqual(config.excludes, ['local-only']);
  assert.deepEqual(config.names, ['selected-a']);
  assert.equal(config.seconds, 21600);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  const configText = readFileSync(configPath, 'utf8');
  for (const value of ['client-value', 'secret-value', 'master-value', 'session-value']) {
    assert.ok(!configText.includes(value));
  }
  ok('config is mode 0600 metadata only');

  const plist = readFileSync(plistPath, 'utf8');
  assert.match(plist, /<integer>21600<\/integer>/);
  assert.match(plist, /<string>run<\/string>/);
  assert.ok(!plist.includes('bitwarden-client-id'));
  assert.ok(!plist.includes('bitwarden-master-password'));
  ok('LaunchAgent contains only runner and config paths');

  let commands = readFileSync(log, 'utf8');
  assert.match(commands, /hush:set bitwarden-master-password/);
  assert.match(commands, /bw:login --apikey/);
  assert.match(commands, /bw:unlock --passwordenv BW_PASSWORD --raw/);
  assert.match(commands, /hush:sync bitwarden --folder hush .*--dry-run selected-a/);
  assert.match(commands, /sync-env:session=present:credentials=/);
  assert.match(commands, /launchctl:bootstrap gui\/\d+ /);
  for (const value of ['client-value', 'secret-value', 'master-value', 'session-value']) {
    assert.ok(!commands.includes(value));
  }
  ok('credential values stay out of argv, config, plist, and logs');

  writeFileSync(log, '');
  result = invoke(['run']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  commands = readFileSync(log, 'utf8');
  assert.ok(!commands.includes('bw:login'));
  assert.match(commands, /bw:unlock --passwordenv BW_PASSWORD --raw/);
  assert.match(commands, /hush:sync bitwarden --folder hush .* selected-a/);
  assert.match(result.stdout, /sync ok/);
  ok('scheduled run reuses API login and obtains a fresh short-lived session');

  result = invoke(['status']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /loaded, every 6h, folder hush/);
  ok('status reports loaded schedule');

  result = invoke(['remove']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(plistPath), false);
  assert.equal(existsSync(configPath), true);
  ok('remove unloads launchd and retains metadata plus hush credentials');

  process.stdout.write('# Bitwarden schedule tests done. failures: 0\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
