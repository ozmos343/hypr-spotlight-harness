import * as readline from "readline";
import { queryGemini, type FinalActionPayload } from "./agent";
import { executeAction, runInteractiveWizard } from "./executor";
import { getApiKey } from "./config";
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
  { cmd: "/clear",   desc: "Reset current rolling conversation buffer" },
  { cmd: "/status",  desc: "Display system stats (uptime, mem, load)" },
  { cmd: "/help",    desc: "Display command help" },
  { cmd: "/exit",    desc: "Close the console window" },
  { cmd: "/reset",   desc: "Reset current session context" },
];

function completer(line: string): [string[], string] {
  if (line.startsWith("/")) {
    const hits = COMMANDS.map((c) => c.cmd).filter((c) => c.startsWith(line));
    return [hits.length ? hits : COMMANDS.map((c) => c.cmd), line];
  }
  return [[], line];
}

function renderHeader() {
  console.log(`${C_CYAN}┌─────────────────────────────────────────────────────────────┐${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_BOLD}HYPR-OPERATOR :: QUAKE SLIDE-IN CONSOLE${C_RESET}                   ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_DIM}Continuous multi-turn system operator harness (Gemini 3.5)  ${C_RESET} ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_YELLOW}Tab completion:${C_RESET} Type '/' and press Tab for slash commands ${C_CYAN}│${C_RESET}`);
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
    const raw = line.trim();
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

    if (raw === "/help") {
      console.log(`\n${C_BOLD}Quake Operator Slash Commands:${C_RESET}`);
      for (const c of COMMANDS) {
        console.log(`  ${C_YELLOW}${c.cmd.padEnd(12)}${C_RESET} - ${c.desc}`);
      }
      console.log(`\n  ${C_DIM}Or enter any natural language instruction (e.g. "show disk usage", "inspect hyprland.lua")${C_RESET}\n`);
      rl.prompt();
      return;
    }

    if (raw === "/status") {
      const uptime = Bun.spawnSync(["uptime", "-p"]).stdout.toString().trim();
      const freeMem = Bun.spawnSync(["bash", "-c", "free -h | awk '/Mem:/ {print $3 \" / \" $2}'"]).stdout.toString().trim();
      console.log(`\n${C_CYAN}System Status:${C_RESET} ${uptime} | ${C_GREEN}Mem Used:${C_RESET} ${freeMem}\n`);
      rl.prompt();
      return;
    }

    // Reload shared buffer so commands run in Spotlight (SUPER + SPACE) immediately sync here
    const currentBuffer = loadRollingBuffer();
    const sessionHistory = currentBuffer.length > 0 ? currentBuffer : loadRollingBuffer();

    process.stdout.write(`${C_DIM}thinking & planning...${C_RESET}\r`);

    try {
      const apiKey = getApiKey();
      let currentQuery = raw;

      // Outer Loop: Auto-Error Correction & Self-Healing (up to 3 repair turns within budget)
      for (let attempt = 0; attempt < 3; attempt++) {
        const action = await queryGemini(currentQuery, apiKey, sessionHistory);

        // Wizard Interaction
        if (action.action === "prompt_wizard") {
          const userChoice = runInteractiveWizard(action.title, action.prompt, action.options, action.ui_type || "gui_yad");
          if (!userChoice) {
            console.log(`\n${C_YELLOW}Action cancelled.${C_RESET}\n`);
            break;
          }

          sessionHistory.push({
            timestamp: Date.now(),
            user: currentQuery,
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
          sessionHistory.push({
            timestamp: Date.now(),
            user: raw,
            action,
          });
          break;
        }

        if (action.action === "exec_shell") {
          console.log(`${C_GREEN}▶ Action: ${action.rationale}${C_RESET}`);
          console.log(`${C_DIM}$ ${action.command}${C_RESET}`);

          // 1. Destructive actions or GUI dialogs (e.g. yad) always go through executor's confirmation / GUI spawner
          if (action.safety === "destructive" || action.display?.mode === "gui_dialog") {
            await executeAction(action);
            saveTurn({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: `Executed via executor (${action.display?.mode || action.safety})`,
            });
            sessionHistory.push({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: `Executed via executor (${action.display?.mode || action.safety})`,
            });
            break;
          }

          // 2. Run in-console first
          const proc = Bun.spawnSync(["bash", "-c", action.command]);
          const out = proc.stdout.toString().trim();
          const err = proc.stderr.toString().trim();

          if (proc.exitCode !== 0) {
            // Error occurred: propagate failure back to Gemini for autonomous self-healing
            console.log(`${C_RED}${err || `Process exited with code ${proc.exitCode}`}${C_RESET}`);
            console.log(`${C_YELLOW}↻ Error detected. Feeding back to operator for self-correction...${C_RESET}`);

            const executionOutput = `Command failed [Exit ${proc.exitCode}]:\nCommand: ${action.command}\nStderr:\n${err}\nStdout:\n${out}`;

            saveTurn({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: executionOutput,
            });

            sessionHistory.push({
              timestamp: Date.now(),
              user: raw,
              action,
              outputSummary: executionOutput,
            });

            // Prompt agent to analyze the error and retry with corrected logic
            currentQuery = `The previous command failed with error:\n${err || out}\nPlease diagnose the issue, fix the syntax/command, and execute the corrected version.`;
            continue;
          }

          // 3. Command succeeded
          const lineCount = out ? out.split("\n").length : 0;
          const isExcessivelyLong = lineCount > 25 || out.length > 2500;

          if (isExcessivelyLong && action.display?.mode === "floating_card") {
            // Output is too large to comfortably view inline in the drop-down; spawn dedicated floating card
            console.log(`${C_DIM}(Output is ${lineCount} lines; opened in floating viewer window)${C_RESET}\n`);
            await executeAction(action);
          } else {
            // Pure text output that comfortably fits in the console: print directly
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
          sessionHistory.push({
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
          sessionHistory.push({
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
