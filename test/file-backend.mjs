#!/usr/bin/env node
// Fake credentials only. HOME and every OS credential/prompt tool are isolated.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Like the scheduler fixtures, these executable stubs require a POSIX host.
if (process.platform === 'win32') {
  console.log('skip - file backend POSIX executable fixtures are not run on native Windows');
  process.exit(0);
}

const hush = process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '../hush');
const root = mkdtempSync(join(tmpdir(), 'hush-file-test-'));
const bin = join(root, 'bin');
const home = join(root, 'home');
mkdirSync(bin);
mkdirSync(home);
const source = join(home, '.secrets');
const log = join(root, 'unexpected-tools');
const marker = join(root, 'sourced');
const fake = 'FAKE-file-test-never-log-this';
const fixture = `# Synthetic Bash credentials, not a real store.
TOKEN='${fake}'
export SECOND='another-fake-value'
_PRIVATE='underscore-fake'
name='name-fake'
__v='local-fake'
__out='output-fake'
NS='namespace-fake'
BACKEND='backend-fake'
HUSH_FILE='path-fake'
EMPTY=''
MULTILINE=$'first\\nsecond\\n\\n'
WITH_SPACES='a b "c"'
UNSET_VALUE='not-available'
unset UNSET_VALUE
printf '%s' '${fake}'
printf '%s' '${fake}' >&2
touch '${marker}'
set -- replaced positional arguments
set -x
`;
writeFileSync(source, fixture);
writeFileSync(join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "$HUSH_TEST_OS"\n', { mode: 0o755 });
for (const tool of ['security', 'secret-tool', 'powershell.exe', 'osascript', 'zenity', 'kdialog']) {
  writeFileSync(join(bin, tool), '#!/bin/sh\nprintf "unexpected\\n" >> "$HUSH_TEST_TOOL_LOG"\nexit 88\n', { mode: 0o755 });
}
writeFileSync(join(bin, 'lpass'), '#!/bin/sh\ncase "$1" in\n status) exit 0 ;;\n edit) cat > "$HOME/fake-synced" ;;\n *) exit 88 ;;\nesac\n', { mode: 0o755 });
const env = {
  HOME: home,
  PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HUSH_BACKEND: 'file', HUSH_FILE: source,
  HUSH_TEST_OS: 'Darwin', HUSH_TEST_TOOL_LOG: log,
  INHERITED_ONLY: 'not-a-source-secret',
};
let checks = 0;
function check(condition, label) {
  if (!condition) throw new Error(label); // Never include captured credentials or output.
  checks++;
  console.log(`ok - ${label}`);
}
function run(args, extra = {}, input, cwd) {
  const result = spawnSync(hush, args, { env: { ...env, ...extra }, input, cwd, encoding: 'utf8', timeout: 5000 });
  if (result.error || result.signal) throw new Error('hush did not complete');
  return result;
}
function noLeak(result, label) {
  check(!`${result.stdout || ''}${result.stderr || ''}`.includes(fake), label);
}
const consumer = 'if (process.env.TOKEN !== process.argv[1] || process.env.SECOND !== undefined || process.env._PRIVATE !== undefined) process.exit(1)';

try {
  const listed = run(['list']);
  check(listed.status === 0 && listed.stdout.split('\n').includes('TOKEN'), 'list returns declaration names');
  noLeak(listed, 'list never exposes values');
  check(spawnSync('/bin/test', ['-e', marker]).status !== 0, 'list does not source the file');

  for (const os of ['Darwin', 'Linux', 'MINGW64_NT', 'OtherOS']) {
    const injected = run(['run', 'TOKEN=TOKEN', '--', process.execPath, '-e', consumer, fake], { HUSH_TEST_OS: os });
    check(injected.status === 0, `selected value injects with ${os} host detection`);
    noLeak(injected, `source output and tracing suppressed on ${os}`);
  }
  for (const [name, value] of [['name', 'name-fake'], ['__v', 'local-fake'], ['__out', 'output-fake'], ['NS', 'namespace-fake'], ['BACKEND', 'backend-fake'], ['HUSH_FILE', 'path-fake'], ['_PRIVATE', 'underscore-fake'], ['EMPTY', ''], ['MULTILINE', 'first\nsecond\n\n'], ['WITH_SPACES', 'a b "c"']]) {
    const result = run(['run', `VALUE=${name}`, '--', process.execPath, '-e', 'if (process.env.VALUE !== process.argv[1]) process.exit(1)', value]);
    check(result.status === 0, `fetch preserves ${name}`);
    noLeak(result, `fetch stays quiet for ${name}`);
  }
  const piped = run(['pipe', 'TOKEN', '--', process.execPath, '-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(s!==process.argv[1])process.exit(1)})', fake]);
  check(piped.status === 0, 'pipe sends only selected value to stdin');
  noLeak(piped, 'pipe never echoes source values');
  const manifest = join(root, '.hush');
  writeFileSync(manifest, 'ns=ignored-in-file-mode\nTOKEN=TOKEN\n');
  const executed = run(['exec', '--file', manifest, '--', process.execPath, '-e', consumer, fake]);
  check(executed.status === 0, 'manifest injection uses the flat file store');
  noLeak(executed, 'manifest injection stays quiet');

  const exported = join(root, 'fake-export');
  const file = run(['file', 'TOKEN', exported]);
  check(file.status === 0 && readFileSync(exported, 'utf8') === fake, 'file-only consumer receives the selected fake value');
  noLeak(file, 'file export stays quiet');
  rmSync(marker, { force: true });
  const preview = run(['sync', 'lastpass', '--dry-run', 'TOKEN']);
  check(preview.status === 0 && spawnSync('/bin/test', ['-e', marker]).status !== 0, 'sync preview reads names without sourcing values');
  noLeak(preview, 'sync preview stays quiet');
  const synced = run(['sync', 'lastpass', 'TOKEN']);
  check(synced.status === 0 && readFileSync(join(home, 'fake-synced'), 'utf8') === fake, 'explicit sync sends selected fake value to a mocked destination');
  noLeak(synced, 'explicit sync never echoes source values');
  rmSync(join(home, 'fake-synced'));
  const multilineSync = run(['sync', 'lastpass', 'MULTILINE']);
  check(multilineSync.status !== 0 && spawnSync('/bin/test', ['-e', join(home, 'fake-synced')]).status !== 0, 'multiline sync is refused without writing the mocked destination');

  const { HUSH_FILE: ignored, ...withDefault } = env;
  const defaulted = spawnSync(hush, ['run', 'TOKEN=TOKEN', '--', process.execPath, '-e', consumer, fake], { env: withDefault, encoding: 'utf8', timeout: 5000 });
  check(!defaulted.error && defaulted.status === 0, 'default path uses isolated HOME/.secrets');
  noLeak(defaulted, 'default path stays quiet');
  writeFileSync(join(root, 'relative.sh'), `TOKEN='${fake}'\n`);
  writeFileSync(join(bin, 'relative.sh'), "TOKEN='wrong-file'\n");
  const relative = run(['run', 'TOKEN=TOKEN', '--', process.execPath, '-e', consumer, fake], { HUSH_FILE: 'relative.sh' }, undefined, root);
  check(relative.status === 0, 'relative source cannot be shadowed by a PATH namesake');
  noLeak(relative, 'relative source stays quiet');
  const { HOME: unusedHome, HUSH_BACKEND: unusedBackend, HUSH_FILE: unusedFile, ...nativeEnv } = env;
  const native = spawnSync(hush, ['--version'], { env: nativeEnv, encoding: 'utf8', timeout: 5000 });
  check(!native.error && native.status === 0 && native.stdout.trim() === '1.6.1', 'default OS mode version needs neither HOME nor a source file');

  for (const name of ['MISSING', 'INHERITED_ONLY', 'UNSET_VALUE', 'bad-name', 'TOKEN[$(touch bad)]', '']) {
    const result = run(['run', `VALUE=${name}`, '--', '/usr/bin/true']);
    check(result.status !== 0, `missing or invalid declaration refused: ${name || '(empty)'}`);
    noLeak(result, 'failed fetch does not leak');
  }
  for (const args of [['set', 'TOKEN', '--gui'], ['mint', 'NEW'], ['gen', 'NEW'], ['rm', 'TOKEN'], ['rename', 'TOKEN', 'NEW'], ['mv', 'TOKEN', 'NEW']]) {
    rmSync(marker, { force: true });
    const result = run(args, {}, fake);
    check(result.status !== 0 && result.stderr.includes('read-only'), `${args[0]} rejects writes`);
    noLeak(result, `${args[0]} refuses without leaking`);
    check(spawnSync('/bin/test', ['-e', marker]).status !== 0, `${args[0]} does not source credentials`);
  }
  check(readFileSync(source, 'utf8') === fixture, 'all commands preserve the source file');
  const traced = run(['run', 'TOKEN=TOKEN', '--', '/usr/bin/true'], { SHELLOPTS: 'xtrace' });
  check(traced.status === 0, 'inherited xtrace still permits injection');
  noLeak(traced, 'inherited xtrace never exposes source values');
  const invalid = run(['list'], { HUSH_BACKEND: 'typo' });
  check(invalid.status !== 0, 'unknown backend does not silently select the OS store');
  for (const path of [join(root, 'absent'), root]) {
    check(run(['list'], { HUSH_FILE: path }).status !== 0, 'missing or non-regular source refused');
  }
  for (const content of [`TOKEN='${fake}'\nexit 0\n`, `TOKEN='${fake}'\nreturn 1\n`, `TOKEN='${fake}'\nunterminated='\n`, `TOKEN='${fake}'\nunset TOKEN\n`]) {
    const broken = join(root, 'broken.sh');
    writeFileSync(broken, content);
    const result = run(['run', 'VALUE=TOKEN', '--', '/usr/bin/true'], { HUSH_FILE: broken });
    check(result.status !== 0, 'failed, early-exiting, or unset source fails closed');
    noLeak(result, 'source failure never exposes values');
  }
  check(spawnSync('/bin/test', ['-e', log]).status !== 0, 'no real or mocked OS store/prompt was invoked');
  console.log(`# passed ${checks} file backend checks`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
