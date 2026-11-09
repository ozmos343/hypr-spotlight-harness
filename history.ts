import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import type { FinalActionPayload } from "./agent";

export interface HistoryTurn {
  timestamp: number;
  user: string;
  action: FinalActionPayload;
  outputSummary?: string;
}

export function loadRollingBuffer(): HistoryTurn[] {
  try {
    if (fs.existsSync(config.historyBufferFile)) {
      const data = JSON.parse(fs.readFileSync(config.historyBufferFile, "utf-8")) as HistoryTurn[];
      const now = Date.now();
      if (data.length > 0 && now - data[data.length - 1].timestamp > config.bufferExpiryMs) {
        return [];
      }
      return data;
    }
  } catch {}
  return [];
}

export function saveTurn(turn: HistoryTurn) {
  // 1. Append to permanent log
  try {
    const dir = path.dirname(config.persistentHistoryFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(config.persistentHistoryFile, JSON.stringify(turn) + "\n", "utf-8");
  } catch (err) {
    console.error("Failed to append to permanent history:", err);
  }

  // 2. Update rolling buffer
  try {
    const buffer = loadRollingBuffer();
    buffer.push(turn);
    const trimmed = buffer.slice(-config.maxBufferTurns);
    fs.writeFileSync(config.historyBufferFile, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to update rolling buffer:", err);
  }
}

export function clearRollingBuffer() {
  try {
    if (fs.existsSync(config.historyBufferFile)) {
      fs.unlinkSync(config.historyBufferFile);
    }
  } catch {}
}

export function searchPersistentHistory(keyword: string, maxResults = 5): HistoryTurn[] {
  try {
    if (!fs.existsSync(config.persistentHistoryFile)) return [];
    const lines = fs.readFileSync(config.persistentHistoryFile, "utf-8").trim().split("\n");
    const results: HistoryTurn[] = [];
    const query = keyword.toLowerCase();

    for (let i = lines.length - 1; i >= 0 && results.length < maxResults; i--) {
      if (!lines[i]) continue;
      try {
        const turn = JSON.parse(lines[i]) as HistoryTurn;
        if (
          turn.user.toLowerCase().includes(query) ||
          (turn.action.action === "exec_shell" && turn.action.command.toLowerCase().includes(query)) ||
          (turn.action.action === "answer" && turn.action.summary.toLowerCase().includes(query))
        ) {
          results.push(turn);
        }
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}
