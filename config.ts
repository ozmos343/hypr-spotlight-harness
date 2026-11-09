import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export interface HarnessConfig {
  apiKey: string;
  model: string;
  cacheFile: string;
  historyBufferFile: string;
  persistentHistoryFile: string;
  maxBufferTurns: number;
  bufferExpiryMs: number;
}

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config/hypr/harness");
const ENV_FILE = path.join(CONFIG_DIR, ".env");

function resolveApiKey(): string {
  // 1. Priority: dedicated .env in config directory
  if (fs.existsSync(ENV_FILE)) {
    const content = fs.readFileSync(ENV_FILE, "utf-8");
    const match = content.match(/^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match && match[1] && !match[1].startsWith("your_")) {
      return match[1].trim();
    }
  }

  // 2. Environment variables
  if (process.env.SPOTLIGHT_GEMINI_API_KEY) {
    return process.env.SPOTLIGHT_GEMINI_API_KEY.trim();
  }
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.trim();
  }

  // 3. User shell rc fallback
  for (const rc of [".zshrc", ".bashrc", ".profile"]) {
    const rcPath = path.join(HOME, rc);
    if (fs.existsSync(rcPath)) {
      const content = fs.readFileSync(rcPath, "utf-8");
      const match = content.match(/export\s+GEMINI_API_KEY=["']?([^"'\n\r]+)["']?/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  throw new Error(
    "GEMINI_API_KEY not found. Please define it in ~/.config/hypr/harness/.env or export GEMINI_API_KEY in your environment."
  );
}

export const config: HarnessConfig = {
  apiKey: "", // lazily resolved
  model: process.env.HYPR_HARNESS_MODEL || "gemini-3.5-flash-lite",
  cacheFile: process.env.HYPR_HARNESS_CACHE || path.join(os.tmpdir(), "hypr-spotlight.cache"),
  historyBufferFile: process.env.HYPR_HARNESS_BUFFER || path.join(os.tmpdir(), "hypr-spotlight.buffer.json"),
  persistentHistoryFile:
    process.env.HYPR_HARNESS_LOG ||
    path.join(HOME, ".local/share/hypr-spotlight/history.jsonl"),
  maxBufferTurns: 6,
  bufferExpiryMs: 15 * 60 * 1000,
};

export function getApiKey(): string {
  if (!config.apiKey) {
    config.apiKey = resolveApiKey();
  }
  return config.apiKey;
}
