#!/usr/bin/env bash
# Deterministic KeePass sync tests. OS storage and keepassxc-cli are fakes, so no real keychain or
# KDBX is touched. Test values may enter fake stdin, but never fake argv, output, or logs.
set -uo pipefail

HUSH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/hush"
STUB="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/hush-keepass-test-$$")"
STORE="$STUB/store"
export HUSH_TEST_STORE="$STORE"
export HUSH_KEEPASS_LOG="$STUB/keepass.log"
export HUSH_KEEPASS_ENTRIES="$STUB/entries"
export HUSH_KEEPASS_GROUP="$STUB/group"
export HUSH_NS="hush-keepass-test-$$"
export HUSH_KEEPASSXC="$STUB/keepassxc-cli"
export HUSH_KEEPASS_DB_EXPECT="KP-DB-$$-never-log-this"
SENTINEL="KP-S3NT-$$-never-log-this"
DATABASE="$STUB/hush.kdbx"
fails=0

mkdir -p "$STORE"
: > "$HUSH_KEEPASS_ENTRIES"
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
  '    if [ "$bare_w" -eq 1 ]; then cat "$HUSH_TEST_STORE/$service"; fi ;;' \
  '  delete-generic-password) rm -f "$HUSH_TEST_STORE/$service" ;;' \
  '  dump-keychain)' \
  '    for item in "$HUSH_TEST_STORE"/*; do' \
  '      [ -f "$item" ] || continue' \
  "      printf '    \"svce\"<blob>=\"%s\"\\n' \"\${item##*/}\"" \
  '    done ;;' \
  '  *) exit 45 ;;' \
  'esac' > "$STUB/security"

printf '%s\n' '#!/usr/bin/env bash' \
  'set -u' \
  'verb="${1:-}"; shift || true' \
  'printf "kpxc:%s %s\n" "$verb" "$*" >> "$HUSH_KEEPASS_LOG"' \
  'last=""; for arg in "$@"; do last="$arg"; done' \
  'case "$verb" in' \
  '  db-create)' \
  '    IFS= read -r db1 || true; IFS= read -r db2 || true' \
  '    [ "$db1" = "$HUSH_KEEPASS_DB_EXPECT" ] && [ "$db2" = "$db1" ] || exit 51' \
  '    : > "$last" ;;' \
  '  mkdir)' \
  '    IFS= read -r db || true; [ "$db" = "$HUSH_KEEPASS_DB_EXPECT" ] || exit 52' \
  '    : > "$HUSH_KEEPASS_GROUP" ;;' \
  '  ls)' \
  '    IFS= read -r db || true; [ "$db" = "$HUSH_KEEPASS_DB_EXPECT" ] || exit 53' \
  '    [ -f "$HUSH_KEEPASS_GROUP" ] || exit 54' \
  '    cat "$HUSH_KEEPASS_ENTRIES" ;;' \
  '  add|edit)' \
  '    IFS= read -r db || true; IFS= read -r entry_value || true' \
  '    [ "$db" = "$HUSH_KEEPASS_DB_EXPECT" ] || exit 55' \
  '    [ -n "$entry_value" ] || exit 56' \
  '    if [ "${HUSH_KEEPASS_EXPECT+x}" = x ] && [ "$entry_value" != "$HUSH_KEEPASS_EXPECT" ]; then exit 57; fi' \
  '    title="${last##*/}"; count="$(grep -cFx "$title" "$HUSH_KEEPASS_ENTRIES" 2>/dev/null || true)"' \
  '    if [ "$verb" = add ]; then [ "$count" -eq 0 ] || exit 58; printf "%s\n" "$title" >> "$HUSH_KEEPASS_ENTRIES"; else [ "$count" -eq 1 ] || exit 59; fi' \
  '    printf "value-ok\n" >> "$HUSH_KEEPASS_LOG" ;;' \
  '  *) exit 60 ;;' \
  'esac' > "$STUB/keepassxc-cli"
chmod +x "$STUB/uname" "$STUB/security" "$STUB/keepassxc-cli"

