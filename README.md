# know-your-claude

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview). A mod is a plugin whose
code runs inside Claude Code, so it can draw its own panels, react to what Claude does, and add commands.

| Mod | What it does |
|---|---|
| [**brain-bar**](brain-bar/) | A knowledge health bar above the prompt. It drains as Claude writes code for you and refills when you pass a short quiz about your own project, with a retro quiz panel, animations, sound, and music. |

## Install

You need Claude Code **2.1.287 or newer** (mods were added in that release). Check with `claude --version`.

Add this repository as a marketplace once, then install the mod:

```bash
claude plugin marketplace add sameerthapax/know-your-claude
claude plugin install brain-bar@sameer-mods
```

Or from inside a Claude Code session:

```
/plugin install brain-bar --marketplace sameerthapax/know-your-claude
```

Start a new session, then run `/plugin`. The line under the tabs should name `brain-bar`.

### Updates

```bash
claude plugin update brain-bar@sameer-mods
```

Each release raises the `version` in the mod's `.claude-plugin/plugin.json`; an update installs only when it changed.

### Try one without installing

```bash
git clone https://github.com/sameerthapax/know-your-claude
claude --plugin-dir ./know-your-claude/brain-bar
```

## Before you install: what a mod can do

A mod is not sandboxed. It runs with **your** permissions: it can read and write your files, start
programs, make network requests, and call a model on your Claude plan. Read the code before you install
it. [brain-bar/README.md](brain-bar/README.md) lists exactly what it reads, runs, and sends. You can also list what a mod hooks
and calls without running it:

```bash
claude plugin validate ./brain-bar
```

To switch it off for one session, start Claude Code with `--safe-mode`. To remove it:
`claude plugin uninstall brain-bar@sameer-mods`.

## Developing

The mod lives in `brain-bar/`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, and `hooks/register.js`.
Load a folder for a session with `claude --plugin-dir ./brain-bar`; Claude Code reloads it when you save.

```bash
claude plugin validate --strict ./brain-bar   # check the manifest and code
cd brain-bar && claude plugin test            # run the tests
```

Tested with Claude Code 2.1.289 on Windows (WSL, Ubuntu).
