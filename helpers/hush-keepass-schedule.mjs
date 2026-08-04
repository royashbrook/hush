#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const LABEL = 'com.royashbrook.hush.keepass-sync';
const SCRIPT = fileURLToPath(import.meta.url);

function die(message) {
  process.stderr.write(`hush-keepass-schedule: ${message}\n`);
  process.exit(1);
}

function usage(code = 0) {
  const out = code ? process.stderr : process.stdout;
  out.write(`hush-keepass-schedule, recurring hush -> KeePassXC sync

  hush-keepass-schedule install [--every 6h] [options] [name ...]
  hush-keepass-schedule run
  hush-keepass-schedule status
  hush-keepass-schedule remove

options:
  --database <file.kdbx>  destination (default: iCloud Drive/hush/hush.kdbx)
  --db-secret <name>      hush name holding the database password
                          (default: hush-keepass-master-password)
  --group <name>          KeePass group (default: hush)
  --exclude <name>        omit from bulk sync; repeatable
  --every <Nm|Nh|Nd>      interval, minimum 5m (default: 6h)

install creates the database when absent and prompts through hush if the database password secret
does not exist. keep a separate durable copy of that password: the kdbx cannot recover itself.
`);
  process.exit(code);
}

function roots() {
  const home = process.env.HUSH_KEEPASS_SCHEDULE_HOME || homedir();
  return {
    home,
    config: join(home, 'Library', 'Application Support', 'hush', 'keepass-schedule.json'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: join(home, 'Library', 'Logs', 'hush-keepass-sync.log'),
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

function expandPath(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return resolve(value);
}

function parseInstall(args, home) {
  const result = {
    database: join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'hush', 'hush.kdbx'),
    dbSecret: 'hush-keepass-master-password',
    group: 'hush', excludes: [], every: '6h', names: [],
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--database') result.database = args.shift() || die('--database needs a path');
    else if (arg === '--db-secret') result.dbSecret = args.shift() || die('--db-secret needs a name');
    else if (arg === '--group') result.group = args.shift() || die('--group needs a name');
    else if (arg === '--exclude') result.excludes.push(args.shift() || die('--exclude needs a name'));
    else if (arg === '--every') result.every = args.shift() || die('--every needs an interval');
    else if (arg === '--') { result.names.push(...args); break; }
    else if (arg.startsWith('-')) die(`unknown option '${arg}'`);
    else result.names.push(arg);
  }
  if (!result.database.endsWith('.kdbx')) die('--database must end in .kdbx');
  if (!result.dbSecret) die('--db-secret must be non-empty');
  if (!result.group || result.group.includes('/') || /[\r\n]/.test(result.group)) {
    die('--group must be one non-empty group name');
  }
  result.database = expandPath(result.database, home);
  result.seconds = seconds(result.every);
  return result;
}

function syncArgs(config, mode = '') {
  const args = [
    'sync', 'keepass', '--database', config.database,
    '--db-secret', config.dbSecret, '--group', config.group,
  ];
  for (const name of config.excludes) args.push('--exclude', name);
  if (mode === 'init') args.push('--init');
  else if (mode === 'dry-run') args.push('--dry-run');
  args.push(...config.names);
  return args;
}

function readConfig(path) {
  if (!existsSync(path)) die(`no schedule config at ${path} (run install)`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { die(`could not read schedule config at ${path}`); }
}

function install(args) {
  const platform = process.env.HUSH_KEEPASS_SCHEDULE_PLATFORM || process.platform;
  if (platform !== 'darwin') die('schedule install currently supports macOS launchd only');
  const paths = roots();
  const options = parseInstall(args, paths.home);
  const hush = findExecutable('hush', process.env.HUSH_KEEPASS_SCHEDULE_HUSH);
  const keepassxc = findExecutable('keepassxc-cli', process.env.HUSH_KEEPASS_SCHEDULE_KEEPASSXC);
  const launchctl = findExecutable('launchctl', process.env.HUSH_KEEPASS_SCHEDULE_LAUNCHCTL);
  const config = {
    version: 1, hush, keepassxc,
    database: options.database, dbSecret: options.dbSecret, group: options.group,
    excludes: options.excludes, names: options.names,
    every: options.every, seconds: options.seconds,
  };
  const env = { ...process.env, HUSH_KEEPASSXC: keepassxc };

  const listed = run(hush, ['list']);
  const hasSecret = listed.status === 0 && listed.stdout.split(/\r?\n/).includes(config.dbSecret);
  if (!hasSecret) {
    process.stdout.write(`hush-keepass-schedule: create the KeePass database password as hush secret '${config.dbSecret}'.\n`);
    const stored = run(hush, ['set', config.dbSecret], { stdio: 'inherit' });
    if (stored.status !== 0) die('database password was not stored; nothing installed');
  }

  let mode = 'dry-run';
  if (!existsSync(config.database)) {
    try { mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 }); }
    catch { die(`could not create database directory: ${dirname(config.database)}`); }
    mode = 'init';
  }
  const preview = run(hush, syncArgs(config, mode), { env, stdio: 'inherit' });
  if (preview.status !== 0) die(`${mode === 'init' ? 'initial sync' : 'sync dry-run'} failed; nothing installed`);

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
  process.stdout.write(`hush-keepass-schedule: installed every ${config.every}. database: ${config.database}\n`);
}

function scheduledRun(configPath) {
  const config = readConfig(configPath);
  if (!existsSync(config.database)) die(`database is missing: ${config.database}`);
  const env = { ...process.env, HUSH_KEEPASSXC: config.keepassxc };
  const synced = run(config.hush, syncArgs(config), { env });
  if (synced.status !== 0) die(`sync failed with exit ${synced.status}`);
  process.stdout.write(`hush-keepass-schedule: ${new Date().toISOString()} sync ok\n`);
}

function status() {
  const paths = roots();
  const config = readConfig(paths.config);
  const launchctl = findExecutable('launchctl', process.env.HUSH_KEEPASS_SCHEDULE_LAUNCHCTL);
  const result = run(launchctl, ['print', `gui/${process.getuid()}/${LABEL}`]);
  process.stdout.write(`hush-keepass-schedule: ${result.status === 0 ? 'loaded' : 'not loaded'}, every ${config.every}, database ${config.database}\n`);
  process.exit(result.status === 0 ? 0 : 1);
}

function remove() {
  const paths = roots();
  const launchctl = findExecutable('launchctl', process.env.HUSH_KEEPASS_SCHEDULE_LAUNCHCTL);
  run(launchctl, ['bootout', `gui/${process.getuid()}`, paths.plist]);
  rmSync(paths.plist, { force: true });
  process.stdout.write(`hush-keepass-schedule: removed LaunchAgent. database and config retained at ${paths.config}.\n`);
}

const [command = 'help', ...args] = process.argv.slice(2);
if (command === 'install') install(args);
else if (command === 'run') {
  let config = roots().config;
  if (args[0] === '--config' && args[1]) config = args[1];
  scheduledRun(config);
} else if (command === 'status') status();
else if (command === 'remove') remove();
else if (command === 'help' || command === '--help' || command === '-h') usage(0);
else usage(2);
