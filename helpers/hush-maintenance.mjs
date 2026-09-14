#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { call, executable, stableNode, inspectSchedule, readPlist, launchState } from './schedule-health.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const label = 'com.royashbrook.hush.maintenance';
class MaintenanceError extends Error {}
export const kinds = ['backup', 'keepass', 'bitwarden', 'lastpass'];
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function newer(a, b) {
  const x = versionPattern.exec(a), y = versionPattern.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (BigInt(x[i]) !== BigInt(y[i])) return BigInt(x[i]) > BigInt(y[i]);
  if (!x[4] || !y[4]) return !x[4] && Boolean(y[4]);
  const aa = x[4].split('.'), bb = y[4].split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue;
    if (aa[i] === undefined) return false;
    if (bb[i] === undefined) return true;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    return an && bn ? BigInt(aa[i]) > BigInt(bb[i]) : an !== bn ? !an : aa[i] > bb[i];
  }
  return false;
}
export function installation(file) {
  let real = null, version = null, skillVersion = null, cliVersion = null;
  try {
    real = fs.realpathSync(file);
    const dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name === '@royashbrook/hush' && versionPattern.test(pkg.version)) version = pkg.version;
    cliVersion = fs.readFileSync(path.join(dir, 'hush'), 'utf8').match(/^HUSH_VERSION=(\S+)$/m)?.[1] || null;
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    skillVersion = skill.match(/^  version: (\S+)$/m)?.[1] || null;
  } catch { /* An old single-file install has no package metadata; do not execute it to guess. */ }
  return { path: path.resolve(file), realPath: real, version: cliVersion || version, packageVersion: version, skillVersion,
    mismatch: Boolean(version && ((skillVersion && version !== skillVersion) || (cliVersion && cliVersion !== version))) };
}
export function schedulePaths(home, kind) {
  if (!kinds.includes(kind)) throw new MaintenanceError('unknown schedule target');
  const label = `com.royashbrook.hush.${kind === 'backup' ? kind : `${kind}-sync`}`;
  return { kind, label, plistFile: path.join(home, 'Library/LaunchAgents', `${label}.plist`),
    configFile: path.join(home, 'Library/Application Support/hush', `${kind}-schedule.json`),
    logFile: path.join(home, 'Library/Logs', `hush-${kind}${kind === 'backup' ? '' : '-sync'}.log`) };
}
export function doctor({ home = os.homedir(), platform = process.platform, now = Date.now(), ctl, read } = {}) {
  const command = process.env.HUSH_INVOKED_PATH || path.join(root, 'hush');
  const paths = new Set([command]);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.resolve(dir, 'hush');
    if (fs.existsSync(file)) paths.add(file);
  }
  const schedules = platform === 'darwin' ? kinds.map((kind) => inspectSchedule({ ...schedulePaths(home, kind), now, ctl, read })) : [];
  for (const schedule of schedules) if (typeof schedule.configuredExecutables?.hush === 'string') paths.add(schedule.configuredExecutables.hush);
  // Discover conventional skill homes; explicit --skill covers other substrates without hard-coding them.
  for (const base of ['.claude/skills/hush', '.codex/skills/hush', '.agents/skills/hush']) {
    const dir = path.join(home, base);
    if (fs.existsSync(dir)) paths.add(dir);
  }
  const legacySchedules = platform === 'darwin' ? ['com.hush-backup', 'com.royashbrook.hush-backup'].filter((name) => fs.existsSync(path.join(home, 'Library/LaunchAgents', `${name}.plist`))) : [];
  const installations = [...paths].map(installation);
  return { schema: 1, checkedAt: new Date(now).toISOString(), invoked: installation(command), node: process.execPath,
    installations, versionDrift: new Set(installations.map((i) => i.version).filter(Boolean)).size > 1, schedules, legacySchedules,
    scheduleSupport: platform === 'darwin' ? 'launchd' : 'unsupported: inspect your external scheduler separately',
    update: { status: 'not-checked' } };
}
export function latestVersion({ request = https.get, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new MaintenanceError('public version check unavailable'));
    const req = request('https://registry.npmjs.org/-/package/@royashbrook%2Fhush/dist-tags', {
      headers: { Accept: 'application/json' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); fail(); return; }
      let body = '', size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) { req.destroy(); fail(); return; }
        body += chunk;
      });
      res.on('error', fail);
      res.on('end', () => {
        try {
          const latest = JSON.parse(body).latest;
          if (typeof latest !== 'string' || !versionPattern.test(latest) || latest.length > 128) throw new MaintenanceError();
          resolve(latest);
        } catch { fail(); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); fail(); }, timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', fail);
  });
}
export async function checkUpdates(report, fetchLatest = latestVersion) {
  try {
    const latest = await fetchLatest();
    const outdated = report.installations.filter((i) => i.version && newer(latest, i.version));
    report.update = { status: outdated.length ? 'available' : report.installations.some((i) => !i.version) ? 'unknown-installation-version' : 'current', latest, outdated: outdated.map((i) => ({ path: i.path, version: i.version })) };
  } catch { report.update = { status: 'unavailable' }; }
  return report;
}
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function jsonRead(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new MaintenanceError('unreadable maintenance state; inspect before replacing'); }
}
export function notices(report, prefs, prior = {}, now = Date.now()) {
  const unhealthy = report.schedules.filter((s) => s.state === 'unhealthy').map((s) => `${s.kind}:${s.problems.join(',')}`).sort();
  const healthKey = unhealthy.join(';');
  const events = [];
  if (prefs.enabled && !prefs.muted) {
    if (report.update.status === 'available' && prior.notifiedVersion !== report.update.latest && !(Date.parse(prefs.snoozeUntil) > now)) {
      events.push({ type: 'update', version: report.update.latest, message: `hush ${report.update.latest} is available. review hush doctor before upgrading.` });
    }
    if (healthKey && prior.notifiedHealth !== healthKey) events.push({ type: 'backup-health', key: healthKey, message: `hush backup needs attention: ${unhealthy.join('; ')}. run hush doctor.` });
  }
  return { events, healthKey };
}
function desktop(message) {
  if (process.platform !== 'darwin') throw new MaintenanceError('desktop notifications currently support macOS only');
  const result = call('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "hush"', '-e', 'end run', message]);
  if (result.status !== 0) throw new MaintenanceError('desktop notification failed; local report retained');
}
function macOnly() { if (process.platform !== 'darwin') throw new MaintenanceError('schedule management currently supports macOS launchd only'); }
function setPlist(file, value) {
  atomic(file, JSON.stringify(value));
  if (call('/usr/bin/plutil', ['-convert', 'xml1', file]).status !== 0) throw new MaintenanceError('plist conversion failed');
}

