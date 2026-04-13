#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";

// ── Colour helpers (no dependencies) ────────────────────────────────
const tty = process.stdout.isTTY;
const c = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t) => c(2, t);
const bold = (t) => c(1, t);
const cyan = (t) => c(36, t);
const yellow = (t) => c(33, t);
const green = (t) => c(32, t);
const magenta = (t) => c(35, t);
const red = (t) => c(31, t);

// ── Date parsing (shared with ClaudeQueryHistory) ───────────────────
function parseDate(input) {
  if (!input) return null;
  const now = new Date();
  const lower = input.toLowerCase();
  if (lower === "today") {
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d;
  }
  if (lower === "yesterday") {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d;
  }
  const weekMatch = lower.match(/^last\s*(\d+)?\s*weeks?$/);
  if (weekMatch) {
    const n = parseInt(weekMatch[1] || "1", 10);
    const d = new Date(now); d.setDate(d.getDate() - n * 7); d.setHours(0, 0, 0, 0); return d;
  }
  const dayMatch = lower.match(/^last\s*(\d+)\s*days?$/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1], 10);
    const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d;
  }
  const monthMatch = lower.match(/^last\s*(\d+)?\s*months?$/);
  if (monthMatch) {
    const n = parseInt(monthMatch[1] || "1", 10);
    const d = new Date(now); d.setMonth(d.getMonth() - n); d.setHours(0, 0, 0, 0); return d;
  }
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;
  console.error(red(`Could not parse date: "${input}"`));
  process.exit(1);
}

// ── Project discovery (shared with ClaudeQueryHistory) ──────────────
function getProjectsBase() {
  return join(homedir(), ".claude", "projects");
}

function listProjects() {
  const base = getProjectsBase();
  if (!existsSync(base)) return [];
  const projects = [];
  for (const dir of readdirSync(base)) {
    const dp = join(base, dir);
    if (!statSync(dp).isDirectory()) continue;
    const sessions = readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
    if (sessions.length === 0) continue;
    const totalSize = sessions.reduce((sum, f) => sum + statSync(join(dp, f)).size, 0);
    // Check for sessions-index.json
    const indexPath = join(dp, "sessions-index.json");
    const hasIndex = existsSync(indexPath);
    projects.push({
      dirName: dir,
      friendlyName: dir.replace(/^[A-Za-z]--/, "").replace(/--/g, " > ").replace(/-/g, "/"),
      sessions: sessions.length,
      sizeMB: (totalSize / 1024 / 1024).toFixed(1),
      hasIndex,
    });
  }
  return projects.sort((a, b) => b.sessions - a.sessions);
}

