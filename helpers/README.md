# helpers/

Optional extras built ON TOP of the `hush` CLI. Some ship in the npm package and some remain
repo-only. They may be platform-specific. Use or ignore freely.

## hush-lastpass-schedule, experimental unattended LastPass sync (macOS)

The npm package installs this Node helper beside `hush`. It creates a per-user launchd job and can
optionally restore the LastPass CLI login after reboot from a master password held in hush:

```sh
hush-lastpass-schedule install --auto-login --email you@example.com --every 6h
hush-lastpass-schedule status
hush-lastpass-schedule remove
```

Auto-login is explicit opt-in and not live-tested. Its deterministic fake-CLI contract passes, but
Homebrew `lastpass-cli` crashed during real MFA before vault access, matching upstream issue #719.
Setup performs one interactive trusted-device login, then stores the master password through hush's
hidden prompt. The auth secret is forcibly excluded from every sync, `lpass --plaintext-key` is
never used, failed setup installs nothing, and expired device trust fails closed. `remove` unloads
the job but retains both config and the hush secret. The implementation is Node and stdlib-only; job
installation currently targets macOS launchd.

## hush-keepass-schedule, unattended local KDBX sync (macOS + iCloud)

The npm package installs this Node helper beside `hush`. It creates or updates an encrypted KeePass
database and schedules recurring sync with launchd:

```sh
brew install --cask keepassxc
hush-keepass-schedule install --every 6h
hush-keepass-schedule status
hush-keepass-schedule remove
```

The default database is `iCloud Drive/hush/hush.kdbx`. Setup asks through hush for
`hush-keepass-master-password` when absent, creates and populates an absent database, then stores
only mode-0600 metadata in its config. Use `--database`, `--db-secret`, `--group`, repeatable
`--exclude`, and positional secret names to change the selection.

Database and entry passwords travel to `keepassxc-cli` only on stdin. The database-password secret
is always excluded from sync. `remove` unloads launchd while retaining the KDBX and config. Keep a
separate durable copy of the database password and avoid simultaneous iCloud writers.

## hush-bitwarden-schedule, unattended hosted-vault sync (macOS)

The npm package installs this Node helper beside hush:

~~~sh
brew install bitwarden-cli
hush-bitwarden-schedule install --every 6h
hush-bitwarden-schedule status
hush-bitwarden-schedule remove
~~~

It expects bitwarden-client-id, bitwarden-client-secret, and bitwarden-master-password in hush,
prompting through hush for any missing value. The API key authenticates bw; the master password is
still required to unlock vault data. Each run obtains a short-lived session, invokes
hush sync bitwarden, then locks the CLI.

Credentials and session values stay out of argv, logs, plist, and the mode-0600 metadata config. The
three auth-secret names are always excluded from sync. Use --folder, repeatable --exclude,
positional secret names, and --every to configure selection. remove unloads launchd but retains the
config and hush credentials.

## hush-backup, encrypted off-machine backup of the store (macOS + iCloud)

A hush store lives only in the local OS keychain, so a wipe means re-provisioning every secret.
`hush-backup` makes an encrypted copy you can keep off-machine.

It composes hush's own primitives, so the never-print contract holds: `hush list` enumerates names,
`hush pipe <name> -- base64` streams each value straight into `gpg`. Plaintext goes keychain -> gpg ->
ciphertext, never to stdout, a log, or the agent transcript.

**The key model.** The symmetric key is a strong random value stored in hush as `hush-backup-key`, so
there is no weak passphrase to remember. A scheduled job pulls the key from hush and backs up
unattended. You keep ONE durable copy of that key (password manager / iCloud Keychain / printed) as
the master. The key lives in the same keychain being backed up, so after a wipe only your stowed copy
can open the files.

### setup

```sh
hush mint hush-backup-key            # generate + store the backup key
# then read it once (Keychain Access -> search "hush" -> hush:hush-backup-key -> Show password)
# and stow a copy somewhere that survives a machine wipe.
```

### use

```sh
hush-backup            # interactive: encrypts the whole store to iCloud Drive/hush-backups (hidden passphrase dialog)
hush-backup --auto     # unattended: keyed from hush-backup-key, for launchd/cron (no dialog)
hush-backup --restore <file.gpg>   # decrypt a backup and re-set each secret into hush
hush-backup --help
```

Env knobs: `HUSH_BACKUP_DIR` (dest, default iCloud Drive/hush-backups), `HUSH_BACKUP_KEY` (key name,
default `hush-backup-key`), `HUSH_BACKUP_KEEP` (retention, default 30).

### schedule it (daily, macOS)

See `com.hush-backup.plist`, customize the script path, copy to `~/Library/LaunchAgents/`, and load it
(instructions in the plist header).

### restore / disaster recovery

`RESTORE-hush-backup.md` is a self-contained runbook: raw `gpg` + `base64`, so it works with no script
and no hush. The backup file is plain `gpg --symmetric` AES256, so any gpg on any OS decrypts it.

### requirements

macOS (the dialog + Keychain + iCloud path), `gpg` (`brew install gnupg`), and hush on PATH. The
recovery runbook needs only `gpg` + `base64`, so a backup made here restores anywhere.