export function repair(home, kind, { apply = false, useCurrent = false, run = call } = {}) {
  macOnly();
  const p = schedulePaths(home, kind), target = `gui/${process.getuid()}/${p.label}`;
  const original = fs.readFileSync(p.plistFile), configBytes = fs.readFileSync(p.configFile);
  const plist = readPlist(p.plistFile), config = JSON.parse(configBytes);
  if (plist.Label !== p.label || plist.Program || JSON.stringify(plist.ProgramArguments?.slice(2)) !== JSON.stringify(['run', '--config', p.configFile])) throw new MaintenanceError('unexpected job shape; manual review required');
  if (!['node', 'node.exe'].includes(path.basename(plist.ProgramArguments[0]))) throw new MaintenanceError('not a Node schedule');
  const before = launchState(run('/bin/launchctl', ['print', target]));
  if (before.running) throw new MaintenanceError('schedule is running; wait for completion before repair');
  const candidate = structuredClone(plist), nextConfig = structuredClone(config);
  candidate.ProgramArguments[0] = stableNode();
  if (useCurrent) {
    candidate.ProgramArguments[1] = path.join(root, 'helpers', `hush-${kind}-schedule.mjs`);
    nextConfig.hush = path.join(root, 'hush');
    if (kind === 'bitwarden') nextConfig.jsonHelper = path.join(root, 'helpers/hush-bitwarden-json.mjs');
    if (kind === 'keepass' && config.version !== 2) throw new MaintenanceError('KeePass config migration requires separate review');
    if (kind !== 'keepass' && config.version !== 1) throw new MaintenanceError('unknown config version');
  }
  if (!executable(candidate.ProgramArguments[0]) || !fs.existsSync(candidate.ProgramArguments[1]) || !executable(nextConfig.hush)) throw new MaintenanceError('replacement runtime/helper/hush unavailable');
  const plan = { kind, apply, useCurrent, from: plist.ProgramArguments.slice(0, 2), to: candidate.ProgramArguments.slice(0, 2), hushFrom: config.hush, hushTo: nextConfig.hush,
    note: 'only runtime and explicitly requested installation paths change; reload may run a backup immediately' };
  if (JSON.stringify(candidate) === JSON.stringify(plist) && JSON.stringify(nextConfig) === JSON.stringify(config)) return { ...plan, changed: false };
  if (!apply) return { ...plan, changed: true };
  const recovery = fs.mkdtempSync(path.join(path.dirname(p.configFile), `repair-${kind}-`));
  fs.chmodSync(recovery, 0o700);
  atomic(path.join(recovery, 'original.plist'), original);
  atomic(path.join(recovery, 'original-config.json'), configBytes);
  atomic(path.join(recovery, 'plan.json'), JSON.stringify(plan, null, 2));
  const staged = path.join(recovery, 'candidate.plist');
  setPlist(staged, candidate);
  if (!isDeepStrictEqual(readPlist(staged), candidate)) throw new MaintenanceError('candidate plist changed during serialization');
  const unchanged = () => fs.readFileSync(p.plistFile).equals(original) && fs.readFileSync(p.configFile).equals(configBytes);
  if (!unchanged() || launchState(run('/bin/launchctl', ['print', target])).running) throw new MaintenanceError('schedule changed or started during preparation; nothing replaced');
  if (before.loaded && run('/bin/launchctl', ['bootout', target]).status !== 0) throw new MaintenanceError('could not unload job; nothing replaced');
  if (!unchanged()) throw new MaintenanceError('schedule drift after unload; foreign changes preserved, inspect job before reloading');
  try {
    if (useCurrent) atomic(p.configFile, JSON.stringify(nextConfig, null, 2) + '\n');
    atomic(p.plistFile, fs.readFileSync(staged));
    if (run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, p.plistFile]).status !== 0) throw new MaintenanceError('repaired job could not load');
  } catch (error) {
    atomic(p.configFile, configBytes); atomic(p.plistFile, original);
    const restored = !before.loaded || run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, p.plistFile]).status === 0;
    throw new MaintenanceError(`${error.message}; original files restored, job reload ${restored ? 'ok' : 'FAILED'}, recovery: ${recovery}`);
  }
  atomic(path.join(recovery, 'result.json'), JSON.stringify({ appliedAt: new Date().toISOString(), registration: 'loaded', backupSuccess: 'not-yet-verified' }));
  return { ...plan, changed: true, recovery };
}

