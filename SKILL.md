---
name: hush
description: Use whenever an agent needs to STORE, GENERATE, or USE a secret (API token, key, signing value, password) without ever exposing the plaintext. Replaces the "go set this env var / paste this token into that system" dance with one structured, OS-keychain-backed flow where the value goes straight from source into the consumer and never passes through the agent (no transcript, no logs, no cloud). Two add-paths: a value you GENERATED elsewhere (a vendor token, a PAT) gets pasted in once via a hidden prompt the agent can't see; a value that just needs to be STRONG+RANDOM (an operator key, a webhook signing secret) the agent generates and stores itself. Then it injects straight into the consumer (an env var, or a command's stdin), never printed , so an agent running as the user, with their CLIs already authed, can set server-side secrets and call services without the value ever touching the chat or disk. Triggers: "store this token", "save this key", "add it to the keychain", "generate an operator/signing key", "use the X secret to call Y", or any moment an agent needs a credential to reach a service. macOS, Linux, and Windows backends built in; the never-print contract is portable beyond them.
version: 1.2.0
---

# hush

A secret store for AI agents, with **one hard rule: the agent never sees the plaintext.**

A value never reaches stdout, so it never enters the tool result, the durable transcript, or the
cloud. It only ever moves from the store straight into the consumer. There is deliberately **no
`get`**, because a plain getter is the leak. That single rule is the whole point of this skill, most
secret helpers don't have it.

## what this is actually for

You're an agent running as the user, with their CLIs already authed (`gh`, `az`, `wrangler`, ...). So
you can *already* set a server-side secret or call a service , the one thing you can't do is **see the
value**. Every usual way to get it is bad: have the user paste it into the chat (now it's in the
transcript), drop it in a temp file, or send them off to set it by hand , each one is a context-switch
and a leak risk, and half the time the value is never written down, so next time you have to rotate
the whole secret.

hush is the single fix. **Get the value once** , the user pastes into a hidden dialog you pop, or you
mint a random one yourself , it lands in the **OS keychain**, and from then on you inject it into
those already-authed commands **forever**, no more pasting, no more waiting on the user. When they
need it back or want to move it elsewhere, it's sitting in their keychain.

It also beats a `.env` file: nothing lives in the repo, so nothing gets committed by accident , you
set secrets server-side straight from the keychain.

## the tool

`./hush` (a single bash script). Make it executable, put it on your PATH or call it directly.

Store backends are auto-detected:
- **macOS** → Keychain (`security`), with a native hidden-field paste dialog for `set`.
- **Linux** → libsecret (`secret-tool`; `apt install libsecret-tools` / `dnf install libsecret`).
- **Windows** → a per-user DPAPI-encrypted store via PowerShell (`win/hush-backend.ps1`), driven from
  git-bash / WSL. Stored items are DPAPI ciphertext (CurrentUser), useless to any other user.
- **anything else** → no built-in backend, but **keep the contract** and use your platform's secret
  store (see *Other platforms* below).

Namespace is configurable with `HUSH_NS` (default `hush`), so multiple projects/agents don't collide.
The namespace prefixes every stored item (e.g. the macOS keychain item is named `hush:<name>`), so a
human can find them by searching the namespace. `list` reads the names straight from the store, so
there's no separate index that can drift out of sync.

## getting a secret INTO the store (the two add-paths)

Pick by where the value comes from:

1. **A value the user holds** (a vendor key from a portal, a GitHub PAT). The AGENT runs:
   ```
   hush set <name>
   ```
   and a hidden paste dialog pops on the **user's screen** (macOS dialog, Linux zenity/kdialog,
   Windows masked box). The user pastes into it , they never leave the conversation , and the command
   blocks until they do; then the agent continues. The agent never sees the value. **This is the
   collaborative path: the agent drives it, the user just answers the popup.** Don't tell the user to
   "go run a command and let you know" , run `hush set <name>` yourself and wait for the dialog.
   - **re-ask** (user pasted the wrong thing, "ask me again for the second token"): the agent just
     runs `hush set <name>` again , it overwrites in place. Same for rotating any secret later.
   - **scripted/CI**: pipe it instead , `printf '%s' "$VAL" | hush set <name>` (still off argv).
   - the user running `hush set` in their *own* terminal is only a far fallback (they can already do
     that); the whole point is the agent-driven popup so nobody leaves the chat.

