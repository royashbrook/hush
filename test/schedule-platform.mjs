#!/usr/bin/env node
// launchd is macOS-only. POSIX fake executables exercise it on macOS/Linux; Windows checks
// the real install refusal, not a fake Darwin override that cannot execute Unix shebangs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const name = process.argv[2];
assert.ok(['lastpass', 'keepass', 'bitwarden', 'backup'].includes(name));
const here = path.dirname(fileURLToPath(import.meta.url));
if (process.platform === 'win32') {
  const env = { ...process.env };
  delete env[`HUSH_${name.toUpperCase()}_SCHEDULE_PLATFORM`];
  const result = spawnSync(process.execPath, [path.join(here, `../helpers/hush-${name}-schedule.mjs`), 'install'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1, 'unsupported host must refuse install');
  assert.match(result.stderr, /macOS launchd only/);
  console.log(`ok   - ${name} scheduler refuses Windows; POSIX launchd fixture intentionally not run`);
} else {
  const result = spawnSync(process.execPath, [path.join(here, `${name}-schedule.mjs`)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
