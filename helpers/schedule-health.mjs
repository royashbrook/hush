import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const call = (exe, args) => spawnSync(exe, args, {
  encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
});
export function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}
export function stableNode(searchPath = process.env.PATH || '', current = process.execPath) {
  // Keep a package-manager symlink, not its disposable Cellar target. Never switch Node versions.
  const candidates = searchPath.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p, path.basename(current)));
  const matching = candidates.filter((p) => {
    try { return executable(p) && fs.realpathSync(p) === fs.realpathSync(current); } catch { return false; }
  });
  const selected = matching.find((p) => !/[/\\](?:Cellar|versions)[/\\]/.test(p)) || current;
  if (!executable(selected)) throw new Error('scheduled Node executable is unavailable');
  if (/[/\\](?:Cellar|versions)[/\\]/.test(selected)) {
    process.stderr.write('hush: scheduled Node path is version-specific; run hush doctor after Node upgrades\n');
  }
  return selected;
}
export function readPlist(file) {
  if (process.platform !== 'darwin') {
    // POSIX fixture hosts lack plutil. Only read the two fields used by status, never rewrite XML.
    const source = fs.readFileSync(file, 'utf8');
    const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
    const label = source.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    const array = source.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    if (!label || !array || array.replace(/<string>[^<]*<\/string>/g, '').trim()) throw new Error('unrecognized schedule XML');
    return { Label: decode(label), ProgramArguments: [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => decode(m[1])) };
  }
  const result = call('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
  if (result.status !== 0) throw new Error('cannot read schedule plist');
  return JSON.parse(result.stdout);
}
export function launchState(result) {
  const text = result.stdout || '';
  return {
    loaded: result.status === 0,
    running: /^\s*pid = \d+\s*$/m.test(text),
    lastExit: Number(text.match(/^\s*last exit code = (-?\d+)\s*$/m)?.[1] ?? NaN),
    spawnFailed: /state = spawn failed/.test(text),
    program: text.match(/^\s*program = (.+)\s*$/m)?.[1]?.trim() || null,
  };
}
export function lastSuccess(file, kind) {
  // Bound reads and return only the scheduler's timestamp, never arbitrary log text or names.
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 256 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const pattern = new RegExp(`^hush-${kind}-schedule: (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z) (?:sync|backup) ok$`, 'gm');
    const stamps = [...buffer.toString('utf8').matchAll(pattern)].map((m) => m[1]).filter((s) => Number.isFinite(Date.parse(s)));
    return stamps.at(-1) || null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function inspectSchedule({ plistFile, configFile, logFile, label, kind, ctl = 'launchctl', now = Date.now(), read = readPlist, probe = call }) {
  if (!fs.existsSync(plistFile)) return { kind, state: 'not-installed', problems: [], plistFile };
  const problems = [];
  let plist, config;
  try { plist = read(plistFile); } catch { problems.push('unreadable-plist'); }
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { problems.push('unreadable-config'); }
  if (config && (typeof config.hush !== 'string' || !Number.isFinite(config.seconds) || config.seconds <= 0)) problems.push('invalid-config');
  const state = launchState(probe(ctl, ['print', `gui/${process.getuid?.()}/${label}`]));
  if (!state.loaded) problems.push('not-loaded');
  if (state.spawnFailed) problems.push('spawn-failed');
  if (!state.running && Number.isFinite(state.lastExit) && state.lastExit !== 0) problems.push('last-run-failed');
  const args = plist?.ProgramArguments;
  if (!Array.isArray(args) || !executable(args[0])) problems.push('missing-runtime');
  if (state.program && args?.[0] !== state.program) problems.push('loaded-runtime-drift');
  if (!Array.isArray(args) || !fs.existsSync(args[1] || '')) problems.push('missing-helper');
  const configuredExecutables = {};
  for (const key of ['hush', 'bw', 'lpass', 'keepassxc', 'bash', 'gpg']) {
    if (config?.[key] !== undefined) {
      configuredExecutables[key] = typeof config[key] === 'string' ? config[key] : null;
      if (typeof config[key] !== 'string' || !executable(config[key])) problems.push(`missing-${key}`);
    }
  }
  if (config?.jsonHelper && !fs.existsSync(config.jsonHelper)) problems.push('missing-json-helper');
  if (plist && (plist.Label !== label || args?.[2] !== 'run' || args?.[3] !== '--config' || args?.[4] !== configFile)) problems.push('unexpected-job-command');
  const success = lastSuccess(logFile, kind);
  const cadence = Number(config?.seconds);
  if (success && Date.parse(success) > now + 60000) problems.push('future-success-time');
  if (success && cadence > 0 && now - Date.parse(success) > Math.max(cadence * 2, cadence + 3600) * 1000) problems.push('success-overdue');
  return {
    kind, state: problems.length ? 'unhealthy' : state.running ? 'running' : success ? 'ok' : 'unverified',
    problems, loaded: state.loaded, running: state.running, lastExit: Number.isFinite(state.lastExit) ? state.lastExit : null,
    lastSuccess: success, cadenceSeconds: cadence > 0 ? cadence : null,
    plistFile, configFile, logFile, runtime: args?.[0] || null, helper: args?.[1] || null, configuredExecutables,
  };
}
export function scheduleStatus(options) {
  const report = inspectSchedule(options);
  console.log(JSON.stringify(report, null, 2));
  // Registration without a run receipt is not backup success, but remains a usable fresh job.
  return ['ok', 'running', 'unverified'].includes(report.state) ? 0 : 1;
}
