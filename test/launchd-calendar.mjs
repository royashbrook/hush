import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { launchdCalendarXml } from '../helpers/launchd-calendar.mjs';

const sixHours = launchdCalendarXml(6 * 60 * 60);
assert.equal((sixHours.match(/<dict>/g) || []).length, 4);
for (const hour of [0, 6, 12, 18]) assert.match(sixHours, new RegExp(`<integer>${hour}</integer>`));

const sevenHours = launchdCalendarXml(7 * 60 * 60);
assert.match(sevenHours, /<key>Weekday<\/key>/);

const tenDays = launchdCalendarXml(10 * 24 * 60 * 60);
for (const day of [1, 11, 21, 31]) assert.match(tenDays, new RegExp(`<integer>${day}</integer>`));

if (process.platform === 'darwin') {
  const plist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>test</string><key>StartCalendarInterval</key>${sixHours}</dict></plist>`;
  const lint = spawnSync('plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stderr || lint.stdout);
}

process.stdout.write('# launchd calendar tests done. failures: 0\n');
