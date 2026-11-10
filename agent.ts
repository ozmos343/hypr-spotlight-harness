import { spawnSync } from "child_process";
import { config } from "./config";
import type { HistoryTurn } from "./history";

export type DisplayConfig = {
  mode: "notification" | "floating_card" | "gui_dialog";
  title?: string;
  width?: number;
  height?: number;
  timeout_ms?: number; // e.g. 8000 to 15000 for notifications so they persist comfortably
};

export type FinalActionPayload =
  | {
      action: "answer";
      summary: string;
      display?: DisplayConfig;
    }
  | {
      action: "exec_shell";
      command: string;
      rationale: string;
      safety: "safe" | "destructive";
      display?: DisplayConfig;
    }
  | {
      action: "spawn_widget";
      backend: "dialog_yad" | "kitty_command" | "tui_gum";
      title?: string;
      command: string;
      arguments?: string[];
      form_schema?: Record<string, any>;
    }
  | {
      action: "prompt_wizard";
      title: string;
      prompt: string;
      options: string[];
      context: string;
      ui_type?: "gui_yad" | "tui_kitty";
    };

const SYSTEM_INSTRUCTION = `You are an intelligent, autonomous system operator for Arch Linux running Hyprland.
You are equipped with a multi-step inspection tool loop (up to 8 iterative reasoning steps).

SAFETY AND RESOURCE PROTECTION RULES:
1. NEVER spawn excessive concurrent processes, loops, or window instances (e.g. loops launching multiple background apps or windows like xeyes, kitty, etc.). Doing so will crash the Wayland compositor or freeze the system.
2. If the user asks for a large number of instances (e.g. "draw 100 xeyes", "open 50 terminals", "fork bomb"), DO NOT execute it. Instead, refuse or offer a safe single visual representation or wizard confirmation.
3. For any operation that could cause resource exhaustion, high CPU/RAM usage, process flooding, or system destabilization, mark safety: "destructive" so the user is prompted with an interactive confirmation before anything runs.
4. If asked to draw or generate art, use a single canvas window (such as a single yad dialog or a single Python/Tkinter window), NEVER repeated process loops. Do not lecture the user about safety rules in text descriptions unless an unsafe operation was actively requested.

AUTONOMOUS DISPLAY & UI CONFIGURATION:
You have FULL CONTROL over how results are presented to the user. Always include a "display" object that reflects the optimal medium for the content:

1. "notification":
   - Use for conversational responses, quick factual answers, confirmations, and small non-tabular updates.
   - Set "timeout_ms": 10000 (10s) to 15000 (15s) so the notification persists comfortably on screen without disappearing prematurely.

2. "floating_card":
   - Use whenever running a shell command whose output the user needs to inspect (e.g. df, free, ps, ip, systemctl, git diff, file lists, pacman queries).
   - Also use for structured markdown tables or multi-paragraph guides.
   - Configure "width" (e.g. 600 - 900) and "height" (e.g. 350 - 600) to comfortably fit the expected output.

3. "gui_dialog":
   - Use native GTK dialogs (via yad) for interactive workflows, form inputs, or graphical message cards.
   - IMPORTANT: DO NOT write raw 'yad' commands or 'export DISPLAY' in exec_shell commands! To show a dialog, simply use action: "answer" with display.mode: "gui_dialog", or action: "exec_shell" with display.mode: "gui_dialog", or action: "spawn_widget" with backend: "dialog_yad". The harness spawns yad natively on your Wayland display without blocking or shell escaping bugs.

JSON OUTPUT SCHEMAS:

A. Answer (Conversational / Explanatory or GUI message):
{
  "action": "answer",
  "summary": "<clear response or message to display>",
  "display": {
    "mode": "notification" | "floating_card" | "gui_dialog",
    "title": "<optional card/dialog title>",
    "timeout_ms": 12000,
    "width": 700,
    "height": 450
  }
}

B. Exec Shell (System Commands & Maintenance):
{
  "action": "exec_shell",
  "command": "<exact bash command>",
  "rationale": "<1 sentence rationale>",
  "safety": "safe" | "destructive",
  "display": {
    "mode": "floating_card" | "notification" | "gui_dialog",
    "title": "<inspector title, e.g. Disk Space Utilization>",
    "width": 750,
    "height": 480
  }
}

C. Spawn GUI Widget / Native Dialog:
{
  "action": "spawn_widget",
  "backend": "dialog_yad" | "kitty_command",
  "title": "<Dialog Title>",
  "command": "<command to produce text or data to display inside the dialog>"
}

C. On-Demand Interactive Wizard:
{
  "action": "prompt_wizard",
  "title": "<Title>",
  "prompt": "<Question/Decision>",
  "options": ["Option 1", "Option 2"],
  "context": "<Context string>",
  "ui_type": "gui_yad" | "tui_kitty"
}

D. Inspection Tool Call:
{
  "action": "inspect",
  "command": "<safe read-only bash command>"
}

Note: Hyprland configuration is in ~/.config/hypr/hyprland.lua. Return ONLY valid JSON.`;

function executeInspection(cmd: string): string {
  const forbidden = [
    "rm ", "rmdir ", "dd ", "mkfs", "chmod ", "chown ", "reboot", "shutdown", "poweroff", "kill ", "killall "
  ];
  for (const f of forbidden) {
    if (cmd.includes(f)) {
      return `Inspection denied: Command contains potentially destructive keyword '${f}'.`;
    }
  }

  try {
    const res = spawnSync("bash", ["-c", cmd], {
      timeout: 10000,
      encoding: "utf-8",
      maxBuffer: 1024 * 512,
    });
    if (res.error) {
      return `Inspection error: ${res.error.message}`;
    }
    const output = (res.stdout || "") + (res.stderr || "");
    return output.trim().slice(0, 4000) || "(No output)";
  } catch (err: any) {
    return `Execution failed: ${err.message}`;
  }
}

export async function queryGemini(
  prompt: string,
  apiKey: string,
  recentHistory: HistoryTurn[] = [],
  signal?: AbortSignal
): Promise<FinalActionPayload> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const turn of recentHistory) {
    contents.push({
      role: "user",
      parts: [{ text: turn.user }],
    });
    let assistantReply = JSON.stringify(turn.action);
    if (turn.outputSummary) {
      assistantReply += `\n/* Execution Output: ${turn.outputSummary} */`;
    }
    contents.push({
      role: "model",
      parts: [{ text: assistantReply }],
    });
  }

  contents.push({
    role: "user",
    parts: [{ text: prompt }],
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;

  for (let step = 0; step < 8; step++) {
    const requestBody = {
      contents,
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }],
      },
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${config.model}) [${response.status}]: ${errText}`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error("No response received from Gemini.");
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return {
        action: "answer",
        summary: rawText,
        display: { mode: "notification", timeout_ms: 12000 },
      };
    }

    if (parsed.action === "inspect" && parsed.command) {
      const inspectOutput = executeInspection(parsed.command);

      contents.push({
        role: "model",
        parts: [{ text: JSON.stringify(parsed) }],
      });

      contents.push({
        role: "user",
        parts: [
          {
            text: `[SYSTEM INSPECTION RESULT for command: "${parsed.command}"]:\n${inspectOutput}\n\nReason over this result. Either perform another inspection step, present a prompt_wizard if you need user choice/input, or provide the final action.`,
          },
        ],
      });

      continue;
    }

    return parsed as FinalActionPayload;
  }

  throw new Error("Maximum inspection iterations exceeded without final response.");
}
