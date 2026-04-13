# ClaudeSessionAnalyser

Compress Claude Code session logs into structured views for analysis. Zero dependencies — just Node.js.

This tool doesn't analyse your sessions itself — it **compresses** 200+ MB of JSONL logs into compact views that fit Claude's context window, so Claude can reason about patterns in an agent loop.

## Quick start

```bash
git clone https://github.com/AltienAllen/ClaudeSessionAnalyser.git
cd ClaudeSessionAnalyser
bash install.sh
```

That's it. The `/analyse-sessions` slash command is now available in **all** Claude Code sessions on this machine.

## Install options

### Global skill (recommended — works in all sessions)

```bash
bash install.sh
```

This copies `index.js` and `SKILL.md` to `~/.claude/skills/analyse-sessions/`. Every Claude Code session on this machine will see the `/analyse-sessions` skill automatically.

### Per-project skill (only one project)

```bash
bash install.sh --local
```

Copies to `.claude/skills/analyse-sessions/` in the current directory. Only sessions rooted in this project will see it.

### Run directly (no skill install)

**Git Bash / WSL / macOS / Linux:**
```bash
node ~/.claude/skills/analyse-sessions/index.js overview
```

**Windows CMD:**
```cmd
node %USERPROFILE%\.claude\skills\analyse-sessions\index.js overview
```

**Windows PowerShell:**
```powershell
node $env:USERPROFILE\.claude\skills\analyse-sessions\index.js overview
```

### Install on another machine

```bash
git clone https://github.com/AltienAllen/ClaudeSessionAnalyser.git
cd ClaudeSessionAnalyser
bash install.sh
```

## Commands

| Command | What it does |
|---------|-------------|
| `overview` | All sessions in a compact table — turns, corrections, errors per session |
| `session <id>` | ASCII conversation tree for one session — every Q&A turn with tool calls |
| `corrections` | All user corrections across sessions with preceding context |
| `errors` | Tool failures and API errors aggregated by tool and timeline |
| `hotspots` | Files ranked by touch frequency, weighted 3x near failures |
| `patterns` | Repeated phrases across sessions, common tool sequences |
| `init-wiki [path]` | Scaffold a `docs/agent-wiki/` directory with templates |
| `list_projects` | Show all projects that have session logs |

## Options

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--project <name>` | `-p` | Target project (substring match) | auto-detect from cwd |
| `--since <date>` | `-s` | Only sessions after this date | — |
| `--before <date>` | `-b` | Only sessions before this date | — |
| `--limit <n>` | `-n` | Max results to display | 30 |
| `--json` | | Machine-readable JSON output | — |
| `--help` | `-h` | Show help | — |

### Date formats

`--since` and `--before` accept: `today`, `yesterday`, `last week`, `last 2 weeks`, `last 3 days`, `last month`, or ISO dates like `2026-04-01`.

## Example output

### `overview`

```
== Session Overview ==

3 sessions | 203 turns | 6 corrections (3%) | 22 API errors | 57 tool failures

ID         Date         Turns  Corr   Errs   First prompt
──────────────────────────────────────────────────────────────────────────────
78b880d3   1w ago       139    5      50     You have access to the legal-sources repo...
1badde8a   2d ago       53     1      25     You are operating inside a local reposito...
dd63ff6e   today        11     0      4      You able to get context from previous ses...
```

### `session <id>` — ASCII conversation tree

```
Q: [12:41] what about claude logs, can you read those?
├─ Bash List Claude config directory contents ✓
├─ Bash List recent session directories ✓
├─ Bash List project-specific Claude data ✓
├─ Bash Check size of session log files ✓
├─ Bash Peek at the most recent/smallest session log ✓
└─ → Yes — I **can** read the session logs.

Q: [12:45] I would like you to make a quick tool...
├─ Bash Analyze message types in session log ✗
│   Exit code 49
├─ Bash Check available runtimes ✗
│   Exit code 103
├─ Bash Analyze session log structure with Node ✓
├─ Agent: Explore session log structure ✓
└─ → Good — now I have a solid understanding.
```

Each turn shows:
- **Q:** User prompt (first line)
- **Tool calls** with description, filename, or command — `✓` success, `✗` failure
- **Agent** sub-calls highlighted with their description
- **Error details** inline below failed tools
- **→** Assistant response (first sentence)

### `corrections`

```
== Corrections across 3 sessions ==

6 corrections out of 203 turns (3.0%)

[2026-04-02 16:21] session:78b880d3
  after: Why did loads of JSON files get deleted? Can you see why?
  tools: Bash
  → ok - but make a note NOT to do that in future, I'll revert the deletions for now
```

## Agent workflow

The intended use is inside Claude Code — either via the `/analyse-sessions` skill or by asking Claude to run the tool:

1. **Overview** — `/analyse-sessions overview` — spot sessions with high correction rates or errors
2. **Drill in** — `/analyse-sessions session 78b880d3` — see the conversation tree for a problem session
3. **Cross-session** — `/analyse-sessions corrections` — find patterns in what keeps going wrong
4. **Hotspots** — `/analyse-sessions hotspots` — which files cause the most trouble
5. **Write it up** — `/analyse-sessions init-wiki` — scaffold output, then Claude writes findings

## Companion tool

[ClaudeQueryHistory](https://github.com/AltienAllen/ClaudeQueryHistory) searches session logs by keyword. This tool compresses; that tool searches. Install both:

```bash
git clone https://github.com/AltienAllen/ClaudeQueryHistory.git
cd ClaudeQueryHistory && bash install.sh && cd ..

git clone https://github.com/AltienAllen/ClaudeSessionAnalyser.git
cd ClaudeSessionAnalyser && bash install.sh && cd ..
```

## How it works

Claude Code stores conversation history as JSONL files in `~/.claude/projects/<project-dir>/`. Each line is a JSON object representing a message, tool call, tool result, or system event.

This tool parses those files and builds a structured representation:
- Groups messages into **turns** (user prompt → tool calls → assistant response)
- Detects **corrections** via lexical patterns ("no", "wrong", "revert", "try again", etc.)
- Tracks **tool failures** by matching tool_use IDs to their results
- Counts **file touches** from Read/Write/Edit tool inputs
- Uses `sessions-index.json` as a fast path when available

## Requirements

- Node.js 18+
- Claude Code (session logs are created automatically)

## License

MIT
