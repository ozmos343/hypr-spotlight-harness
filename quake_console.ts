import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { queryGemini, type FinalActionPayload } from "./agent";
import { executeAction, runInteractiveWizard } from "./executor";
import { getApiKey, setModel, getCurrentModel, SUPPORTED_MODELS } from "./config";
import { loadRollingBuffer, saveTurn, clearRollingBuffer, searchPersistentHistory, type HistoryTurn } from "./history";

const C_RESET = "\x1b[0m";
const C_BOLD = "\x1b[1m";
const C_CYAN = "\x1b[1;36m";
const C_GREEN = "\x1b[1;32m";
const C_YELLOW = "\x1b[1;33m";
const C_MAGENTA = "\x1b[1;35m";
const C_DIM = "\x1b[2m";
const C_RED = "\x1b[1;31m";

const COMMANDS = [
  { cmd: "/history", desc: "View persistent command audit log" },
  { cmd: "/model",   desc: "Switch or view active Gemini model" },
  { cmd: "/clear",   desc: "Reset current rolling conversation buffer" },
  { cmd: "/status",  desc: "Display system stats (uptime, mem, load)" },
  { cmd: "/help",    desc: "Display command help" },
  { cmd: "/exit",    desc: "Close the console window" },
  { cmd: "/reset",   desc: "Reset current session context" },
];

function completer(line: string): [string[], string] {
  // 1. Slash commands autocomplete
  if (line.startsWith("/")) {
    const hits = COMMANDS.map((c) => c.cmd).filter((c) => c.startsWith(line));
    return [hits.length ? hits : COMMANDS.map((c) => c.cmd), line];
  }

  // 2. @ File Autocomplete
  const atMatch = line.match(/(^|.*?\s)@([^\s]*)$/);
  if (atMatch) {
    const prefix = atMatch[2];
    const baseDir = prefix.startsWith("/")
      ? path.dirname(prefix)
      : path.join(process.cwd(), path.dirname(prefix));
    const searchBase = path.basename(prefix);

    try {
      if (fs.existsSync(baseDir)) {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        const matches: string[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(searchBase) || !searchBase) {
            const relPath = prefix.includes("/")
              ? path.join(path.dirname(prefix), entry.name)
              : entry.name;
            matches.push(`@${relPath}${entry.isDirectory() ? "/" : ""}`);
          }
        }
        if (matches.length > 0) {
          return [matches, `@${prefix}`];
        }
      }
    } catch {}
  }

  return [[], line];
}

function resolveAtFileReferences(input: string): string {
  return input.replace(/@([a-zA-Z0-9_\-\.\/~]+)/g, (match, filePath) => {
    const resolvedPath = filePath.startsWith("~")
      ? path.join(process.env.HOME || "", filePath.slice(1))
      : path.resolve(process.cwd(), filePath);

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      try {
        const stats = fs.statSync(resolvedPath);
        if (stats.size > 200 * 1024) {
          return `\n[Referenced File @${filePath}: file size too large (${(stats.size / 1024).toFixed(1)} KB)]\n`;
        }
        const content = fs.readFileSync(resolvedPath, "utf-8");
        return `\n--- START OF FILE: @${filePath} ---\n${content}\n--- END OF FILE: @${filePath} ---\n`;
      } catch (err: any) {
        return `[Error reading file @${filePath}: ${err.message}]`;
      }
    }
    return match;
  });
}

function runInteractiveMenu(title: string, items: Array<{ id: string; desc: string }>): string | null {
  const formatted = items.map((i) => `${i.id} - ${i.desc}`).join("\n");
  const tmpIn = `/tmp/quake_menu_${Date.now()}_in.txt`;
  const tmpOut = `/tmp/quake_menu_${Date.now()}_out.txt`;
  fs.writeFileSync(tmpIn, formatted, "utf-8");

  try {
    const proc = Bun.spawnSync([
      "fzf",
      "--height=40%",
      "--reverse",
      `--header=${title}`,
      "--prompt=Select > "
    ], {
      stdin: fs.openSync(tmpIn, "r"),
      stdout: "pipe",
      stderr: "inherit"
    });

    const chosen = proc.stdout.toString().trim();
    if (chosen) {
      return chosen.split(" - ")[0].trim();
    }
  } catch {} finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
  return null;
}

function renderHeader() {
  const currentModel = getCurrentModel();
  console.log(`${C_CYAN}┌─────────────────────────────────────────────────────────────┐${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_BOLD}HYPR-OPERATOR :: QUAKE SLIDE-IN CONSOLE${C_RESET}                   ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_DIM}Continuous multi-turn harness [Model: ${C_YELLOW}${currentModel}${C_DIM}]${C_RESET}     ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_YELLOW}Tab completion:${C_RESET} Type '/' for commands, '@' for file refs   ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}└─────────────────────────────────────────────────────────────┘${C_RESET}\n`);
}

