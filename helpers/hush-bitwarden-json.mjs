#!/usr/bin/env node

function die(message, code = 1) {
  process.stderr.write(`hush-bitwarden-json: ${message}\n`);
  process.exit(code);
}

function readStdin() {
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
  });
}

function json(value, label) {
  try { return JSON.parse(value); }
  catch { die(`invalid JSON from Bitwarden (${label})`); }
}

function encoded(value) {
  process.stdout.write(Buffer.from(JSON.stringify(value), 'utf8').toString('base64'));
}

const [command, ...args] = process.argv.slice(2);
const input = await readStdin();

if (command === 'status') {
  const value = json(input, 'status');
  process.exit(value.status === 'unlocked' ? 0 : 2);
}

if (command === 'folder') {
  const [name] = args;
  const values = json(input, 'folder list');
  if (!Array.isArray(values)) die('folder list was not an array');
  const matches = values.filter((value) => value && value.name === name);
  if (matches.length > 1) die(`duplicate folder name '${name}'`, 3);
  if (matches.length === 1) process.stdout.write(String(matches[0].id));
  process.exit(0);
}

if (command === 'item') {
  const [name, folderId] = args;
  const values = json(input, 'item list');
  if (!Array.isArray(values)) die('item list was not an array');
  const matches = values.filter((value) => (
    value && value.name === name && String(value.folderId || '') === folderId
  ));
  if (matches.length > 1) die(`duplicate item name '${name}'`, 3);
  if (matches.length === 1) process.stdout.write(String(matches[0].id));
  process.exit(0);
}

if (command === 'id') {
  const value = json(input, 'created object');
  if (!value || !value.id) die('Bitwarden response had no id');
  process.stdout.write(String(value.id));
  process.exit(0);
}

if (command === 'folder-create') {
  const [name] = args;
  const value = json(input, 'folder template');
  value.name = name;
  encoded(value);
  process.exit(0);
}

if (command === 'item-create' || command === 'item-update') {
  const [name, folderId] = args;
  if (!Object.hasOwn(process.env, 'HUSH_BITWARDEN_VALUE')) die('missing protected item value');
  const value = json(input, command === 'item-create' ? 'item template' : 'existing item');
  value.type = 1;
  value.name = name;
  value.folderId = folderId;
  if (!value.login || typeof value.login !== 'object') value.login = {};
  value.login.password = process.env.HUSH_BITWARDEN_VALUE;
  encoded(value);
  process.exit(0);
}

die('unknown command');
