#!/bin/bash
# Wrapper that bridges whisper-cpp CLI args to Hailo whisper pipeline.
#
# stt-local-whisper.ts passes these exact args:
#   -m <modelPath> -l <language> -f <wavPath> -otxt -of <outputPrefix> --no-timestamps
#
# We parse all flags explicitly to avoid misalignment between
# paired flags (-m, -l, -f, -of take a value) and standalone flags (-otxt, --no-timestamps).
#
# Setup prerequisites:
#   1. HailoRT runtime installed on the Pi (provides /usr/lib/libhailort.so)
#   2. Hailo whisper model (HEF file) — downloaded automatically by hailo-apps,
#      or manually from https://hailo.ai/products/hailo-software/model-explorer/
#   3. Python environment with hailo-apps or your preferred Hailo whisper package
#   4. Test standalone first: ./hailo-whisper-wrapper.sh -f /path/to/test.wav

WAV_FILE=""
LANGUAGE="en"
MODEL_PATH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -f)  WAV_FILE="$2";   shift 2;;   # input WAV path (required)
    -l)  LANGUAGE="$2";   shift 2;;   # language code
    -m)  MODEL_PATH="$2"; shift 2;;   # model path (ignored by Hailo)
    -of) shift 2;;                     # output file prefix (ignored — we use stdout)
    -otxt|--no-timestamps) shift;;     # standalone flags (ignored)
    *)   shift;;                       # unknown flags
  esac
done

if [[ -z "$WAV_FILE" ]]; then
  echo "Error: no -f <wav_path> provided" >&2
  exit 1
fi

# Run Hailo whisper — adjust this command to match your Hailo setup.
# The transcription MUST be printed to stdout (stt-local-whisper.ts reads stdout as fallback).

# Option A: If using hailo-apps standalone whisper:
python3 -m app.app_hailo_whisper --hw-arch hailo8l --input "$WAV_FILE" --language "$LANGUAGE" 2>/dev/null

# Option B: If using a custom Hailo whisper script:
# python3 /path/to/your/hailo_transcribe.py "$WAV_FILE" --language "$LANGUAGE"

# Option C: If using the Hailo whisper FastAPI server as a sidecar:
# curl -s -X POST "http://localhost:8000/transcribe?language=$LANGUAGE" -F "file=@$WAV_FILE" | jq -r '.text'
