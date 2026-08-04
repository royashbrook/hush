#!/usr/bin/env bash
# Deterministic Bitwarden sync tests. OS storage and bw are fakes, so no real keychain or vault is touched.
set -uo pipefail

HUSH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/hush"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
STUB="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/hush-bitwarden-test-$$")"
STORE="$STUB/store"
export HUSH_TEST_STORE="$STORE"
export HUSH_SECURITY_LOG="$STUB/security.log"
export HUSH_BW_LOG="$STUB/bw.log"
export HUSH_BW_STATE="$STUB/bw-state.json"
export HUSH_NS="hush-bitwarden-test-$$"
export HUSH_BITWARDEN="$STUB/bw"
export HUSH_BITWARDEN_JSON="$ROOT/helpers/hush-bitwarden-json.mjs"
SENTINEL="BW-S3NT-$$-never-log-this"
fails=0

mkdir -p "$STORE"
cleanup() { rm -rf "$STUB" 2>/dev/null; }
trap cleanup EXIT
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n' "$1"; fails=$((fails + 1)); }
run_hush() { env PATH="$STUB:$PATH" "$HUSH" "$@"; }

printf '%s\n' '#!/bin/sh' \
  'if [ "${1:-}" = -s ]; then printf "Darwin\n"; else /usr/bin/uname "$@"; fi' > "$STUB/uname"

printf '%s\n' '#!/usr/bin/env bash' \
  'set -u' \
  'verb="${1:-}"; shift || true' \
  'service=""; value=""; bare_w=0' \
  'while [ $# -gt 0 ]; do' \
  '  case "$1" in' \
  '    -s) service="$2"; shift 2 ;;' \
  '    -w) if [ $# -gt 1 ]; then value="$2"; shift 2; else bare_w=1; shift; fi ;;' \
  '    *) shift ;;' \
  '  esac' \
  'done' \
  'case "$verb" in' \
  '  add-generic-password)' \
  '    if [ "$bare_w" -eq 1 ]; then IFS= read -r value || true; IFS= read -r confirm || true; [ "$value" = "$confirm" ] || exit 46; fi' \
  '    printf "%s" "$value" > "$HUSH_TEST_STORE/$service" ;;' \
  '  find-generic-password)' \
  '    [ -f "$HUSH_TEST_STORE/$service" ] || exit 44' \
  '    if [ "$bare_w" -eq 1 ]; then printf "fetch:%s\n" "$service" >> "$HUSH_SECURITY_LOG"; cat "$HUSH_TEST_STORE/$service"; fi ;;' \
  '  delete-generic-password) rm -f "$HUSH_TEST_STORE/$service" ;;' \
  '  dump-keychain)' \
  '    for item in "$HUSH_TEST_STORE"/*; do' \
  '      [ -f "$item" ] || continue' \
  "      printf '    \"svce\"<blob>=\"%s\"\\n' \"\${item##*/}\"" \
  '    done ;;' \
  '  *) exit 45 ;;' \
  'esac' > "$STUB/security"

cat > "$STUB/bw" <<'NODE'
#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HUSH_BW_LOG, `bw:${args.join(' ')}\n`);
const read = () => fs.readFileSync(0, 'utf8');
const load = () => JSON.parse(fs.readFileSync(process.env.HUSH_BW_STATE, 'utf8'));
const save = (value) => fs.writeFileSync(process.env.HUSH_BW_STATE, JSON.stringify(value));
const out = (value) => process.stdout.write(JSON.stringify(value));
const [verb, noun, ...rest] = args;
if (verb === 'status') out({ status: process.env.HUSH_BW_LOCKED === '1' ? 'locked' : 'unlocked' });
else if (verb === 'sync') process.exit(0);
else if (verb === 'list' && noun === 'folders') {
  out(process.env.HUSH_BW_NO_FOLDER === '1' ? [] : load().folders);
} else if (verb === 'list' && noun === 'items') {
  const state = load();
  const at = rest.indexOf('--search');
  const name = at >= 0 ? rest[at + 1] : '';
  const matches = state.items.filter((item) => item.name.includes(name));
  if (process.env.HUSH_BW_DUPLICATE === '1' && name === 'sync-a' && matches[0]) {
    matches.push({ ...matches[0], id: 'duplicate-id' });
  }
  out(matches);
} else if (verb === 'get' && noun === 'template' && rest[0] === 'folder') {
  out({ name: null });
} else if (verb === 'get' && noun === 'template' && rest[0] === 'item') {
  out({ type: 1, name: null, folderId: null, login: { username: null, password: null } });
} else if (verb === 'get' && noun === 'item') {
  const item = load().items.find((value) => value.id === rest[0]);
  if (!item) process.exit(50);
  out(item);
} else if (verb === 'create' && noun === 'folder') {
  const state = load();
  const folder = { ...JSON.parse(Buffer.from(read(), 'base64').toString('utf8')), id: 'folder-created' };
  state.folders.push(folder); save(state); out(folder);
} else if (verb === 'create' && noun === 'item') {
  const state = load();
  const item = { ...JSON.parse(Buffer.from(read(), 'base64').toString('utf8')), id: `item-${state.items.length + 1}` };
  if (item.name === 'sync-a' && item.login.password !== process.env.HUSH_BW_EXPECT) process.exit(51);
  state.items.push(item); save(state); fs.appendFileSync(process.env.HUSH_BW_LOG, 'value-ok\n'); out(item);
} else if (verb === 'edit' && noun === 'item') {
  const state = load();
  const item = JSON.parse(Buffer.from(read(), 'base64').toString('utf8'));
  if (item.name === 'sync-a' && item.login.password !== process.env.HUSH_BW_EXPECT) process.exit(52);
  const at = state.items.findIndex((value) => value.id === rest[0]);
  if (at < 0) process.exit(53);
  state.items[at] = item; save(state); fs.appendFileSync(process.env.HUSH_BW_LOG, 'value-ok\n'); out(item);
} else process.exit(54);
NODE

