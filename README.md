# hush

A secret store for AI agents, with one hard rule: **the agent never sees the plaintext.**

Values never reach stdout, so they never land in the tool result, the transcript, or the cloud. A
secret only ever moves from the store straight into the consumer. There's no `get` on purpose, a
plain getter is the leak.

It kills the *"go set this env var"* / *"paste this token into that dashboard"* dance: store a
credential once, then inject it wherever it's needed, without it ever passing through the agent.

## agents: start here

**If you were handed this repo's url, install yourself as a skill, then follow the playbook.** One
copy-paste:

```sh
git clone https://github.com/royashbrook/hush ~/.claude/skills/hush
chmod +x ~/.claude/skills/hush/hush
```

Then **read [`~/.claude/skills/hush/SKILL.md`](SKILL.md) and follow it** , that's the whole
onboarding. It tells you how to store / mint / inject secrets and how to adopt hush in the repo
you're working in. Call the tool as `~/.claude/skills/hush/hush ...` (or put it on your PATH).

> Want it scoped to one project instead of every session? Clone into `./.claude/skills/hush` in that
> repo instead.

That's it , the human can just point you here and say "use the hush skill," and you take it from
here. The one thing only a human can do is paste a secret they hold: when you hit that, run
`hush set <name>` and a hidden dialog pops on *their* screen (you never see the value).

## install (humans)

Same clone as above, or just grab the single `hush` script and put it on your PATH.

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
the easy path. It's also only as durable as the machine it's on (a local keychain) , back the machine
up, or sync onward into a real secret manager, and don't make hush the only copy of a secret you
can't regenerate. MIT licensed.
