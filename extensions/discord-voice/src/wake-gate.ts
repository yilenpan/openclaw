/**
 * Wake word detection — ported from Swabble/Sources/SwabbleKit/WakeWordGate.swift.
 *
 * We only port the text-only matching path (`matchesTextOnly` and `stripWake`)
 * because whisper.cpp doesn't provide reliable word-level timestamps for the
 * segment-timing gap detection the Swift version uses.
 */

const STRIP_RE = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

function trimPunctuation(s: string): string {
  return s.replace(STRIP_RE, "");
}

/**
 * Check whether `text` contains any of the given wake `triggers`.
 *
 * Matching is case-insensitive and uses substring containment (not word-boundary
 * matching), mirroring the Swift `matchesTextOnly` implementation.
 */
export function matchesTextOnly(text: string, triggers: string[]): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  for (const trigger of triggers) {
    const token = trimPunctuation(trigger).toLowerCase();
    if (!token) continue;
    if (normalized.includes(token)) return true;
  }
  return false;
}

/**
 * Remove all wake-word trigger occurrences from `text` and return the remaining
 * command portion (trimmed of surrounding whitespace and punctuation).
 *
 * Case-insensitive replacement, matching the Swift `stripWake` implementation.
 */
export function stripWake(text: string, triggers: string[]): string {
  let out = text;
  for (const trigger of triggers) {
    const token = trimPunctuation(trigger);
    if (!token) continue;
    // Global, case-insensitive replacement (escape regex specials in token).
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "");
  }
  return trimPunctuation(out);
}
