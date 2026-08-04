#!/usr/bin/env bash
# Opt-in macOS integration test. Requires KeePassXC and a writable login Keychain.
set -eu
set +x

repo="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
hush="$repo/hush"
kpxc="${HUSH_KEEPASSXC:-keepassxc-cli}"
command -v "$kpxc" >/dev/null 2>&1 || { printf 'keepassxc-cli is required\n' >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { printf 'openssl is required\n' >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/hush-keepass-live.XXXXXX")"
database="$work/hush-live.kdbx"
namespace="hush-keepass-live-$$"

cleanup() {
  HUSH_NS="$namespace" "$hush" rm keepass-master >/dev/null 2>&1 || true
  HUSH_NS="$namespace" "$hush" rm live-entry >/dev/null 2>&1 || true
  rm -f "$database"
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

openssl rand -hex 32 | HUSH_NS="$namespace" "$hush" set keepass-master --pipe >/dev/null
openssl rand -hex 32 | HUSH_NS="$namespace" "$hush" set live-entry --pipe >/dev/null

HUSH_NS="$namespace" "$hush" sync keepass \
  --database "$database" --db-secret keepass-master --init live-entry >/dev/null

verify_entry() {
  HUSH_NS="$namespace" "$hush" run DB=keepass-master EXPECTED=live-entry -- \
    sh -c '
      actual="$(printf "%s\n" "$DB" | "$1" show -q -a Password "$2" hush/live-entry 2>/dev/null)"
      [ "$actual" = "$EXPECTED" ]
    ' sh "$kpxc" "$database"
}

verify_entry
openssl rand -hex 32 | HUSH_NS="$namespace" "$hush" set live-entry --pipe >/dev/null
HUSH_NS="$namespace" "$hush" sync keepass \
  --database "$database" --db-secret keepass-master live-entry >/dev/null
verify_entry

printf 'ok   - real KeePassXC create and update preserve values without printing them\n'
