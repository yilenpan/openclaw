import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig, type DiscordVoiceConfig } from "./src/config.js";

const discordVoicePlugin = {
  id: "discord-voice",
  name: "Discord Voice",
  description: "Join Discord voice channels, listen via whisper.cpp, respond via TTS",
  configSchema: {
    parse(value: unknown) {
      return parseConfig(value);
    },
  },
  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig) as DiscordVoiceConfig;
    if (!config.enabled) {
      api.logger.info("[discord-voice] disabled via config");
      return;
    }

    api.logger.info("[discord-voice] registered");

    api.registerService({
      id: "discord-voice",
      async start(ctx) {
        ctx.logger.info("[discord-voice] service starting");

        // Lazy-import to avoid loading heavy deps when disabled
        const { createVoiceService } = await import("./src/voice-service.js");
        const service = createVoiceService({ config, api, ctx });
        await service.start();
      },
      async stop(ctx) {
        ctx.logger.info("[discord-voice] service stopping");
      },
    });
  },
};

export default discordVoicePlugin;