export async function main(args, { home = os.homedir(), run = call, notify = desktop, fetchLatest = latestVersion, emit = console.log, directory } = {}) {
  const stateDir = path.resolve(directory || process.env.HUSH_MAINTENANCE_DIR || path.join(home, '.hush', 'maintenance'));
  const prefsFile = path.join(stateDir, 'preferences.json'), reportFile = path.join(stateDir, 'latest.json');
  const seenFile = path.join(stateDir, 'notified.json');
  const plistFile = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
  const prefs = jsonRead(prefsFile, { enabled: false, desktop: false, muted: false });
  if (!prefs || typeof prefs !== 'object' || !['enabled', 'desktop', 'muted'].every((key) => typeof prefs[key] === 'boolean')) throw new MaintenanceError('invalid preferences; inspect before replacing');
  const command = args.shift() || 'help';
  const output = (value) => emit(JSON.stringify(value, null, 2));
  const savePrefs = () => { atomic(prefsFile, JSON.stringify(prefs, null, 2) + '\n'); output(prefs); };
  if (command === '--version') { if (args.length) throw new MaintenanceError('unexpected arguments'); console.log(installation(root).version || 'unknown'); return; }
  if (command === 'doctor') {
    let updates = false;
    const skills = [];
    while (args.length) {
      const flag = args.shift();
      if (flag === '--check-updates') updates = true;
      else if (flag === '--json') continue;
      else if (flag === '--skill' && args[0] && !args[0].startsWith('--')) skills.push(args.shift());
      else throw new MaintenanceError('doctor: use --check-updates, --json, or --skill PATH');
    }
    const report = doctor({ home });
    report.installations.push(...skills.map(installation));
    report.versionDrift = new Set(report.installations.map((i) => i.version).filter(Boolean)).size > 1;
    if (updates) await checkUpdates(report, fetchLatest);
    output(report);
    process.exitCode = report.schedules.some((s) => s.state === 'unhealthy') ? 1 : updates && report.update.status === 'unavailable' ? 2 : 0;
    return;
  }
  if (command === 'repair') {
    const kind = args.shift();
    if (args.some((a) => !['--apply', '--use-current'].includes(a))) throw new MaintenanceError('repair: TARGET [--use-current] [--apply]');
    output(repair(home, kind, { apply: args.includes('--apply'), useCurrent: args.includes('--use-current') })); return;
  }
  if (['enable', 'install'].includes(command)) {
    if (args.some((a) => a !== '--desktop')) throw new MaintenanceError('use --desktop to opt in to macOS notifications');
    if (args.includes('--desktop')) macOnly();
    if (command === 'install') {
      macOnly();
      if (fs.existsSync(plistFile) || run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]).status === 0) throw new MaintenanceError('maintenance job already exists; remove explicitly before reinstalling');
      const oldPrefs = fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile) : null;
      const job = { Label: label, ProgramArguments: [stableNode(), script, 'check', '--scheduled'],
        EnvironmentVariables: { HUSH_MAINTENANCE_DIR: stateDir },
        StartCalendarInterval: { Hour: 9, Minute: 17 }, RunAtLoad: true,
        StandardOutPath: path.join(stateDir, 'scheduler.log'), StandardErrorPath: path.join(stateDir, 'scheduler.log') };
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      Object.assign(prefs, { enabled: true, desktop: args.includes('--desktop'), muted: false });
      try {
        atomic(prefsFile, JSON.stringify(prefs)); setPlist(plistFile, job);
        if (run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistFile]).status !== 0) throw new MaintenanceError('maintenance job could not load');
      } catch (error) {
        fs.rmSync(plistFile, { force: true });
        if (oldPrefs) atomic(prefsFile, oldPrefs); else fs.rmSync(prefsFile, { force: true });
        throw error;
      }
      output({ ...prefs, schedule: 'daily at 09:17 local and on load', reportFile }); return;
    }
    Object.assign(prefs, { enabled: true, desktop: args.includes('--desktop'), muted: false }); savePrefs(); return;
  }
  if (command === 'snooze') {
    if (args.length !== 1 || !/^[1-9]\d{0,2}$/.test(args[0])) throw new MaintenanceError('snooze requires 1-999 days');
    prefs.snoozeUntil = new Date(Date.now() + Number(args[0]) * 86400000).toISOString(); savePrefs(); return;
  }
  if (['mute', 'unmute', 'disable', 'status', 'remove'].includes(command)) {
    if (args.length) throw new MaintenanceError('unexpected arguments');
    if (command === 'status') { output({ preferences: prefs, reportFile, latest: jsonRead(reportFile, null) }); return; }
    if (command === 'remove') {
      macOnly();
      const target = `gui/${process.getuid()}/${label}`;
      if (run('/bin/launchctl', ['print', target]).status === 0 && run('/bin/launchctl', ['bootout', target]).status !== 0) throw new MaintenanceError('unload failed; files preserved');
      fs.rmSync(plistFile, { force: true }); prefs.enabled = false;
    } else if (command === 'disable') prefs.enabled = false;
    else prefs.muted = command === 'mute';
    savePrefs(); return;
  }
  if (command === 'check') {
    if (args.some((a) => a !== '--scheduled')) throw new MaintenanceError('check accepts only --scheduled');
    if (args.includes('--scheduled') && !prefs.enabled) return;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const lock = path.join(stateDir, 'check.lock');
    // No competing checks/dedupe writes. A crash leaves a visible lock for explicit inspection.
    const fd = fs.openSync(lock, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, String(process.pid));
      const report = await checkUpdates(doctor({ home }), fetchLatest);
      const prior = jsonRead(seenFile, {}), pending = notices(report, prefs, prior);
      report.notifications = pending.events;
      atomic(reportFile, JSON.stringify(report, null, 2) + '\n');
      for (const event of pending.events) {
        if (prefs.desktop) notify(event.message);
        if (event.type === 'update') prior.notifiedVersion = event.version;
        else prior.notifiedHealth = event.key;
      }
      if (!pending.healthKey) delete prior.notifiedHealth;
      atomic(seenFile, JSON.stringify(prior, null, 2));
      output({ checkedAt: report.checkedAt, update: report.update.status, notifications: pending.events, reportFile });
      if (report.update.status === 'unavailable') process.exitCode = 2;
    } finally { fs.closeSync(fd); fs.rmSync(lock); }
    return;
  }
  if (!['help', '--help', '-h'].includes(command)) throw new MaintenanceError('unknown maintenance command');
  console.log(`hush maintenance (Node 18+, no secret access)
  hush doctor [--check-updates] [--skill PATH] [--json]
  hush maintenance check                 public version + local health, saves JSON
  hush maintenance enable [--desktop]    opt in, bring your own scheduler
  hush maintenance install [--desktop]   opt-in daily macOS job (09:17 + load)
  hush maintenance status | mute | unmute | snooze DAYS | disable | remove
  hush maintenance repair TARGET [--use-current] [--apply]
Targets: backup, keepass, bitwarden, lastpass. Repair previews by default.
No upgrade is automatic. Snooze affects update notices only; mute silences all notices.
An external scheduler runs: node /absolute/path/helpers/hush-maintenance.mjs check --scheduled
State: ${stateDir}`);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === script) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof MaintenanceError ? `hush maintenance: ${error.message}` : `hush maintenance failed (${error.code || 'invalid local data'}); inspect configuration and local state, then retry.`);
    process.exitCode = 1;
  });
}
