/**
 * Voice service — wires all components into the full pipeline:
 *
 *   Discord audio → Opus decode → PCM → silence detect → whisper STT
 *     → wake gate → LLM → TTS → PCM → Opus encode → Discord playback
 */

import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { VoiceConnectionStatus, entersState } from "@discordjs/voice";
import { ChannelType, Client, Events, GatewayIntentBits, type VoiceState } from "discord.js";
import type { DiscordVoiceConfig } from "./config.js";
import { generateBeeboop } from "./beeboop.js";
import { generateResponse } from "./response-generator.js";
import { SessionManager, transitionState, addTranscriptEntry } from "./session-manager.js";
import { transcribe } from "./stt-local-whisper.js";
import { textToDiscordPcm, type TtsRuntime } from "./tts-bridge.js";
import { UserStreamManager } from "./user-stream.js";
import { connectToVoiceChannel, type VoiceChannelConnection } from "./voice-connection.js";
import { matchesTextOnly, stripWake } from "./wake-gate.js";

export type VoiceServiceParams = {
  config: DiscordVoiceConfig;
  api: OpenClawPluginApi;
  ctx: OpenClawPluginServiceContext;
};

export function createVoiceService(params: VoiceServiceParams) {
  const { config, api, ctx } = params;
  const sessionManager = new SessionManager();
  const connections = new Map<string, VoiceChannelConnection>();
  const userStreams = new Map<string, UserStreamManager>();
  let client: Client | null = null;
  let sessionTimeoutInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Resolve the Discord bot token from config or environment.
   */
  function getToken(): string {
    const cfg = api.config as Record<string, any>;
    const discordCfg = cfg?.channels?.discord;

    // Check account token
    const defaultAccount = discordCfg?.accounts?.default;
    const accountToken = defaultAccount?.token?.trim();
    if (accountToken) return accountToken.replace(/^Bot\s+/i, "");

    // Check top-level discord token
    const topToken = discordCfg?.token?.trim();
    if (topToken) return topToken.replace(/^Bot\s+/i, "");

    // Check environment
    const envToken = process.env.DISCORD_BOT_TOKEN?.trim();
    if (envToken) return envToken.replace(/^Bot\s+/i, "");

    throw new Error(
      "[discord-voice] No Discord bot token found. Set channels.discord.token or DISCORD_BOT_TOKEN.",
    );
  }

  /**
   * Process a completed user utterance through the pipeline:
   * wake check → STT → LLM → TTS → speak
   */
  async function handleUtterance(
    guildId: string,
    userId: string,
    pcm16kMono: Buffer,
    durationMs: number,
  ): Promise<void> {
    const session = sessionManager.getSession(guildId);
    const conn = connections.get(guildId);
    if (!session || !conn) return;

    ctx.logger.info(
      `[discord-voice] user ${userId}: received ${(durationMs / 1000).toFixed(1)}s of audio`,
    );

    // Queue if bot is busy
    if (session.state === "generating" || session.state === "speaking") {
      ctx.logger.info(`[discord-voice] user ${userId}: bot busy (${session.state}), skipping`);
      return;
    }

    // Transcribe
    transitionState(session, "transcribing");
    ctx.logger.info(`[discord-voice] ${guildId}: idle → listening → transcribing`);

    let text: string;
    try {
      const sttResult = await transcribe(pcm16kMono, {
        modelPath: config.stt.modelPath ?? "",
        binaryPath: config.stt.binaryPath,
        language: config.stt.language,
        timeoutMs: 30_000,
      });
      text = sttResult.text;
      ctx.logger.info(
        `[discord-voice] transcribed (${sttResult.durationMs}ms): "${text.substring(0, 100)}"`,
      );
    } catch (err) {
      ctx.logger.error(`[discord-voice] STT failed: ${String(err)}`);
      transitionState(session, "listening");
      return;
    }

    if (!text.trim()) {
      transitionState(session, "listening");
      return;
    }

    // Wake word check
    if (config.wake.enabled) {
      if (!matchesTextOnly(text, config.wake.words)) {
        ctx.logger.info(`[discord-voice] no wake word detected, ignoring`);
        transitionState(session, "listening");
        return;
      }
      // Strip wake word to get the command
      text = stripWake(text, config.wake.words);
      if (!text.trim()) {
        ctx.logger.info(`[discord-voice] wake word detected but no command`);
        transitionState(session, "listening");
        return;
      }
    }

    // Play beeboop acknowledgment so the user knows the bot heard them
    try {
      await conn.playPcm(generateBeeboop());
    } catch (err) {
      ctx.logger.warn(`[discord-voice] beeboop playback failed: ${String(err)}`);
    }

    addTranscriptEntry(session, "user", text, userId);

    // Generate LLM response
    transitionState(session, "generating");
    ctx.logger.info(`[discord-voice] generating response for: "${text.substring(0, 80)}"`);

    const response = await generateResponse(text, session.transcript, {
      runtime: api.runtime as any,
      config: api.config,
      agentId: undefined,
    });

    if (!response.text) {
      ctx.logger.warn(`[discord-voice] no response generated: ${response.error ?? "empty"}`);
      transitionState(session, "listening");
      return;
    }

    addTranscriptEntry(session, "bot", response.text);

    // TTS and speak
    transitionState(session, "speaking");
    ctx.logger.info(`[discord-voice] speaking: "${response.text.substring(0, 80)}"`);

    try {
      const ttsResult = await textToDiscordPcm(response.text, {
        runtime: api.runtime.tts as TtsRuntime,
        coreConfig: api.config,
      });
      await conn.playPcm(ttsResult.pcm48kStereo);
    } catch (err) {
      ctx.logger.error(`[discord-voice] TTS/playback failed: ${String(err)}`);
    }

    transitionState(session, "listening");
    ctx.logger.info(`[discord-voice] ${guildId}: back to listening`);

    // Process any queued requests
    const pending = sessionManager.popPendingRequest(guildId);
    if (pending) {
      ctx.logger.info(`[discord-voice] processing queued request from ${pending.userId}`);
      addTranscriptEntry(session, "user", pending.text, pending.userId);
      transitionState(session, "generating");

      const queuedResponse = await generateResponse(pending.text, session.transcript, {
        runtime: api.runtime as any,
        config: api.config,
      });

      if (queuedResponse.text) {
        addTranscriptEntry(session, "bot", queuedResponse.text);
        transitionState(session, "speaking");
        try {
          const ttsResult = await textToDiscordPcm(queuedResponse.text, {
            runtime: api.runtime.tts as TtsRuntime,
            coreConfig: api.config,
          });
          await conn.playPcm(ttsResult.pcm48kStereo);
        } catch (err) {
          ctx.logger.error(`[discord-voice] queued TTS failed: ${String(err)}`);
        }
      }
      transitionState(session, "listening");
    }
  }

  /**
   * Subscribe to a user's audio in a guild, wiring packets into the UserStreamManager.
   */
  function subscribeUserAudio(guildId: string, userId: string): void {
    const conn = connections.get(guildId);
    const streamMgr = userStreams.get(guildId);
    if (!conn || !streamMgr) return;

    const opusStream = conn.subscribeUser(userId);
    if (!opusStream) return;

    opusStream.on("data", (chunk: Buffer) => {
      streamMgr.pushOpusPacket(userId, chunk);
    });

    opusStream.on("end", () => {
      ctx.logger.info(`[discord-voice] user ${userId} audio stream ended in guild ${guildId}`);
    });

    ctx.logger.info(`[discord-voice] subscribed to user ${userId} audio in guild ${guildId}`);
  }

  /**
   * Join a voice channel and start listening.
   */
  async function joinChannel(guildId: string, channelId: string): Promise<void> {
    if (!client) throw new Error("[discord-voice] Client not ready");

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      throw new Error(`[discord-voice] Guild ${guildId} not found — is the bot a member?`);
    }

    // Create per-guild UserStreamManager
    const streamMgr = new UserStreamManager({
      silenceThresholdMs: config.session.silenceThresholdMs,
      vadEnergyThreshold: config.session.vadEnergyThreshold,
      onUtterance: (userId, pcm16kMono, durationMs) => {
        handleUtterance(guildId, userId, pcm16kMono, durationMs).catch((err) => {
          ctx.logger.error(`[discord-voice] utterance handling error: ${String(err)}`);
        });
      },
    });
    userStreams.set(guildId, streamMgr);

    // Connect to voice channel
    const conn = await connectToVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    connections.set(guildId, conn);

    // Listen for auto-reconnect on disconnect
    conn.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      ctx.logger.warn(
        `[discord-voice] disconnected from guild ${guildId}, attempting reconnect...`,
      );
      try {
        // Wait for either reconnecting or disconnected state
        await Promise.race([
          entersState(conn.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnecting — wait for ready
        await entersState(conn.connection, VoiceConnectionStatus.Ready, 15_000);
        ctx.logger.info(`[discord-voice] reconnected to guild ${guildId}`);
      } catch {
        ctx.logger.error(`[discord-voice] reconnect failed for guild ${guildId}, destroying`);
        conn.destroy();
        connections.delete(guildId);
        streamMgr.destroy();
        userStreams.delete(guildId);
        sessionManager.removeSession(guildId);
      }
    });

    // Subscribe to users already in the voice channel
    const channel = guild.channels.cache.get(channelId);
    if (channel?.isVoiceBased()) {
      for (const [memberId, member] of channel.members) {
        if (!member.user.bot) {
          subscribeUserAudio(guildId, memberId);
        }
      }
    }

    // Create session and transition to listening
    const session = sessionManager.getOrCreateSession(guildId, channelId);
    transitionState(session, "listening");

    ctx.logger.info(`[discord-voice] joined guild=${guildId} channel=${channelId}`);
  }

  /**
   * Check for expired sessions and clean them up.
   */
  function checkSessionTimeouts(): void {
    const maxDurationMs = config.session.maxDurationMinutes * 60_000;
    for (const [guildId, conn] of connections) {
      if (sessionManager.isExpired(guildId, maxDurationMs)) {
        ctx.logger.info(
          `[discord-voice] session expired for guild ${guildId} (>${config.session.maxDurationMinutes}min)`,
        );
        const streamMgr = userStreams.get(guildId);
        streamMgr?.flushAll();
        streamMgr?.destroy();
        userStreams.delete(guildId);
        conn.destroy();
        connections.delete(guildId);
        sessionManager.removeSession(guildId);
      }
    }
  }

  return {
    async start() {
      const token = getToken();
      ctx.logger.info(`[discord-voice] service starting (token resolved)`);

      // Create a minimal Discord.js Client for voice adapter
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      // Handle voice state updates (user join/leave)
      client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
        const guildId = newState.guild.id;
        const userId = newState.member?.id;
        if (!userId || newState.member?.user.bot) return;

        const conn = connections.get(guildId);
        if (!conn) return;

        // User joined or moved to our channel
        if (newState.channelId === conn.channelId && oldState.channelId !== conn.channelId) {
          ctx.logger.info(
            `[discord-voice] user ${userId} joined voice channel in guild ${guildId}`,
          );
          subscribeUserAudio(guildId, userId);
        }

        // User left our channel
        if (oldState.channelId === conn.channelId && newState.channelId !== conn.channelId) {
          ctx.logger.info(`[discord-voice] user ${userId} left voice channel in guild ${guildId}`);
          const streamMgr = userStreams.get(guildId);
          streamMgr?.removeUser(userId);
        }
      });

      // Handle text messages: "@bot join <channelId>"
      client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot || !message.guild || !client?.user) return;
        if (!message.mentions.has(client.user)) return;

        const content = message.content;

        // Extract a voice channel ID from: channel mention <#id> or raw snowflake
        const channelMentionMatch = content.match(/<#(\d{17,20})>/);
        const rawSnowflakeMatch = content.match(/\b(\d{17,20})\b/);
        const targetChannelId = channelMentionMatch?.[1] ?? rawSnowflakeMatch?.[1];

        if (!targetChannelId) {
          await message.reply(
            "Please mention a voice channel or provide a channel ID. Example: `@bot join <#channelId>`",
          );
          return;
        }

        // Validate target is a voice/stage channel in this guild
        const channel = message.guild.channels.cache.get(targetChannelId);
        if (!channel) {
          await message.reply(`Channel ${targetChannelId} not found in this server.`);
          return;
        }
        if (
          channel.type !== ChannelType.GuildVoice &&
          channel.type !== ChannelType.GuildStageVoice
        ) {
          await message.reply(`<#${targetChannelId}> is not a voice or stage channel.`);
          return;
        }

        const guildId = message.guild.id;

        try {
          // Disconnect from existing voice channel in this guild if any
          const existingConn = connections.get(guildId);
          if (existingConn) {
            ctx.logger.info(
              `[discord-voice] disconnecting from existing channel in guild ${guildId}`,
            );
            const streamMgr = userStreams.get(guildId);
            streamMgr?.flushAll();
            streamMgr?.destroy();
            userStreams.delete(guildId);
            existingConn.destroy();
            connections.delete(guildId);
            sessionManager.removeSession(guildId);
          }

          await joinChannel(guildId, targetChannelId);
          await message.reply(`Joining <#${targetChannelId}>`);
        } catch (err) {
          ctx.logger.error(`[discord-voice] failed to join via text command: ${String(err)}`);
          await message.reply(`Failed to join <#${targetChannelId}>: ${String(err)}`);
        }
      });

      // Wait for client to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("[discord-voice] Client login timed out after 30s"));
        }, 30_000);

        client!.once(Events.ClientReady, () => {
          clearTimeout(timeout);
          ctx.logger.info(`[discord-voice] Discord client ready as ${client!.user?.tag}`);
          resolve();
        });

        client!.once(Events.Error, (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        client!.login(token).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Auto-join configured channels
      for (const chan of config.autoJoinChannels) {
        try {
          await joinChannel(chan.guildId, chan.channelId);
        } catch (err) {
          ctx.logger.error(
            `[discord-voice] Failed to join ${chan.guildId}/${chan.channelId}: ${String(err)}`,
          );
        }
      }

      if (config.autoJoinChannels.length === 0) {
        ctx.logger.info(
          "[discord-voice] no autoJoinChannels configured — use slash command to join",
        );
      }

      // Start session timeout checker
      sessionTimeoutInterval = setInterval(checkSessionTimeouts, 60_000);
    },

    async stop() {
      if (sessionTimeoutInterval) {
        clearInterval(sessionTimeoutInterval);
        sessionTimeoutInterval = null;
      }

      for (const [guildId, conn] of connections) {
        const stream = userStreams.get(guildId);
        stream?.flushAll();
        stream?.destroy();
        conn.destroy();
        sessionManager.removeSession(guildId);
      }
      connections.clear();
      userStreams.clear();

      if (client) {
        client.destroy();
        client = null;
      }

      ctx.logger.info("[discord-voice] service stopped");
    },

    // Expose for testing / external integration
    sessionManager,
    handleUtterance,
    joinChannel,
  };
}
