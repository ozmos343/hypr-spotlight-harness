import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { FinalActionPayload } from "./agent";

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")  // Bold
    .replace(/\*(.*?)\*/g, "$1")      // Italic
    .replace(/__(.*?)__/g, "$1")      // Underline
    .replace(/`(.*?)`/g, "$1")        // Inline code
    .replace(/```[\s\S]*?```/g, "")   // Code blocks
    .replace(/^#+\s+/gm, "")          // Headers
    .replace(/^[\*\-\+]\s+/gm, "• ")  // Bullet points
    .replace(/^\d+\.\s+/gm, "")       // Numbered lists
    .trim();
}

function notify(title: string, message: string, urgency: "low" | "normal" | "critical" = "normal") {
  const cleanMsg = stripMarkdown(message);
  spawn("notify-send", ["-a", "spotlight", "-u", urgency, title, cleanMsg], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function runInteractiveInKitty(title: string, cmd: string, isInspector = false) {
  const script = isInspector
    ? `
      printf "\\033]2;${title}\\007"
      echo -e "\\033[1;36m▶ ${title}\\033[0m"
      echo -e "\\033[1;30m--------------------------------------------------\\033[0m"
      ${cmd}
      echo ""
      echo -e "\\033[1;30m--------------------------------------------------\\033[0m"
      read -n 1 -s -r -p "Press any key to close..."
    `
    : `
      printf "\\033]2;${title}\\007"
      ${cmd}
      printf "\\n\\033[1;30mPress Enter to close...\\033[0m"
      read -r
    `;

  const proc = spawn(
    "kitty",
    ["--class", "hypr-harness-floating", "--title", title, "bash", "-c", script],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  proc.unref();
}

function displayCardInKitty(title: string, content: string) {
  const formatted = content
    .replace(/\*\*(.*?)\*\*/g, "\x1b[1;37m$1\x1b[0m")       // Bold bright
    .replace(/`([^`]+)`/g, "\x1b[1;33m$1\x1b[0m")          // Yellow code
    .replace(/^#+\s+(.*)$/gm, "\x1b[1;36m$1\x1b[0m")       // Cyan headers
    .replace(/^(\s*[\*\-\+]\s+)/gm, "\x1b[1;35m• \x1b[0m"); // Purple bullets

  const tmpFile = `/tmp/spotlight_card_${Date.now()}.txt`;
  fs.writeFileSync(tmpFile, formatted, "utf-8");

  const script = `
    printf "\\033]2;${title}\\007"
    echo -e "\\033[1;36m✦ ${title}\\033[0m"
    echo -e "\\033[1;30m──────────────────────────────────────────────────\\033[0m"
    echo ""
    cat "${tmpFile}"
    echo ""
    echo -e "\\033[1;30m──────────────────────────────────────────────────\\033[0m"
    rm -f "${tmpFile}"
    read -n 1 -s -r -p "Press any key to close..."
  `;

  const proc = spawn(
    "kitty",
    ["--class", "hypr-harness-floating", "--title", title, "bash", "-c", script],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  proc.unref();
}

export function runInteractiveWizard(
  title: string,
  prompt: string,
  options: string[],
  uiType: "gui_yad" | "tui_kitty" = "gui_yad"
): string | null {
  // If yad is installed and requested (or defaulted), use native GTK list dialog
  if (uiType === "gui_yad") {
    try {
      const yadArgs = [
        "--title=" + title,
        "--text=" + prompt,
        "--list",
        "--column=Option",
        "--width=560",
        "--height=360",
        "--center",
        "--class=hypr-harness-floating",
        "--button=Cancel:1",
        "--button=Select:0",
        ...options,
      ];
      const res = spawnSync("yad", yadArgs, { encoding: "utf-8" });
      if (res.status === 0 && res.stdout) {
        // yad returns "selection|"
        const clean = res.stdout.replace(/\|.*$/, "").trim();
        if (clean) return clean;
      }
      return null;
    } catch {}
  }

  // TUI Kitty fallback with fzf
  const tmpChoiceFile = `/tmp/spotlight_wizard_${Date.now()}_choice.txt`;
  const optionsText = options.join("\n");
  const tmpOptsFile = `/tmp/spotlight_wizard_${Date.now()}_opts.txt`;
  fs.writeFileSync(tmpOptsFile, optionsText, "utf-8");

  const script = `
    printf "\\033]2;${title}\\007"
    echo -e "\\033[1;36m🔮 ${title}\\033[0m"
    echo -e "\\033[1;37m${prompt}\\033[0m"
    echo -e "\\033[1;30m──────────────────────────────────────────────────\\033[0m"
    CHOICE=$(fzf --height 100% --reverse --header="Use arrow keys to select, Enter to confirm, ESC to cancel" < "${tmpOptsFile}")
    echo "$CHOICE" > "${tmpChoiceFile}"
    rm -f "${tmpOptsFile}"
  `;

  spawnSync(
    "kitty",
    ["--class", "hypr-harness-floating", "--title", title, "bash", "-c", script],
    { stdio: "inherit" }
  );

  let selected: string | null = null;
  if (fs.existsSync(tmpChoiceFile)) {
    const raw = fs.readFileSync(tmpChoiceFile, "utf-8").trim();
    fs.unlinkSync(tmpChoiceFile);
    if (raw) selected = raw;
  }
  return selected;
}

export async function executeAction(action: FinalActionPayload): Promise<void> {
  switch (action.action) {
    case "answer": {
      const text = action.summary.trim();
      const lineCount = text.split("\n").length;
      if (text.length > 200 || lineCount > 3) {
        displayCardInKitty("Spotlight", text);
      } else {
        notify("Spotlight", text);
      }
      break;
    }

    case "exec_shell": {
      if (action.safety === "destructive") {
        // Confirmation dialog: offer native yad confirmation or fallback to terminal
        const confirmScript = `
          if command -v yad &>/dev/null; then
            yad --title="Confirm Action" --text="⚠️  DESTRUCTIVE ACTION REQUESTED\\n\\nRationale: ${action.rationale}\\n\\nCommand:\\n${action.command}" --class=hypr-harness-floating --center --button="Cancel:1" --button="Execute:0"
            if [ $? -eq 0 ]; then
              ${action.command}
            fi
          else
            echo -e "\\033[1;31m⚠️  DESTRUCTIVE ACTION REQUESTED\\033[0m"
            echo "=================================="
            echo "Rationale: ${action.rationale}"
            echo ""
            echo "Command to run:"
            echo "  ${action.command}"
            echo "=================================="
            read -p "Execute this command? [y/N] " yn
            if [[ "$yn" =~ ^[Yy]$ ]]; then
              echo ""
              echo "Running: ${action.command}"
              ${action.command}
            else
              echo "Cancelled."
            fi
          fi
        `;
        runInteractiveInKitty(`Confirm: ${action.rationale}`, confirmScript);
      } else if (action.display === "floating_window") {
        runInteractiveInKitty(action.rationale || "System Inspector", action.command, true);
      } else {
        notify("Spotlight", `Executing: ${action.rationale}`, "low");
        const proc = spawn("bash", ["-c", action.command]);
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("close", (code) => {
          if (code === 0) {
            const outLines = stdout.trim().split("\n");
            if (outLines.length > 3 || stdout.trim().length > 200) {
              runInteractiveInKitty(action.rationale, action.command, true);
            } else {
              const outSnippet = stdout.trim() ? stdout.trim() : "Done";
              notify("Spotlight: Success", `${action.rationale}\n${outSnippet}`);
            }
          } else {
            notify(
              "Spotlight: Error",
              `Exit ${code}: ${stderr.trim() || stdout.trim() || "Failed"}`,
              "critical"
            );
          }
        });
      }
      break;
    }

    case "spawn_widget": {
      const title = action.title || "Spotlight Widget";
      if (action.backend === "dialog_yad") {
        // Native GTK Yad dialog
        const yadProc = spawn("bash", [
          "-c",
          `yad --title="${title}" --text-info --width=680 --height=450 --center --class=hypr-harness-floating <<< "$(${action.command})"`,
        ], { detached: true, stdio: "ignore" });
        yadProc.unref();
      } else {
        runInteractiveInKitty(title, action.command);
      }
      break;
    }

    case "prompt_wizard": {
      break;
    }
  }
}