function resolveProjectDir(projectFilter) {
  const base = getProjectsBase();
  if (!projectFilter) {
    const cwd = process.cwd().replace(/\\/g, "/").replace(/^\/([a-z])\//, (_, l) => `${l.toUpperCase()}:\\`).replace(/\//g, "\\");
    const cwdKey = cwd.replaceAll("\\", "-").replace(":", "");
    const dirs = existsSync(base) ? readdirSync(base) : [];
    const match = dirs.find((d) => d === cwdKey || d.toLowerCase() === cwdKey.toLowerCase());
    if (match) return [join(base, match)];
    const partial = dirs.filter((d) => d.toLowerCase().includes(basename(cwd).toLowerCase()));
    if (partial.length > 0) return partial.map((d) => join(base, d));
    console.error(yellow("Could not auto-detect project. Use --project or run list_projects."));
    process.exit(1);
  }
  const dirs = existsSync(base) ? readdirSync(base) : [];
  const matches = dirs.filter((d) => d.toLowerCase().includes(projectFilter.toLowerCase()));
  if (matches.length === 0) {
    console.error(red(`No project matching "${projectFilter}".`));
    process.exit(1);
  }
  return matches.map((d) => join(base, d));
}

// ── Correction detection ────────────────────────────────────────────
const CORRECTION_PATTERNS = [
  /^no[,.\s!-]/i, /^no$/i,
  /^wrong/i, /^incorrect/i,
  /^that'?s not/i, /^that is not/i, /^that isn'?t/i,
  /^don'?t /i, /^do not /i, /^stop /i,
  /^actually[,\s]/i, /^instead[,\s]/i, /^rather[,\s]/i,
  /^wait[,.\s!]/i, /^hang on/i, /^hold on/i,
  /\brevert\b/i, /\bundo\b/i, /\btry again\b/i, /\bput it back\b/i,
  /\bstill doesn'?t\b/i, /\bstill broken\b/i, /\bstill not\b/i,
  /\bthat didn'?t work\b/i, /\bdoesn'?t work\b/i,
  /\bnot what I\b/i, /\bnot what i\b/i,
  /\byou (missed|forgot|skipped)\b/i,
  /\bI (said|told you|asked|meant)\b/i,
];

function isCorrection(text) {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

// ── Enhanced session parser ─────────────────────────────────────────
function parseSessionRich(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const id = basename(filePath, ".jsonl");

  const result = {
    id,
    customTitle: null,
    firstTimestamp: null,
    lastTimestamp: null,
    gitBranch: null,
    cwd: null,
    counts: { user: 0, assistant: 0, system: 0, progress: 0, other: 0 },
    turns: [],
    corrections: [],
    apiErrors: 0,
    toolResults: { success: 0, fail: 0 },
    failedTools: [],
    filesTouched: {},
    toolCounts: {},
  };

  // First pass: collect all entries by type
  const entries = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    entries.push(obj);

    // Count types
    const t = obj.type;
    if (t === "user") result.counts.user++;
    else if (t === "assistant") result.counts.assistant++;
    else if (t === "system") result.counts.system++;
    else if (t === "progress") result.counts.progress++;
    else result.counts.other++;

    // Metadata
    if (t === "custom-title") result.customTitle = obj.title || obj.customTitle;
    if (!result.gitBranch && obj.gitBranch) result.gitBranch = obj.gitBranch;
    if (!result.cwd && obj.cwd) result.cwd = obj.cwd;

    // Timestamps
    if (obj.timestamp) {
      const ts = new Date(obj.timestamp);
      if (!result.firstTimestamp || ts < result.firstTimestamp) result.firstTimestamp = ts;
      if (!result.lastTimestamp || ts > result.lastTimestamp) result.lastTimestamp = ts;
    }

    // API errors
    if (t === "system" && obj.subtype === "api_error") result.apiErrors++;
  }

  // Second pass: build turns (user prompt → assistant responses until next prompt)
  // Build a map of tool_use_id → tool name from assistant messages
  const toolUseIdToName = {};
  for (const obj of entries) {
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === "tool_use" && block.id) {
          toolUseIdToName[block.id] = block.name || "unknown";
        }
      }
    }
  }

  let currentTurn = null;

  for (const obj of entries) {
    if (obj.type === "user") {
      const content = obj.message?.content;
      if (!content) continue;

      // Check if this is a tool result or a user text prompt
      if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => b.type === "tool_result");
        if (hasToolResult) {
          // Process tool results
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const isError = block.is_error === true;
            const toolId = block.tool_use_id;
            const toolName = toolUseIdToName[toolId] || obj.toolUseResult?.commandName || "unknown";
            if (isError) {
              result.toolResults.fail++;
              // Extract error text from tool result content
              let errorText = "";
              if (typeof block.content === "string") errorText = block.content.slice(0, 120);
              else if (Array.isArray(block.content)) {
                const txt = block.content.find((b) => b.type === "text");
                if (txt) errorText = txt.text.slice(0, 120);
              }
              result.failedTools.push({
                toolName,
                error: errorText,
                timestamp: obj.timestamp ? new Date(obj.timestamp) : null,
              });
            } else {
              result.toolResults.success++;
            }
          }
          continue;
        }

        // User text prompt
        const textParts = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const cleaned = textParts.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, "").trim();
        if (!cleaned) continue;

        // Save previous turn
        if (currentTurn) result.turns.push(currentTurn);

        currentTurn = {
          userPrompt: cleaned,
          timestamp: obj.timestamp ? new Date(obj.timestamp) : null,
          toolCalls: [],
          toolFailures: 0,
          isCorrection: isCorrection(cleaned),
        };

        if (currentTurn.isCorrection) {
          result.corrections.push({
            text: cleaned,
            timestamp: currentTurn.timestamp,
            sessionId: id,
          });
        }
      } else if (typeof content === "string") {
        const cleaned = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, "").trim();
        if (!cleaned) continue;
        if (currentTurn) result.turns.push(currentTurn);
        currentTurn = {
          userPrompt: cleaned,
          timestamp: obj.timestamp ? new Date(obj.timestamp) : null,
          toolCalls: [],
          toolFailures: 0,
          isCorrection: isCorrection(cleaned),
        };
        if (currentTurn.isCorrection) {
          result.corrections.push({ text: cleaned, timestamp: currentTurn.timestamp, sessionId: id });
        }
      }
    } else if (obj.type === "assistant" && currentTurn) {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_use") {
          const toolName = block.name || "unknown";
          currentTurn.toolCalls.push({ name: toolName });
          result.toolCounts[toolName] = (result.toolCounts[toolName] || 0) + 1;

          // Extract file paths from tool inputs
          const input = block.input;
          if (input) {
            const fp = input.file_path || input.path || input.filePath;
            if (fp && typeof fp === "string") {
              result.filesTouched[fp] = (result.filesTouched[fp] || 0) + 1;
            }
          }
        }
      }
    }
  }
  // Don't forget the last turn
  if (currentTurn) result.turns.push(currentTurn);

  // Mark turns that precede corrections
  for (let i = 0; i < result.turns.length - 1; i++) {
    if (result.turns[i + 1].isCorrection) {
      result.turns[i].followedByCorrection = true;
    }
  }

  return result;
}

// ── Tree parser for session detail ──────────────────────────────────
function parseSessionTree(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { continue; }
  }

  // Build lookup maps
  const byUuid = {};
  const toolUseIdToInfo = {};  // tool_use block id → { name, input summary }

  for (const obj of entries) {
    if (obj.uuid) byUuid[obj.uuid] = obj;
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === "tool_use" && block.id) {
          const input = block.input || {};
          let summary = "";
          if (block.name === "Agent") {
            summary = input.description || input.prompt?.split("\n")[0].slice(0, 80) || "";
          } else if (block.name === "Read" || block.name === "Write" || block.name === "Edit") {
            const fp = input.file_path || input.path || "";
            summary = fp ? basename(fp) : "";
          } else if (block.name === "Bash") {
            // Use description if available, otherwise first line of command
            const cmd = input.command || "";
            summary = input.description || cmd.split("\n")[0];
          } else if (block.name === "Grep" || block.name === "Glob") {
            summary = input.pattern || "";
          } else if (block.name === "Skill") {
            summary = input.skill || "";
          } else {
            const keys = Object.keys(input);
            if (keys.length > 0) summary = keys.slice(0, 3).join(", ");
          }
          toolUseIdToInfo[block.id] = { name: block.name, summary };
        }
      }
    }
  }

  // Build conversation tree: group into "turns"
  // A turn starts with a user text prompt (not a tool_result)
  const turns = [];
  let currentTurn = null;

  for (const obj of entries) {
    if (obj.type === "user") {
      const content = obj.message?.content;
      if (!content) continue;
      if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => b.type === "tool_result");
        if (hasToolResult) {
          // Attach tool results to current turn
          if (currentTurn) {
            for (const block of content) {
              if (block.type !== "tool_result") continue;
              const toolId = block.tool_use_id;
              const info = toolUseIdToInfo[toolId] || { name: "unknown", summary: "" };
              const isError = block.is_error === true;
              // Extract short result for display
              let resultSnippet = "";
              if (isError) {
                if (typeof block.content === "string") resultSnippet = block.content.split("\n")[0];
                else if (Array.isArray(block.content)) {
                  const txt = block.content.find((b) => b.type === "text");
                  if (txt) resultSnippet = txt.text.split("\n")[0];
                }
              }
              currentTurn.toolResults.push({
                toolId,
                name: info.name,
                summary: info.summary,
                isError,
                resultSnippet,
              });
            }
          }
          continue;
        }
        // User text prompt — start new turn
        const textParts = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const cleaned = textParts.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
          .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, "").trim();
        if (!cleaned) continue;
        if (currentTurn) turns.push(currentTurn);
        currentTurn = {
          prompt: cleaned,
          timestamp: obj.timestamp ? new Date(obj.timestamp) : null,
          toolCalls: [],
          toolResults: [],
          assistantTexts: [],
          isCorrection: isCorrection(cleaned),
        };
      } else if (typeof content === "string") {
        const cleaned = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
          .replace(/<local-command-[\s\S]*?<\/local-command-[^>]*>/g, "").trim();
        if (!cleaned) continue;
        if (currentTurn) turns.push(currentTurn);
        currentTurn = {
          prompt: cleaned,
          timestamp: obj.timestamp ? new Date(obj.timestamp) : null,
          toolCalls: [],
          toolResults: [],
          assistantTexts: [],
          isCorrection: isCorrection(cleaned),
        };
      }
    } else if (obj.type === "assistant" && currentTurn) {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_use") {
          const info = toolUseIdToInfo[block.id] || { name: block.name, summary: "" };
          currentTurn.toolCalls.push({
            id: block.id,
            name: info.name,
            summary: info.summary,
            isAgent: block.name === "Agent",
            agentDesc: block.name === "Agent" ? (block.input?.description || "") : null,
          });
        } else if (block.type === "text" && block.text) {
          const cleaned = block.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
          if (cleaned.length > 10) {
            currentTurn.assistantTexts.push(cleaned);
          }
        }
      }
    }
  }
  if (currentTurn) turns.push(currentTurn);

  return turns;
}

