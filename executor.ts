import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { FinalActionPayload, DisplayConfig } from "./agent";

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

function isHazardousCommand(cmd: string): { hazardous: boolean; reason?: string } {
  // 1. Detect loops that spawn background processes
  if (/(?:for|while)\b.*\b(?:do|run)\b/i.test(cmd)) {
    const rangeMatch = cmd.match(/\{(\d+)\.\.(\d+)\}/);
    if (rangeMatch) {
      const count = Math.abs(parseInt(rangeMatch[2], 10) - parseInt(rangeMatch[1], 10));
      if (count > 5) {
        return {
          hazardous: true,
          reason: `Excessive loop iteration (${count} runs) detected. Spawning multiple background tasks risks freezing the compositor.`,
        };
      }
    }
    if (/nohup|&\s*done|xargs\s+-P/i.test(cmd)) {
      return {
        hazardous: true,
        reason: "Loop spawning concurrent background processes detected.",
      };
    }
  }

  // 2. Fork bombs and process bombs
  if (/\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i.test(cmd) || /bomb/i.test(cmd)) {
    return { hazardous: true, reason: "Fork bomb pattern detected." };
  }

  // 3. Destructive mass-disk operations
  if (/rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|-rf|-fr)\s+(\/|~|\$HOME|\*)/i.test(cmd)) {
    return { hazardous: true, reason: "Recursive root/home directory deletion detected." };
  }

  return { hazardous: false };
}

function notify(title: string, message: string, timeoutMs = 12000, urgency: "low" | "normal" | "critical" = "normal") {
  const cleanMsg = stripMarkdown(message);
  spawn("notify-send", ["-a", "spotlight", "-t", String(timeoutMs), "-u", urgency, title, cleanMsg], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function runInteractiveInKitty(title: string, cmd: string, display?: DisplayConfig) {
  const width = display?.width || 750;
  const height = display?.height || 480;

  const script = `
    printf "\\033]2;${title}\\007"
    echo -e "\\033[1;36m▶ ${title}\\033[0m"
    echo -e "\\033[1;30m──────────────────────────────────────────────────\\033[0m"
    ${cmd}
    echo ""
    echo -e "\\033[1;30m──────────────────────────────────────────────────\\033[0m"
    read -n 1 -s -r -p "Press any key to close..."
  `;

  const proc = spawn(
    "kitty",
    [
      "--class",
      "hypr-harness-floating",
      "--title",
      title,
      "-o",
      `initial_window_width=${width}`,
      "-o",
      `initial_window_height=${height}`,
      "bash",
      "-c",
      script,
    ],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  proc.unref();
}

function displayCardInKitty(title: string, content: string, display?: DisplayConfig) {
  const width = display?.width || 700;
  const height = display?.height || 450;

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
    [
      "--class",
      "hypr-harness-floating",
      "--title",
      title,
      "-o",
      `initial_window_width=${width}`,
      "-o",
      `initial_window_height=${height}`,
      "bash",
      "-c",
      script,
    ],
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
  if (uiType === "gui_yad") {
    try {
      const yadArgs = [
        "--title=" + title,
        "--text=" + prompt,
        "--list",
        "--column=Option",
        "--width=580",
        "--height=380",
        "--center",
        "--class=yad",
        "--button=Cancel:1",
        "--button=Select:0",
        ...options,
      ];
      const res = spawnSync("yad", yadArgs, { encoding: "utf-8" });
      if (res.status === 0 && res.stdout) {
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
      const displayMode = action.display?.mode || "notification";
      const timeout = action.display?.timeout_ms || 12000;
      const title = action.display?.title || "Spotlight";

      if (displayMode === "floating_card") {
        displayCardInKitty(title, action.summary, action.display);
      } else if (displayMode === "gui_dialog") {
        const width = action.display?.width || 600;
        const height = action.display?.height || 400;
        const yadProc = spawn("yad", [
          `--title=${title}`,
          `--text=${action.summary}`,
          `--width=${width}`,
          `--height=${height}`,
          "--center",
          "--class=yad",
          "--button=Close:0",
        ], { detached: true, stdio: "ignore" });
        yadProc.unref();
      } else {
        notify(title, action.summary, timeout);
      }
      break;
    }

    case "exec_shell": {
      const hazard = isHazardousCommand(action.command);
      const isDangerous = action.safety === "destructive" || hazard.hazardous;
      const displayMode = action.display?.mode || "floating_card";
      const title = action.display?.title || action.rationale;

      if (isDangerous) {
        const hazardNotice = hazard.reason ? `\\n\\n⚠️  SAFETY INTERCEPT: ${hazard.reason}` : "";
        const confirmScript = `
          if command -v yad &>/dev/null; then
            yad --title="Confirm Action" --text="⚠️  HAZARDOUS / DESTRUCTIVE ACTION REQUESTED\\n\\nRationale: ${action.rationale}${hazardNotice}\\n\\nCommand:\\n${action.command}" --class=yad --center --button="Cancel:1" --button="Execute:0"
            if [ $? -eq 0 ]; then
              ${action.command}
            fi
          else
            echo -e "\\033[1;31m⚠️  HAZARDOUS / DESTRUCTIVE ACTION REQUESTED\\033[0m"
            echo "=================================="
            echo "Rationale: ${action.rationale}"
            if [ -n "${hazard.reason || ""}" ]; then
              echo "Warning: ${hazard.reason}"
            fi
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
        runInteractiveInKitty(`Confirm: ${action.rationale}`, confirmScript, action.display);
      } else if (displayMode === "floating_card") {
        // Output of a command: display in configured floating window
        runInteractiveInKitty(title, action.command, action.display);
      } else if (displayMode === "gui_dialog") {
        const width = action.display?.width || 680;
        const height = action.display?.height || 450;
        const yadProc = spawn("bash", [
          "-c",
          `yad --title="${title}" --text-info --width=${width} --height=${height} --center --class=yad <<< "$(${action.command})"`,
        ], { detached: true, stdio: "ignore" });
        yadProc.unref();
      } else {
        // Background toggle/notification
        notify("Spotlight", `Executing: ${action.rationale}`, 5000, "low");
        const proc = spawn("bash", ["-c", action.command]);
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("close", (code) => {
          if (code === 0) {
            const outSnippet = stdout.trim() ? stdout.trim() : "Done";
            notify("Spotlight: Success", `${action.rationale}\n${outSnippet}`, 10000);
          } else {
            notify(
              "Spotlight: Error",
              `Exit ${code}: ${stderr.trim() || stdout.trim() || "Failed"}`,
              12000,
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
        const yadProc = spawn("bash", [
          "-c",
          `yad --title="${title}" --text-info --width=680 --height=450 --center --class=yad <<< "$(${action.command})"`,
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
