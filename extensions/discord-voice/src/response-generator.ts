/**
 * LLM response generation for voice interactions.
 *
 * Thin wrapper that formats the transcript and invokes the core agent pipeline
 * via the plugin runtime, similar to voice-call/src/response-generator.ts.
 */

import type { TranscriptEntry } from "./session-manager.js";

export type ResponseGeneratorDeps = {
  /** The plugin runtime for running embedded agent. */
  runtime: {
    runEmbeddedPiAgent?: (params: {
      sessionId: string;
      sessionKey: string;
      messageProvider: string;
      prompt: string;
      provider?: string;
      model?: string;
      extraSystemPrompt?: string;
      timeoutMs?: number;
      lane?: string;
      [key: string]: unknown;
    }) => Promise<{
      payloads?: Array<{ text?: string; isError?: boolean }>;
      meta?: { aborted?: boolean };
    }>;
  };
  config: unknown;
  agentId?: string;
};

export type GenerateResponseResult = {
  text: string | null;
  error?: string;
};

/**
 * Build a system prompt incorporating transcript history.
 */
function buildSystemPrompt(transcript: TranscriptEntry[], agentName: string): string {
  const basePrompt = `You are ${agentName}, a helpful voice assistant in a Discord voice channel. Keep responses brief and conversational (1-3 sentences). Be natural and friendly.`;

  if (transcript.length === 0) return basePrompt;

  const history = transcript
    .slice(-20) // Keep last 20 entries to avoid context overflow
    .map(
      (entry) =>
        `${entry.speaker === "bot" ? "You" : `User${entry.userId ? ` <@${entry.userId}>` : ""}`}: ${entry.text}`,
    )
    .join("\n");

  return `${basePrompt}\n\nConversation so far:\n${history}`;
}

/**
 * Generate an LLM response for the given user message.
 */
export async function generateResponse(
  userMessage: string,
  transcript: TranscriptEntry[],
  deps: ResponseGeneratorDeps,
): Promise<GenerateResponseResult> {
  if (!deps.runtime.runEmbeddedPiAgent) {
    // Fallback: return a simple acknowledgment if no agent runtime available
    return { text: `I heard you say: "${userMessage}". The agent runtime is not available.` };
  }

  const sessionKey = `discord-voice:${deps.agentId ?? "default"}`;
  const sessionId = `discord-voice-${Date.now()}`;
  const systemPrompt = buildSystemPrompt(transcript, "Claude");

  try {
    const result = await deps.runtime.runEmbeddedPiAgent({
      sessionId,
      sessionKey,
      messageProvider: "discord-voice",
      prompt: userMessage,
      extraSystemPrompt: systemPrompt,
      timeoutMs: 30_000,
      lane: "discord-voice",
    });

    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const text = texts.join(" ") || null;

    if (!text && result.meta?.aborted) {
      return { text: null, error: "Response generation was aborted" };
    }

    return { text };
  } catch (err) {
    return { text: null, error: String(err) };
  }
}