function renderRecentHistory(history: HistoryTurn[]) {
  if (history.length === 0) {
    console.log(`${C_DIM}No recent history in current session. Type a request or command below.${C_RESET}\n`);
    return;
  }
  console.log(`${C_DIM}── Recent Session Context ───────────────────────────────────${C_RESET}`);
  for (const turn of history.slice(-4)) {
    const timeStr = new Date(turn.timestamp).toLocaleTimeString();
    console.log(`${C_DIM}[${timeStr}]${C_RESET} ${C_BOLD}You:${C_RESET} ${turn.user}`);
    if (turn.outputSummary) {
      console.log(`${turn.outputSummary}`);
    } else if (turn.action.action === "answer") {
      console.log(`${C_CYAN}Operator:${C_RESET} ${turn.action.summary.split("\n")[0].slice(0, 90)}...`);
    } else if (turn.action.action === "exec_shell") {
      console.log(`${C_GREEN}Exec:${C_RESET} \`${turn.action.command}\` ${C_DIM}(${turn.action.rationale})${C_RESET}`);
    } else if (turn.action.action === "spawn_widget") {
      console.log(`${C_MAGENTA}Widget:${C_RESET} ${turn.action.title || "Window"} -> \`${turn.action.command}\``);
    }
    console.log("");
  }
  console.log(`${C_DIM}─────────────────────────────────────────────────────────────${C_RESET}\n`);
}

