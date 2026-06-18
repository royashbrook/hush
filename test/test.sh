#!/usr/bin/env bash
# hush test harness — backend-agnostic. Exercises the roundtrip on whatever OS it runs on, and
# asserts the load-bearing invariant: a secret value NEVER appears in hush's own stdout/stderr.
# Uses an isolated namespace so it never touches real secrets. Exits nonzero on any failure.
set -uo pipefail

HUSH="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/hush"
export HUSH_NS="hush-citest-$$"
SENTINEL="S3NT-$$-do-not-leak-9f3a2b"
ROT="R0T8-$$-also-secret-1c4d"
fails=0
tmpf="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/hush-citest-$$.tmp")"

ok()   { printf 'ok   - %s\n' "$1"; }
bad()  { printf 'FAIL - %s\n' "$1"; fails=$((fails+1)); }
cleanup() { "$HUSH" rm t-set  >/dev/null 2>&1; "$HUSH" rm t-mint >/dev/null 2>&1; rm -f "$tmpf" 2>/dev/null; }
trap cleanup EXIT

# assert that hush's OWN output (stdout+stderr) for a command never contains the sentinel
no_leak() { # no_leak <label> <command...>
  local label="$1"; shift
  local out; out="$("$@" 2>&1)"; rc=$?
  if printf '%s' "$out" | grep -qF "$SENTINEL"; then bad "LEAK in $label: sentinel appeared in hush output"; else ok "no leak: $label"; fi
  return $rc
}

echo "# hush test on $(uname -s 2>/dev/null) — ns=$HUSH_NS"

# 1. set via stdin (also a no-leak check on the 'stored' message)
printf '%s' "$SENTINEL" | "$HUSH" set t-set >/dev/null 2>&1 && ok "set (stdin)" || bad "set (stdin)"
no_leak "set message" bash -c "printf '%s' '$SENTINEL' | '$HUSH' set t-set"

# 2. list shows the name, not the value
lst="$("$HUSH" list 2>&1)"
printf '%s' "$lst" | grep -qx "t-set" && ok "list shows name" || bad "list shows name (got: $lst)"
printf '%s' "$lst" | grep -qF "$SENTINEL" && bad "LEAK: value in list" || ok "no leak: list"

# 3. run injects the correct value into the child
got="$("$HUSH" run V=t-set -- sh -c 'printf "%s" "$V"' 2>/dev/null)"
[ "$got" = "$SENTINEL" ] && ok "run injects correct value" || bad "run value mismatch"

# 4. pipe streams the value to the consumer's stdin
got="$("$HUSH" pipe t-set -- cat 2>/dev/null)"
[ "$got" = "$SENTINEL" ] && ok "pipe to stdin" || bad "pipe value mismatch"

# 5. file writes the value (skip perms-number check, varies by OS)
"$HUSH" file t-set "$tmpf" >/dev/null 2>&1 && [ "$(cat "$tmpf")" = "$SENTINEL" ] && ok "file write" || bad "file write"

# 6. mint generates + stores a random value; run reads it back as 64 hex chars
"$HUSH" mint t-mint >/dev/null 2>&1 && ok "mint" || bad "mint"
mintlen="$("$HUSH" run V=t-mint -- sh -c 'printf "%s" "${#V}"' 2>/dev/null)"
[ "$mintlen" = "64" ] && ok "mint value is 64 hex chars" || bad "mint length wrong ($mintlen)"

# 7. rotate: re-set overwrites in place
printf '%s' "$ROT" | "$HUSH" set t-set >/dev/null 2>&1
got="$("$HUSH" run V=t-set -- sh -c 'printf "%s" "$V"' 2>/dev/null)"
[ "$got" = "$ROT" ] && ok "rotate (re-set)" || bad "rotate failed"

# 8. rm removes it from the store
"$HUSH" rm t-set >/dev/null 2>&1 && ok "rm" || bad "rm"
"$HUSH" list 2>&1 | grep -qx "t-set" && bad "rm did not remove from list" || ok "rm gone from list"

# 9. xtrace-guard: hush handling a STORED value under inherited xtrace must NOT dump it to stderr.
# (store first, untraced; then run hush under SHELLOPTS=xtrace and watch hush's own stderr.)
printf '%s' "$SENTINEL" | "$HUSH" set t-set >/dev/null 2>&1
trace="$(env SHELLOPTS=xtrace "$HUSH" run V=t-set -- true 2>&1 1>/dev/null)"
printf '%s' "$trace" | grep -qF "$SENTINEL" && bad "LEAK: xtrace dumped the value" || ok "xtrace guard holds"
"$HUSH" rm t-set >/dev/null 2>&1

echo "# done. failures: $fails"
[ "$fails" -eq 0 ]
