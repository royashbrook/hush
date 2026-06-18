---
name: hush
description: Use whenever an agent needs to STORE, GENERATE, or USE a secret (API token, key, signing value, password) without ever exposing the plaintext. Replaces the "go set this env var / paste this token into that system" dance with one structured, OS-keychain-backed flow where the value goes straight from source into the consumer and never passes through the agent (no transcript, no logs, no cloud). Two add-paths: a value you GENERATED elsewhere (a vendor token, a PAT) gets pasted in once via a hidden prompt the agent can't see; a value that just needs to be STRONG+RANDOM (an operator key, a webhook signing secret) the agent generates and stores itself. Then it injects straight into the consumer (env var, command stdin, a 0600 file), never printed. Triggers: "store this token", "save this key", "add it to the keychain", "generate an operator/signing key", "use the X secret to call Y", or any moment an agent needs a credential to reach a service. macOS + Linux backends built in; the never-print contract is portable to any platform.
version: 1.0.0
---

# hush

A secret store for AI agents, with **one hard rule: the agent never sees the plaintext.**

A value never reaches stdout, so it never enters the tool result, the durable transcript, or the
cloud. It only ever moves from the store straight into the consumer. There is deliberately **no
`get`**, because a plain getter is the leak. That single rule is the whole point of this skill, most
secret helpers don't have it.

The discipline it's really enforcing: stop the *"go set THIS env var"* / *"paste THIS token into
THAT dashboard"* dance. Store a credential once, then inject it wherever it's needed, without it
ever passing through the agent or the chat.

## the tool

`./hush` (a single bash script). Make it executable, put it on your PATH or call it directly.

Store backends are auto-detected:
- **macOS** → Keychain (`security`), with a native hidden-field paste dialog for `set`.
- **Linux** → libsecret (`secret-tool`; `apt install libsecret-tools` / `dnf install libsecret`).
- **anything else (Windows, etc.)** → no built-in backend, but **keep the contract** and use your
  platform's secret store (see *Other platforms* below).

Namespace is configurable with `HUSH_NS` (default `agent-secret`), so multiple projects/agents don't
collide. A plaintext NAMES index (names aren't secret) lives at `~/.config/hush/names` so `list` is
cheap.

## getting a secret INTO the store (the two add-paths)

Pick by where the value comes from:

1. **You made the token elsewhere** (a vendor key, a GitHub PAT, anything from a portal). Store it
   once, the agent never sees it:
   ```
   hush set <name>
   ```
   On macOS this pops a hidden-field dialog; elsewhere it's a silent terminal prompt. You paste, the
   value goes prompt → keychain.

2. **The value just needs to be strong + random** (an operator key, a signing secret). The agent
   generates and stores it itself, no human in the loop:
   ```
   hush mint <name>            # openssl rand -hex 32 by default; --bytes N to change
   ```

## autonomy — proceed, or ask the human?

The split falls straight out of the two classes:

- **mint (a strong random value): proceed without asking.** When the agent decides it needs an
  operator key / signing secret / any value that just has to be random, it mints + stores + wires it
  itself, then tells the human only the **name** (never the value) and what it's for. Minting is
  reversible, bounded, and involves no secret the human holds.
- **set (a value the human holds): needs the human.** The value comes from outside (a vendor token
  generated in a portal), so the agent can't proceed alone, it needs the paste. This is the only
  secret case that should wait on a human.

So a secret that doesn't need the human never blocks on the human.

## using a secret (never prints it)

```
hush run NAME=VAR [N2=V2 ...] -- <cmd>   # fetch into env vars, exec <cmd> (value only in the child)
hush pipe <name> -- <cmd>                # stream the value to <cmd>'s stdin
hush file <name> <path>                  # write a 0600 file (refuses inside a git repo)
hush list                                # NAMES only, never values
hush rm   <name>                         # delete
```

## worked examples

A vendor token, set once, used forever:
```
hush set gh-automation-pat
hush run GH_TOKEN=gh-automation-pat -- gh api /user
```

An agent-generated operator key, stored AND pushed to a service, no human, no printing:
```
hush mint app-operator-key
hush pipe app-operator-key -- npx wrangler secret put OPERATOR_KEY
# later, to actually use it:
hush run OPKEY=app-operator-key -- curl -H "Authorization: Bearer $OPKEY" https://.../endpoint
```

## other platforms

The backends are mac + linux, but the **contract is the product**, not the backend. On Windows, use
PowerShell SecretManagement (`Set-Secret` / `Get-Secret`) or Credential Manager. On anything else,
use whatever secret store you have. The rules to keep, on any platform:

1. **never print the plaintext** (not to stdout, not to logs, not to the chat).
2. **inject, don't read** — pass the value into the consumer (env / stdin / a 0600 file), never into
   a variable that gets echoed.
3. **no getter** — there is no command that prints a secret.
4. **two add-paths** — paste a held value via a hidden prompt; mint a random one.

An agent that can't run `hush` can still follow the contract with its platform's native store. That
discipline is the skill.

## when NOT to use

- **org / team secrets** — those live in the org's own stores (vaults, CI secret managers), not a
  local keychain.
- **a value you need to READ on screen** — that's a human running their store's CLI, not the agent.
  This skill has no getter on purpose.

## honesty about scope

This is **not a security vault.** An agent with shell access can read and write this store, so it's
not a lock against a hostile process. It's structure that keeps plaintext out of the transcript and
out of the back-and-forth, and makes "store a credential once, inject it everywhere" the easy path.
That's it, and that's enough to remove a real, constant friction.
