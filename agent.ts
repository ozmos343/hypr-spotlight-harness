import { spawnSync } from "child_process";
import { config } from "./config";
import type { HistoryTurn } from "./history";

export type FinalActionPayload =
  | {
      action: "answer";
      summary: string;
    }
  | {
      action: "exec_shell";
      command: string;
      rationale: string;
      safety: "safe" | "destructive";
      display?: "notification" | "floating_window";
    }
  | {
      action: "spawn_widget";
      backend: "tui_gum" | "dialog_yad" | "kitty_command";
      title?: string;
      command: string;
      arguments?: string[];
      form_schema?: Record<string, any>;
    };

const SYSTEM_INSTRUCTION = `You are a high-speed, intelligent system operator assistant for Arch Linux running Hyprland.
Your goal is to handle user queries from a quick launcher (Spotlight / Raycast style).

LOCAL INSPECTION CAPABILITY:
When the user asks questions about their actual system, configurations, keybindings, packages, or logs (e.g. checking ~/.config/hypr/hyprland.lua or ~/.config/hypr/hyprland.conf, active services, hardware), you can request local inspection commands before answering.
If you need to inspect the system, reply with a single JSON block:
{
  "action": "inspect",
  "command": "<safe read-only bash command to run, e.g. grep, cat, hyprctl, pacman -Q>"
}
The system will run your inspection command and give you the output so you can formulate the correct final answer.

FINAL OUTPUT:
When you have all the facts or do not need inspection, return your final response as valid JSON matching ONE of the following schemas:

1. "answer": For direct answers, explanations, or answers derived from your inspection.
   {
     "action": "answer",
     "summary": "<concise markdown formatted answer>"
   }

2. "exec_shell": When the user is asking you to perform an action or change system state.
   {
     "action": "exec_shell",
     "command": "<exact bash command>",
     "rationale": "<short 1-sentence rationale>",
     "safety": "safe" | "destructive",
     "display": "notification" | "floating_window"
   }

3. "spawn_widget": When the user requests an interactive TUI/GUI app (fzf, btop, ranger, nvim).
   {
     "action": "spawn_widget",
     "backend": "kitty_command" | "dialog_yad" | "tui_gum",
     "title": "<title>",
     "command": "<command>"
   }

Return ONLY valid JSON.`;

function executeInspection(cmd: string): string {
  const forbidden = [
    "rm ", "rmdir ", "dd ", "mkfs", ">", ">>", "chmod ", "chown ", "reboot", "shutdown", "poweroff", "kill ", "killall "
  ];
  for (const f of forbidden) {
    if (cmd.includes(f)) {
      return `Inspection denied: Command contains potentially destructive or modifying keyword '${f}'.`;
    }
  }

  try {
    const res = spawnSync("bash", ["-c", cmd], {
      timeout: 8000,
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

  for (let step = 0; step < 4; step++) {
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
            text: `[SYSTEM INSPECTION RESULT for command: "${parsed.command}"]:\n${inspectOutput}\n\nNow provide your final refined answer or action based on this result.`,
          },
        ],
      });

      continue;
    }

    return parsed as FinalActionPayload;
  }

  throw new Error("Maximum inspection iterations exceeded without final response.");
}
