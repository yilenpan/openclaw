/**
 * Generate a short "beeboop" acknowledgment tone as 48kHz stereo 16-bit PCM.
 *
 * Two sine-wave tones:
 *   - "bee"  ~100ms at 880Hz (A5)
 *   - gap    ~50ms silence
 *   - "boop" ~100ms at 440Hz (A4)
 *
 * Total ~250ms — returned as a Buffer ready for `conn.playPcm()`.
 */

const SAMPLE_RATE = 48_000;
const CHANNELS = 2; // stereo
const BYTES_PER_SAMPLE = 2; // 16-bit
const FRAME_SIZE = CHANNELS * BYTES_PER_SAMPLE; // 4 bytes per frame

const BEE_FREQ = 880; // Hz  (A5)
const BOOP_FREQ = 440; // Hz (A4)
const AMPLITUDE = 0.25; // keep it gentle

const BEE_MS = 100;
const GAP_MS = 50;
const BOOP_MS = 100;

function msToFrames(ms: number): number {
  return Math.round((SAMPLE_RATE * ms) / 1000);
}

function writeTone(buf: Buffer, offset: number, frames: number, freq: number): number {
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(AMPLITUDE * 32767 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE));
    // Write to both left and right channels (16-bit LE)
    buf.writeInt16LE(sample, offset);
    buf.writeInt16LE(sample, offset + 2);
    offset += FRAME_SIZE;
  }
  return offset;
}

function writeSilence(buf: Buffer, offset: number, frames: number): number {
  // Buffer.alloc fills with 0, but be explicit for partial writes
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(0, offset);
    buf.writeInt16LE(0, offset + 2);
    offset += FRAME_SIZE;
  }
  return offset;
}

export function generateBeeboop(): Buffer {
  const beeFrames = msToFrames(BEE_MS);
  const gapFrames = msToFrames(GAP_MS);
  const boopFrames = msToFrames(BOOP_MS);
  const totalFrames = beeFrames + gapFrames + boopFrames;

  const buf = Buffer.alloc(totalFrames * FRAME_SIZE);
  let offset = 0;
  offset = writeTone(buf, offset, beeFrames, BEE_FREQ);
  offset = writeSilence(buf, offset, gapFrames);
  writeTone(buf, offset, boopFrames, BOOP_FREQ);

  return buf;
}
