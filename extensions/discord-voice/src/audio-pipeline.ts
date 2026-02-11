/**
 * Pure audio processing utilities for Discord voice.
 *
 * PCM is always 16-bit signed little-endian (Int16LE).
 */

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

/**
 * Resample 16-bit PCM mono using linear interpolation.
 * Adapted from voice-call/src/telephony-audio.ts `resamplePcmTo8k` but
 * generalised to arbitrary source/target sample rates.
 */
export function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;

  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);

  const ratio = fromRate / toRate;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input.readInt16LE(srcIndex * 2);
    const s1Index = Math.min(srcIndex + 1, inputSamples - 1);
    const s1 = input.readInt16LE(s1Index * 2);

    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

/**
 * Convert interleaved stereo 16-bit PCM to mono by averaging left/right channels.
 */
export function stereoToMono(input: Buffer): Buffer {
  // Stereo: 2 samples (4 bytes) per frame
  const frames = Math.floor(input.length / 4);
  if (frames === 0) return Buffer.alloc(0);

  const output = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const left = input.readInt16LE(i * 4);
    const right = input.readInt16LE(i * 4 + 2);
    const mono = Math.round((left + right) / 2);
    output.writeInt16LE(clamp16(mono), i * 2);
  }
  return output;
}

/**
 * Convert mono 16-bit PCM to interleaved stereo (duplicate mono to both channels).
 */
export function monoToStereo(input: Buffer): Buffer {
  const samples = Math.floor(input.length / 2);
  if (samples === 0) return Buffer.alloc(0);

  const output = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const sample = input.readInt16LE(i * 2);
    output.writeInt16LE(sample, i * 4);
    output.writeInt16LE(sample, i * 4 + 2);
  }
  return output;
}

/**
 * Compute RMS (root-mean-square) energy of a 16-bit PCM buffer.
 * Returns a value in [0, 1] where 0 is silence and 1 is max amplitude.
 */
export function computeRmsEnergy(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}
