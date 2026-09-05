#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { launchdCalendarXml } from './launchd-calendar.mjs';

const script = fileURLToPath(import.meta.url);
const helper = path.join(path.dirname(script), 'hush-backup');
const home = process.env.HUSH_BACKUP_SCHEDULE_HOME || os.homedir();
const label = process.env.HUSH_BACKUP_SCHEDULE_LABEL || 'com.royashbrook.hush.backup';
if (!/^com\.royashbrook\.hush\.backup(?:\.test-[a-zA-Z0-9-]+)?$/.test(label)) throw new Error('invalid job label');
const configFile = path.join(home, 'Library/Application Support/hush/backup-schedule.json');
const plistFile = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
const logFile = path.join(home, 'Library/Logs/hush-backup.log');
const domain = `gui/${process.getuid?.()}`;
const target = `${domain}/${label}`;
const cloud = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs');
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const call = (exe, args, env = process.env) => spawnSync(exe, args, { env, encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 });
const fail = (message) => { throw new Error(message); };
const log = (message) => console.log(`hush-backup-schedule: ${new Date().toISOString()} ${message}`);

function executable(name, override) {
  const candidates = override ? [override] : (process.env.PATH || '').split(path.delimiter).map((p) => path.resolve(p, name));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch {}
  }
  fail(`${name} executable not found`);
}
function launchctl() { return executable('launchctl', process.env.HUSH_BACKUP_SCHEDULE_LAUNCHCTL); }
function macOnly() {
  if ((process.env.HUSH_BACKUP_SCHEDULE_PLATFORM || process.platform) !== 'darwin') fail('schedule management currently supports macOS launchd only');
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function environment(config) {
  return { ...process.env, PATH: config.path, HUSH_NS: config.namespace,
    HUSH_BACKUP_HUSH: config.hush, HUSH_BACKUP_GPG: config.gpg,
    HUSH_BACKUP_DIR: config.directory, HUSH_BACKUP_KEY: config.key, HUSH_BACKUP_KEEP: String(config.keep) };
}
function read(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.version !== 1 || !['hush', 'gpg', 'bash', 'directory', 'key', 'namespace', 'path'].every((key) => typeof config[key] === 'string')
    || !Number.isInteger(config.keep) || config.keep < 1 || config.keep > 10000) fail('invalid schedule config; reinstall');
  return config;
}
function install(args) {
  macOnly();
  const options = { directory: path.join(cloud, 'hush-backups'), key: 'hush-backup-key', keep: '30', every: '6h' };
  let customDirectory = false;
  while (args.length) {
    const key = args.shift();
    if (!['--directory', '--key-secret', '--keep', '--every'].includes(key) || !args.length) fail('invalid install option; see --help');
    const name = key === '--key-secret' ? 'key' : key.slice(2);
    options[name] = args.shift();
    if (name === 'directory') customDirectory = true;
  }
  if (!customDirectory && (!fs.existsSync(cloud) || !fs.statSync(cloud).isDirectory())) fail('iCloud Drive is unavailable; enable it or provide --directory');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.key)) fail('invalid backup key name');
  if (!/^\d+$/.test(options.keep) || Number(options.keep) < 1 || Number(options.keep) > 10000) fail('--keep must be 1-10000');
  const interval = /^(\d+)(m|h)$/.exec(options.every);
  const seconds = interval && Number(interval[1]) * (interval[2] === 'm' ? 60 : 3600);
  if (!seconds || seconds < 300 || 86400 % seconds !== 0) fail('--every must divide one day into equal slots, minimum 5m (for example 30m, 6h, 24h)');
  const config = { version: 1, directory: path.resolve(options.directory), key: options.key, keep: Number(options.keep), every: options.every, seconds,
    hush: executable('hush', process.env.HUSH_BACKUP_HUSH || path.join(path.dirname(script), '../hush')),
    gpg: executable('gpg', process.env.HUSH_BACKUP_GPG), bash: executable('bash', process.env.HUSH_BACKUP_BASH),
    namespace: process.env.HUSH_NS || 'hush', path: process.env.PATH || '/usr/bin:/bin' };
  const ctl = launchctl();
  const legacyFile = path.join(home, 'Library/LaunchAgents/com.hush-backup.plist');
  if (fs.existsSync(legacyFile) || call(ctl, ['print', `${domain}/com.hush-backup`]).status === 0) {
    fail('legacy com.hush-backup schedule exists; remove that schedule deliberately before installing this one (keep its key and backups)');
  }
  const checked = call(config.bash, [helper, '--dry-run'], environment(config));
  if (checked.status !== 0) fail('backup dry-run failed; check destination, gpg, and the hush key (mint it once and keep a separate recovery copy)');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[process.execPath, script, 'run', '--config', configFile].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>StartCalendarInterval</key>${launchdCalendarXml(seconds)}
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(logFile)}</string>
<key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>\n`;
  // Preserve the previous working schedule if reinstallation cannot load the replacement.
  const oldConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
  const oldPlist = fs.existsSync(plistFile) ? fs.readFileSync(plistFile) : null;
  const wasLoaded = call(ctl, ['print', target]).status === 0;
  if (wasLoaded && !oldPlist) fail('loaded job has no owned plist; inspect it before reinstalling');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  if (wasLoaded && call(ctl, ['bootout', target]).status !== 0) fail('could not unload current schedule; nothing replaced');
  try {
    write(configFile, `${JSON.stringify(config, null, 2)}\n`);
    write(plistFile, plist);
    if (call(ctl, ['bootstrap', domain, plistFile]).status !== 0) fail('launchctl bootstrap failed');
  } catch (error) {
    if (oldConfig) write(configFile, oldConfig); else fs.rmSync(configFile, { force: true });
    if (oldPlist) write(plistFile, oldPlist); else fs.rmSync(plistFile, { force: true });
    if (wasLoaded && call(ctl, ['bootstrap', domain, plistFile]).status !== 0) fail('install failed; old files restored but old job could not reload');
    throw error;
  }
  log(`installed ${options.every}; keep a recovery copy of the backup key outside this Keychain. log: ${logFile}`);
}
function run(file) {
  const config = read(file);
  log('backup starting');
  const result = call(config.bash, [helper, '--auto'], environment(config));
  if (result.status !== 0) fail(`backup failed (${result.error?.code || result.status}); no child output logged`);
  log('backup ok');
}
function status() {
  macOnly();
  const loaded = call(launchctl(), ['print', target]).status === 0;
  log(`${loaded ? 'loaded' : 'not loaded'}; config: ${configFile}; log: ${logFile}`);
  process.exitCode = loaded ? 0 : 1;
}
function remove() {
  macOnly();
  const ctl = launchctl();
  if (call(ctl, ['print', target]).status === 0 && call(ctl, ['bootout', target]).status !== 0) fail('could not unload schedule; plist preserved');
  fs.rmSync(plistFile, { force: true });
  log('schedule removed; config, encrypted backups and Keychain entries retained');
}
const [command = 'help', ...args] = process.argv.slice(2);
try {
  if (command === 'install') install(args);
  else if (command === 'run' && (!args.length || (args.length === 2 && args[0] === '--config'))) run(args[1] || configFile);
  else if (command === 'status' && !args.length) status();
  else if (command === 'remove' && !args.length) remove();
  else if (['help', '--help', '-h'].includes(command)) console.log(`hush-backup-schedule: opt-in encrypted backups (macOS launchd)
  install [--directory PATH] [--key-secret NAME] [--keep 30] [--every 6h]
  run | status | remove
Default destination: iCloud Drive/hush-backups. Requires GnuPG and an existing Hush backup key.
First: hush mint hush-backup-key, then keep a recovery copy outside this Keychain.
Install checks names/prerequisites without reading values; launchd runs the first backup on load.
Only ciphertext is written. Remove preserves backups, config, and secrets. Schedule slots use local time.`);
  else fail('invalid command or arguments; see --help');
} catch (error) { console.error(`hush-backup-schedule: ${error.message}`); process.exitCode = 1; }
