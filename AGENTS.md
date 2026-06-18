# AGENTS.md , for any agent, not just one tool

You were probably pointed here as "use the hush skill." This file is the agent-agnostic entry point;
the full playbook is [`SKILL.md`](SKILL.md).

## what hush is (one line)

A secret store you operate so the user never has to paste a secret into the chat: get a value once
into the OS keychain, then inject it into the already-authed CLIs you're running as the user , forever,
never printed, never written to the repo.

## install (any agent)

`hush` is a single self-contained bash script. Get it on the box and make it executable:

```sh
git clone https://github.com/royashbrook/hush
chmod +x hush/hush
```

Then either put `hush/hush` on your `PATH`, or move it into wherever your agent loads its
tools/skills. That's all the install there is , no build, no deps beyond your OS secret backend
(macOS Keychain / Linux `secret-tool` / Windows DPAPI, all auto-detected).

Tool-specific convenience:
- **Claude Code** , clone into `~/.claude/skills/hush` (whole session) or `./.claude/skills/hush`
  (one project) and it auto-loads as a skill.
- **Anything else** , PATH or your tool's plugin/skill directory works the same; hush is just a script.

## then read SKILL.md

[`SKILL.md`](SKILL.md) is the contract and the playbook: the two add-paths (`hush set` pops a hidden
dialog for a value the user holds; `hush mint` generates a random one), injecting with `hush run` /
`hush pipe`, adopting hush in an existing repo, and the one hard rule , **you never see the
plaintext, and there is no `get`.** Follow it directly.