function renderSessionTree(turns, opts = {}) {
  const limit = opts.limit || 30;
  const limited = turns.slice(0, limit);

  for (let i = 0; i < limited.length; i++) {
    const t = limited[i];
    const time = fmtTime(t.timestamp);
    const isLast = i === limited.length - 1;
    const corrFlag = t.isCorrection ? red(" CORRECTION") : "";

    // User prompt — first line only
    const promptLine = t.prompt.split("\n")[0].replace(/\s+/g, " ");
    console.log(`${green("Q:")} ${dim(`[${time}]`)} ${promptLine}${corrFlag}`);

    // Build ordered list of tool calls with their results
    const resultByToolId = {};
    for (const tr of t.toolResults) {
      resultByToolId[tr.toolId] = tr;
    }

    // Collect items to display: tool calls + final assistant text
    const items = [];
    for (const tc of t.toolCalls) {
      const result = resultByToolId[tc.id];
      items.push({ type: "tool", ...tc, result });
    }
    // Add assistant response summary if there is one
    if (t.assistantTexts.length > 0) {
      const lastText = t.assistantTexts[t.assistantTexts.length - 1];
      items.push({ type: "response", text: lastText });
    }

    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      const isItemLast = j === items.length - 1;
      const connector = isItemLast ? "└─" : "├─";
      const prefix = isItemLast ? "   " : "│  ";

      if (item.type === "tool") {
        const statusIcon = item.result?.isError ? red("✗") : green("✓");
        const status = item.result ? ` ${statusIcon}` : "";
        const summaryText = item.summary ? dim(` ${item.summary}`) : "";

        if (item.isAgent) {
          console.log(`${dim(connector)} ${magenta("Agent")}: ${cyan(item.agentDesc || "?")}${status}`);
        } else {
          console.log(`${dim(connector)} ${yellow(item.name)}${summaryText}${status}`);
        }

        // Show error details inline
        if (item.result?.isError && item.result.resultSnippet) {
          console.log(`${dim(prefix)} ${red(item.result.resultSnippet)}`);
        }
      } else if (item.type === "response") {
        // Response summary — first sentence or 150 chars, whichever is shorter
        const flat = item.text.replace(/\n/g, " ").replace(/\s+/g, " ");
        const firstSentence = flat.match(/^.{20,}?[.!?]\s/);
        const respLine = firstSentence ? firstSentence[0].trim() : truncate(flat, 150);
        console.log(`${dim(connector)} ${cyan("→")} ${dim(respLine)}`);
      }
    }

    // Empty line between turns (unless it's the last)
    if (!isLast) console.log("");
  }

  if (turns.length > limit) {
    console.log(dim(`\n  ... ${turns.length - limit} more turns. Use --limit ${turns.length}.`));
  }
}

// ── Sessions index fast path ────────────────────────────────────────
function loadSessionsIndex(projectDir) {
  const indexPath = join(projectDir, "sessions-index.json");
  if (!existsSync(indexPath)) return null;
  try {
    const data = JSON.parse(readFileSync(indexPath, "utf8"));
    return data.entries || null;
  } catch { return null; }
}

// ── Arg parsing ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    command: null,
    commandArgs: [],
    project: null,
    since: null,
    before: null,
    json: false,
    limit: 30,
    listProjects: false,
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--project" || a === "-p") args.project = argv[++i];
    else if (a === "--since" || a === "-s") args.since = parseDate(argv[++i]);
    else if (a === "--before" || a === "-b") args.before = parseDate(argv[++i]);
    else if (a === "--limit" || a === "-n") args.limit = parseInt(argv[++i], 10);
    else if (a === "--json") args.json = true;
    else if (a === "list_projects" || a === "--list-projects") args.listProjects = true;
    else if (!a.startsWith("-")) {
      if (!args.command) args.command = a;
      else args.commandArgs.push(a);
    }
    i++;
  }
  return args;
}

// ── Helpers ─────────────────────────────────────────────────────────
function truncate(text, maxLen = 80) {
  const oneLine = text.replace(/\n/g, " ").replace(/\s+/g, " ");
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen) + "...";
}

function fmtDate(ts) {
  if (!ts) return "?";
  return ts.toISOString().slice(0, 10);
}

