#!/usr/bin/env bash
# Install ClaudeSessionAnalyser as a Claude Code skill
# Usage:
#   ./install.sh          # global install (~/.claude/skills/)
#   ./install.sh --local  # project-local install (.claude/skills/)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST_DIR="$HOME/.claude/skills/analyse-sessions"

if [[ "$1" == "--local" ]]; then
  DEST_DIR=".claude/skills/analyse-sessions"
  echo "Installing locally to $DEST_DIR"
else
  echo "Installing globally to $DEST_DIR"
fi

mkdir -p "$DEST_DIR"
cp "$SCRIPT_DIR/index.js" "$DEST_DIR/index.js"
cp "$SCRIPT_DIR/skills/analyse-sessions.md" "$DEST_DIR/SKILL.md"

echo "Done. Use /analyse-sessions in Claude Code."
echo ""
echo "Example: /analyse-sessions overview"