2. **The value just needs to be strong + random** (an operator key, a signing secret). The agent
   generates and stores it itself, no human in the loop:
   ```
   hush mint <name>            # openssl rand -hex 32 by default; --bytes N to change (alias: gen)
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
hush list                                # NAMES only, never values
hush rm   <name>                         # delete
```

`run` and `pipe` are the whole game. **pipe** a value straight into an already-authed CLI to set a
server-side secret (`hush pipe gh-pat -- gh secret set X`, `hush pipe key -- npx wrangler secret put
X`); **run** a command with the value in its environment to call a service (`hush run TOKEN=t --
curl ...`). The value lives only in that child process , never on disk, never printed.

> **Escape hatch , `hush file <name> <path>`.** A few tools can *only* read a credential from a file
> path (a service-account JSON, a cert, a kubeconfig). For those, and only those, `hush file` writes a
> 0600 file (and refuses inside a git repo). Don't reach for it as a convenience , writing a secret to
> disk is the exact dance hush exists to kill. Inject via `run`/`pipe` whenever the tool allows it.

## if a human needs to read a value

The agent never prints a secret, there's no `get`. But a human sometimes legitimately needs to see
one. The agent's job is to **tell the human how to read it themselves**, not to fetch and print it:

- **macOS**: open the Keychain Access app, search your namespace (default `hush`), open the
  `hush:<name>` item, and click *Show password* (it'll ask for your login password).
- **Linux**: the human runs `secret-tool lookup hush <namespace> name <name>` in their own terminal
  (or browses it in Seahorse / the GNOME keyring GUI).
- **Windows**: the human runs `powershell -File win/hush-backend.ps1 get <name>` (it DPAPI-decrypts
  and prints the value for them; only works as the same user who stored it).

The agent relays these steps; it does not run them and pipe the output back.

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

## adopting hush in an existing project (the first run)

A new project is trivial, `mint`/`set` secrets as you create them. An existing project is the real
onboarding: hush starts empty while the secrets already live in scattered places (`.env`, wrangler,
gh, the user's head), so it's useless until seeded. The agent's job is to get from "not using hush"
to "one command injects everything":

1. **find the secrets the project uses.** look in `.env` / `.env.*` / `.dev.vars`, `wrangler.jsonc`
   (`vars` + secret bindings), `process.env.X` / `import.meta.env.X` in the code, `gh secret list`,
   the README. collect the ENVVAR names it needs.
2. **get each value into hush, without printing it:**
   - already in a local `.env`: `grep '^FOO=' .env | cut -d= -f2- | hush set foo` (piped, never echoed).
   - already stored in hush: reuse it.
   - should be fresh + random: `hush mint foo`.
   - **only the user has it** (a portal/dashboard key, nothing local): the AGENT runs `hush set foo`,
     which pops the paste dialog for the user , do NOT tell them to run a command and report back.
     they paste into the popup and you continue.
3. **pick how the secrets reach the consumer , two shapes, by how the app reads them:**

   **(a) the run command reads them from the environment** (a node / vite / python dev-or-deploy that
   uses `process.env.X`). write a `.hush` manifest in the repo root mapping each env var to its hush
   secret name (names aren't secret, so it commits):
   ```
   ns=lifescored            # optional first line: a per-project namespace
   DATABASE_URL=db-url
   GEMINI_API_KEY=gemini-key
   ```
   then **switch the dev/deploy command to** `hush exec -- <cmd>` , it reads `.hush`, injects every
   mapped secret, and runs the command. a fresh agent just runs that, no rediscovery.
   (`hush exec --file <path>` if the manifest isn't at the repo root.)

   **(b) nothing in the run path reads the environment** , e.g. a Cloudflare Worker (secrets are
   *bindings* via `platform.env`, populated from the dashboard / `.dev.vars`, not the process
   environment), or a repo that only deploys from CI. there's no run command to wrap, so skip the
   manifest , `hush exec` would just inject into a process that never looks. the adoption here is
   **store once, then pipe straight into the write-only destination:**
   ```
   hush pipe gemini-key   -- npx wrangler secret put GEMINI_API_KEY   # into the Worker
   hush pipe deploy-token -- gh secret set CLOUDFLARE_API_TOKEN       # into GitHub Actions
   ```
   this is a first-class outcome, not a lesser one , see *why store it at all* below.

4. **stop committing the plaintext** (gitignore or delete the `.env` / `.dev.vars`) now that hush
   holds it.

Work through this and **report the result, don't narrate each command.** End on one of two things:
"it's wired, here's what changed," or "i need one value only you have , paste it" and drive the
`hush set` dialog yourself. Don't hand the human a list of commands to go run.

## why store it at all (if it's already in Cloudflare / GitHub)

Because those are **write-only.** Once a value is a Worker secret or a GitHub Actions secret, you
can't read it back , so if the original wasn't kept, your only move next time is to rotate the whole
secret. The usual stopgaps are worse: pasting it into Notes/TextEdit "just for a sec," or letting an
agent drop it in a `/tmp` file to read-and-push, then forgetting it exists.

hush is the **owner-readable backstop** , a consistent *first* home, not the final one. The pattern:
the agent mints or receives the value, stores it in hush, AND pipes it into the write-only
destination, so the value is never lost or force-rotated just because nobody wrote it down. When
*you* need it later you read it from your own keychain (see *if a human needs to read a value*), not
a sticky note.

Treat it as an **on-ramp.** Two wins land immediately, even with no `hush exec` in sight: you can
generate secrets securely from day one, and on an old project with values scattered across `.env`s,
dashboards, and your head, a few pastes get them (a) centralized and (b) agent-usable from then on.
For a durable, shareable home, **sync them onward** into a real secret manager , see *extending
hush* for wiring a 1Password / vault / pass backend. hush gets you consistent; the sync makes it
permanent.

## extending hush to the tools you already use

The friction this kills: *"go create this key, then paste it into GitHub / Wrangler / your vault, then
tell me when it's there."* If the agent already has the CLI for that tool, it shouldn't hand that
back, it should just do it. Two directions:

1. **Push a hush-held secret INTO another tool** (it's already built, via `pipe`). Anything with a
   CLI that takes the value on stdin is a consumer:
   ```
   hush pipe deploy-token -- gh secret set DEPLOY_TOKEN          # into GitHub Actions
   hush pipe api-key      -- npx wrangler secret put API_KEY     # into a Worker
   hush pipe db-pass      -- fly secrets import                  # etc.
   ```
   So "store it, then put it in X" becomes one agent step, no human relay. `mint` + `pipe` together
   means the agent can generate a strong secret AND install it into the service without the value
   ever being seen or pasted.

2. **Augment hush to use a tool as the STORE itself.** If the user already lives in a secret manager
   with a CLI (1Password `op`, `pass`, HashiCorp `vault`, Doppler, Bitwarden `bw`), an agent can
   offer to add a backend so hush reads/writes through that instead of the OS keychain. hush doesn't
   ship every adapter, but the backend is a small, swappable layer (`b_store` / `b_fetch` /
   `b_exists` / `b_delete` / `b_list` in the script) , an agent can wire a new one locally (a local,
   user-owned edit, that's fine). **Any added backend keeps the same contract**: never print the
   value, inject-only, no getter. The base just has to exist so the agent stops asking the human to
   shuttle secrets by hand.

## other platforms

The built-in backends are mac + linux + windows, but the **contract is the product**, not the
backend. On any platform without a built-in backend, use whatever secret store you have (a cloud
secret manager, your distro's keyring, etc.). The rules to keep, on any platform:

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

It's also **only as durable as the machine it lives on.** The store is a local keychain, so a machine
backup (Time Machine and the like) covers it, but if the disk dies and nothing's backed up, it's
gone. So back the machine up, or sync onward into a real secret manager (see *extending hush*) , and
don't treat hush as the *only* copy of a secret you can't regenerate. (No runtime nagging about this;
it's just the honest expectation to set.)