function fmtTime(ts) {
  if (!ts) return "?";
  return ts.toISOString().slice(11, 16);
}

function fmtRelative(ts) {
  if (!ts) return "unknown";
  const days = Math.floor((new Date() - ts) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return fmtDate(ts);
}

function summarizeToolCalls(toolCalls) {
  const counts = {};
  for (const tc of toolCalls) counts[tc.name] = (counts[tc.name] || 0) + 1;
  return Object.entries(counts).map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(", ");
}

function padRight(str, len) {
  if (str.length >= len) return str.slice(0, len);
  return str + " ".repeat(len - str.length);
}

// ── Load sessions for a project ─────────────────────────────────────
function loadAllSessions(projectDirs, opts = {}) {
  const sessions = [];
  for (const dir of projectDirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const parsed = parseSessionRich(join(dir, f));
      // Date filter
      if (opts.since && parsed.lastTimestamp && parsed.lastTimestamp < opts.since) continue;
      if (opts.before && parsed.firstTimestamp && parsed.firstTimestamp > opts.before) continue;
      sessions.push(parsed);
    }
  }
  return sessions.sort((a, b) => {
    if (!a.firstTimestamp) return -1;
    if (!b.firstTimestamp) return 1;
    return a.firstTimestamp - b.firstTimestamp;
  });
}

