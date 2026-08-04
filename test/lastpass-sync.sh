#!/usr/bin/env bash
# Deterministic LastPass sync tests. Both the OS store and lpass are fakes, so this never touches a
# real keychain or vault. The sentinel is test data and is never written to the command log/output.
set -uo pipefail

HUSH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/hush"
STUB="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/hush-lastpass-test-$$")"
STORE="$STUB/store"
export HUSH_TEST_STORE="$STORE"
export HUSH_TEST_SECURITY_LOG="$STUB/security.log"
export HUSH_LPASS_LOG="$STUB/lpass.log"
export HUSH_NS="hush-lastpass-test-$$"
export HUSH_LPASS="$STUB/lpass"
SENTINEL="LP-S3NT-$$-never-log-this"
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
  '    if [ "$bare_w" -eq 1 ]; then' \
  '      IFS= read -r value || true' \
  '      IFS= read -r confirm || true' \
  '      [ "$value" = "$confirm" ] || exit 46' \
  '      printf "prompt-store\n" >> "$HUSH_TEST_SECURITY_LOG"' \
  '    else' \
  '      printf "argv-store\n" >> "$HUSH_TEST_SECURITY_LOG"' \
  '    fi' \
  '    printf "%s" "$value" > "$HUSH_TEST_STORE/$service"' \
  '    ;;' \
  '  find-generic-password)' \
  '    [ -f "$HUSH_TEST_STORE/$service" ] || exit 44' \
  '    if [ "$bare_w" -eq 1 ]; then printf "fetch\n" >> "$HUSH_TEST_SECURITY_LOG"; cat "$HUSH_TEST_STORE/$service"; fi' \
  '    exit 0' \
  '    ;;' \
  '  delete-generic-password) rm -f "$HUSH_TEST_STORE/$service" ;;' \
  '  dump-keychain)' \
  '    for item in "$HUSH_TEST_STORE"/*; do' \
  '      [ -f "$item" ] || continue' \
  "      printf '    \"svce\"<blob>=\"%s\"\\n' \"\${item##*/}\"" \
  '    done' \
  '    ;;' \
  '  *) exit 45 ;;' \
  'esac' > "$STUB/security"

printf '%s\n' '#!/usr/bin/env bash' \
  'set -u' \
  'printf "%s\n" "$*" >> "$HUSH_LPASS_LOG"' \
  'case "$1" in' \
  '  status) exit "${HUSH_LPASS_STATUS_RC:-0}" ;;' \
  '  edit)' \
  '    value="$(cat)"' \
  '    [ -n "$value" ] || exit 41' \
  '    if [ "${HUSH_LPASS_EXPECT+x}" = x ] && [ "$value" != "$HUSH_LPASS_EXPECT" ]; then exit 42; fi' \
  '    printf "value-ok\n" >> "$HUSH_LPASS_LOG"' \
  '    exit "${HUSH_LPASS_EDIT_RC:-0}" ;;' \
  '  *) exit 43 ;;' \
  'esac' > "$STUB/lpass"
chmod +x "$STUB/uname" "$STUB/security" "$STUB/lpass"

printf '%s' "$SENTINEL" | run_hush set sync-a --pipe >/dev/null 2>&1
run_hush mint sync-b --bytes 4 >/dev/null 2>&1
printf '%s' 'login-only-test-value' | run_hush set sync-auth --pipe >/dev/null 2>&1
grep -qF 'prompt-store' "$HUSH_TEST_SECURITY_LOG" && ok "single-line macOS stores use stdin prompt" || bad "single-line macOS store used argv"
grep -qF 'argv-store' "$HUSH_TEST_SECURITY_LOG" && bad "single-line secret reached security argv" || ok "single-line secret stays out of security argv"