chmod +x "$STUB/uname" "$STUB/security" "$STUB/bw"
printf '%s' '{"folders":[{"id":"folder-1","name":"hush"}],"items":[{"id":"item-1","name":"sync-a","folderId":"folder-1","type":1,"login":{"password":"REMOTE-OLD-NEVER-LOG"}}]}' > "$HUSH_BW_STATE"
export HUSH_BW_EXPECT="$SENTINEL"

printf '%s' "$SENTINEL" | run_hush set sync-a --pipe >/dev/null 2>&1
run_hush mint sync-b --bytes 4 >/dev/null 2>&1
printf '%s' 'CLIENT-ID-NEVER-SYNC' | run_hush set bitwarden-client-id --pipe >/dev/null 2>&1
printf '%s' 'CLIENT-SECRET-NEVER-SYNC' | run_hush set bitwarden-client-secret --pipe >/dev/null 2>&1
printf '%s' 'MASTER-NEVER-SYNC' | run_hush set bitwarden-master-password --pipe >/dev/null 2>&1
printf '%s' 'LOCAL-ONLY' | run_hush set local-only --pipe >/dev/null 2>&1

: > "$HUSH_BW_LOG"; : > "$HUSH_SECURITY_LOG"
out="$(run_hush sync bitwarden --dry-run sync-a 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "dry-run succeeds" || bad "dry-run failed (got: $out)"
printf '%s' "$out" | grep -q 'would edit sync-a' && ok "dry-run identifies update" || bad "dry-run action wrong"
[ ! -s "$HUSH_SECURITY_LOG" ] && ok "dry-run fetches no hush values" || bad "dry-run fetched a value"

: > "$HUSH_BW_LOG"; : > "$HUSH_SECURITY_LOG"
out="$(run_hush sync bitwarden sync-a 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "existing item update succeeds" || bad "update failed (got: $out)"
grep -q '^bw:edit item item-1$' "$HUSH_BW_LOG" && grep -q '^value-ok$' "$HUSH_BW_LOG" && ok "unique item is safely edited" || bad "edit contract wrong"
grep -qF "$SENTINEL" "$HUSH_BW_LOG" && bad "value reached Bitwarden argv/log" || ok "value stays out of Bitwarden argv/log"
printf '%s' "$out" | grep -qF "$SENTINEL" && bad "value leaked in output" || ok "success output does not leak"

: > "$HUSH_BW_LOG"
out="$(run_hush sync bitwarden sync-b 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^bw:create item$' "$HUSH_BW_LOG" && ok "missing item is created" || bad "create failed (got: $out)"

: > "$HUSH_BW_LOG"
out="$(run_hush sync bitwarden --exclude local-only 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "bulk sync with exclusion succeeds" || bad "bulk sync failed (got: $out)"
printf '%s' "$out" | grep -Eq 'bitwarden-client|bitwarden-master|local-only' && bad "auth or excluded name was selected" || ok "auth defaults and explicit exclusions stay local"

: > "$HUSH_BW_LOG"
out="$(run_hush sync bitwarden sync-a does-not-exist 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "missing selection fails" || bad "missing selection accepted"
grep -Eq '^bw:(create|edit) ' "$HUSH_BW_LOG" && bad "write happened before local validation" || ok "all local names validate before write"

: > "$HUSH_BW_LOG"
out="$(HUSH_BW_DUPLICATE=1 run_hush sync bitwarden sync-a 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "duplicate item fails closed" || bad "duplicate item accepted"
grep -Eq '^bw:(create|edit) ' "$HUSH_BW_LOG" && bad "duplicate item was written" || ok "duplicate detection precedes write"

: > "$HUSH_BW_LOG"
out="$(HUSH_BW_LOCKED=1 run_hush sync bitwarden sync-a 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "locked vault fails closed" || bad "locked vault accepted"
grep -Eq '^bw:(create|edit) ' "$HUSH_BW_LOG" && bad "locked vault was written" || ok "unlock check precedes write"

run_hush mint sync-c --bytes 4 >/dev/null 2>&1
: > "$HUSH_BW_LOG"
out="$(HUSH_BW_NO_FOLDER=1 run_hush sync bitwarden --folder fresh sync-c 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^bw:create folder$' "$HUSH_BW_LOG" && grep -q '^bw:create item$' "$HUSH_BW_LOG" && ok "missing folder is created before item" || bad "folder create failed (got: $out)"

printf '# Bitwarden sync tests done. failures: %s\n' "$fails"
exit "$fails"
