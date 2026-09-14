#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newer, installation, doctor, latestVersion, checkUpdates, notices, atomic, repair, schedulePaths, main } from '../helpers/hush-maintenance.mjs';
import { stableNode, inspectSchedule, readPlist, launchState, lastSuccess } from '../helpers/schedule-health.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-maintenance-test-'));
const home = path.join(tmp, 'home'), state = path.join(tmp, 'state');
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); checks++; console.log(`ok - ${name}`); }
function requestFixture(body, status = 200, hang = false) {
  return (url, options, callback) => {
    assert.equal(url, 'https://registry.npmjs.org/-/package/@royashbrook%2Fhush/dist-tags');
    assert.deepEqual(options, { headers: { Accept: 'application/json' } });
    const req = new EventEmitter();
    req.destroy = () => req.emit('close');
    if (!hang) setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = status; res.resume = () => {};
      callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); req.emit('close');
    });
    return req;
  };
}
const cli = (args, status = 0) => {
  const result = spawnSync(process.execPath, [path.join(repo, 'helpers/hush-maintenance.mjs'), ...args], {
    env: { ...process.env, HUSH_MAINTENANCE_DIR: state }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, status, result.stderr); return result;
};
try {
  test('semver respects prerelease, numeric ordering, equality and invalid data', () => {
    for (const [a, b, expected] of [['1.10.0','1.9.0',true], ['2.0.0','1.99.0',true], ['1.0.0','1.0.0-beta',true], ['1.0.0-beta.10','1.0.0-beta.2',true], ['1.0.0-a','1.0.0',false], ['1.0.0','1.0.0',false], ['bad','1.0.0',false], ['1.0.0+other','1.0.0+build',false]]) assert.equal(newer(a,b), expected);
  });
  test('version, manifest and skill metadata agree', () => {
    const info = installation(repo);
    assert.equal(info.version, '1.6.0'); assert.equal(info.mismatch, false);
  });
  test('offline doctor needs no store or registry, unsupported schedulers explicit', () => {
    const report = doctor({ home, platform: 'win32' });
    assert.equal(report.update.status, 'not-checked'); assert.equal(report.schedules.length, 0);
    assert.match(report.scheduleSupport, /unsupported/);
  });
  await asyncTest('registry bounded request sends no local metadata', async () => {
    assert.equal(await latestVersion({ request: requestFixture('{"latest":"1.7.0"}') }), '1.7.0');
    for (const body of ['not json', '{"latest":"x\\u001b[31m"}', '{}', 'x'.repeat(70000)]) await assert.rejects(latestVersion({ request: requestFixture(body) }));
    await assert.rejects(latestVersion({ request: requestFixture('{}', 302) }));
    await assert.rejects(latestVersion({ request: requestFixture('', 200, true), timeout: 20 }));
  });
  await asyncTest('offline registry failure stays unknown, never up-to-date', async () => {
    const r = doctor({ home, platform: 'linux' });
    await checkUpdates(r, async () => { throw new Error('offline'); }); assert.equal(r.update.status, 'unavailable');
    r.installations = [{ path:'scheduled',version:'1.4.0' }, {path:'skill',version:'1.6.0'}];
    await checkUpdates(r, async () => '1.5.0'); assert.equal(r.update.status, 'available'); assert.equal(r.update.outdated[0].path, 'scheduled');
  });
  test('notification consent, dedupe, snooze and health stay separate', () => {
    const report = { update: {status:'available',latest:'1.7.0'}, schedules:[{kind:'backup',state:'unhealthy',problems:['missing-runtime']}] };
    assert.equal(notices(report, {}).events.length, 0);
    assert.equal(notices(report, {enabled:true}).events.length, 2);
    assert.equal(notices(report, {enabled:true,muted:true}).events.length, 0);
    assert.deepEqual(notices(report, {enabled:true,snoozeUntil:'2099-01-01'}, {}).events.map((e) => e.type), ['backup-health']);
    const prior = {notifiedVersion:'1.7.0',notifiedHealth:'backup:missing-runtime'};
    assert.equal(notices(report, {enabled:true}, prior).events.length, 0);
    report.update.latest = '1.8.0'; assert.equal(notices(report, {enabled:true}, prior).events.length, 1);
  });
  test('CLI opt-in, mute, snooze, disable persist, disabled scheduled check makes no request', () => {
    cli(['enable']); cli(['mute']); cli(['snooze','7']);
    assert.equal(JSON.parse(cli(['status']).stdout).preferences.muted, true);
    cli(['unmute']); cli(['disable']); cli(['check','--scheduled']);
    assert.ok(!fs.existsSync(path.join(state,'latest.json')));
    cli(['snooze','-1'],1); cli(['doctor','--unknown'],1);
    assert.ok(!fs.existsSync(path.join(home,'Library/LaunchAgents')));
  });
  test('job registration is not successful execution', () => {
    assert.equal(launchState({status:0,stdout:'state = spawn failed\nlast exit code = 78'}).spawnFailed,true);
    assert.equal(launchState({status:0,stdout:'state = waiting'}).lastExit.toString(),'NaN');
  });
  await asyncTest('full check writes persistent report and dedupes across invocations', async () => {
    const directory = path.join(tmp,'check-state');
    let requests = 0;
    const options = {home,directory,emit:()=>{},fetchLatest:async()=>{requests++;return '99.0.0';}};
    await main(['enable'],options);
    await main(['check','--scheduled'],options);
    let report = JSON.parse(fs.readFileSync(path.join(directory,'latest.json')));
    assert.equal(report.notifications.length,1); assert.equal(report.update.latest,'99.0.0');
    await main(['check','--scheduled'],options);
    report = JSON.parse(fs.readFileSync(path.join(directory,'latest.json')));
    assert.equal(report.notifications.length,0); assert.equal(report.update.latest,'99.0.0');
    await main(['disable'],options); await main(['check','--scheduled'],options); assert.equal(requests,2);
    await main(['enable'],options); atomic(path.join(directory,'check.lock'),'not-running-test');
    await assert.rejects(main(['check','--scheduled'],options),/EEXIST/); assert.equal(requests,2);
    fs.rmSync(path.join(directory,'check.lock'));
  });
  const p = schedulePaths(home,'keepass');
  const config = {version:2,hush:path.join(repo,'hush'),seconds:21600,names:['test-name'],excludes:['local'],database:'keep-destination',mirror:'keep-mirror',group:'keep-group',dbSecret:'test-key'};
  const plist = {Label:p.label,ProgramArguments:[process.execPath,path.join(repo,'helpers/hush-keepass-schedule.mjs'),'run','--config',p.configFile],StartInterval:21600,RunAtLoad:true,StandardOutPath:p.logFile,StandardErrorPath:p.logFile};
  atomic(p.configFile, JSON.stringify(config)); atomic(p.plistFile, JSON.stringify(plist));
  const read = () => JSON.parse(fs.readFileSync(p.plistFile));
  test('missing runtime beats loaded status and recent success evidence', () => {
    const broken = structuredClone(plist); broken.ProgramArguments[0] = path.join(tmp,'gone','node');
    atomic(p.plistFile,JSON.stringify(broken));
    atomic(p.logFile, `do not echo this arbitrary sensitive log line\nhush-keepass-schedule: ${new Date().toISOString()} sync ok\n`);
    const r = inspectSchedule({...p,read,probe:()=>({status:0,stdout:'state = spawn failed\nlast exit code = 78\n'})});
    assert.equal(r.loaded,true); assert.equal(r.state,'unhealthy'); assert.equal(r.lastExit,78);
    assert.ok(r.problems.includes('missing-runtime')); assert.ok(r.lastSuccess);
    assert.ok(!JSON.stringify(r).includes('arbitrary sensitive'));
    atomic(p.plistFile,JSON.stringify(plist));
  });
  test('registered idle job needs success evidence, loaded command drift refuses healthy', () => {
    atomic(p.logFile,'');
    const probe = () => ({status:0,stdout:'state = waiting\nlast exit code = 0\n'});
    assert.equal(inspectSchedule({...p,read,probe}).state,'unverified');
    atomic(p.logFile,`hush-keepass-schedule: ${new Date().toISOString()} sync ok\n`);
    assert.equal(inspectSchedule({...p,read,probe}).state,'ok');
    const bad = inspectSchedule({...p,read,probe:()=>({status:0,stdout:'program = /old/node\n'})});
    assert.ok(bad.problems.includes('loaded-runtime-drift'));
  });
  test('old, absent and future success evidence are not fresh success', () => {
    atomic(p.logFile,'hush-keepass-schedule: 2000-01-01T00:00:00.000Z sync ok\n');
    assert.ok(inspectSchedule({...p,read,ctl:process.execPath}).problems.includes('success-overdue'));
    atomic(p.logFile,'hush-keepass-schedule: 2099-01-01T00:00:00.000Z sync ok\n');
    assert.ok(inspectSchedule({...p,read,ctl:process.execPath}).problems.includes('future-success-time'));
    atomic(p.logFile,'unrecognized success'); assert.equal(lastSuccess(p.logFile,'keepass'), null);
  });
  if (process.platform !== 'win32') {
    test('stable Node keeps the matching symlink, not its version-specific target', () => {
      const bin = path.join(tmp,'bin'); fs.mkdirSync(bin);
      const stable = path.join(bin,path.basename(process.execPath)); fs.symlinkSync(process.execPath,stable);
      assert.equal(stableNode(bin),stable);
    });
    test('npm-style symlink invocation finds helpers with no backend', () => {
      const link = path.join(tmp,'hush'); fs.symlinkSync(path.join(repo,'hush'),link);
      const r = spawnSync('bash',[link,'--version'],{encoding:'utf8'}); assert.equal(r.status,0); assert.equal(r.stdout.trim(),'1.6.0');
      const doc = spawnSync('bash',[link,'maintenance','--help'],{encoding:'utf8'}); assert.equal(doc.status,0); assert.match(doc.stdout,/No upgrade is automatic/);
      const helperLink = path.join(tmp,'hush-maintenance'); fs.symlinkSync(path.join(repo,'helpers/hush-maintenance.mjs'),helperLink);
      const helperResult = spawnSync(process.execPath,[helperLink,'--help'],{encoding:'utf8'});
      assert.equal(helperResult.status,0); assert.match(helperResult.stdout,/No upgrade is automatic/);
    });
  }
  if (process.platform === 'darwin') {
    await asyncTest('cold notification install, failure rollback, send retry and remove (fake OS calls)', async () => {
      const isolated = path.join(tmp,'notification-home'), directory = path.join(tmp,'notification-state');
      const job = path.join(isolated,'Library/LaunchAgents/com.royashbrook.hush.maintenance.plist');
      let loaded = false, fail = true, sends = 0;
      const run = (_,args) => {
        if(args[0]==='print') return {status:loaded?0:1};
        if(args[0]==='bootstrap') {if(fail)return{status:1}; loaded=true; return{status:0};}
        if(args[0]==='bootout'){loaded=false;return{status:0};}
        throw new Error('unexpected OS call');
      };
      const options = {home:isolated,directory,run,emit:()=>{},fetchLatest:async()=>'99.0.0',notify:()=>{sends++; if(sends===1)throw new Error('fixture notification failed');}};
      await assert.rejects(main(['install','--desktop'],options),/could not load/);
      assert.ok(!fs.existsSync(job)); assert.ok(!fs.existsSync(path.join(directory,'preferences.json')));
      fail=false; await main(['install','--desktop'],options);
      const config = readPlist(job);
      assert.equal(config.ProgramArguments[0],stableNode()); assert.deepEqual(config.StartCalendarInterval,{Hour:9,Minute:17});
      assert.equal(config.EnvironmentVariables.HUSH_MAINTENANCE_DIR,directory);
      await assert.rejects(main(['install','--desktop'],options),/already exists/);
      await assert.rejects(main(['check','--scheduled'],options),/notification failed/);
      assert.ok(fs.existsSync(path.join(directory,'latest.json'))); assert.ok(!fs.existsSync(path.join(directory,'notified.json')));
      await main(['check','--scheduled'],options); await main(['check','--scheduled'],options); assert.equal(sends,2);
      await main(['remove'],options); assert.equal(loaded,false); assert.ok(!fs.existsSync(job)); assert.ok(fs.existsSync(path.join(directory,'latest.json')));
    });
    const oldPlist = JSON.stringify({...plist,ProgramArguments:['/missing/Cellar/node/old/bin/node',...plist.ProgramArguments.slice(1)]});
    atomic(p.plistFile,oldPlist);
    const oldConfig = fs.readFileSync(p.configFile);
    const actions = [];
    let running = false, failLoad = false, drift = false;
    const run = (exe,args) => {
      assert.equal(exe,'/bin/launchctl'); actions.push(args[0]);
      if (args[0] === 'print') return {status:0,stdout:running ? 'pid = 123\n' : 'state = waiting\nlast exit code = 0\n'};
      if (args[0] === 'bootout' && drift) atomic(p.configFile,'{"foreign":"change"}');
      if (args[0] === 'bootstrap' && failLoad) { failLoad = false; return {status:1}; }
      return {status:0};
    };
    test('repair preview does not write or bootout', () => {
      const r = repair(home,'keepass',{run}); assert.equal(r.apply,false); assert.equal(r.changed,true);
      assert.equal(fs.readFileSync(p.plistFile,'utf8'),oldPlist); assert.ok(!actions.includes('bootout'));
    });
    test('repair refuses active jobs', () => {
      running = true; assert.throws(() => repair(home,'keepass',{apply:true,run}),/running/); running = false;
    });
    test('failed bootstrap restores exact original config and plist', () => {
      failLoad = true; assert.throws(() => repair(home,'keepass',{apply:true,run}),/original files restored/);
      assert.equal(fs.readFileSync(p.plistFile,'utf8'),oldPlist); assert.ok(fs.readFileSync(p.configFile).equals(oldConfig));
    });
    test('repair preserves destinations, exclusions, cadence and bytes of config', () => {
      const r = repair(home,'keepass',{apply:true,run}); assert.ok(r.recovery);
      const changed = readPlist(p.plistFile); const expected = JSON.parse(oldPlist); expected.ProgramArguments[0] = stableNode();
      assert.deepEqual(changed,expected); assert.ok(fs.readFileSync(p.configFile).equals(oldConfig));
      assert.equal(fs.readFileSync(path.join(r.recovery,'original.plist'),'utf8'),oldPlist);
      assert.equal(repair(home,'keepass',{apply:true,run}).changed,false);
    });
    test('config drift after unload is preserved, never overwritten by rollback', () => {
      atomic(p.plistFile,oldPlist); drift = true;
      assert.throws(() => repair(home,'keepass',{apply:true,run}),/foreign changes preserved/);
      assert.equal(fs.readFileSync(p.configFile,'utf8'),'{"foreign":"change"}'); drift = false; atomic(p.configFile,oldConfig);
    });
    test('use-current only reconciles installation paths', () => {
      const r = repair(home,'keepass',{apply:true,useCurrent:true,run}); assert.ok(r.recovery);
      assert.deepEqual(JSON.parse(fs.readFileSync(p.configFile)),config);
    });
  } else console.log('skip - live plist serialization + fake launchctl repair gate is macOS-only');
  console.log(`${checks} maintenance checks passed; no live vault or scheduler mutations`);
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
