/**
 * Discord voice connection management.
 *
 * Uses @discordjs/voice to join voice channels, subscribe to per-user audio
 * streams via VoiceReceiver, and create an AudioPlayer for TTS output.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
  StreamType,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import { Readable } from "node:stream";

export type VoiceConnectionConfig = {
  guildId: string;
  channelId: string;
  /** The Discord bot adapter creator — obtained from the discord.js Client. */
  adapterCreator: Parameters<typeof joinVoiceChannel>[0]["adapterCreator"];
  selfDeaf?: boolean;
};

export type VoiceChannelConnection = {
  connection: VoiceConnection;
  player: AudioPlayer;
  guildId: string;
  channelId: string;
  /** Subscribe to a user's audio stream. Returns the Opus readable or null. */
  subscribeUser: (userId: string) => AudioReceiveStream | undefined;
  /** Play a PCM buffer (48kHz stereo) through the bot. */
  playPcm: (pcm: Buffer) => Promise<void>;
  /** Disconnect and cleanup. */
  destroy: () => void;
};

/**
 * Join a Discord voice channel and return a managed connection.
 */
export async function connectToVoiceChannel(
  config: VoiceConnectionConfig,
): Promise<VoiceChannelConnection> {
  const connection = joinVoiceChannel({
    channelId: config.channelId,
    guildId: config.guildId,
    adapterCreator: config.adapterCreator,
    selfDeaf: config.selfDeaf ?? false,
  });

  // Wait for connection to be ready
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    throw new Error(
      `Failed to connect to voice channel ${config.channelId} in guild ${config.guildId}`,
    );
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  connection.subscribe(player);

  const subscribeUser = (userId: string): AudioReceiveStream | undefined => {
    return connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
  };

  const playPcm = (pcm: Buffer): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const stream = Readable.from([pcm]);
      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
      });

      player.play(resource);

      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        player.removeListener(AudioPlayerStatus.Idle, onIdle);
        player.removeListener("error", onError);
      };

      player.on(AudioPlayerStatus.Idle, onIdle);
      player.on("error", onError);
    });
  };

  const destroy = () => {
    player.stop();
    connection.destroy();
  };

  return {
    connection,
    player,
    guildId: config.guildId,
    channelId: config.channelId,
    subscribeUser,
    playPcm,
    destroy,
  };
}
