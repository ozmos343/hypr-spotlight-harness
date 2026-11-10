import { spawn } from "child_process";
import * as fs from "fs";

// Audio recording parameters
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM = 2 bytes
const CHANNELS = 1;
const FRAME_DURATION_MS = 100;
const FRAME_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * FRAME_DURATION_MS) / 1000; // 3200 bytes

// Silence detection timings
const SILENCE_TIMEOUT_MS = 1200; // 1.2s of continuous silence after speech -> auto-stop
const MAX_RECORDING_MS = 25000;  // 25s hard safety cutoff
const CALIBRATION_FRAMES = 3;    // First 300ms used to measure live ambient noise floor

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
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
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

  let ambientFloor = 0;
  let calibrationSamples = 0;
  let dynamicThreshold = 12000; // conservative fallback until calibrated

  return new Promise((resolve, reject) => {
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

        // 1. Initial 300ms calibration phase
        if (calibrationSamples < CALIBRATION_FRAMES) {
          ambientFloor += rms;
          calibrationSamples++;
          if (calibrationSamples === CALIBRATION_FRAMES) {
            ambientFloor = ambientFloor / CALIBRATION_FRAMES;
            // Speech threshold set to 1.6x the measured ambient noise floor or +4500 RMS
            dynamicThreshold = Math.max(ambientFloor * 1.6, ambientFloor + 4500);
          }
          continue;
        }

        // 2. Active speech detection
        if (rms > dynamicThreshold) {
          speechFrames++;
          if (speechFrames >= 2) { // 200ms of speech triggers active speech mode
            speechDetected = true;
          }
          silenceDurationMs = 0;
        } else {
          // If speech was previously active and current RMS is back down near ambient
          if (speechDetected) {
            silenceDurationMs += FRAME_DURATION_MS;
            if (silenceDurationMs >= SILENCE_TIMEOUT_MS) {
              // User finished speaking! Auto-stop immediately
              finish();
              return;
            }
          }
        }

        // 3. Hard safety cutoff
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

    process.on("SIGINT", () => finish());
    process.on("SIGTERM", () => finish());
  });
}

if (import.meta.main) {
  const targetFile = process.argv[2] || "/tmp/hypr-voice-input.wav";
  const ok = await recordVoiceWithVAD(targetFile);
  process.exit(ok ? 0 : 1);
}
