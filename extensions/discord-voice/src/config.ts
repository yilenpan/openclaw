import { z } from "zod";

export const AutoJoinChannelSchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
});
export type AutoJoinChannel = z.infer<typeof AutoJoinChannelSchema>;

export const WakeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  words: z.array(z.string()).default(["hey claude", "claude"]),
});
export type WakeConfig = z.infer<typeof WakeConfigSchema>;

export const SttConfigSchema = z.object({
  provider: z.literal("whisper-local").default("whisper-local"),
  /** Path to the GGML model file (e.g. ~/.cache/whisper.cpp/ggml-base.bin). */
  modelPath: z.string().optional(),
  /** Path to the whisper-cpp binary. Defaults to "whisper-cpp" (looked up on PATH). */
  binaryPath: z.string().optional(),
  modelSize: z.enum(["tiny", "base", "small"]).default("base"),
  language: z.string().default("en"),
});
export type SttConfig = z.infer<typeof SttConfigSchema>;

export const TtsConfigSchema = z.object({
  provider: z.enum(["openai", "elevenlabs"]).default("openai"),
});
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

export const SessionConfigSchema = z.object({
  maxDurationMinutes: z.number().int().min(1).default(60),
  silenceThresholdMs: z.number().int().min(100).default(800),
  vadEnergyThreshold: z.number().min(0).default(0.01),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const DiscordVoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  autoJoinChannels: z.array(AutoJoinChannelSchema).default([]),
  wake: WakeConfigSchema.default(() => WakeConfigSchema.parse({})),
  stt: SttConfigSchema.default(() => SttConfigSchema.parse({})),
  tts: TtsConfigSchema.default(() => TtsConfigSchema.parse({})),
  session: SessionConfigSchema.default(() => SessionConfigSchema.parse({})),
});
export type DiscordVoiceConfig = z.infer<typeof DiscordVoiceConfigSchema>;

export function parseConfig(raw: unknown): DiscordVoiceConfig {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return DiscordVoiceConfigSchema.parse(input);
}