printf '%s' "$HUSH_KEEPASS_DB_EXPECT" | run_hush set kp-db --pipe >/dev/null 2>&1
printf '%s' "$SENTINEL" | run_hush set sync-a --pipe >/dev/null 2>&1
run_hush mint sync-b --bytes 4 >/dev/null 2>&1

: > "$HUSH_KEEPASS_LOG"
out="$(run_hush sync keepass --init --dry-run --database "$DATABASE" --db-secret kp-db sync-a 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "init dry-run succeeds" || bad "init dry-run failed (got: $out)"
[ ! -e "$DATABASE" ] && ok "dry-run creates no database" || bad "dry-run created database"
grep -q '^kpxc:' "$HUSH_KEEPASS_LOG" && bad "dry-run invoked KeePassXC" || ok "dry-run reads no values or database"

: > "$HUSH_KEEPASS_LOG"
out="$(HUSH_KEEPASS_EXPECT="$SENTINEL" run_hush sync keepass --init --database "$DATABASE" --db-secret kp-db sync-a 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ -f "$DATABASE" ] && ok "database initializes and selected secret syncs" || bad "init sync failed (got: $out)"
grep -q '^kpxc:db-create -q -p ' "$HUSH_KEEPASS_LOG" && grep -q '^kpxc:mkdir -q ' "$HUSH_KEEPASS_LOG" && grep -q '^kpxc:add -q -p ' "$HUSH_KEEPASS_LOG" && ok "init uses create, group, then add" || bad "init command sequence wrong"
grep -qF "$SENTINEL" "$HUSH_KEEPASS_LOG" && bad "entry value reached KeePass argv/log" || ok "entry value stays out of KeePass argv/log"
grep -qF "$HUSH_KEEPASS_DB_EXPECT" "$HUSH_KEEPASS_LOG" && bad "database password reached KeePass argv/log" || ok "database password stays out of KeePass argv/log"
printf '%s' "$out" | grep -qF "$SENTINEL" && bad "entry value leaked in output" || ok "success output does not leak"

: > "$HUSH_KEEPASS_LOG"
out="$(run_hush sync keepass --database "$DATABASE" --db-secret kp-db 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "bulk upsert succeeds" || bad "bulk upsert failed (got: $out)"
grep -q '^kpxc:edit .*hush/sync-a$' "$HUSH_KEEPASS_LOG" && grep -q '^kpxc:add .*hush/sync-b$' "$HUSH_KEEPASS_LOG" && ok "bulk chooses edit and add" || bad "bulk upsert actions wrong"
grep -q 'hush/kp-db$' "$HUSH_KEEPASS_LOG" && bad "database secret was synced" || ok "database secret is always excluded"

: > "$HUSH_KEEPASS_LOG"
out="$(run_hush sync keepass --database "$DATABASE" --db-secret kp-db missing-name 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "missing selection fails" || bad "missing selection accepted"
grep -q '^kpxc:\(add\|edit\)' "$HUSH_KEEPASS_LOG" && bad "write happened before selection validation" || ok "selection validates before write"

printf 'line one\nline two' | run_hush set sync-multiline --pipe >/dev/null 2>&1
: > "$HUSH_KEEPASS_LOG"
out="$(run_hush sync keepass --database "$DATABASE" --db-secret kp-db sync-multiline 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "multiline value is refused" || bad "multiline value accepted"
grep -q '^kpxc:\(add\|edit\)' "$HUSH_KEEPASS_LOG" && bad "multiline value reached KeePass" || ok "multiline refusal precedes write"

out="$(run_hush sync keepass --database "$DATABASE" --db-secret kp-db bad/name 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "slash-bearing name is refused" || bad "slash-bearing name accepted"

printf 'sync-a\n' >> "$HUSH_KEEPASS_ENTRIES"
: > "$HUSH_KEEPASS_LOG"
out="$(run_hush sync keepass --database "$DATABASE" --db-secret kp-db sync-a 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "duplicate entry fails closed" || bad "duplicate entry accepted"
grep -q '^kpxc:\(add\|edit\)' "$HUSH_KEEPASS_LOG" && bad "duplicate entry was written" || ok "duplicate detection precedes write"

printf '# KeePass sync tests done. failures: %s\n' "$fails"
[ "$fails" -eq 0 ]
