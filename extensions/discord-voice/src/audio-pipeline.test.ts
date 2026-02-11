import { describe, expect, it } from "vitest";
import { resamplePcm, stereoToMono, monoToStereo, computeRmsEnergy } from "./audio-pipeline.js";

/** Create a mono 16-bit PCM buffer with a constant sample value. */
function monoSamples(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    buf.writeInt16LE(values[i], i * 2);
  }
  return buf;
}

/** Create an interleaved stereo 16-bit PCM buffer. */
function stereoSamples(frames: [number, number][]): Buffer {
  const buf = Buffer.alloc(frames.length * 4);
  for (let i = 0; i < frames.length; i++) {
    buf.writeInt16LE(frames[i][0], i * 4);
    buf.writeInt16LE(frames[i][1], i * 4 + 2);
  }
  return buf;
}

describe("resamplePcm", () => {
  it("returns same buffer when rates match", () => {
    const input = monoSamples([100, 200, 300]);
    const output = resamplePcm(input, 48000, 48000);
    expect(output).toBe(input); // identity
  });

  it("downsamples 48kHz → 16kHz (output ~1/3 of input length)", () => {
    const inputSamples = 4800;
    const input = Buffer.alloc(inputSamples * 2);
    for (let i = 0; i < inputSamples; i++) {
      input.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 16000), i * 2);
    }
    const output = resamplePcm(input, 48000, 16000);
    const outputSamples = output.length / 2;
    // Should be roughly 1/3 of input samples
    expect(outputSamples).toBe(1600);
  });

  it("upsamples 16kHz → 48kHz (output ~3x input length)", () => {
    const inputSamples = 1600;
    const input = Buffer.alloc(inputSamples * 2);
    for (let i = 0; i < inputSamples; i++) {
      input.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 16000), i * 2);
    }
    const output = resamplePcm(input, 16000, 48000);
    const outputSamples = output.length / 2;
    expect(outputSamples).toBe(4800);
  });

  it("handles empty buffer", () => {
    expect(resamplePcm(Buffer.alloc(0), 48000, 16000).length).toBe(0);
  });

  it("round-trip preserves approximate signal", () => {
    // Create a 440Hz sine wave at 48kHz
    const nSamples = 4800;
    const input = Buffer.alloc(nSamples * 2);
    for (let i = 0; i < nSamples; i++) {
      input.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 16000), i * 2);
    }
    // Down to 16k then back up to 48k
    const down = resamplePcm(input, 48000, 16000);
    const up = resamplePcm(down, 16000, 48000);

    // Signal should be similar (not identical due to interpolation loss)
    let maxDiff = 0;
    const compareLen = Math.min(input.length, up.length) / 2;
    for (let i = 0; i < compareLen; i++) {
      const diff = Math.abs(input.readInt16LE(i * 2) - up.readInt16LE(i * 2));
      if (diff > maxDiff) maxDiff = diff;
    }
    // Expect max difference to be reasonable (< 10% of max amplitude)
    expect(maxDiff).toBeLessThan(3200);
  });
});

describe("stereoToMono", () => {
  it("averages left and right channels", () => {
    const input = stereoSamples([
      [1000, 3000],
      [-1000, 1000],
    ]);
    const output = stereoToMono(input);
    expect(output.length).toBe(4); // 2 samples * 2 bytes
    expect(output.readInt16LE(0)).toBe(2000);
    expect(output.readInt16LE(2)).toBe(0);
  });

  it("output length is half of input", () => {
    const input = stereoSamples(Array.from({ length: 100 }, () => [100, 200] as [number, number]));
    expect(stereoToMono(input).length).toBe(input.length / 2);
  });

  it("handles empty buffer", () => {
    expect(stereoToMono(Buffer.alloc(0)).length).toBe(0);
  });
});

describe("monoToStereo", () => {
  it("duplicates mono to both channels", () => {
    const input = monoSamples([1000, -500]);
    const output = monoToStereo(input);
    expect(output.length).toBe(8); // 2 frames * 4 bytes
    expect(output.readInt16LE(0)).toBe(1000); // L
    expect(output.readInt16LE(2)).toBe(1000); // R
    expect(output.readInt16LE(4)).toBe(-500); // L
    expect(output.readInt16LE(6)).toBe(-500); // R
  });
});

describe("computeRmsEnergy", () => {
  it("returns 0 for silence", () => {
    const silence = monoSamples(Array.from({ length: 100 }, () => 0));
    expect(computeRmsEnergy(silence)).toBe(0);
  });

  it("returns high value for loud signal", () => {
    const loud = monoSamples(Array.from({ length: 100 }, () => 16000));
    const energy = computeRmsEnergy(loud);
    expect(energy).toBeGreaterThan(0.4);
  });

  it("low-amplitude signal has lower energy than high-amplitude", () => {
    const low = monoSamples(Array.from({ length: 100 }, () => 100));
    const high = monoSamples(Array.from({ length: 100 }, () => 10000));
    expect(computeRmsEnergy(low)).toBeLessThan(computeRmsEnergy(high));
  });

  it("returns 0 for empty buffer", () => {
    expect(computeRmsEnergy(Buffer.alloc(0))).toBe(0);
  });
});
