#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const LABEL = 'com.royashbrook.hush.bitwarden-sync';
const SCRIPT = fileURLToPath(import.meta.url);
const JSON_HELPER = fileURLToPath(new URL('hush-bitwarden-json.mjs', import.meta.url));

function die(message) {
  process.stderr.write(`hush-bitwarden-schedule: ${message}\n`);
  process.exit(1);
}

function usage(code = 0) {
  const out = code ? process.stderr : process.stdout;
  out.write(`hush-bitwarden-schedule, recurring hush -> Bitwarden sync

  hush-bitwarden-schedule install [--every 6h] [options] [name ...]
  hush-bitwarden-schedule run
  hush-bitwarden-schedule status
  hush-bitwarden-schedule remove

options:
  --client-id-secret <name>      default: bitwarden-client-id
  --client-secret-secret <name>  default: bitwarden-client-secret
  --master-secret <name>         default: bitwarden-master-password
  --folder <name>                Bitwarden folder (default: hush)
  --exclude <name>               omit from bulk sync; repeatable
  --every <Nm|Nh|Nd>             interval, minimum 5m (default: 6h)

the API key authenticates the CLI, but Bitwarden still requires the master password to unlock vault
data. install stores missing values through hush's hidden prompt, then validates login and unlock.
`);
  process.exit(code);
}

function roots() {
  const home = process.env.HUSH_BITWARDEN_SCHEDULE_HOME || homedir();
  return {
    home,
    config: join(home, 'Library', 'Application Support', 'hush', 'bitwarden-schedule.json'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: join(home, 'Library', 'Logs', 'hush-bitwarden-sync.log'),
  };
}

function findExecutable(name, override) {
  if (override) {
    if (existsSync(override)) return override;
    die(`configured ${name} executable does not exist: ${override}`);
  }
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  die(`${name} is not on PATH`);
}

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: options.stdio || 'pipe',
  });
}

function seconds(value) {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) die(`bad interval '${value}' (use Nm, Nh, or Nd)`);
  const unit = { m: 60, h: 3600, d: 86400 }[match[2]];
  const result = Number(match[1]) * unit;
  if (result < 300) die('interval must be at least 5m');
  return result;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function writeAtomic(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temp, value, { mode });
  renameSync(temp, path);
}

function parseInstall(args) {
  const result = {
    clientIdSecret: 'bitwarden-client-id',
    clientSecretSecret: 'bitwarden-client-secret',
    masterSecret: 'bitwarden-master-password',
    folder: 'hush', excludes: [], every: '6h', names: [],
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--client-id-secret') result.clientIdSecret = args.shift() || die('--client-id-secret needs a name');
    else if (arg === '--client-secret-secret') result.clientSecretSecret = args.shift() || die('--client-secret-secret needs a name');
    else if (arg === '--master-secret') result.masterSecret = args.shift() || die('--master-secret needs a name');
    else if (arg === '--folder') result.folder = args.shift() || die('--folder needs a name');
    else if (arg === '--exclude') result.excludes.push(args.shift() || die('--exclude needs a name'));
    else if (arg === '--every') result.every = args.shift() || die('--every needs an interval');
    else if (arg === '--') { result.names.push(...args); break; }
    else if (arg.startsWith('-')) die(`unknown option '${arg}'`);
    else result.names.push(arg);
  }
  if (!result.folder || /[\r\n]/.test(result.folder)) die('--folder must be non-empty and one line');
  for (const name of [result.clientIdSecret, result.clientSecretSecret, result.masterSecret]) {
    if (!name || /[\r\n]/.test(name)) die('auth secret names must be non-empty and one line');
  }
  result.seconds = seconds(result.every);
  return result;
}

function syncArgs(config, dryRun = false) {
  const args = ['sync', 'bitwarden', '--folder', config.folder];
  const excluded = new Set([
    ...config.excludes,
    config.clientIdSecret, config.clientSecretSecret, config.masterSecret,
  ]);
  for (const name of excluded) args.push('--exclude', name);
  if (dryRun) args.push('--dry-run');
  args.push(...config.names);
  return args;
}