async function main() {
  renderHeader();
  const sessionHistory: HistoryTurn[] = loadRollingBuffer();
  renderRecentHistory(sessionHistory);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer,
    terminal: true,
    prompt: `${C_GREEN}operator❯${C_RESET} `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    let raw = line.trim();
    if (!raw) {
      rl.prompt();
      return;
    }

    if (raw === "/exit" || raw === "/quit") {
      console.log(`${C_DIM}Closing console...${C_RESET}`);
      process.exit(0);
    }

    if (raw === "/clear" || raw === "/reset") {
      clearRollingBuffer();
      sessionHistory.length = 0;
      console.clear();
      renderHeader();
      console.log(`${C_YELLOW}Session history reset.${C_RESET}\n`);
      rl.prompt();
      return;
    }

    if (raw === "/history") {
      const results = searchPersistentHistory("", 10);
      console.log(`\n${C_CYAN}=== Persistent History (Last 10) ===${C_RESET}`);
      for (const r of results) {
        const d = new Date(r.timestamp).toLocaleTimeString();
        console.log(`• ${C_DIM}[${d}]${C_RESET} ${C_BOLD}${r.user}${C_RESET} -> ${r.action.action === "exec_shell" ? r.action.command : r.action.action}`);
      }
      console.log("");
      rl.prompt();
      return;
    }

    if (raw === "/model" || raw.startsWith("/model ")) {
      const target = raw.replace(/^\/model\s*/, "").trim();
      if (target) {
        setModel(target);
        console.log(`\n${C_GREEN}✓ Active model updated to: ${C_BOLD}${target}${C_RESET}\n`);
      } else {
        const choice = runInteractiveMenu(
          "Select Gemini Model (ESC to cancel)",
          SUPPORTED_MODELS.map((m) => ({ id: m.id, desc: m.name }))
        );
        if (choice) {
          setModel(choice);
          console.log(`\n${C_GREEN}✓ Active model updated to: ${C_BOLD}${choice}${C_RESET}\n`);
        }
      }
      rl.prompt();
      return;
    }

    if (raw === "/help") {
      console.log(`\n${C_BOLD}Quake Operator Slash Commands:${C_RESET}`);
      for (const c of COMMANDS) {
        console.log(`  ${C_YELLOW}${c.cmd.padEnd(12)}${C_RESET} - ${c.desc}`);
      }
      console.log(`\n${C_BOLD}Features & Shortcuts:${C_RESET}`);
      console.log(`  ${C_YELLOW}/<cmd>${C_RESET}     - Press Tab on / to autocomplete slash commands`);
      console.log(`  ${C_YELLOW}@<file>${C_RESET}    - Press Tab on @ to autocomplete files & inject their contents`);
      console.log(`  ${C_YELLOW}/model${C_RESET}     - Interactive menu to switch Gemini models on the fly\n`);
      rl.prompt();
      return;
    }

    if (raw === "/status") {
      const uptime = Bun.spawnSync(["uptime", "-p"]).stdout.toString().trim();
      const freeMem = Bun.spawnSync(["bash", "-c", "free -h | awk '/Mem:/ {print $3 \" / \" $2}'"]).stdout.toString().trim();
      const currentModel = getCurrentModel();
      console.log(`\n${C_CYAN}Status:${C_RESET} ${uptime} | ${C_GREEN}Mem:${C_RESET} ${freeMem} | ${C_MAGENTA}Model:${C_RESET} ${currentModel}\n`);
      rl.prompt();
      return;
    }

    // Intercept @ file references and inject contents into prompt
    const expandedQuery = resolveAtFileReferences(raw);

    // Reload shared buffer so commands run in Spotlight (SUPER + SPACE) immediately sync here
    const currentBuffer = loadRollingBuffer();
    const activeHistory = currentBuffer.length > 0 ? currentBuffer : sessionHistory;

    process.stdout.write(`${C_DIM}thinking & planning...${C_RESET}\r`);

    try {
      const apiKey = getApiKey();
      let currentQuery = expandedQuery;

      for (let attempt = 0; attempt < 3; attempt++) {
        const action = await queryGemini(currentQuery, apiKey, activeHistory);

        // Wizard Interaction
        if (action.action === "prompt_wizard") {
          const userChoice = runInteractiveWizard(action.title, action.prompt, action.options, action.ui_type || "gui_yad");
          if (!userChoice) {
            console.log(`\n${C_YELLOW}Action cancelled.${C_RESET}\n`);
            break;
          }

          activeHistory.push({
            timestamp: Date.now(),
            user: raw,
            action,
          });

          currentQuery = `User chose option: "${userChoice}". Context: ${action.context}. Continue workflow accordingly.`;
          continue;
        }

        console.log(`\r${C_RESET}${" ".repeat(30)}\r`);

        if (action.action === "answer") {
          console.log(`${C_CYAN}✦ Operator:${C_RESET}`);
          console.log(`${action.summary}\n`);

          saveTurn({
            timestamp: Date.now(),
            user: raw,
            action,
          });
          activeHistory.push({
            timestamp: Date.now(),
            user: raw,
            action,
          });
          break;
        }

        if (action.action === "exec_shell") {
          console.log(`${C_GREEN}▶ Action: ${action.rationale}${C_RESET}`);
          console.log(`${C_DIM}$ ${action.command}${C_RESET}`);

          if (action.safety === "destructive" || action.display?.mode === "gui_dialog") {
            await executeAction(action);
            saveTurn({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: `Executed via executor (${action.display?.mode || action.safety})`,
            });
            activeHistory.push({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: `Executed via executor (${action.display?.mode || action.safety})`,
            });
            break;
          }

          const proc = Bun.spawnSync(["bash", "-c", action.command]);
          const out = proc.stdout.toString().trim();
          const err = proc.stderr.toString().trim();

          if (proc.exitCode !== 0) {
            console.log(`${C_RED}${err || `Process exited with code ${proc.exitCode}`}${C_RESET}`);
            console.log(`${C_YELLOW}↻ Error detected. Feeding back to operator for self-correction...${C_RESET}`);

            const executionOutput = `Command failed [Exit ${proc.exitCode}]:\nCommand: ${action.command}\nStderr:\n${err}\nStdout:\n${out}`;

            saveTurn({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: executionOutput,
            });

            activeHistory.push({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: executionOutput,
            });

            currentQuery = `The previous command failed with error:\n${err || out}\nPlease diagnose the issue, fix the syntax/command, and execute the corrected version.`;
            continue;
          }

          const lineCount = out ? out.split("\n").length : 0;
          const isExcessivelyLong = lineCount > 25 || out.length > 2500;

          if (isExcessivelyLong && action.display?.mode === "floating_card") {
            console.log(`${C_DIM}(Output is ${lineCount} lines; opened in floating viewer window)${C_RESET}\n`);
            await executeAction(action);
          } else {
            if (out) {
              console.log(`${out}\n`);
            } else {
              console.log(`${C_DIM}(Command completed with no output)${C_RESET}\n`);
            }
          }

          saveTurn({
            timestamp: Date.now(),
            user: raw,
            action,
            outputSummary: out ? `Success: ${out.slice(0, 150)}` : "Success",
          });
          activeHistory.push({
            timestamp: Date.now(),
            user: raw,
            action,
            outputSummary: out ? `Success: ${out.slice(0, 150)}` : "Success",
          });
          break;
        }

        if (action.action === "spawn_widget") {
          console.log(`${C_MAGENTA}✦ Launching widget: ${action.title || action.command}${C_RESET}\n`);
          saveTurn({
            timestamp: Date.now(),
            user: raw,
            action,
          });
          activeHistory.push({
            timestamp: Date.now(),
            user: raw,
            action,
          });
          await executeAction(action);
          break;
        }

        break;
      }
    } catch (err: any) {
      console.log(`\r${C_RED}Error: ${err.message || err}${C_RESET}\n`);
    }

    rl.prompt();
  });
}

main();
