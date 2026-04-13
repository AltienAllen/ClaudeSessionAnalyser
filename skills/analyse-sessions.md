---
name: analyse-sessions
description: Compress Claude Code session logs into structured views for analysis. Use to find patterns in corrections, errors, file hotspots, and recurring themes across past sessions. Produces overviews, session narratives, and cross-session extracts.
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash(node *)
argument-hint: <command> [options] — commands: overview, sessions, session <id>, corrections, errors, hotspots, patterns, init-wiki
---

# Analyse Sessions

Compress and structure Claude Code session logs so you can reason about patterns, corrections, and recurring issues.

## How to run

```bash
node ~/.claude/skills/analyse-sessions/index.js <command> [options]
```

## Agent workflow

Follow this loop to analyse a project's session history:

### Step 1 — Get the big picture
```bash
node ~/.claude/skills/analyse-sessions/index.js overview
```
This shows all sessions in a compact table with turn counts, correction counts, and error counts. Identify sessions with high correction density or error rates.

### Step 2 — Drill into interesting sessions
```bash
node ~/.claude/skills/analyse-sessions/index.js session <id-prefix>
```
Shows a turn-by-turn compressed narrative. Look for:
- Turns marked with CORRECTION — what went wrong?
- Turns with tool failures — what broke?
- Files that appear repeatedly — hotspots?

### Step 3 — Cross-session analysis
```bash
node ~/.claude/skills/analyse-sessions/index.js corrections
node ~/.claude/skills/analyse-sessions/index.js errors
node ~/.claude/skills/analyse-sessions/index.js hotspots
node ~/.claude/skills/analyse-sessions/index.js patterns
```

### Step 4 — Write findings
```bash
node ~/.claude/skills/analyse-sessions/index.js init-wiki docs/agent-wiki
```
Then populate the wiki pages with your analysis.

## Commands

- `overview` — project-wide session summary table
- `sessions` — session listing (alias for overview)
- `session <id>` — compressed single-session narrative (prefix match, e.g. `78b880d3`)
- `corrections` — all user corrections with preceding context
- `errors` — tool failures and API errors aggregated
- `hotspots` — files ranked by weighted touch frequency (failures weighted 3x)
- `patterns` — repeated phrases, common tool sequences, correction keywords
- `init-wiki [path]` — scaffold docs/agent-wiki with templates
- `list_projects` — show available projects

## Options

- `-p, --project <name>` — target project (default: auto-detect from cwd)
- `-s, --since <date>` — filter by date (today, yesterday, last week, 2026-04-01)
- `-b, --before <date>` — upper date bound
- `-n, --limit <n>` — max results (default: 30)
- `--json` — structured JSON output (preferred in agent loops)

## Tips

- Use `--json` when you need to process the data programmatically
- Use `--since "last week"` to focus on recent sessions
- Session IDs can be prefix-matched (first 8 chars is enough)
- Use ClaudeQueryHistory (`/query-history`) to search for specific keywords when you need the actual message text
