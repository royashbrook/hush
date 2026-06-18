# hush

A secret store for AI agents, with one hard rule: **the agent never sees the plaintext.**

Values never reach stdout, so they never land in the tool result, the transcript, or the cloud. A
secret only ever moves from the store straight into the consumer. There's no `get` on purpose, a
plain getter is the leak.

It kills the *"go set this env var"* / *"paste this token into that dashboard"* dance: store a
credential once, then inject it wherever it's needed, without it ever passing through the agent.

## install

Drop it in as an agent skill (e.g. for Claude Code):

```sh
git clone https://github.com/royashbrook/hush ~/.claude/skills/hush
chmod +x ~/.claude/skills/hush/hush
```

Or just grab the single `hush` script and put it on your PATH.

Backends: macOS Keychain, Linux libsecret (`secret-tool`), and Windows DPAPI (via PowerShell) are
built in. On other platforms keep the same contract with your OS secret store (see [SKILL.md](SKILL.md)).
Cross-OS tested in CI (manual `workflow_dispatch`, all three runners).

## quick start

```sh
hush set my-vendor-token                      # paste a value you hold (hidden prompt)
printf '%s' "$TOK" | hush set my-vendor-token # ...or pipe it in (scripts/CI), still off argv
hush mint app-operator-key                    # generate + store a random one
hush run TOKEN=my-vendor-token -- some-cmd    # inject into a command, never printed
hush list                                     # names only, never values
```

Namespace with `HUSH_NS` (default `hush`). Full docs + the portable contract: [SKILL.md](SKILL.md).

## not a vault

An agent with shell access can read+write this store, so it's not a lock against a hostile process.
It's structure that keeps plaintext out of the transcript and makes "store once, inject everywhere"
the easy path. MIT licensed.
