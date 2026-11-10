import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export interface HarnessConfig {
  apiKey: string;
  model: string;
  cacheFile: string;
  historyBufferFile: string;
  persistentHistoryFile: string;
  modelSettingFile: string;
  maxBufferTurns: number;
  bufferExpiryMs: number;
}

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config/hypr/harness");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const MODEL_FILE = path.join(CONFIG_DIR, "model.txt");

export const SUPPORTED_MODELS = [
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite (Fast, lightweight system operator)" },
  { id: "gemini-2.5-flash",      name: "Gemini 2.5 Flash (Balanced speed & deeper reasoning)" },
  { id: "gemini-2.5-pro",        name: "Gemini 2.5 Pro (Maximum reasoning & complex task coding)" },
];

function resolveModel(): string {
  if (process.env.HYPR_HARNESS_MODEL) {
    return process.env.HYPR_HARNESS_MODEL.trim();
  }
  if (fs.existsSync(MODEL_FILE)) {
    const saved = fs.readFileSync(MODEL_FILE, "utf-8").trim();
    if (saved) return saved;
  }
  return "gemini-3.5-flash-lite";
}

export function setModel(modelId: string) {
  fs.writeFileSync(MODEL_FILE, modelId.trim(), "utf-8");
  config.model = modelId.trim();
}

function resolveApiKey(): string {
  if (fs.existsSync(ENV_FILE)) {
    const content = fs.readFileSync(ENV_FILE, "utf-8");
    const match = content.match(/^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match && match[1] && !match[1].startsWith("your_")) {
      return match[1].trim();
    }
  }

  if (process.env.SPOTLIGHT_GEMINI_API_KEY) {
    return process.env.SPOTLIGHT_GEMINI_API_KEY.trim();
  }
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.trim();
  }

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
  apiKey: "",
  model: resolveModel(),
  cacheFile: process.env.HYPR_HARNESS_CACHE || path.join(os.tmpdir(), "hypr-spotlight.cache"),
  historyBufferFile: process.env.HYPR_HARNESS_BUFFER || path.join(os.tmpdir(), "hypr-spotlight.buffer.json"),
  persistentHistoryFile:
    process.env.HYPR_HARNESS_LOG ||
    path.join(HOME, ".local/share/hypr-spotlight/history.jsonl"),
  modelSettingFile: MODEL_FILE,
  maxBufferTurns: 6,
  bufferExpiryMs: 15 * 60 * 1000,
};

export function getApiKey(): string {
  if (!config.apiKey) {
    config.apiKey = resolveApiKey();
  }
  return config.apiKey;
}

export function getCurrentModel(): string {
  config.model = resolveModel();
  return config.model;
}
