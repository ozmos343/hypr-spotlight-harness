import * as fs from "fs";
import { getApiKey, config } from "./config";

export async function transcribeAudio(audioFilePath: string): Promise<string> {
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }

  const audioBytes = fs.readFileSync(audioFilePath);
  const base64Audio = audioBytes.toString("base64");

  const apiKey = getApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: "You are a speech-to-text transcriber for a Linux system command assistant. Transcribe exactly what the user said in this audio recording. Output ONLY the transcribed text. Do not add quotes, commentary, or explanation. If the audio is silent or unintelligible, output nothing.",
          },
          {
            inlineData: {
              mimeType: "audio/wav",
              data: base64Audio,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.0,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini transcription error [${resp.status}]: ${err}`);
  }

  const data = await resp.json();
  const transcript = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return transcript;
}

// CLI entrypoint when invoked directly: bun run voice.ts <audio_file>
if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: bun run voice.ts <path-to-wav>");
    process.exit(1);
  }

  try {
    const text = await transcribeAudio(file);
    if (text) {
      process.stdout.write(text);
    }
    process.exit(0);
  } catch (err: any) {
    console.error("Transcription failed:", err.message || err);
    process.exit(1);
  }
}
