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
cleanup() { "$HUSH" rm t-set  >/dev/null 2>&1; "$HUSH" rm t-mint >/dev/null 2>&1; "$HUSH" rm t-renamed >/dev/null 2>&1; rm -f "$tmpf" 2>/dev/null; }
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

# 5b. exec: a .hush manifest injects mapped secrets, then runs the command
manifest="${tmpf}.hush"
printf '# test manifest\nns=%s\nXV=t-set\n' "$HUSH_NS" > "$manifest"
got="$("$HUSH" exec --file "$manifest" -- sh -c 'printf "%s" "$XV"' 2>/dev/null)"
[ "$got" = "$SENTINEL" ] && ok "exec (manifest inject)" || bad "exec manifest mismatch (got: $got)"
rm -f "$manifest" 2>/dev/null

# 6. mint generates + stores a random value; run reads it back as 64 hex chars
"$HUSH" mint t-mint >/dev/null 2>&1 && ok "mint" || bad "mint"
mintlen="$("$HUSH" run V=t-mint -- sh -c 'printf "%s" "${#V}"' 2>/dev/null)"
[ "$mintlen" = "64" ] && ok "mint value is 64 hex chars" || bad "mint length wrong ($mintlen)"

# 7. rotate: re-set overwrites in place
printf '%s' "$ROT" | "$HUSH" set t-set >/dev/null 2>&1
got="$("$HUSH" run V=t-set -- sh -c 'printf "%s" "$V"' 2>/dev/null)"
[ "$got" = "$ROT" ] && ok "rotate (re-set)" || bad "rotate failed"

# 7b. rename moves the value internally: old name gone, value kept, nothing leaked, no re-ask
ren="$("$HUSH" rename t-set t-renamed 2>&1)" && ok "rename" || bad "rename"
printf '%s' "$ren" | grep -qF "$ROT" && bad "LEAK: rename printed the value" || ok "no leak: rename"
got="$("$HUSH" run V=t-renamed -- sh -c 'printf "%s" "$V"' 2>/dev/null)"
[ "$got" = "$ROT" ] && ok "rename keeps the value" || bad "rename lost the value (got: $got)"
"$HUSH" list 2>&1 | grep -qx "t-set" && bad "rename left the old name behind" || ok "rename removed old name"
"$HUSH" rename t-renamed t-set >/dev/null 2>&1   # rename back so the rm step below targets t-set

# 8. rm removes it from the store
"$HUSH" rm t-set >/dev/null 2>&1 && ok "rm" || bad "rm"
"$HUSH" list 2>&1 | grep -qx "t-set" && bad "rm did not remove from list" || ok "rm gone from list"

# 9. xtrace-guard: hush handling a STORED value under inherited xtrace must NOT dump it to stderr.
# (store first, untraced; then run hush under SHELLOPTS=xtrace and watch hush's own stderr.)
printf '%s' "$SENTINEL" | "$HUSH" set t-set >/dev/null 2>&1
trace="$(env SHELLOPTS=xtrace "$HUSH" run V=t-set -- true 2>&1 1>/dev/null)"
printf '%s' "$trace" | grep -qF "$SENTINEL" && bad "LEAK: xtrace dumped the value" || ok "xtrace guard holds"
"$HUSH" rm t-set >/dev/null 2>&1

# 10. prompt-method regression (the agent-host GUI-prompt fixes).
# 10a. HUSH_PROMPT=pipe with an EMPTY stdin must ERROR, never silently store empty.
printf '' | env HUSH_PROMPT=pipe "$HUSH" set t-empty >/dev/null 2>&1 && bad "empty forced-pipe stored (should error)" || ok "empty forced-pipe errors"
"$HUSH" list 2>&1 | grep -qx "t-empty" && bad "forced-pipe stored empty" || ok "forced-pipe stored nothing"
# 10b. bad HUSH_PROMPT is rejected.
env HUSH_PROMPT=bogus "$HUSH" set t-x >/dev/null 2>&1 && bad "bad HUSH_PROMPT accepted" || ok "bad HUSH_PROMPT rejected"

# On mac the GUI branch is always reachable (osascript exists), so a bare fall-through would hit the
# REAL dialog and block/vary by session. Stub osascript on PATH to simulate a no-GUI session (the
# reported XPC failure) so the fall-through + honest-error paths are deterministic. Non-mac CI has no
# GUI dialog backend, so the fall-through naturally lands on the final die.
STUB=""
if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  STUB="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/hush-stub-$$")"; mkdir -p "$STUB"
  printf '#!/bin/sh\necho "execution error: Connection Invalid error for service com.apple.hiservices-xpcservice. (-1)" >&2\nexit 1\n' > "$STUB/osascript"
  chmod +x "$STUB/osascript"
fi
run_prompt() { # run hush set with the stub PATH (mac) or bare (else), HUSH_PROMPT cleared
  if [ -n "$STUB" ]; then env -u HUSH_PROMPT PATH="$STUB:$PATH" "$HUSH" "$@"; else env -u HUSH_PROMPT "$HUSH" "$@"; fi
}
# 10c. an EMPTY real pipe must FALL THROUGH (not be stored as empty). With the GUI failing/absent it
# ends in an honest nonzero error and stores nothing, proving empty-pipe != empty-value.
out="$(printf '' | run_prompt set t-empty 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "empty pipe falls through (nonzero exit)" || bad "empty pipe stored (exit 0)"
"$HUSH" list 2>&1 | grep -qx "t-empty" && bad "empty pipe stored a value" || ok "empty pipe stored nothing"
# 10d. mac only: the fall-through reached the dialog, and its FAILURE is reported honestly, NEVER
# masked as "cancelled or empty". Also check the forced --gui path surfaces the same way.
if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  printf '%s' "$out" | grep -qi "could not open" && ok "dialog failure reported honestly" || bad "dialog failure not surfaced (got: $out)"
  printf '%s' "$out" | grep -qi "cancelled or empty" && bad "backend failure masked as cancelled/empty" || ok "backend failure NOT masked as cancelled"
  out2="$(run_prompt set t-x --gui < /dev/null 2>&1)"
  printf '%s' "$out2" | grep -qi "could not open" && ok "--gui failure honest" || bad "--gui failure not surfaced (got: $out2)"
  "$HUSH" list 2>&1 | grep -qx "t-x" && bad "stored despite dialog failure" || ok "nothing stored on dialog failure"
  rm -rf "$STUB" 2>/dev/null
else
  ok "osascript-failure checks (mac-only, skipped on $(uname -s 2>/dev/null))"
fi
"$HUSH" rm t-empty >/dev/null 2>&1; "$HUSH" rm t-x >/dev/null 2>&1

if bash "$(dirname "${BASH_SOURCE[0]:-$0}")/lastpass-sync.sh"; then
  ok "isolated LastPass sync suite"
else
  bad "isolated LastPass sync suite"
fi

echo "# done. failures: $fails"
[ "$fails" -eq 0 ]
