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
  console.clear();
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
    if (turn.action.action === "answer") {
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

    // Builtin Slash Commands
    if (raw === "/exit" || raw === "/quit") {
      console.log(`${C_DIM}Closing console...${C_RESET}`);
      process.exit(0);
    }

    if (raw === "/clear" || raw === "/reset") {
      clearRollingBuffer();
      sessionHistory.length = 0;
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

    // Multi-turn reasoning & execution
    process.stdout.write(`${C_DIM}thinking & inspecting...${C_RESET}\r`);

    try {
      const apiKey = getApiKey();
      let currentQuery = raw;

      while (true) {
        const action = await queryGemini(currentQuery, apiKey, sessionHistory);

        // Handle Wizard Solicitation
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

        // Terminal Action Reached
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

        console.log(`\r${C_RESET}${" ".repeat(30)}\r`);

        if (action.action === "answer") {
          console.log(`${C_CYAN}✦ Operator:${C_RESET}`);
          console.log(`${action.summary}\n`);
        } else if (action.action === "exec_shell") {
          console.log(`${C_GREEN}▶ Action: ${action.rationale}${C_RESET}`);
          console.log(`${C_DIM}$ ${action.command}${C_RESET}`);
          const proc = Bun.spawnSync(["bash", "-c", action.command]);
          const out = proc.stdout.toString().trim();
          const err = proc.stderr.toString().trim();
          if (out) console.log(out);
          if (err) console.log(`${C_RED}${err}${C_RESET}`);
          console.log("");
        } else if (action.action === "spawn_widget") {
          console.log(`${C_MAGENTA}✦ Launching widget: ${action.title || action.command}${C_RESET}\n`);
          await executeAction(action);
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
