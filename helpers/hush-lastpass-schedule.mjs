#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const LABEL = 'com.royashbrook.hush.lastpass-sync';
const SCRIPT = fileURLToPath(import.meta.url);

function die(message) {
  process.stderr.write(`hush-lastpass-schedule: ${message}\n`);
  process.exit(1);
}

function usage(code = 0) {
  const out = code ? process.stderr : process.stdout;
  out.write(`hush-lastpass-schedule, recurring hush -> LastPass sync

  hush-lastpass-schedule install --every 6h [--group path] [name ...]
  hush-lastpass-schedule install --auto-login --email you@example.com [options]
  hush-lastpass-schedule run
  hush-lastpass-schedule status
  hush-lastpass-schedule remove

options:
  --auto-login             opt in to storing the LastPass master password in hush
  --email <address>        LastPass login email, required with --auto-login
  --auth-secret <name>     hush name for the login secret (default: hush-lastpass-master-password)
  --refresh-login-secret   replace an existing stored login secret during install
  --every <Nm|Nh|Nd>       interval, minimum 5m (default: 6h)
  --group <path>           LastPass group (default: hush)

auto-login never uses lpass --plaintext-key. setup performs one interactive trusted-device login.
if that trust is revoked or expires, scheduled runs fail closed until install/login is run again.
`);
  process.exit(code);
}

function roots() {
  const home = process.env.HUSH_LASTPASS_SCHEDULE_HOME || homedir();
  return {
    home,
    config: join(home, 'Library', 'Application Support', 'hush', 'lastpass-schedule.json'),
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: join(home, 'Library', 'Logs', 'hush-lastpass-sync.log'),
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
    every: '6h', group: 'hush', autoLogin: false, email: '',
    authSecret: 'hush-lastpass-master-password', refresh: false, names: [],
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--every') result.every = args.shift() || die('--every needs an interval');
    else if (arg === '--group') result.group = args.shift() || die('--group needs a path');
    else if (arg === '--email') result.email = args.shift() || die('--email needs an address');
    else if (arg === '--auth-secret') result.authSecret = args.shift() || die('--auth-secret needs a name');
    else if (arg === '--auto-login') result.autoLogin = true;
    else if (arg === '--refresh-login-secret') result.refresh = true;
    else if (arg === '--') { result.names.push(...args); break; }
    else if (arg.startsWith('-')) die(`unknown option '${arg}'`);
    else result.names.push(arg);
  }
  if (!result.group || result.group.endsWith('/')) die('--group must be non-empty and cannot end with /');
  if (result.autoLogin && !result.email) die('--email is required with --auto-login');
  if (result.refresh && !result.autoLogin) die('--refresh-login-secret requires --auto-login');
  result.seconds = seconds(result.every);
  return result;
}

function syncArgs(config, dryRun = false) {
  const args = ['sync', 'lastpass', '--group', config.group];
  if (config.autoLogin) args.push('--exclude', config.authSecret);
  if (dryRun) args.push('--dry-run');
  args.push(...config.names);
  return args;
}

function readConfig(path) {
  if (!existsSync(path)) die(`no schedule config at ${path} (run install)`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { die(`could not read schedule config at ${path}`); }
}

function install(args) {
  const platform = process.env.HUSH_LASTPASS_SCHEDULE_PLATFORM || process.platform;
  if (platform !== 'darwin') die('schedule install currently supports macOS launchd only');
  const options = parseInstall(args);
  const paths = roots();
  const hush = findExecutable('hush', process.env.HUSH_LASTPASS_SCHEDULE_HUSH);
  const lpass = findExecutable('lpass', process.env.HUSH_LASTPASS_SCHEDULE_LPASS);
  const launchctl = findExecutable('launchctl', process.env.HUSH_LASTPASS_SCHEDULE_LAUNCHCTL);

  if (options.autoLogin) {
    process.stdout.write('hush-lastpass-schedule: auto-login opt-in stores your LastPass master password in the local hush store.\n');
    const login = run(lpass, ['login', '--trust', options.email], {
      stdio: 'inherit',
      env: { ...process.env, LPASS_AGENT_TIMEOUT: '0' },
    });
    if (login.status !== 0) die('interactive trusted-device login failed; nothing installed');

    const listed = run(hush, ['list']);
    const hasSecret = listed.status === 0 && listed.stdout.split(/\r?\n/).includes(options.authSecret);
    if (!hasSecret || options.refresh) {
      process.stdout.write(`hush-lastpass-schedule: storing login material as hush secret '${options.authSecret}'.\n`);
      const stored = run(hush, ['set', options.authSecret], { stdio: 'inherit' });
      if (stored.status !== 0) die('login secret was not stored; nothing installed');
    }
  } else {
    const status = run(lpass, ['status', '--quiet', '--color=never']);
    if (status.status !== 0) die('LastPass is not logged in; run lpass login first or use --auto-login');
  }

  const config = {
    version: 1,
    hush, lpass,
    group: options.group,
    names: options.names,
    every: options.every,
    seconds: options.seconds,
    autoLogin: options.autoLogin,
    email: options.email,
    authSecret: options.authSecret,
  };

  const preview = run(hush, syncArgs(config, true), { stdio: 'inherit' });
  if (preview.status !== 0) die('sync dry-run failed; nothing installed');
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
  process.stdout.write(`hush-lastpass-schedule: installed every ${config.every}. log: ${paths.log}\n`);
}

function scheduledRun(configPath) {
  const config = readConfig(configPath);
  if (run(config.lpass, ['status', '--quiet', '--color=never']).status !== 0) {
    if (!config.autoLogin) die('LastPass is logged out and auto-login is disabled');
    const env = {
      ...process.env,
      LPASS_AGENT_TIMEOUT: '0',
      LPASS_DISABLE_PINENTRY: '1',
    };
    const login = run(config.hush, [
      'pipe', config.authSecret, '--', config.lpass, 'login', '--trust', config.email,
    ], { env });
    if (login.status !== 0) die('automatic LastPass login failed; refresh trusted login interactively');
  }

  const synced = run(config.hush, syncArgs(config));
  if (synced.status !== 0) die(`sync failed with exit ${synced.status}`);
  process.stdout.write(`hush-lastpass-schedule: ${new Date().toISOString()} sync ok\n`);
}

function status() {
  const paths = roots();
  const config = readConfig(paths.config);
  const launchctl = findExecutable('launchctl', process.env.HUSH_LASTPASS_SCHEDULE_LAUNCHCTL);
  const result = run(launchctl, ['print', `gui/${process.getuid()}/${LABEL}`]);
  process.stdout.write(`hush-lastpass-schedule: ${result.status === 0 ? 'loaded' : 'not loaded'}, every ${config.every}, auto-login ${config.autoLogin ? 'enabled' : 'disabled'}\n`);
  process.exit(result.status === 0 ? 0 : 1);
}

function remove() {
  const paths = roots();
  const launchctl = findExecutable('launchctl', process.env.HUSH_LASTPASS_SCHEDULE_LAUNCHCTL);
  run(launchctl, ['bootout', `gui/${process.getuid()}`, paths.plist]);
  rmSync(paths.plist, { force: true });
  process.stdout.write(`hush-lastpass-schedule: removed LaunchAgent. config retained at ${paths.config}.\n`);
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
