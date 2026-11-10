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
const C_BG_SELECT = "\x1b[48;5;238m\x1b[1;36m";

const COMMANDS = [
  { cmd: "/history", desc: "View persistent command audit log" },
  { cmd: "/model",   desc: "Switch or view active Gemini model" },
  { cmd: "/clear",   desc: "Reset current rolling conversation buffer" },
  { cmd: "/status",  desc: "Display system stats (uptime, mem, load)" },
  { cmd: "/help",    desc: "Display command help" },
  { cmd: "/exit",    desc: "Close the console window" },
  { cmd: "/reset",   desc: "Reset current session context" },
];

function getFileMatches(prefix: string): Array<{ text: string; desc: string }> {
  let searchDir = process.cwd();
  let searchBase = prefix;

  if (prefix.startsWith("~")) {
    const full = path.join(process.env.HOME || "", prefix.slice(1));
    searchDir = prefix.includes("/") ? path.dirname(full) : (process.env.HOME || "");
    searchBase = path.basename(prefix);
  } else if (prefix.startsWith("/")) {
    searchDir = path.dirname(prefix);
    searchBase = path.basename(prefix);
  } else if (prefix.includes("/")) {
    searchDir = path.resolve(process.cwd(), path.dirname(prefix));
    searchBase = path.basename(prefix);
  }

  const results: Array<{ text: string; desc: string }> = [];
  try {
    if (fs.existsSync(searchDir)) {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const e of entries) {
        if (!searchBase || e.name.toLowerCase().startsWith(searchBase.toLowerCase())) {
          const isDir = e.isDirectory();
          let completionText = e.name;
          if (prefix.includes("/")) {
            completionText = path.join(path.dirname(prefix), e.name);
          }
          if (isDir) completionText += "/";
          results.push({
            text: `@${completionText}`,
            desc: isDir ? "directory" : "file",
          });
          if (results.length >= 8) break;
        }
      }
    }
  } catch {}
  return results;
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

