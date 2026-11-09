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
    }
  | {
      action: "prompt_wizard";
      title: string;
      prompt: string;
      options: string[];
      context: string;
    };

const SYSTEM_INSTRUCTION = `You are a proactive, autonomous system operator and orchestration engine for Arch Linux / Hyprland.
You are equipped with a multi-step inspection tool loop (up to 8 iterative reasoning steps).

AUTONOMOUS TOOL CHAINS:
When the user asks you to do something complex (e.g. "display my system as a pretty printed graph", "diagnose network lag", "convert all FLACs to MP3", "monitor GPU thermals"):
1. DO NOT simply tell the user what commands to run.
2. DO NOT give up if a utility is not installed.
3. Actively inspect the machine step-by-step using "inspect":
   - Step 1: Check what utilities exist on the system (e.g. \`which btop htop duf ncdu graphviz pstree lspci\`).
   - Step 2: If a candidate tool or script is found, test it or inspect its flags.
   - Step 3: If multiple viable approaches or tools exist, or if an installation/choice is needed, solicit user input via a wizard interface!

INTERACTION / WIZARD INTERFACE ("prompt_wizard"):
When you need clarification, a decision from the user, or permission to proceed with an installation/workflow option, return:
{
  "action": "prompt_wizard",
  "title": "<Short Title for the Wizard>",
  "prompt": "<Clear question or prompt for the user>",
  "options": ["Option 1 Description", "Option 2 Description", "Option 3 Description"],
  "context": "<Internal context summarizing what was already discovered so the subsequent step picks up seamlessly>"
}
The system will render an ephemeral floating interactive selection menu (using fzf/whiptail). Once the user chooses an option, the system feeds the user's choice and your context back to you so you can continue the chain!

OTHER ACTIONS (TERMINAL STEPS):
- "inspect": For multi-step fact gathering in the background.
  { "action": "inspect", "command": "<safe bash inspection command>" }
- "answer": For purely informational queries or final conclusions.
  { "action": "answer", "summary": "<markdown summary>" }
- "exec_shell": For executing a concrete action (safe or destructive).
  { "action": "exec_shell", "command": "<bash command>", "rationale": "<1 sentence>", "safety": "safe" | "destructive", "display": "notification" | "floating_window" }
- "spawn_widget": For full interactive programs (e.g., launching an interactive monitor or nvim in a floating window).
  { "action": "spawn_widget", "backend": "kitty_command", "title": "<title>", "command": "<command>" }

Return ONLY valid JSON for each step.`;

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

  // Multi-step tool use loop (up to 8 iterative reasoning steps)
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
      };
    }

    // Step A: Multi-turn tool execution and inspection
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

    // Step B: Terminal action (prompt_wizard, exec_shell, spawn_widget, answer)
    return parsed as FinalActionPayload;
  }

  throw new Error("Maximum inspection iterations exceeded without final response.");
}
