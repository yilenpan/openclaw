/**
 * Per-guild voice session state machine.
 *
 * Adapted from voice-call/src/manager/state.ts patterns:
 * - Linear state progression with conversational cycling
 * - TranscriptEntry tracking
 * - Concurrent request queuing
 */

export type VoiceSessionState =
  | "idle"
  | "listening"
  | "transcribing"
  | "generating"
  | "speaking"
  | "disconnected";

const TerminalStates = new Set<VoiceSessionState>(["disconnected"]);
const ConversationStates = new Set<VoiceSessionState>([
  "listening",
  "transcribing",
  "generating",
  "speaking",
]);

const StateOrder: readonly VoiceSessionState[] = [
  "idle",
  "listening",
  "transcribing",
  "generating",
  "speaking",
];

export type TranscriptEntry = {
  timestamp: number;
  speaker: "bot" | "user";
  userId?: string;
  text: string;
};

export type VoiceSession = {
  guildId: string;
  channelId: string;
  state: VoiceSessionState;
  transcript: TranscriptEntry[];
  startedAt: number;
  /** Queued requests while bot is speaking/generating. */
  pendingRequests: Array<{ userId: string; text: string }>;
};

/**
 * Transition a session to a new state, enforcing ordering rules.
 */
export function transitionState(session: VoiceSession, newState: VoiceSessionState): boolean {
  if (session.state === newState || TerminalStates.has(session.state)) {
    return false;
  }

  if (TerminalStates.has(newState)) {
    session.state = newState;
    return true;
  }

  // Allow cycling between conversation states
  if (ConversationStates.has(session.state) && ConversationStates.has(newState)) {
    session.state = newState;
    return true;
  }

  // Only allow forward transitions
  const currentIdx = StateOrder.indexOf(session.state);
  const newIdx = StateOrder.indexOf(newState);
  if (newIdx > currentIdx) {
    session.state = newState;
    return true;
  }

  return false;
}

export function addTranscriptEntry(
  session: VoiceSession,
  speaker: "bot" | "user",
  text: string,
  userId?: string,
): void {
  session.transcript.push({
    timestamp: Date.now(),
    speaker,
    userId,
    text,
  });
}

export function createSession(guildId: string, channelId: string): VoiceSession {
  return {
    guildId,
    channelId,
    state: "idle",
    transcript: [],
    startedAt: Date.now(),
    pendingRequests: [],
  };
}

/**
 * Manages voice sessions across multiple guilds.
 */
export class SessionManager {
  private sessions = new Map<string, VoiceSession>();

  getSession(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  getOrCreateSession(guildId: string, channelId: string): VoiceSession {
    let session = this.sessions.get(guildId);
    if (!session) {
      session = createSession(guildId, channelId);
      this.sessions.set(guildId, session);
    }
    return session;
  }

  removeSession(guildId: string): void {
    this.sessions.delete(guildId);
  }

  /**
   * Check if the session has exceeded the max duration.
   */
  isExpired(guildId: string, maxDurationMs: number): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    return Date.now() - session.startedAt > maxDurationMs;
  }

  /**
   * Queue a request if the bot is busy generating/speaking.
   */
  queueRequest(guildId: string, userId: string, text: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    if (session.state === "generating" || session.state === "speaking") {
      session.pendingRequests.push({ userId, text });
      return true;
    }
    return false;
  }

  /**
   * Pop the next pending request.
   */
  popPendingRequest(guildId: string): { userId: string; text: string } | undefined {
    const session = this.sessions.get(guildId);
    if (!session) return undefined;
    return session.pendingRequests.shift();
  }
}
