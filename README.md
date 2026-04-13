# ClaudeSessionAnalyser

Compress Claude Code session logs into structured views for agent-driven analysis. Zero dependencies — just Node.js.

This tool doesn't analyse your sessions — it **compresses** them into views that fit Claude's context window, so Claude can do the analysis in an agent loop.

## What it does

Session logs (200+ MB of JSONL) get compressed into:

- **Overview** — all sessions in one screen (~50 lines)
- **Session detail** — single session as a turn-by-turn narrative (~80-120 lines)
- **Corrections** — every user correction with preceding context
- **Errors** — tool failures and API errors aggregated
- **Hotspots** — files ranked by frequency, weighted by proximity to failures
- **Patterns** — repeated phrases, common tool sequences, correction keywords
- **Wiki scaffold** — template directory for writing up findings

## Installation

### Option A — Claude Code skill (recommended)

```bash
git clone https://github.com/AltienAllen/ClaudeSessionAnalyser.git
cd ClaudeSessionAnalyser
bash install.sh          # global (~/.claude/skills/)
bash install.sh --local  # per-project (.claude/skills/)
```

Then use `/analyse-sessions overview` in any Claude Code session.

### Option B — Run directly

```bash
node /path/to/ClaudeSessionAnalyser/index.js <command> [options]
```

## Usage

```
node index.js <command> [options]

Commands:
  overview              Project-wide session summary
  sessions              List sessions (alias for overview)
  session <id>          Compressed single-session narrative (prefix match)
  corrections           All user corrections across sessions
  errors                Tool failures and API errors
  hotspots              Files appearing most in problem contexts
  patterns              Repeated phrases, tool sequences, themes
  init-wiki [path]      Scaffold docs/agent-wiki directory
  list_projects         List available projects

Options:
  -p, --project <name>  Target project (substring match, default: cwd)
  -s, --since <date>    Only sessions after this date
  -b, --before <date>   Only sessions before this date
  -n, --limit <n>       Max results (default: 30)
  --json                Machine-readable JSON output
  -h, --help            Show help
```

## Examples

```bash
# Get the big picture
node index.js overview

# Drill into a specific session
node index.js session 78b880d3

# Find all user corrections from the last week
node index.js corrections --since "last week"

# See which files cause the most trouble
node index.js hotspots --project MatterAI

# JSON output for agent processing
node index.js patterns --json

# Scaffold a wiki to write up findings
node index.js init-wiki docs/agent-wiki
```

## Agent workflow

The intended use is inside a Claude Code agent loop:

1. `/analyse-sessions overview` — spot sessions with high correction rates or errors
2. `/analyse-sessions session <id>` — drill into problem sessions
3. `/analyse-sessions corrections` — find cross-session correction patterns
4. `/analyse-sessions hotspots` — identify files that keep causing issues
5. `/analyse-sessions init-wiki` — scaffold output directory
6. Claude writes findings to the wiki pages

## Companion tool

Use [ClaudeQueryHistory](https://github.com/AltienAllen/ClaudeQueryHistory) to search for specific keywords in session logs. This tool compresses; that tool searches.

## Requirements

- Node.js 18+
- Claude Code session logs (created automatically by Claude Code)

## License

MIT
