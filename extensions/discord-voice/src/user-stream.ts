/**
 * Per-user audio buffering with silence detection.
 *
 * Accumulates Opus-decoded PCM chunks for each Discord user and emits complete
 * utterances when silence exceeds a configurable threshold.
 */

import { OpusEncoder } from "@discordjs/opus";
import { computeRmsEnergy, stereoToMono, resamplePcm } from "./audio-pipeline.js";

export type UserStreamConfig = {
  /** Silence threshold in milliseconds. Default: 800. */
  silenceThresholdMs?: number;
  /** VAD energy threshold (0–1). Chunks below this are considered silence. Default: 0.01. */
  vadEnergyThreshold?: number;
  /** Called when a complete utterance is detected for a user. */
  onUtterance: (userId: string, pcm16kMono: Buffer, durationMs: number) => void;
};

type UserBuffer = {
  chunks: Buffer[];
  totalBytes: number;
  lastAudioTimestamp: number;
  silenceTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Manages per-user audio streams from a Discord voice channel.
 */
export class UserStreamManager {
  private users = new Map<string, UserBuffer>();
  private config: Required<Pick<UserStreamConfig, "silenceThresholdMs" | "vadEnergyThreshold">> & {
    onUtterance: UserStreamConfig["onUtterance"];
  };

  /** Opus decoder: Discord sends 48kHz stereo Opus packets. */
  private decoder = new OpusEncoder(48000, 2);

  constructor(config: UserStreamConfig) {
    this.config = {
      silenceThresholdMs: config.silenceThresholdMs ?? 800,
      vadEnergyThreshold: config.vadEnergyThreshold ?? 0.01,
      onUtterance: config.onUtterance,
    };
  }

  /**
   * Feed an Opus packet from a user's audio stream.
   */
  pushOpusPacket(userId: string, opusPacket: Buffer): void {
    // Decode Opus → PCM 48kHz stereo (16-bit LE)
    let pcm48kStereo: Buffer;
    try {
      pcm48kStereo = this.decoder.decode(opusPacket);
    } catch {
      return; // Drop malformed packets
    }

    // Convert to mono for energy check
    const pcm48kMono = stereoToMono(pcm48kStereo);
    const energy = computeRmsEnergy(pcm48kMono);

    // Get or create the user's buffer
    let userBuf = this.users.get(userId);
    if (!userBuf) {
      userBuf = {
        chunks: [],
        totalBytes: 0,
        lastAudioTimestamp: Date.now(),
        silenceTimer: null,
      };
      this.users.set(userId, userBuf);
    }

    if (energy < this.config.vadEnergyThreshold) {
      // This chunk is below VAD threshold (silence).
      // If we have accumulated audio, start/extend silence timer.
      if (userBuf.chunks.length > 0 && !userBuf.silenceTimer) {
        userBuf.silenceTimer = setTimeout(() => {
          this.flushUser(userId);
        }, this.config.silenceThresholdMs);
      }
      return;
    }

    // Active speech — clear any silence timer and accumulate.
    if (userBuf.silenceTimer) {
      clearTimeout(userBuf.silenceTimer);
      userBuf.silenceTimer = null;
    }
    userBuf.lastAudioTimestamp = Date.now();

    // Store the mono 48kHz PCM (we'll downsample on flush for whisper)
    userBuf.chunks.push(pcm48kMono);
    userBuf.totalBytes += pcm48kMono.length;
  }

  /**
   * Flush a user's accumulated audio and emit the utterance.
   */
  private flushUser(userId: string): void {
    const userBuf = this.users.get(userId);
    if (!userBuf || userBuf.chunks.length === 0) return;

    if (userBuf.silenceTimer) {
      clearTimeout(userBuf.silenceTimer);
      userBuf.silenceTimer = null;
    }

    // Concatenate all mono 48kHz chunks
    const pcm48kMono = Buffer.concat(userBuf.chunks);
    const durationMs = (pcm48kMono.length / 2 / 48000) * 1000;

    // Downsample 48kHz → 16kHz for whisper
    const pcm16kMono = resamplePcm(pcm48kMono, 48000, 16000);

    // Reset the user's buffer
    userBuf.chunks = [];
    userBuf.totalBytes = 0;

    this.config.onUtterance(userId, pcm16kMono, durationMs);
  }

  /**
   * Force-flush all user buffers (e.g. on disconnect).
   */
  flushAll(): void {
    for (const userId of this.users.keys()) {
      this.flushUser(userId);
    }
  }

  /**
   * Remove a user's stream (on voice channel leave).
   */
  removeUser(userId: string): void {
    const userBuf = this.users.get(userId);
    if (userBuf?.silenceTimer) {
      clearTimeout(userBuf.silenceTimer);
    }
    this.users.delete(userId);
  }

  /**
   * Cleanup all resources.
   */
  destroy(): void {
    for (const [userId, buf] of this.users) {
      if (buf.silenceTimer) clearTimeout(buf.silenceTimer);
    }
    this.users.clear();
  }
}
