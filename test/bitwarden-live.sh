#!/usr/bin/env bash
# Opt-in integration test. Requires real Bitwarden CLI auth secrets in the default hush namespace.
set -eu
set +x

repo="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
hush="$repo/hush"
bw="${HUSH_BITWARDEN:-bw}"
helper="$repo/helpers/hush-bitwarden-json.mjs"
namespace="hush-bitwarden-live-$$"
entry="hush-live-entry-$$"
folder="hush"

cleanup() {
  HUSH_NS="$namespace" "$hush" rm "$entry" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

command -v "$bw" >/dev/null 2>&1 || { printf 'bw is required\n' >&2; exit 1; }
openssl rand -hex 32 | HUSH_NS="$namespace" "$hush" set "$entry" --pipe >/dev/null

sync_verify() {
  delete_after="$1"
  HUSH_NS=hush "$hush" run \
    BW_CLIENTID=bitwarden-client-id \
    BW_CLIENTSECRET=bitwarden-client-secret \
    BW_PASSWORD=bitwarden-master-password -- \
    env HUSH_NS="$namespace" "$hush" run EXPECTED="$entry" -- \
    sh -c '
      session="$("$1" unlock --passwordenv BW_PASSWORD --raw)" || exit 1
      export BW_SESSION="$session" HUSH_BITWARDEN="$1" HUSH_BITWARDEN_JSON="$2"
      "$3" sync bitwarden --folder "$4" "$5" >/dev/null
      item_id="$("$1" list items --search "$5" |
        EXPECTED="$EXPECTED" node -e '\''
          let s = "";
          process.stdin.on("data", d => s += d).on("end", () => {
            const [name] = process.argv.slice(1);
            const matches = JSON.parse(s).filter(x => x.name === name);
            if (matches.length !== 1 || matches[0].login.password !== process.env.EXPECTED) process.exit(1);
            process.stdout.write(matches[0].id);
          });
        '\'' "$5")" || exit 1
      if [ "$6" = yes ]; then "$1" delete item "$item_id" --permanent >/dev/null; fi
      "$1" lock >/dev/null
    ' sh "$bw" "$helper" "$hush" "$folder" "$entry" "$delete_after"
}

sync_verify no
openssl rand -hex 32 | HUSH_NS="$namespace" "$hush" set "$entry" --pipe >/dev/null
sync_verify yes

printf 'ok   - real Bitwarden create and update preserve values without printing them\n'
