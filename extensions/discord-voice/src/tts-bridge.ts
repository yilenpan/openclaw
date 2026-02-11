/**
 * Bridge to core TTS for Discord voice output.
 *
 * Uses api.runtime.tts.textToSpeechTelephony() which returns PCM buffers,
 * then resamples to 48kHz stereo for Discord's Opus-based voice connection.
 */

import { resamplePcm, monoToStereo } from "./audio-pipeline.js";

export type TtsRuntime = {
  textToSpeechTelephony: (params: { text: string; cfg: unknown }) => Promise<{
    success: boolean;
    audioBuffer?: Buffer;
    sampleRate?: number;
    provider?: string;
    error?: string;
  }>;
};

export type TtsBridgeConfig = {
  runtime: TtsRuntime;
  coreConfig: unknown;
};

export type TtsBridgeResult = {
  /** PCM 48kHz stereo 16-bit LE — ready for Discord AudioPlayer. */
  pcm48kStereo: Buffer;
  provider?: string;
};

/**
 * Convert text to PCM audio suitable for Discord voice playback.
 *
 * The core TTS returns mono PCM at various sample rates (OpenAI: 24kHz,
 * ElevenLabs: 22.05kHz, etc.). We resample to 48kHz and convert to stereo
 * for Discord's AudioPlayer.
 */
export async function textToDiscordPcm(
  text: string,
  config: TtsBridgeConfig,
): Promise<TtsBridgeResult> {
  const result = await config.runtime.textToSpeechTelephony({
    text,
    cfg: config.coreConfig,
  });

  if (!result.success || !result.audioBuffer || !result.sampleRate) {
    throw new Error(result.error ?? "TTS conversion failed");
  }

  // Resample to 48kHz mono, then duplicate to stereo
  const pcm48kMono = resamplePcm(result.audioBuffer, result.sampleRate, 48000);
  const pcm48kStereo = monoToStereo(pcm48kMono);

  return {
    pcm48kStereo,
    provider: result.provider,
  };
}
