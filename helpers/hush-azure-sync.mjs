#!/usr/bin/env node
// az supplies auth. HTTPS keeps values off CLI argv and plaintext files on every OS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function syncSecret(host, name, token, value, request = fetch) {
  const url = `https://${host}/secrets/${name}?api-version=2025-07-01`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = (method, body) => request(url, {
    method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  const current = await call('GET');
  const body = { value };
  if (current.status === 200) {
    const existing = await current.json();
    if (typeof existing.value !== 'string') throw new Error('Azure returned no secret value');
    if (existing.value === value) return 'unchanged';
    for (const field of ['tags', 'contentType']) {
      if (existing[field] !== undefined) body[field] = existing[field];
    }
    if (existing.attributes) {
      body.attributes = Object.fromEntries(['enabled', 'nbf', 'exp']
        .filter((key) => existing.attributes[key] !== undefined)
        .map((key) => [key, existing.attributes[key]]));
    }
  } else if (current.status !== 404) {
    throw new Error(`Azure GET HTTP ${current.status}`);
  }
  const result = await call('PUT', JSON.stringify(body));
  if (result.status !== 200) throw new Error(`Azure PUT HTTP ${result.status}`);
  await result.arrayBuffer();
  return 'synced';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [host, name] = process.argv.slice(2);
  try {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]\.vault\.(azure\.net|azure\.cn|usgovcloudapi\.net)$/.test(host)
      || !/^[a-z0-9-]{1,127}$/.test(name) || !process.env.HUSH_AZURE_TOKEN) {
      throw new Error('invalid Azure destination or missing token');
    }
    const status = await syncSecret(host, name, process.env.HUSH_AZURE_TOKEN, readFileSync(0, 'utf8'));
    process.stdout.write(`hush: ${status} ${name} -> Azure ${host}/${name} (value not shown).\n`);
  } catch (error) {
    // Provider/network exceptions can contain credentials or response bodies. Emit only our codes.
    const safe = /^Azure (GET|PUT) HTTP \d+$/.test(error.message) ? error.message : 'request failed';
    process.stderr.write(`hush: sync azurekv: ${safe}; check az login, vault access and connectivity.\n`);
    process.exitCode = 1;
  }
}
