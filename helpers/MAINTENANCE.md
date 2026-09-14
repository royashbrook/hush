# maintenance without surprises

`hush doctor` checks installations and known backup schedules without opening the secret store.
it does not enumerate secrets, log in, run a backup, or contact the network. maintenance needs
Node 18+, ordinary hush storage commands do not.

```sh
hush --version
hush doctor
hush doctor --skill /path/to/another/skills/hush
hush doctor --check-updates
```

output is JSON (`--json` is accepted). it identifies the invoked CLI, PATH copies, scheduled
CLIs and conventional skill homes. `versionDrift` means copies differ. `mismatch` means one copy's
CLI, package and skill version declarations disagree. old single-file copies without metadata
are unknown. version declarations are diagnostics, not a cryptographic integrity check.

## backup health

macOS inspects the four packaged launchd jobs. `loaded` means registration, nothing more.

- `not-installed`: no owned plist. retained config alone isn't an active job.
- `unhealthy`: missing executable/helper, unreadable config, unloaded job, failed spawn or last
  run, loaded-runtime drift, future success timestamp, or overdue success.
- `unverified`: registered with prerequisites, but no recognized successful run in the log tail.
- `running`: launchd has a PID and no other problem was detected. completion isn't claimed.
- `ok`: registration and prerequisites pass, with recent success evidence.

only the last 256 KiB of each known log is scanned for the scheduler's exact dated success line.
arbitrary log text is never returned. success is overdue after the larger of two intervals or
one interval plus an hour. missing evidence means unknown, not "never ran". log rotation or
large output can hide old evidence. known legacy job labels are flagged for manual inspection,
not migrated. custom jobs/labels and external schedulers are not discovered.

this proves local runner evidence, not a restore, current vault contents, or remote iCloud upload.
doctor exits 1 for known unhealthy schedules, 2 for an unavailable explicit update check (unless
health already requires 1), otherwise 0. inspect the states, not exit 0 alone.

## how a user hears about updates

normal secret commands never check or nag. the only network operation is a five-second,
64-KiB-bounded HTTPS request for this public npm package's dist-tags. no auth, installed version,
path, secret name or value is sent. no code is downloaded and redirects aren't followed.
offline/error means `unavailable`, never "up to date".

```sh
hush maintenance check                  # one explicit check, saves local JSON
hush maintenance install --desktop      # opt-in daily macOS check and notices
hush maintenance status
hush maintenance snooze 7
hush maintenance mute
hush maintenance unmute
hush maintenance disable
hush maintenance remove
```

install runs on load and daily at 09:17 local time. omit `--desktop` for local reporting only.
it doesn't install/change secret-sync jobs. snooze delays update notices only, backup-health
notices still work. mute silences both while checks continue. disable makes scheduled checks
return without a registry request. remove also unloads the maintenance job but keeps local
reports/preferences. reinstall requires explicit removal.

each new version is announced once. changed unhealthy conditions are separate notices, recovery
resets their dedupe so recurrence can alert again. failed desktop sends retain the report and
retry next check. macOS permissions, Focus and GUI availability affect visibility, successful
AppleScript submission isn't proof the human saw it.

`~/.hush/maintenance/latest.json` holds the report. `preferences.json` and `notified.json` hold
consent and dedupe. atomic files are mode 0600 on POSIX and contain metadata only. Windows
protection depends on directory ACLs. `HUSH_MAINTENANCE_DIR` selects another local directory,
don't put it in git. `check.lock` prevents overlapping checks. after a crash, inspect its PID
and confirm no checker is running before removing that exact lock.

an agent reads `latest.json` at wake or through its existing watcher. check `checkedAt` first,
then persistent `update` and `schedules`, not just this check's transient `notifications`.
that's the optional bridge, no particular agent framework or additional daemon is required.
consumers needing their own receipt guarantees maintain their own dedupe state.

the checker cannot alert if its own runtime/job stops. review report freshness after OS/Node
upgrades. the metadata-only scheduler log is not automatically rotated.

## platforms

| capability | macOS | Linux / Windows |
| --- | --- | --- |
| installation/version checks, preferences, report | Node | Node |
| backup schedule inspection and repair | packaged launchd jobs | inspect external scheduler separately |
| automatic installation and desktop notices | launchd and AppleScript | bring your own scheduler/notifier |

npm also exposes `hush-maintenance`, usable directly from PowerShell without bash.
`hush-maintenance doctor` equals `hush doctor`. for an external scheduler:

```sh
hush-maintenance enable
# schedule this absolute script daily under the same user and state directory:
node /absolute/path/to/hush/helpers/hush-maintenance.mjs check --scheduled
```

native Linux timer/Windows Task Scheduler installers and desktop adapters aren't shipped.
the portable command/report contract is not a claim those adapters were live-tested.

## deliberate upgrades and repair

1. inspect `doctor --check-updates`. upgrading one skill copy doesn't upgrade other checkouts
   or scheduled runners. review release changes and keep the previous version/ref for rollback.
2. npm: explicitly run `npm install -g @royashbrook/hush@VERSION` for the chosen version.
   git: save the current commit, require a clean tree, fetch/review the intended ref and
   fast-forward. never discard local changes to force an update. refresh copied skills through
   their original installer with provenance. never edit a checkout while a sync executes it.
3. preview an existing schedule's repair, then explicitly apply it:

   ```sh
   hush maintenance repair bitwarden
   hush maintenance repair bitwarden --apply
   ```

   default changes **only Node's path**. add `--use-current` to preview and apply to move the
   scheduled helper and configured hush to the installation running this maintenance command.
   Bitwarden's JSON helper moves too. never use a temporary development checkout for a live job.
4. repair refuses a running job or unexpected shape. it snapshots the original plist/config
   beside the config in `repair-TARGET-*`, then unloads/replaces/reloads. cadence, destinations,
   selection/exclusions, passwords, mirrors and backups stay intact. failed bootstrap restores
   original files and attempts to reload. foreign edits detected after unload are preserved,
   requiring manual review/reload, never overwritten. no-op repair doesn't unload anything.
   **reload can immediately run the existing backup because RunAtLoad is preserved.**
5. run doctor after completion and verify a *new* success timestamp. keep the recovery directory
   until verified. to roll back a successful repair while idle, unload the exact job, restore
   its original plist/config from that recovery directory, reload, then verify. don't restore
   a removed old Node path without restoring that runtime too. repair never deletes backups.

new schedules keep a matching Node executable symlink when available, rather than resolving it
into a disposable version directory. if only a version-specific path exists, installation warns.
this reduces upgrade breakage, it doesn't make a path immortal.

references: [npm metadata](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md),
[launchd scheduling](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html),
[AppleScript notifications](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html).