// ── Command: overview ───────────────────────────────────────────────
function cmdOverview(args) {
  const projectDirs = resolveProjectDir(args.project);

  // Try sessions-index.json fast path first
  let indexEntries = null;
  for (const dir of projectDirs) {
    const idx = loadSessionsIndex(dir);
    if (idx) {
      indexEntries = indexEntries || [];
      indexEntries.push(...idx);
    }
  }

  if (indexEntries && !args.json) {
    // Fast path: use index
    if (args.since) indexEntries = indexEntries.filter((e) => new Date(e.modified) >= args.since);
    if (args.before) indexEntries = indexEntries.filter((e) => new Date(e.created) <= args.before);
    indexEntries.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    const totalMsgs = indexEntries.reduce((s, e) => s + (e.messageCount || 0), 0);
    const branches = new Set(indexEntries.map((e) => e.gitBranch).filter(Boolean));

    console.log(bold("\n== Session Overview ==\n"));
    console.log(dim(`${indexEntries.length} sessions | ${totalMsgs} total messages | ${branches.size} branches\n`));

    const limited = indexEntries.slice(0, args.limit);
    console.log(`${dim(padRight("ID", 10))} ${dim(padRight("Date", 12))} ${dim(padRight("Msgs", 6))} ${dim(padRight("Branch", 20))} ${dim("Summary")}`);
    console.log(dim("─".repeat(90)));

    for (const e of limited) {
      const id = (e.sessionId || "").slice(0, 8);
      const date = fmtRelative(new Date(e.modified));
      const msgs = String(e.messageCount || "?");
      const branch = (e.gitBranch || "?").slice(0, 19);
      const summary = truncate(e.summary || e.firstPrompt || "?", 40);
      console.log(`${cyan(padRight(id, 10))} ${padRight(date, 12)} ${padRight(msgs, 6)} ${green(padRight(branch, 20))} ${summary}`);
    }

    if (indexEntries.length > args.limit) {
      console.log(dim(`\n  ... ${indexEntries.length - args.limit} more. Use --limit ${indexEntries.length} to see all.`));
    }
    console.log("");
    return;
  }

  // Slow path: parse all JSONL files
  const sessions = loadAllSessions(projectDirs, { since: args.since, before: args.before });
  if (sessions.length === 0) { console.log(yellow("No sessions found.")); return; }

  if (args.json) {
    const output = sessions.map((s) => ({
      id: s.id, title: s.customTitle, firstDate: fmtDate(s.firstTimestamp), lastDate: fmtDate(s.lastTimestamp),
      branch: s.gitBranch, turns: s.turns.length, corrections: s.corrections.length,
      apiErrors: s.apiErrors, toolFailures: s.toolResults.fail,
      correctionRate: s.turns.length > 0 ? (s.corrections.length / s.turns.length * 100).toFixed(1) + "%" : "0%",
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const totalTurns = sessions.reduce((s, x) => s + x.turns.length, 0);
  const totalCorrections = sessions.reduce((s, x) => s + x.corrections.length, 0);
  const totalErrors = sessions.reduce((s, x) => s + x.apiErrors, 0);
  const totalToolFails = sessions.reduce((s, x) => s + x.toolResults.fail, 0);

  console.log(bold("\n== Session Overview ==\n"));
  console.log(dim(`${sessions.length} sessions | ${totalTurns} turns | ${totalCorrections} corrections (${totalTurns > 0 ? (totalCorrections / totalTurns * 100).toFixed(0) : 0}%) | ${totalErrors} API errors | ${totalToolFails} tool failures\n`));

  console.log(`${dim(padRight("ID", 10))} ${dim(padRight("Date", 12))} ${dim(padRight("Turns", 6))} ${dim(padRight("Corr", 6))} ${dim(padRight("Errs", 6))} ${dim("First prompt")}`);
  console.log(dim("─".repeat(90)));

  const limited = sessions.slice(0, args.limit);
  for (const s of limited) {
    const id = s.id.slice(0, 8);
    const date = fmtRelative(s.lastTimestamp);
    const turns = String(s.turns.length);
    const corr = s.corrections.length > 0 ? yellow(String(s.corrections.length)) : dim("0");
    const errs = (s.apiErrors + s.toolResults.fail) > 0 ? red(String(s.apiErrors + s.toolResults.fail)) : dim("0");
    const prompt = truncate(s.turns[0]?.userPrompt || s.customTitle || "?", 45);
    console.log(`${cyan(padRight(id, 10))} ${padRight(date, 12)} ${padRight(turns, 6)} ${padRight(corr, 6)} ${padRight(errs, 6)} ${prompt}`);
  }

  if (sessions.length > args.limit) {
    console.log(dim(`\n  ... ${sessions.length - args.limit} more. Use --limit ${sessions.length}.`));
  }

  // Tool usage breakdown
  const allTools = {};
  for (const s of sessions) for (const [t, c] of Object.entries(s.toolCounts)) allTools[t] = (allTools[t] || 0) + c;
  const toolTotal = Object.values(allTools).reduce((a, b) => a + b, 0);
  if (toolTotal > 0) {
    console.log(bold("\n### Tool Usage"));
    const sorted = Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [name, count] of sorted) {
      const pct = (count / toolTotal * 100).toFixed(0);
      console.log(`  ${padRight(name, 20)} ${padRight(String(count), 8)} ${dim(pct + "%")}`);
    }
  }
  console.log("");
}

// ── Command: sessions ───────────────────────────────────────────────
function cmdSessions(args) {
  // Delegates to overview with same logic — they're similar enough
  cmdOverview(args);
}

// ── Command: session <id> ───────────────────────────────────────────
function cmdSessionDetail(args) {
  const sessionId = args.commandArgs[0];
  if (!sessionId) {
    console.error(red("Usage: session <session-id-prefix>"));
    process.exit(1);
  }

  const projectDirs = resolveProjectDir(args.project);
  let targetFile = null;
  for (const dir of projectDirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const match = files.find((f) => f.startsWith(sessionId));
    if (match) { targetFile = join(dir, match); break; }
  }
  if (!targetFile) {
    console.error(red(`No session matching "${sessionId}".`));
    process.exit(1);
  }

  const s = parseSessionRich(targetFile);
  const treeTurns = parseSessionTree(targetFile);

  if (args.json) {
    console.log(JSON.stringify({
      id: s.id, title: s.customTitle,
      dates: { first: fmtDate(s.firstTimestamp), last: fmtDate(s.lastTimestamp) },
      branch: s.gitBranch, cwd: s.cwd,
      counts: s.counts,
      turnCount: s.turns.length,
      correctionCount: s.corrections.length,
      apiErrors: s.apiErrors,
      toolResults: s.toolResults,
      toolCounts: s.toolCounts,
      corrections: s.corrections.map((c) => ({ text: truncate(c.text, 150), timestamp: c.timestamp?.toISOString() })),
      failedTools: s.failedTools.map((f) => ({ tool: f.toolName, error: f.error, timestamp: f.timestamp?.toISOString() })),
      topFiles: Object.entries(s.filesTouched).sort((a, b) => b[1] - a[1]).slice(0, 15),
      turns: treeTurns.map((t) => ({
        time: fmtTime(t.timestamp), prompt: truncate(t.prompt, 100),
        isCorrection: t.isCorrection,
        toolCalls: t.toolCalls.map((tc) => ({ name: tc.name, summary: tc.summary, isAgent: tc.isAgent })),
        toolResults: t.toolResults.map((tr) => ({ name: tr.name, isError: tr.isError, snippet: tr.resultSnippet })),
        response: t.assistantTexts.length > 0 ? truncate(t.assistantTexts[t.assistantTexts.length - 1], 120) : null,
      })),
    }, null, 2));
    return;
  }

  const title = s.customTitle || truncate(s.turns[0]?.userPrompt || "?", 60);
  const corrRate = s.turns.length > 0 ? (s.corrections.length / s.turns.length * 100).toFixed(0) : 0;
  console.log(bold(`\n== Session: ${cyan(s.id.slice(0, 8))} ==`));
  console.log(dim(`"${title}"`));
  console.log(`${fmtDate(s.firstTimestamp)} to ${fmtDate(s.lastTimestamp)} | Branch: ${green(s.gitBranch || "?")} | ${treeTurns.length} turns | ${s.corrections.length} corrections (${corrRate}%) | ${s.apiErrors} API errors`);

  // Conversation tree
  console.log(bold("\n### Conversation tree\n"));
  renderSessionTree(treeTurns, { limit: args.limit });

  // Tool summary
  const toolTotal = Object.values(s.toolCounts).reduce((a, b) => a + b, 0);
  if (toolTotal > 0) {
    console.log(bold("\n### Tool usage"));
    const sorted = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [name, count] of sorted) {
      console.log(`  ${padRight(name, 20)} ${count}`);
    }
    if (s.toolResults.fail > 0) {
      console.log(red(`  Failures: ${s.toolResults.fail}`));
    }
  }

  // Hotspot files
  const fileEntries = Object.entries(s.filesTouched).sort((a, b) => b[1] - a[1]);
  if (fileEntries.length > 0) {
    console.log(bold("\n### Hotspot files (top 10)"));
    for (const [fp, count] of fileEntries.slice(0, 10)) {
      console.log(`  ${padRight(String(count) + "x", 5)} ${fp}`);
    }
  }

  // Corrections
  if (s.corrections.length > 0) {
    console.log(bold("\n### Corrections"));
    for (const corr of s.corrections) {
      console.log(`  ${dim(`[${fmtTime(corr.timestamp)}]`)} ${yellow(truncate(corr.text, 100))}`);
    }
  }

  // Failed tools
  if (s.failedTools.length > 0) {
    console.log(bold("\n### Tool failures"));
    for (const f of s.failedTools.slice(0, 10)) {
      console.log(`  ${dim(`[${fmtTime(f.timestamp)}]`)} ${red(f.toolName)} ${dim(truncate(f.error, 60))}`);
    }
  }
  console.log("");
}

// ── Command: corrections ────────────────────────────────────────────
function cmdCorrections(args) {
  const projectDirs = resolveProjectDir(args.project);
  const sessions = loadAllSessions(projectDirs, { since: args.since, before: args.before });

  const allCorrections = [];
  for (const s of sessions) {
    // Find corrections with preceding turn context
    for (let i = 0; i < s.turns.length; i++) {
      if (!s.turns[i].isCorrection) continue;
      const prevTurn = i > 0 ? s.turns[i - 1] : null;
      allCorrections.push({
        text: s.turns[i].userPrompt,
        timestamp: s.turns[i].timestamp,
        sessionId: s.id,
        precedingAction: prevTurn ? summarizeToolCalls(prevTurn.toolCalls) : null,
        precedingPrompt: prevTurn ? truncate(prevTurn.userPrompt, 60) : null,
      });
    }
  }

  if (args.json) {
    console.log(JSON.stringify(allCorrections.map((c) => ({
      text: c.text, timestamp: c.timestamp?.toISOString(), sessionId: c.sessionId,
      precedingAction: c.precedingAction, precedingPrompt: c.precedingPrompt,
    })), null, 2));
    return;
  }

  console.log(bold(`\n== Corrections across ${sessions.length} sessions ==\n`));
  if (allCorrections.length === 0) { console.log(green("No corrections detected.")); return; }

  const totalTurns = sessions.reduce((s, x) => s + x.turns.length, 0);
  console.log(dim(`${allCorrections.length} corrections out of ${totalTurns} turns (${(allCorrections.length / totalTurns * 100).toFixed(1)}%)\n`));

  const limited = allCorrections.slice(0, args.limit);
  for (const c of limited) {
    const sid = c.sessionId.slice(0, 8);
    console.log(`${dim(`[${fmtDate(c.timestamp)} ${fmtTime(c.timestamp)}]`)} ${dim("session:" + sid)}`);
    if (c.precedingPrompt) console.log(`  ${dim("after:")} ${dim(c.precedingPrompt)}`);
    if (c.precedingAction) console.log(`  ${dim("tools:")} ${dim(c.precedingAction)}`);
    console.log(`  ${yellow("→")} ${yellow(truncate(c.text, 120))}`);
    console.log("");
  }
  if (allCorrections.length > limited.length) {
    console.log(dim(`  ... ${allCorrections.length - limited.length} more. Use --limit ${allCorrections.length}.`));
  }
}

// ── Command: errors ─────────────────────────────────────────────────
function cmdErrors(args) {
  const projectDirs = resolveProjectDir(args.project);
  const sessions = loadAllSessions(projectDirs, { since: args.since, before: args.before });

  let totalApiErrors = 0;
  let totalToolFails = 0;
  const toolFailsByName = {};
  const allFailedTools = [];

  for (const s of sessions) {
    totalApiErrors += s.apiErrors;
    totalToolFails += s.toolResults.fail;
    for (const f of s.failedTools) {
      toolFailsByName[f.toolName] = (toolFailsByName[f.toolName] || 0) + 1;
      allFailedTools.push({ ...f, sessionId: s.id });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({
      totalApiErrors, totalToolFails, toolFailsByName,
      timeline: allFailedTools.map((f) => ({
        tool: f.toolName, error: f.error, timestamp: f.timestamp?.toISOString(), sessionId: f.sessionId,
      })),
    }, null, 2));
    return;
  }

  console.log(bold(`\n== Errors across ${sessions.length} sessions ==\n`));
  console.log(`API errors:    ${totalApiErrors > 0 ? red(String(totalApiErrors)) : green("0")}`);
  console.log(`Tool failures: ${totalToolFails > 0 ? red(String(totalToolFails)) : green("0")}`);

  if (Object.keys(toolFailsByName).length > 0) {
    console.log(bold("\n### Failures by tool"));
    const sorted = Object.entries(toolFailsByName).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${padRight(name, 20)} ${red(String(count))}`);
    }
  }

  if (allFailedTools.length > 0) {
    console.log(bold("\n### Failure timeline"));
    const limited = allFailedTools.slice(-args.limit);
    for (const f of limited) {
      const sid = f.sessionId.slice(0, 8);
      console.log(`  ${dim(`[${fmtDate(f.timestamp)} ${fmtTime(f.timestamp)}]`)} ${dim("session:" + sid)} ${red(f.toolName)} ${dim(truncate(f.error, 60))}`);
    }
  }

  // Per-session breakdown
  const sessionsWithErrors = sessions.filter((s) => s.apiErrors > 0 || s.toolResults.fail > 0);
  if (sessionsWithErrors.length > 0) {
    console.log(bold("\n### Sessions with errors"));
    for (const s of sessionsWithErrors) {
      const id = s.id.slice(0, 8);
      console.log(`  ${cyan(id)} ${dim(fmtDate(s.lastTimestamp))} API:${s.apiErrors} Tools:${s.toolResults.fail}`);
    }
  }
  console.log("");
}

// ── Command: hotspots ───────────────────────────────────────────────
function cmdHotspots(args) {
  const projectDirs = resolveProjectDir(args.project);
  const sessions = loadAllSessions(projectDirs, { since: args.since, before: args.before });

  // Aggregate file touches with weighting
  const fileScores = {};   // weighted score
  const fileCounts = {};   // raw count
  const fileFailures = {}; // near-failure count
  const fileSessions = {}; // how many sessions touched this file

  for (const s of sessions) {
    const sessionFiles = new Set();
    // Collect files near failures
    const failureFiles = new Set();
    for (const f of s.failedTools) {
      // Mark files touched in same turn as failure
      for (const t of s.turns) {
        for (const tc of t.toolCalls) {
          if (tc.filePath) failureFiles.add(tc.filePath);
        }
      }
    }

    for (const [fp, count] of Object.entries(s.filesTouched)) {
      fileCounts[fp] = (fileCounts[fp] || 0) + count;
      sessionFiles.add(fp);

      let weight = count;
      if (failureFiles.has(fp)) {
        weight *= 3;
        fileFailures[fp] = (fileFailures[fp] || 0) + 1;
      }
      fileScores[fp] = (fileScores[fp] || 0) + weight;
    }

    for (const fp of sessionFiles) {
      fileSessions[fp] = (fileSessions[fp] || 0) + 1;
    }
  }

  const sorted = Object.entries(fileScores).sort((a, b) => b[1] - a[1]);

  if (args.json) {
    const output = sorted.slice(0, args.limit).map(([fp, score]) => ({
      file: fp, score, rawCount: fileCounts[fp] || 0,
      sessions: fileSessions[fp] || 0, nearFailures: fileFailures[fp] || 0,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(bold(`\n== File Hotspots across ${sessions.length} sessions ==\n`));
  if (sorted.length === 0) { console.log(dim("No file touches recorded.")); return; }

  console.log(`${dim(padRight("Score", 7))} ${dim(padRight("Count", 7))} ${dim(padRight("Sess", 6))} ${dim(padRight("Fails", 7))} ${dim("File")}`);
  console.log(dim("─".repeat(80)));

  const limited = sorted.slice(0, args.limit);
  for (const [fp, score] of limited) {
    const count = fileCounts[fp] || 0;
    const sess = fileSessions[fp] || 0;
    const fails = fileFailures[fp] || 0;
    const failStr = fails > 0 ? red(String(fails)) : dim("0");
    console.log(`${padRight(String(score), 7)} ${padRight(String(count), 7)} ${padRight(String(sess), 6)} ${padRight(failStr, 7)} ${fp}`);
  }
  if (sorted.length > limited.length) {
    console.log(dim(`\n  ... ${sorted.length - limited.length} more files.`));
  }
  console.log("");
}

// ── Command: patterns ───────────────────────────────────────────────
function cmdPatterns(args) {
  const projectDirs = resolveProjectDir(args.project);
  const sessions = loadAllSessions(projectDirs, { since: args.since, before: args.before });

  // 1. Extract n-grams from user prompts to find repeated themes
  const ngramSessions = {}; // ngram → Set of session IDs
  const ngramExamples = {}; // ngram → first full prompt

  for (const s of sessions) {
    for (const t of s.turns) {
      const words = t.userPrompt.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3);
      const seen = new Set();
      for (let i = 0; i <= words.length - 3; i++) {
        const ngram = words.slice(i, i + 3).join(" ");
        if (seen.has(ngram)) continue;
        seen.add(ngram);
        if (!ngramSessions[ngram]) ngramSessions[ngram] = new Set();
        ngramSessions[ngram].add(s.id);
        if (!ngramExamples[ngram]) ngramExamples[ngram] = truncate(t.userPrompt, 100);
      }
    }
  }

  // Filter to n-grams appearing in 2+ sessions
  const repeatedNgrams = Object.entries(ngramSessions)
    .filter(([, sids]) => sids.size >= 2)
    .map(([ngram, sids]) => ({ ngram, sessions: sids.size, example: ngramExamples[ngram] }))
    .sort((a, b) => b.sessions - a.sessions);

  // 2. Common tool sequences
  const sequences = {};
  for (const s of sessions) {
    for (const t of s.turns) {
      if (t.toolCalls.length < 2) continue;
      const seq = t.toolCalls.map((tc) => tc.name).join(" → ");
      sequences[seq] = (sequences[seq] || 0) + 1;
    }
  }
  const commonSeqs = Object.entries(sequences).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);

  // 3. Correction themes — what topics trigger corrections?
  const correctionWords = {};
  for (const s of sessions) {
    for (const c of s.corrections) {
      const words = c.text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 3);
      for (const w of words) correctionWords[w] = (correctionWords[w] || 0) + 1;
    }
  }
  const topCorrWords = Object.entries(correctionWords).sort((a, b) => b[1] - a[1]).slice(0, 20);

  if (args.json) {
    console.log(JSON.stringify({
      repeatedPhrases: repeatedNgrams.slice(0, 30),
      commonToolSequences: commonSeqs.slice(0, 15),
      correctionKeywords: topCorrWords,
    }, null, 2));
    return;
  }

  console.log(bold(`\n== Patterns across ${sessions.length} sessions ==\n`));

  // Repeated phrases
  if (repeatedNgrams.length > 0) {
    console.log(bold("### Repeated phrases (appearing in 2+ sessions)"));
    const limited = repeatedNgrams.slice(0, 15);
    for (const r of limited) {
      console.log(`  ${cyan(padRight(`${r.sessions} sessions`, 12))} "${r.ngram}" ${dim(`— ${r.example}`)}`);
    }
    console.log("");
  }

  // Tool sequences
  if (commonSeqs.length > 0) {
    console.log(bold("### Common tool sequences (3+ occurrences)"));
    for (const [seq, count] of commonSeqs.slice(0, 10)) {
      console.log(`  ${padRight(String(count) + "x", 5)} ${seq}`);
    }
    console.log("");
  }

  // Correction keywords
  if (topCorrWords.length > 0) {
    console.log(bold("### Top words in corrections"));
    console.log(`  ${dim(topCorrWords.map(([w, c]) => `${w}(${c})`).join(", "))}`);
    console.log("");
  }
}

// ── Command: init-wiki ──────────────────────────────────────────────
function cmdInitWiki(args) {
  const basePath = args.commandArgs[0] || "docs/agent-wiki";

  const dirs = [
    basePath,
    join(basePath, "sessions"),
    join(basePath, "patterns"),
    join(basePath, "hotspots"),
    join(basePath, "recommendations"),
  ];

  for (const d of dirs) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
      console.log(green(`  Created ${d}/`));
    } else {
      console.log(dim(`  Exists  ${d}/`));
    }
  }

  const files = {
    [join(basePath, "README.md")]: `# Agent Wiki

Auto-generated knowledge base from Claude Code session analysis.

## Structure

- **sessions/** — Per-session analysis pages
- **patterns/** — Cross-session pattern analysis
  - corrections.md — Analysis of user corrections and course-changes
  - recurring-themes.md — Topics and questions that recur across sessions
  - tool-usage.md — Tool usage patterns, failures, and inefficiencies
- **hotspots/** — Files and modules that repeatedly cause issues
- **recommendations/**
  - claude-md.md — Suggested CLAUDE.md improvements based on session patterns
  - refactoring.md — Code areas that would benefit from refactoring

## How to populate

Run the ClaudeSessionAnalyser commands and use the output to fill in these pages:

1. \`node index.js overview\` — get the big picture
2. \`node index.js session <id>\` — drill into specific sessions
3. \`node index.js corrections\` — find patterns in user corrections
4. \`node index.js hotspots\` — identify problematic files
5. \`node index.js patterns\` — find recurring themes
`,
    [join(basePath, "sessions", "_template.md")]: `# Session Analysis: {{session-id}}

## Summary
<!-- 2-3 sentence summary of what this session accomplished -->

## Key Decisions
<!-- Decisions made during this session and their rationale -->

## Corrections & Course-Changes
<!-- User corrections, why they happened, what should change -->

## Files Changed
<!-- Key files modified and why -->

## Lessons Learned
<!-- What should be added to CLAUDE.md or changed in approach -->
`,
    [join(basePath, "patterns", "corrections.md")]: `# Correction Analysis

## Overview
<!-- Summary statistics: total corrections, rate, trend -->

## Common Correction Categories
<!-- Group corrections by type: wrong file, wrong approach, missing context, etc. -->

## Root Causes
<!-- Why these corrections keep happening -->

## Recommended CLAUDE.md Additions
<!-- Specific instructions that would prevent these corrections -->
`,
    [join(basePath, "patterns", "recurring-themes.md")]: `# Recurring Themes

## Topics That Appear Across Sessions
<!-- Themes the user keeps coming back to -->

## Repeated Explanations
<!-- Things the user has to explain more than once -->

## Knowledge Gaps
<!-- Areas where Claude consistently needs guidance -->
`,
    [join(basePath, "patterns", "tool-usage.md")]: `# Tool Usage Patterns

## Tool Distribution
<!-- Which tools are used most, least -->

## Failure Patterns
<!-- Common tool failures and their causes -->

## Inefficiencies
<!-- Patterns that suggest wasted effort (excessive reads, retries) -->
`,
    [join(basePath, "hotspots", "_template.md")]: `# Hotspot: {{file-path}}

## Frequency
<!-- How often this file appears in sessions, in what context -->

## Issues
<!-- Problems associated with this file -->

## Recommendation
<!-- Refactor? Better documentation? Add to CLAUDE.md? -->
`,
    [join(basePath, "recommendations", "claude-md.md")]: `# CLAUDE.md Improvement Suggestions

## Project Conventions
<!-- Conventions the user had to explain repeatedly -->

## File/Directory Guidance
<!-- Key files and what they do, to avoid wrong-file exploration -->

## Common Pitfalls
<!-- Things Claude keeps getting wrong -->

## Workflow Instructions
<!-- Preferred workflows and approaches -->
`,
    [join(basePath, "recommendations", "refactoring.md")]: `# Refactoring Recommendations

## High-Priority
<!-- Files/modules that cause the most friction -->

## Medium-Priority
<!-- Areas that would benefit from cleanup -->

## Low-Priority
<!-- Nice-to-have improvements -->
`,
  };

  for (const [fp, content] of Object.entries(files)) {
    if (!existsSync(fp)) {
      writeFileSync(fp, content, "utf8");
      console.log(green(`  Created ${fp}`));
    } else {
      console.log(dim(`  Exists  ${fp}`));
    }
  }

  console.log(bold("\nWiki scaffolded. Use analyse-sessions commands to populate it."));
}

// ── Help ────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${bold("claude-session-analyser")} — Compress session logs for agent-driven analysis

${bold("USAGE")}
  node index.js <command> [options]

${bold("COMMANDS")}
  ${cyan("overview")}              Project-wide session summary
  ${cyan("sessions")}              List sessions (alias for overview)
  ${cyan("session <id>")}          Compressed single-session narrative (prefix match)
  ${cyan("corrections")}           All user corrections across sessions
  ${cyan("errors")}                Tool failures and API errors
  ${cyan("hotspots")}              Files appearing most in problem contexts
  ${cyan("patterns")}              Repeated phrases, tool sequences, themes
  ${cyan("init-wiki [path]")}      Scaffold docs/agent-wiki directory
  ${cyan("list_projects")}         List available projects

${bold("OPTIONS")}
  ${cyan("-p, --project <name>")}  Target project (substring match, default: cwd)
  ${cyan("-s, --since <date>")}    Only sessions after this date
  ${cyan("-b, --before <date>")}   Only sessions before this date
  ${cyan("-n, --limit <n>")}       Max results (default: 30)
  ${cyan("--json")}                Machine-readable JSON output
  ${cyan("-h, --help")}            Show this help

${bold("EXAMPLES")}
  node index.js overview
  node index.js session 78b880d3
  node index.js corrections --since "last week"
  node index.js hotspots --project MatterAI
  node index.js patterns --json
  node index.js init-wiki docs/agent-wiki
`);
}

// ── Main ────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { printHelp(); process.exit(0); }
  if (args.listProjects) {
    const projects = listProjects();
    if (projects.length === 0) { console.log(yellow("No session logs found.")); process.exit(0); }
    console.log(bold("\nAvailable projects:\n"));
    for (const p of projects) {
      const idx = p.hasIndex ? green(" [indexed]") : "";
      console.log(`  ${cyan(p.friendlyName)}  ${dim(`(${p.sessions} sessions, ${p.sizeMB} MB)`)}${idx}`);
      console.log(`    ${dim("dir: " + p.dirName)}`);
    }
    console.log("");
    process.exit(0);
  }

  const commands = {
    overview: cmdOverview,
    sessions: cmdSessions,
    session: cmdSessionDetail,
    corrections: cmdCorrections,
    errors: cmdErrors,
    hotspots: cmdHotspots,
    patterns: cmdPatterns,
    "init-wiki": cmdInitWiki,
  };

  if (!args.command) {
    console.error(red("No command specified."));
    console.error(dim("  Run with --help for usage."));
    process.exit(1);
  }

  // Handle init-wiki with hyphen
  let cmd = args.command;
  if (cmd === "init" && args.commandArgs[0] === "wiki") {
    cmd = "init-wiki";
    args.commandArgs.shift();
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(red(`Unknown command: "${cmd}"`));
    console.error(dim("  Available: " + Object.keys(commands).join(", ")));
    process.exit(1);
  }

  handler(args);
}

main();
