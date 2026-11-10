import { queryGemini, type FinalActionPayload } from "./agent";
import { executeAction, runInteractiveWizard } from "./executor";
import { config, getApiKey, setModel, getCurrentModel, SUPPORTED_MODELS } from "./config";
import { loadRollingBuffer, saveTurn, clearRollingBuffer, searchPersistentHistory, type HistoryTurn } from "./history";

async function main() {
  const initialQuery = process.argv.slice(2).join(" ").trim();
  if (!initialQuery) {
    process.exit(0);
  }

  // Handle explicit reset/clear commands locally without an LLM call
  if (/^(clear history|reset history|new session|reset)$/i.test(initialQuery)) {
    clearRollingBuffer();
    const proc = Bun.spawn(["notify-send", "-a", "spotlight", "Spotlight", "Session history cleared."]);
    await proc.exited;
    process.exit(0);
  }

  // Handle model change/query commands
  if (/^\/?(model|set model|change model)\b/i.test(initialQuery)) {
    const parts = initialQuery.split(/\s+/);
    if (parts.length > 1 && parts[1].includes("gemini")) {
      const targetModel = parts[1].trim();
      setModel(targetModel);
      const proc = Bun.spawn(["notify-send", "-a", "spotlight", "Model Updated", `Active model set to: ${targetModel}`]);
      await proc.exited;
      process.exit(0);
    } else {
      // Interactive model switcher via dedicated clean two-column yad dialog
      const current = getCurrentModel();
      const yadArgs = [
        `--title=Select Gemini Model (Current: ${current})`,
        "--text=Choose the Gemini model to power Spotlight, Voice, and Quake harness:",
        "--list",
        "--column=Model ID",
        "--column=Profile",
        "--width=650",
        "--height=300",
        "--center",
        "--class=yad",
        "--button=Cancel:1",
        "--button=Select:0",
      ];
      for (const m of SUPPORTED_MODELS) {
        yadArgs.push(m.id, m.name);
      }
      const res = Bun.spawnSync(["yad", ...yadArgs]);
      if (res.exitCode === 0 && res.stdout) {
        const out = res.stdout.toString().trim();
        const selectedId = out.split("|")[0].trim();
        if (selectedId) {
          setModel(selectedId);
          const proc = Bun.spawn(["notify-send", "-a", "spotlight", "Model Updated", `Active model set to: ${selectedId}`]);
          await proc.exited;
        }
      }
      process.exit(0);
    }
  }

  // Abort controller for fast exit
  const abortController = new AbortController();
  process.on("SIGINT", () => {
    abortController.abort();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    abortController.abort();
    process.exit(0);
  });

  const recentHistory: HistoryTurn[] = loadRollingBuffer();

  // Instant history query
  if (/^(history|what did i run|past commands)/i.test(initialQuery)) {
    const match = initialQuery.match(/^history\s+(.*)/i);
    const filter = match ? match[1] : "";
    const results = searchPersistentHistory(filter, 8);
    const summary = results.length > 0
      ? results.map((r) => `• [${new Date(r.timestamp).toLocaleTimeString()}] ${r.user} -> ${r.action.action === 'exec_shell' ? r.action.command : r.action.action}`).join("\n")
      : "No matching history found in disk log.";

    await executeAction({
      action: "spawn_widget",
      backend: "dialog_yad",
      title: "Spotlight History Log",
      command: `echo -e "=== Spotlight History ===\\n${summary.replace(/"/g, '\\"')}"`
    });
    return;
  }

  try {
    const apiKey = getApiKey();
    let currentQuery = initialQuery;

    // Orchestration & Wizard Loop (allows AI to solicit interactive user decisions and re-enter tool chain)
    while (true) {
      const action = await queryGemini(currentQuery, apiKey, recentHistory, abortController.signal);

      // If the model wants to present an interactive wizard:
      if (action.action === "prompt_wizard") {
        const uiType = action.ui_type || "gui_yad";
        const userChoice = runInteractiveWizard(action.title, action.prompt, action.options, uiType);
        if (!userChoice) {
          // User hit Cancel / ESC
          process.exit(0);
        }

        // Record the intermediate step in context and feed user's choice back into the loop
        recentHistory.push({
          timestamp: Date.now(),
          user: currentQuery,
          action,
        });

        currentQuery = `User chose option: "${userChoice}". Context: ${action.context}. Now continue the workflow accordingly.`;
        continue;
      }

      // Terminal step reached: save to persistent history and execute
      saveTurn({
        timestamp: Date.now(),
        user: initialQuery,
        action,
      });

      await executeAction(action);
      break;
    }
  } catch (err: any) {
    if (abortController.signal.aborted) {
      process.exit(0);
    }
    console.error("Harness error:", err);
    const proc = Bun.spawn(["notify-send", "-a", "spotlight", "-u", "critical", "Spotlight Error", String(err.message || err)]);
    await proc.exited;
    process.exit(1);
  }
}

main();
