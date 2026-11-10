import { spawn } from "child_process";
import * as fs from "fs";
import { transcribeAudio } from "./voice";

// Audio recording parameters
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM = 2 bytes
const CHANNELS = 1;
const FRAME_DURATION_MS = 100;
const FRAME_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * FRAME_DURATION_MS) / 1000; // 3200 bytes

// Silence detection thresholds
const SILENCE_RMS_THRESHOLD = 350; // RMS amplitude below which audio is considered silence
const SILENCE_TIMEOUT_MS = 1400;   // 1.4 seconds of continuous silence after speech to auto-stop
const MAX_RECORDING_MS = 25000;    // 25s hard cutoff to prevent runaway recordings
const MIN_SPEECH_FRAMES = 3;       // Must hear at least ~300ms of non-silence before silence detection activates

function computeRMS(buffer: Buffer): number {
  let sumSquares = 0;
  const sampleCount = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const val = buffer.readInt16LE(i);
    sumSquares += val * val;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function writeWavHeader(dataLength: number, sampleRate = 16000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // ByteRate
  header.writeUInt16LE(channels * 2, 32);              // BlockAlign
  header.writeUInt16LE(16, 34);                        // BitsPerSample
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export async function recordVoiceWithVAD(outputPath: string): Promise<boolean> {
  const chunks: Buffer[] = [];
  let speechDetected = false;
  let speechFrames = 0;
  let silenceDurationMs = 0;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // Record raw 16kHz 16-bit mono PCM via ffmpeg or pw-record
    const recorder = spawn("ffmpeg", [
      "-f", "pulse",
      "-i", "default",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-f", "s16le",
      "-loglevel", "quiet",
      "pipe:1"
    ], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    let currentChunk = Buffer.alloc(0);

    const finish = () => {
      try {
        recorder.kill("SIGINT");
      } catch {}

      if (chunks.length === 0) {
        resolve(false);
        return;
      }

      const pcmData = Buffer.concat(chunks);
      const wavHeader = writeWavHeader(pcmData.length, SAMPLE_RATE, CHANNELS);
      fs.writeFileSync(outputPath, Buffer.concat([wavHeader, pcmData]));
      resolve(true);
    };

    recorder.stdout.on("data", (data: Buffer) => {
      currentChunk = Buffer.concat([currentChunk, data]);

      while (currentChunk.length >= FRAME_BYTES) {
        const frame = currentChunk.subarray(0, FRAME_BYTES);
        currentChunk = currentChunk.subarray(FRAME_BYTES);
        chunks.push(frame);

        const rms = computeRMS(frame);

        if (rms > SILENCE_RMS_THRESHOLD) {
          speechFrames++;
          if (speechFrames >= MIN_SPEECH_FRAMES) {
            speechDetected = true;
          }
          silenceDurationMs = 0;
        } else {
          if (speechDetected) {
            silenceDurationMs += FRAME_DURATION_MS;
            if (silenceDurationMs >= SILENCE_TIMEOUT_MS) {
              // Silence threshold reached after speech -> Auto-stop!
              finish();
              return;
            }
          }
        }

        // Hard timeout
        if (Date.now() - startTime >= MAX_RECORDING_MS) {
          finish();
          return;
        }
      }
    });

    recorder.on("error", (err) => reject(err));
    recorder.on("close", () => {
      if (!fs.existsSync(outputPath) && chunks.length > 0) {
        finish();
      }
    });

    // Handle early cancellation if parent kills us
    process.on("SIGINT", () => finish());
    process.on("SIGTERM", () => finish());
  });
}

// When executed directly
if (import.meta.main) {
  const targetFile = process.argv[2] || "/tmp/hypr-voice-input.wav";
  const ok = await recordVoiceWithVAD(targetFile);
  process.exit(ok ? 0 : 1);
}
