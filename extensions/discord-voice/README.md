# discord-voice

OpenClaw plugin that joins Discord voice channels, listens to users speaking, detects a wake word, transcribes speech with local whisper.cpp, generates an LLM response, and speaks it back via TTS.

Designed to run on a Raspberry Pi with local STT (no cloud speech APIs required).

## Audio pipeline

```
Discord Voice Channel
  Inbound (per user):
    Opus packets -> decode -> PCM 48kHz stereo
      -> stereo-to-mono -> energy-based VAD -> silence detection
      -> downsample to 16kHz mono -> whisper.cpp transcribe -> text
      -> wake gate check -> strip wake word -> extract command
      -> LLM response generation

  Outbound (bot speaks):
    LLM text -> textToSpeechTelephony() -> PCM (24kHz or 22.05kHz mono)
      -> resample to 48kHz -> mono-to-stereo -> Discord AudioPlayer
```

## Config

Add to your OpenClaw config under `plugins`:

```yaml
plugins:
  discord-voice:
    enabled: true

    # Auto-join these voice channels on startup (optional).
    # If empty, use @bot mention in a text channel to join.
    autoJoinChannels:
      - guildId: "123456789"
        channelId: "987654321"

    wake:
      enabled: true # set false to respond to all speech
      words: ["hey claude", "claude"]

    stt:
      provider: "whisper-local"
      binaryPath: "whisper-cpp" # path to whisper-cpp binary (or wrapper script)
      modelPath: "/path/to/ggml-base.bin" # GGML model file
      modelSize: "base" # tiny | base | small
      language: "en"

    tts:
      provider: "openai" # openai | elevenlabs (inherits from main TTS config)

    session:
      maxDurationMinutes: 60
      silenceThresholdMs: 800 # silence gap to segment utterances
      vadEnergyThreshold: 0.01 # RMS energy below this = silence
```

The bot token is read from `channels.discord.token`, `channels.discord.accounts.default.token`, or the `DISCORD_BOT_TOKEN` environment variable.

Your Discord bot needs the **Guild Voice States** and **Guilds** intents enabled. If you want the `@bot join` text command, also enable **Guild Messages** and **Message Content** intents.

## Joining a voice channel

**Auto-join:** Configure `autoJoinChannels` with guild and channel IDs. The bot joins on startup.

**Text command:** Mention the bot in any text channel with a voice channel reference:

```
@bot <#voice-channel-id>
```

The bot will join the mentioned voice channel (or move to it if already connected in that guild).

## Whisper.cpp setup

Install [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and download a model:

```bash
# Build whisper.cpp
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp && make

# Download a model (tiny for speed, base for accuracy)
bash ./models/download-ggml-model.sh base
```

Set `stt.binaryPath` to the compiled `main` binary and `stt.modelPath` to the `.bin` file.

### Pi model recommendations

| Model | RAM    | Transcription time (5s audio, Pi 5) |
| ----- | ------ | ----------------------------------- |
| tiny  | ~75MB  | ~2-3s                               |
| base  | ~150MB | ~5-8s                               |
| small | ~500MB | ~15-20s                             |

Use `tiny` for responsiveness on Pi 4, `base` on Pi 5.

## Hailo NPU acceleration

If you have a Hailo AI accelerator (e.g. Hailo-8L on Pi AI HAT+), use the wrapper script in `custom-whisper/` to run whisper on the NPU instead of CPU:

```yaml
plugins:
  discord-voice:
    stt:
      binaryPath: "./extensions/discord-voice/custom-whisper/hailo-whisper-wrapper.sh"
      modelPath: "unused" # wrapper ignores this, but field is required by schema
      language: "en"
```

The wrapper parses the same CLI flags that `stt-local-whisper.ts` passes to whisper-cpp and routes them to the Hailo pipeline. Edit the script to point at your Hailo whisper installation.

Expected speedup: ~3-5x faster transcription (e.g. 5s audio in ~1s vs ~5s CPU-only with base model).

### Prerequisites

1. HailoRT runtime installed (`/usr/lib/libhailort.so`)
2. Hailo whisper model (HEF file)
3. Python environment with `hailo-apps` or equivalent
4. Test standalone: `./custom-whisper/hailo-whisper-wrapper.sh -f test.wav`

## File structure

```
extensions/discord-voice/
  package.json
  openclaw.plugin.json
  index.ts                        # Plugin registration, lazy-loads voice service
  src/
    config.ts                     # Zod config schema
    voice-service.ts              # Orchestrator: Discord client, pipeline wiring
    voice-connection.ts           # @discordjs/voice join/leave/audio streams
    user-stream.ts                # Per-user Opus decode, VAD, silence segmentation
    audio-pipeline.ts             # PCM resampling, stereo/mono conversion, RMS energy
    stt-local-whisper.ts          # whisper.cpp child process wrapper
    wake-gate.ts                  # Wake word detection (ported from SwabbleKit)
    session-manager.ts            # Per-guild state machine and transcript history
    response-generator.ts         # LLM response via embedded agent
    tts-bridge.ts                 # Core TTS -> 48kHz stereo PCM for Discord
    beeboop.ts                    # Short acknowledgment tone on wake word detection
    wake-gate.test.ts             # 16 tests
    audio-pipeline.test.ts        # 13 tests
    stt-local-whisper.test.ts     # 3 tests
  custom-whisper/
    hailo-whisper-wrapper.sh      # Bridges whisper-cpp CLI args to Hailo NPU
```

## Pi-specific notes

- **Opus native bindings:** `@discordjs/opus` compiles libopus via node-gyp. On ARM this should work out of the box. If compilation fails, `opusscript` is a pure-JS fallback (add it to package.json and it will be picked up automatically by `prism-media`).
- **Memory:** whisper-base needs ~150MB. Pi 4 (2GB+) is fine. Pi Zero will not work.
- **Disk:** Models: tiny=75MB, base=150MB, small=500MB.
- **Auto-reconnect:** The bot automatically attempts to reconnect on voice connection drops.
- **Session timeout:** Sessions are cleaned up after `maxDurationMinutes` (default 60).

## Running tests

```bash
pnpm vitest run extensions/discord-voice
```