function renderHeader() {
  const currentModel = getCurrentModel();
  console.log(`${C_CYAN}┌─────────────────────────────────────────────────────────────┐${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_BOLD}HYPR-OPERATOR :: QUAKE SLIDE-IN CONSOLE${C_RESET}                   ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_DIM}Continuous multi-turn harness [Model: ${C_YELLOW}${currentModel}${C_DIM}]${C_RESET}     ${C_CYAN}│${C_RESET}`);
  console.log(`${C_CYAN}│${C_RESET} ${C_YELLOW}Inline Autocomplete:${C_RESET} Type '/' or '@' for instant popup menu  ${C_CYAN}│${C_RESET}`);
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

/**
 * Interactive Input Prompt with Live Pop-Up Autocomplete for / and @
 */
async function promptLine(promptStr: string): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    let cursorPos = 0;
    let selectedMenuIndex = 0;
    let renderedPopupLines = 0;
    const historyIndex = -1;

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const getPopupCandidates = (): { items: Array<{ text: string; desc: string }>; replaceStart: number } | null => {
      // 1. Check if line starts with '/'
      if (input.startsWith("/")) {
        const query = input.slice(0, cursorPos);
        const hits = COMMANDS.filter((c) => c.cmd.startsWith(query)).map((c) => ({
          text: c.cmd,
          desc: c.desc,
        }));
        if (hits.length > 0) {
          return { items: hits, replaceStart: 0 };
        }
      }

      // 2. Check for '@' symbol under or before cursor
      const beforeCursor = input.slice(0, cursorPos);
      const atMatch = beforeCursor.match(/(^|\s)@([^\s]*)$/);
      if (atMatch) {
        const atPrefix = atMatch[2];
        const matchIndex = beforeCursor.lastIndexOf("@");
        const matches = getFileMatches(atPrefix);
        if (matches.length > 0) {
          return { items: matches, replaceStart: matchIndex };
        }
      }

      return null;
    };

    const redraw = () => {
      // Clear previously rendered popup lines
      if (renderedPopupLines > 0) {
        for (let i = 0; i < renderedPopupLines; i++) {
          process.stdout.write("\x1b[1B\x1b[2K"); // Move down 1 and clear line
        }
        process.stdout.write(`\x1b[${renderedPopupLines}A`); // Move back up
        renderedPopupLines = 0;
      }

      // Move to beginning of input line and render prompt + text
      process.stdout.write("\r\x1b[2K" + promptStr + input);

      // Check popup suggestions
      const popup = getPopupCandidates();
      if (popup && popup.items.length > 0) {
        if (selectedMenuIndex >= popup.items.length) {
          selectedMenuIndex = popup.items.length - 1;
        }
        if (selectedMenuIndex < 0) selectedMenuIndex = 0;

        renderedPopupLines = Math.min(popup.items.length, 6) + 1;

        // Draw dropdown box
        process.stdout.write("\n\x1b[2K" + `${C_DIM}┌─ Suggestions (Tab/Enter to apply, ↑/↓ to navigate) ─┐${C_RESET}`);
        for (let i = 0; i < Math.min(popup.items.length, 6); i++) {
          const item = popup.items[i];
          const isSelected = i === selectedMenuIndex;
          const prefix = isSelected ? `${C_BG_SELECT} › ` : "   ";
          const suffix = isSelected ? `${C_RESET}` : "";
          const textPart = item.text.padEnd(20);
          process.stdout.write(`\n\x1b[2K${prefix}${textPart} ${C_DIM}${item.desc}${suffix}`);
        }

        // Return cursor to input position
        process.stdout.write(`\x1b[${renderedPopupLines}A`);
      }

      // Position physical terminal cursor
      const targetCol = promptStr.replace(/\x1b\[[0-9;]*m/g, "").length + cursorPos + 1;
      process.stdout.write(`\r\x1b[${targetCol - 1}C`);
    };

    const cleanup = () => {
      if (renderedPopupLines > 0) {
        for (let i = 0; i < renderedPopupLines; i++) {
          process.stdout.write("\x1b[1B\x1b[2K");
        }
        process.stdout.write(`\x1b[${renderedPopupLines}A`);
        renderedPopupLines = 0;
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
    };

    redraw();

    process.stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString();

      // Ctrl + C / Ctrl + D -> Exit
      if (key === "\u0003" || key === "\u0004") {
        cleanup();
        process.stdout.write("\n");
        process.exit(0);
      }

      // Enter key
      if (key === "\r" || key === "\n") {
        const popup = getPopupCandidates();
        // If popup is active and user presses Enter on a slash command or file, complete it first
        if (popup && popup.items.length > 0 && selectedMenuIndex >= 0) {
          const item = popup.items[selectedMenuIndex];
          input = input.slice(0, popup.replaceStart) + item.text + (item.text.endsWith("/") ? "" : " ");
          cursorPos = input.length;
          selectedMenuIndex = 0;
          redraw();
          return;
        }

        cleanup();
        process.stdout.write("\n");
        resolve(input);
        return;
      }

      // Tab key -> autocomplete selected item
      if (key === "\t") {
        const popup = getPopupCandidates();
        if (popup && popup.items.length > 0) {
          const item = popup.items[selectedMenuIndex];
          input = input.slice(0, popup.replaceStart) + item.text + (item.text.endsWith("/") ? "" : " ");
          cursorPos = input.length;
          selectedMenuIndex = 0;
          redraw();
          return;
        }
      }

      // Arrow Up -> Navigate popup or history
      if (key === "\x1b[A") {
        const popup = getPopupCandidates();
        if (popup && popup.items.length > 0) {
          selectedMenuIndex = (selectedMenuIndex - 1 + popup.items.length) % popup.items.length;
          redraw();
          return;
        }
      }

      // Arrow Down -> Navigate popup
      if (key === "\x1b[B") {
        const popup = getPopupCandidates();
        if (popup && popup.items.length > 0) {
          selectedMenuIndex = (selectedMenuIndex + 1) % popup.items.length;
          redraw();
          return;
        }
      }

      // Arrow Left
      if (key === "\x1b[D") {
        if (cursorPos > 0) cursorPos--;
        redraw();
        return;
      }

      // Arrow Right
      if (key === "\x1b[C") {
        if (cursorPos < input.length) cursorPos++;
        redraw();
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (cursorPos > 0) {
          input = input.slice(0, cursorPos - 1) + input.slice(cursorPos);
          cursorPos--;
          selectedMenuIndex = 0;
        }
        redraw();
        return;
      }

      // Escape -> close popup
      if (key === "\x1b") {
        selectedMenuIndex = -1;
        redraw();
        return;
      }

      // Regular characters
      if (key.length === 1 && key >= " ") {
        input = input.slice(0, cursorPos) + key + input.slice(cursorPos);
        cursorPos++;
        selectedMenuIndex = 0;
        redraw();
        return;
      }
    });
  });
}

