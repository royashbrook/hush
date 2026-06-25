# helpers/

Optional extras built ON TOP of the `hush` CLI. They are not part of core hush, not covered by its
tests, and may be platform-specific. Use or ignore freely.

## hush-backup , encrypted off-machine backup of the store (macOS + iCloud)

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

See `com.hush-backup.plist` , customize the script path, copy to `~/Library/LaunchAgents/`, and load it
(instructions in the plist header).

### restore / disaster recovery

`RESTORE-hush-backup.md` is a self-contained runbook: raw `gpg` + `base64`, so it works with no script
and no hush. The backup file is plain `gpg --symmetric` AES256, so any gpg on any OS decrypts it.

### requirements

macOS (the dialog + Keychain + iCloud path), `gpg` (`brew install gnupg`), and hush on PATH. The
recovery runbook needs only `gpg` + `base64`, so a backup made here restores anywhere.
