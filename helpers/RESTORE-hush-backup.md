# hush-backup , recovery / restore runbook

Self-contained. Keep a copy of this WITH the key (password manager / printed / next to the backups).
The commands are raw `gpg` + `base64`, so they work even if you have neither this helper nor hush.

## What you need

1. **a backup file** , `hush-backup-<date>.gpg` (iCloud Drive → `hush-backups/`, or wherever you airdropped one).
2. **the key** , the value of `hush-backup-key` that you stowed in your password manager. The key IS the
   gpg passphrase. Without it these files are unrecoverable.
3. **gpg installed** , macOS: `brew install gnupg`. linux: `apt install gnupg` (or distro equiv). `base64`
   is already on every unix/mac. You do NOT need hush to read the secrets, only to put them back in a keychain.

Every command below prompts ONCE for the passphrase , paste the key at the prompt. (`--pinentry-mode
loopback` just forces the prompt onto the terminal; if your gpg pops its own dialog you can drop that flag.)

The decrypted format is one line per secret: `name<TAB>base64-of-value`.

---

## A. Just DECRYPT and VIEW everything (no hush needed)

```sh
gpg --pinentry-mode loopback -d hush-backup-<date>.gpg | while IFS=$'\t' read -r name b64; do
  [ -n "$name" ] || continue
  printf '%s = %s\n' "$name" "$(printf '%s' "$b64" | base64 -d)"
done
```

Prints `name = value` for every secret. (To see the raw `name<TAB>base64` without decoding, just run
`gpg --pinentry-mode loopback -d hush-backup-<date>.gpg`.)

---

## B. RESTORE the whole store into hush (overwrite), on a machine that HAS hush

Easiest, with the hush-backup helper (it handles confirm + namespace):

```sh
hush-backup --restore hush-backup-<date>.gpg
# paste the key, then type RESTORE to confirm
```

Raw equivalent, no script (paste the key once at the gpg prompt):

```sh
gpg --pinentry-mode loopback -d hush-backup-<date>.gpg | while IFS=$'\t' read -r name b64; do
  [ -n "$name" ] || continue
  printf '%s' "$b64" | base64 -d | hush set "$name"
done
```

---

## C. RESTORE into a DIFFERENT namespace (a separate keychain)

hush picks the namespace from `HUSH_NS` (default `hush`). Prefix everything with it:

```sh
HUSH_NS=mybackup hush-backup --restore hush-backup-<date>.gpg
```

or raw:

```sh
gpg --pinentry-mode loopback -d hush-backup-<date>.gpg | while IFS=$'\t' read -r name b64; do
  [ -n "$name" ] || continue
  printf '%s' "$b64" | base64 -d | HUSH_NS=mybackup hush set "$name"
done
```

(Now the secrets live under `HUSH_NS=mybackup`, leaving your default `hush` store untouched.)

---

## D. You DON'T have hush

You don't need it to recover the secret VALUES , use **section A** to print every `name = value`, then put
them wherever you need (set env vars, paste into the new service, etc). If you want hush itself back, it's at
https://github.com/royashbrook/hush (build/install per its README), then use B or C.

---

## Notes

- `hush-backup-key` is the ONE secret you must keep safe and SEPARATE. It is in the backup too, but a wipe
  takes the in-keychain copy, so your stowed copy is the master.
- To drop the passphrase non-interactively (scripting only): add `--batch --passphrase 'THE-KEY'` to the gpg
  command. That puts the key in your shell history , prefer the interactive prompt.
- The file is plain `gpg --symmetric` AES256. Any gpg on any OS decrypts it; nothing here is mac-specific
  except where noted.