async function main() {
  renderHeader();
  const sessionHistory: HistoryTurn[] = loadRollingBuffer();
  renderRecentHistory(sessionHistory);

  while (true) {
    const promptStr = `${C_GREEN}operator❯${C_RESET} `;
    const raw = (await promptLine(promptStr)).trim();

    if (!raw) continue;

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
      continue;
    }

    if (raw === "/history") {
      const results = searchPersistentHistory("", 10);
      console.log(`\n${C_CYAN}=== Persistent History (Last 10) ===${C_RESET}`);
      for (const r of results) {
        const d = new Date(r.timestamp).toLocaleTimeString();
        console.log(`• ${C_DIM}[${d}]${C_RESET} ${C_BOLD}${r.user}${C_RESET} -> ${r.action.action === "exec_shell" ? r.action.command : r.action.action}`);
      }
      console.log("");
      continue;
    }

    if (raw === "/model" || raw.startsWith("/model ")) {
      const target = raw.replace(/^\/model\s*/, "").trim();
      if (target) {
        setModel(target);
        console.log(`\n${C_GREEN}✓ Active model updated to: ${C_BOLD}${target}${C_RESET}\n`);
      } else {
        const options = SUPPORTED_MODELS.map((m) => `${m.id} - ${m.name}`);
        const choice = runInteractiveWizard(
          "Select Gemini Model",
          "Choose model to power operator:",
          options,
          "tui_kitty"
        );
        if (choice) {
          const selectedId = choice.split(" - ")[0].trim();
          setModel(selectedId);
          console.log(`\n${C_GREEN}✓ Active model updated to: ${C_BOLD}${selectedId}${C_RESET}\n`);
        }
      }
      continue;
    }

    if (raw === "/help") {
      console.log(`\n${C_BOLD}Quake Operator Slash Commands:${C_RESET}`);
      for (const c of COMMANDS) {
        console.log(`  ${C_YELLOW}${c.cmd.padEnd(12)}${C_RESET} - ${c.desc}`);
      }
      console.log(`\n${C_BOLD}Interactive Features:${C_RESET}`);
      console.log(`  ${C_YELLOW}/<cmd>${C_RESET}     - Pop-up autocomplete menu appears as you type /`);
      console.log(`  ${C_YELLOW}@<file>${C_RESET}    - Pop-up file autocomplete appears as you type @`);
      console.log(`  ${C_YELLOW}↑ / ↓${C_RESET}      - Navigate pop-up suggestions`);
      console.log(`  ${C_YELLOW}Tab / Enter${C_RESET}- Autocomplete selected suggestion into input\n`);
      continue;
    }

    if (raw === "/status") {
      const uptime = Bun.spawnSync(["uptime", "-p"]).stdout.toString().trim();
      const freeMem = Bun.spawnSync(["bash", "-c", "free -h | awk '/Mem:/ {print $3 \" / \" $2}'"]).stdout.toString().trim();
      const currentModel = getCurrentModel();
      console.log(`\n${C_CYAN}Status:${C_RESET} ${uptime} | ${C_GREEN}Mem:${C_RESET} ${freeMem} | ${C_MAGENTA}Model:${C_RESET} ${currentModel}\n`);
      continue;
    }

    // Intercept @ file references and inject file contents into payload
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
  }
}

main();