: > "$HUSH_LPASS_LOG"
out="$(HUSH_LPASS_EXPECT="$SENTINEL" run_hush sync lastpass --group team/secrets sync-a 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "selected secret syncs" || bad "selected sync failed (got: $out)"
printf '%s' "$out" | grep -qF "$SENTINEL" && bad "secret leaked in success output" || ok "success output does not leak"
grep -qx 'status --quiet --color=never' "$HUSH_LPASS_LOG" && ok "login checked first" || bad "login check missing"
grep -qx 'edit --sync=now --non-interactive --password --color=never team/secrets/sync-a' "$HUSH_LPASS_LOG" && ok "safe upsert argv" || bad "upsert argv wrong"
grep -qx 'value-ok' "$HUSH_LPASS_LOG" && ok "value arrives on stdin" || bad "stdin value mismatch"
grep -qF "$SENTINEL" "$HUSH_LPASS_LOG" && bad "secret reached LastPass argv/log" || ok "secret stays out of LastPass argv/log"

: > "$HUSH_LPASS_LOG"
: > "$HUSH_TEST_SECURITY_LOG"
out="$(run_hush sync lastpass --dry-run sync-a 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "dry-run succeeds" || bad "dry-run failed (got: $out)"
grep -q '^edit ' "$HUSH_LPASS_LOG" && bad "dry-run wrote remotely" || ok "dry-run makes no write"
printf '%s' "$out" | grep -q 'value not read' && ok "dry-run skips fetch" || bad "dry-run report missing"
[ ! -s "$HUSH_TEST_SECURITY_LOG" ] && ok "dry-run performs no backend fetch" || bad "dry-run fetched a secret"

: > "$HUSH_LPASS_LOG"
listed="$(run_hush list 2>&1)"
printf '%s\n' "$listed" | grep -qx 'sync-a' && printf '%s\n' "$listed" | grep -qx 'sync-b' && ok "fake store lists both names" || bad "fake store list mismatch (got: $listed)"
out="$(run_hush sync lastpass --exclude sync-auth 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "bulk sync with exclusion succeeds" || bad "bulk exclusion failed (got: $out)"
[ "$(grep -c '^edit ' "$HUSH_LPASS_LOG")" -eq 2 ] && ok "bulk sync selects all non-excluded names" || bad "bulk selection wrong"
grep -q 'hush/sync-a$' "$HUSH_LPASS_LOG" && grep -q 'hush/sync-b$' "$HUSH_LPASS_LOG" && ok "bulk destinations" || bad "bulk destinations wrong"
grep -q 'sync-auth$' "$HUSH_LPASS_LOG" && bad "excluded login secret reached LastPass" || ok "excluded login secret stays local"

: > "$HUSH_LPASS_LOG"
out="$(run_hush sync lastpass --exclude sync-auth sync-auth 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "all-excluded selection is a clean no-op" || bad "all-excluded selection failed"
grep -q '^edit ' "$HUSH_LPASS_LOG" && bad "all-excluded selection wrote remotely" || ok "all-excluded selection makes no write"

: > "$HUSH_LPASS_LOG"
out="$(HUSH_LPASS_STATUS_RC=1 run_hush sync lastpass sync-a 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "logged-out state fails" || bad "logged-out state accepted"
grep -q '^edit ' "$HUSH_LPASS_LOG" && bad "write attempted while logged out" || ok "login failure precedes write"

: > "$HUSH_LPASS_LOG"
out="$(run_hush sync lastpass sync-a missing-name 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "missing selection fails" || bad "missing selection accepted"
grep -q '^edit ' "$HUSH_LPASS_LOG" && bad "partial write before selection validation" || ok "all names validate before write"

: > "$HUSH_LPASS_LOG"
out="$(HUSH_LPASS_EXPECT="$SENTINEL" HUSH_LPASS_EDIT_RC=9 run_hush sync lastpass sync-a 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "remote rejection propagates" || bad "remote rejection ignored"
printf '%s' "$out" | grep -qF "$SENTINEL" && bad "secret leaked in failure output" || ok "failure output does not leak"

printf 'line one\nline two' | run_hush set sync-multiline --pipe >/dev/null 2>&1
: > "$HUSH_LPASS_LOG"
out="$(run_hush sync lastpass sync-multiline 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "multiline value is refused" || bad "multiline value was truncated"
grep -q '^edit ' "$HUSH_LPASS_LOG" && bad "multiline value reached remote" || ok "multiline refusal precedes write"

printf '# LastPass sync tests done. failures: %d\n' "$fails"
[ "$fails" -eq 0 ]
