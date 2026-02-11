/**
 * Local whisper.cpp STT via child_process.
 *
 * Writes PCM to a temp .wav file, runs the `whisper` (or `whisper-cpp`) CLI,
 * then parses the text output.
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type WhisperConfig = {
  /** Path to the whisper CLI binary (default: "whisper-cpp"). */
  binaryPath?: string;
  /** Path to the GGML model file. */
  modelPath: string;
  /** Language code (default: "en"). */
  language?: string;
  /** Timeout in ms (default: 30000). */
  timeoutMs?: number;
};

export type TranscribeResult = {
  text: string;
  durationMs: number;
};

/**
 * Write a raw 16kHz 16-bit mono PCM buffer as a WAV file.
 */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);

  // fmt chunk
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); // chunk size
  wav.writeUInt16LE(1, 20); // PCM format
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, 44);

  return wav;
}

/**
 * Transcribe a 16kHz 16-bit mono PCM buffer using whisper.cpp.
 */
export async function transcribe(pcm: Buffer, config: WhisperConfig): Promise<TranscribeResult> {
  const binary = config.binaryPath ?? "whisper-cpp";
  const language = config.language ?? "en";
  const timeoutMs = config.timeoutMs ?? 30_000;
  const start = Date.now();

  // Create temp directory for the WAV file
  const tempDir = await mkdtemp(join(tmpdir(), "discord-voice-stt-"));
  const wavPath = join(tempDir, "input.wav");
  const txtPath = join(tempDir, "input.wav.txt");

  try {
    // Write PCM as WAV (whisper.cpp expects WAV input)
    const wav = pcmToWav(pcm, 16000);
    await writeFile(wavPath, wav);

    // Run whisper.cpp
    const args = [
      "-m",
      config.modelPath,
      "-l",
      language,
      "-f",
      wavPath,
      "-otxt",
      "-of",
      join(tempDir, "input.wav"),
      "--no-timestamps",
    ];

    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { timeout: timeoutMs },
        async (error, stdout, stderr) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              reject(
                new Error(`whisper binary not found at "${binary}". Install whisper.cpp first.`),
              );
              return;
            }
            if (error.killed) {
              reject(new Error(`whisper transcription timed out after ${timeoutMs}ms`));
              return;
            }
            reject(new Error(`whisper error: ${stderr || error.message}`));
            return;
          }

          // whisper.cpp with -otxt writes a .txt file; also check stdout
          try {
            const txtContent = await readFile(txtPath, "utf-8");
            resolve(txtContent.trim());
          } catch {
            // Fallback: parse stdout
            resolve(stdout.trim());
          }
        },
      );

      // Ensure the child is killed on timeout
      child.unref?.();
    });

    return { text, durationMs: Date.now() - start };
  } finally {
    // Cleanup temp files
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
