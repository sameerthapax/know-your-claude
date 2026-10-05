# Brain Bar

A health bar for **your** knowledge of the code. Every line Claude writes for you is a line you did not
write yourself, so the bar drains as Claude works. Win it back by passing a short quiz about your own
project.

```
🧠 ████████████████████████████████░░░░░░░░  7,936 / 10,000 HP   -24 Claude edited architecture.md (architecture ×2)   [ Test my brain ]
```

## How health changes

Health starts at **10,000** and is kept per project (per folder you start Claude Code in), across sessions.

| Event | HP |
|---|---|
| Each line Claude adds | −4 |
| Each line Claude changes | −2 |
| Each line Claude deletes | −5 |
| A new file Claude creates | −50, plus its lines |
| Lines in an architecture file | ×2 |
| Right answer: easy / medium / hard | +200 / +500 / +1,000 |
| Wrong answer | −100 |

Health never goes above 10,000. The bar is green from 6,000, yellow below 6,000, and red below 3,000.
Every change plays a short animation: a loss blinks red and drains away, a gain glows green and grows in.

Claude's **Edit**, **Write**, and **NotebookEdit** tools count, and so do files Claude changes through
**Bash** (for example `sed` or a Python one-liner): the mod reads `git status` before and after each Bash
command and charges for every file whose text changed in between. That works only inside a git
repository, and only for files git sees (gitignored files are not counted). A file you edit yourself
while a Bash command is running is counted as Claude's.

**Architecture files** are anything under `infra/`, `terraform/`, `.github/workflows/`, `docs/adr/`, or a
`contract/` or `contracts/` folder, plus `docs/architecture.md` and any `.tf`, `.tfvars`, or `.bicep` file.
Change the list in `ARCHITECTURE` at the top of `hooks/register.js`.

## The brain test

Start it with the **Test my brain** button on the bar, or:

```
/brain-test              five questions about the project, mostly its architecture
/brain-test animation    every question about the topic you type
```

- Five questions: two easy, two medium, one hard, four choices each.
- **↑ ↓** select, **Enter** answers, **Esc** cancels at any stage, loading included.
- A right answer flashes and counts up its points; a wrong one shakes, is struck through, and shows the
  right answer with a one-line reason.
- **It opens by itself** while Claude is working once health is below 6,000, at most once per reply.
  Claude Code only opens a panel unasked in a terminal at least 144 columns wide; in a narrower one you
  get a reminder instead.

The questions are written by a separate model call (Sonnet) that this mod makes, so the mod holds the
answers and Claude never sees them.

## Sound and music

Short effects (start, select, right, wrong, done, alert) and a quiet looping 8-bit track while a test is
open. All sounds are generated and included in `sounds/`.

- **Windows (WSL):** a small hidden PowerShell player (`sounds/player.ps1`) mixes the music and the
  effects. It stops when the test ends or the panel closes, when a newer player starts, and by itself if
  the mod stops sending a heartbeat for 6 seconds. Volumes are at the top of `player.ps1`
  (`$musicVolume = 0.06`, `$sfxVolume = 0.55`).
- **macOS:** effects play through Claude Code's own player; there is no music.
- **Linux (not WSL):** no sound; everything else works.

## What it reads, runs, and sends

- **Reads:** the files Claude edits (to count lines), `git status` and the changed files' text around
  each Bash command, and for a quiz: this session's recent conversation
  including the tool calls Claude made, `git diff HEAD`, `git log`, `git ls-files`, and the first part of
  `README.md`, `CLAUDE.md`, and `docs/architecture.md`.
- **Sends:** that quiz context to a model **on your own Claude plan**, once per test. Nothing else leaves
  your machine.
- **Runs:** `git`, and on WSL `wslpath` and `powershell.exe` for sound.
- **Writes:** health to Claude Code's per-plugin store (`~/.claude/plugins/store/`), and on WSL the sound
  files and player to `%TEMP%\brain-bar` on Windows.

## Requirements

Claude Code 2.1.287 or newer, `git`. Tested with 2.1.289 on Windows (WSL, Ubuntu).

## Tests

```bash
claude plugin test
```

Nine tests cover the quiz panel, right and wrong answers, the final screen, a small panel, the automatic
opening below 6,000 HP, and each health cost.