function readConfig(path) {
  if (!existsSync(path)) die(`no schedule config at ${path} (run install)`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { die(`could not read schedule config at ${path}`); }
}

function encodedConfig(config, dryRun) {
  return Buffer.from(JSON.stringify({ ...config, dryRun }), 'utf8').toString('base64');
}

function invokeAuthenticated(config, dryRun, stdio = 'inherit') {
  return run(config.hush, [
    'run',
    `BW_CLIENTID=${config.clientIdSecret}`,
    `BW_CLIENTSECRET=${config.clientSecretSecret}`,
    `BW_PASSWORD=${config.masterSecret}`,
    '--', process.execPath, SCRIPT, 'authenticated-run', '--config64', encodedConfig(config, dryRun),
  ], { stdio });
}

function parseStatus(result) {
  if (result.status !== 0) return { status: 'error' };
  try { return JSON.parse(result.stdout); }
  catch { return { status: 'error' }; }
}

function authenticatedRun(config) {
  const authEnv = { ...process.env };
  let status = parseStatus(run(config.bw, ['status'], { env: authEnv }));
  const expectedUser = authEnv.BW_CLIENTID?.startsWith('user.') ? authEnv.BW_CLIENTID.slice(5) : '';
  if (expectedUser && status.userId && expectedUser.toLowerCase() !== status.userId.toLowerCase()) {
    die('authenticated Bitwarden account does not match the configured personal API key');
  }
  if (status.status === 'unauthenticated') {
    const login = run(config.bw, ['login', '--apikey'], { env: authEnv });
    if (login.status !== 0) die('Bitwarden API-key login failed');
    status = parseStatus(run(config.bw, ['status'], { env: authEnv }));
  }
  if (status.status !== 'locked' && status.status !== 'unlocked') {
    die(`unexpected Bitwarden status '${status.status}'`);
  }

  let session = '';
  if (status.status === 'unlocked' && authEnv.BW_SESSION) session = authEnv.BW_SESSION;
  else {
    const unlocked = run(config.bw, ['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], { env: authEnv });
    if (unlocked.status !== 0) die('Bitwarden unlock failed');
    session = unlocked.stdout.trim();
  }
  if (!session) die('Bitwarden returned an empty session');

  const syncEnv = {
    ...process.env,
    BW_SESSION: session,
    HUSH_BITWARDEN: config.bw,
    HUSH_BITWARDEN_JSON: config.jsonHelper,
    HUSH_NODE: process.execPath,
  };
  delete syncEnv.BW_CLIENTID;
  delete syncEnv.BW_CLIENTSECRET;
  delete syncEnv.BW_PASSWORD;
  delete process.env.BW_CLIENTID;
  delete process.env.BW_CLIENTSECRET;
  delete process.env.BW_PASSWORD;

  const synced = run(config.hush, syncArgs(config, config.dryRun), { env: syncEnv, stdio: 'inherit' });
  run(config.bw, ['lock'], { env: syncEnv });
  session = '';
  if (synced.status !== 0) die(`sync failed with exit ${synced.status}`);
  if (!config.dryRun) process.stdout.write(`hush-bitwarden-schedule: ${new Date().toISOString()} sync ok\n`);
}

function install(args) {
  const platform = process.env.HUSH_BITWARDEN_SCHEDULE_PLATFORM || process.platform;
  if (platform !== 'darwin') die('schedule install currently supports macOS launchd only');
  const options = parseInstall(args);
  const paths = roots();
  const hush = findExecutable('hush', process.env.HUSH_BITWARDEN_SCHEDULE_HUSH);
  const bw = findExecutable('bw', process.env.HUSH_BITWARDEN_SCHEDULE_BW);
  const launchctl = findExecutable('launchctl', process.env.HUSH_BITWARDEN_SCHEDULE_LAUNCHCTL);
  const config = {
    version: 1, hush, bw, jsonHelper: JSON_HELPER,
    clientIdSecret: options.clientIdSecret,
    clientSecretSecret: options.clientSecretSecret,
    masterSecret: options.masterSecret,
    folder: options.folder, excludes: options.excludes, names: options.names,
    every: options.every, seconds: options.seconds,
  };

  const listed = run(hush, ['list']);
  if (listed.status !== 0) die('could not list hush secret names');
  const present = new Set(listed.stdout.split(/\r?\n/).filter(Boolean));
  for (const name of [config.clientIdSecret, config.clientSecretSecret, config.masterSecret]) {
    if (present.has(name)) continue;
    process.stdout.write(`hush-bitwarden-schedule: store required credential as hush secret '${name}'.\n`);
    const stored = run(hush, ['set', name], { stdio: 'inherit' });
    if (stored.status !== 0) die(`credential '${name}' was not stored; nothing installed`);
  }

  const preview = invokeAuthenticated(config, true);
  if (preview.status !== 0) die('authenticated sync dry-run failed; nothing installed');
  writeAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(dirname(paths.log), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(SCRIPT)}</string>
    <string>run</string>
    <string>--config</string>
    <string>${xml(paths.config)}</string>
  </array>
  <key>StartInterval</key><integer>${config.seconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict>
</plist>
`;
  writeAtomic(paths.plist, plist);

  const domain = `gui/${process.getuid()}`;
  run(launchctl, ['bootout', domain, paths.plist]);
  const loaded = run(launchctl, ['bootstrap', domain, paths.plist]);
  if (loaded.status !== 0) die(`launchctl bootstrap failed; config and plist remain at ${paths.plist}`);
  process.stdout.write(`hush-bitwarden-schedule: installed every ${config.every}. log: ${paths.log}\n`);
}

function scheduledRun(configPath) {
  const config = readConfig(configPath);
  const result = invokeAuthenticated(config, false);
  if (result.status !== 0) die(`authenticated runner failed with exit ${result.status}`);
}

function status() {
  const paths = roots();
  const config = readConfig(paths.config);
  const launchctl = findExecutable('launchctl', process.env.HUSH_BITWARDEN_SCHEDULE_LAUNCHCTL);
  const result = run(launchctl, ['print', `gui/${process.getuid()}/${LABEL}`]);
  process.stdout.write(`hush-bitwarden-schedule: ${result.status === 0 ? 'loaded' : 'not loaded'}, every ${config.every}, folder ${config.folder}\n`);
  process.exit(result.status === 0 ? 0 : 1);
}

function remove() {
  const paths = roots();
  const launchctl = findExecutable('launchctl', process.env.HUSH_BITWARDEN_SCHEDULE_LAUNCHCTL);
  run(launchctl, ['bootout', `gui/${process.getuid()}`, paths.plist]);
  rmSync(paths.plist, { force: true });
  process.stdout.write('hush-bitwarden-schedule: removed LaunchAgent. config and hush credentials retained.\n');
}

const [command = 'help', ...args] = process.argv.slice(2);
if (command === 'install') install(args);
else if (command === 'run') {
  let config = roots().config;
  if (args[0] === '--config' && args[1]) config = args[1];
  scheduledRun(config);
} else if (command === 'authenticated-run') {
  if (args[0] !== '--config64' || !args[1]) die('missing internal config');
  let config;
  try { config = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8')); }
  catch { die('invalid internal config'); }
  authenticatedRun(config);
} else if (command === 'status') status();
else if (command === 'remove') remove();
else if (command === 'help' || command === '--help' || command === '-h') usage(0);
else usage(2);
