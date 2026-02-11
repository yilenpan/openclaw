import { describe, expect, it } from "vitest";
import { matchesTextOnly, stripWake } from "./wake-gate.js";

describe("matchesTextOnly", () => {
  it("matches when trigger is present", () => {
    expect(matchesTextOnly("claude hello world", ["claude"])).toBe(true);
  });

  it("does not match when trigger is absent", () => {
    expect(matchesTextOnly("hello world", ["claude"])).toBe(false);
  });

  it("matches any of multiple triggers", () => {
    expect(matchesTextOnly("hey clawd what time is it", ["claude", "clawd"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesTextOnly("Hey CLAUDE", ["claude"])).toBe(true);
  });

  it("returns false for empty text", () => {
    expect(matchesTextOnly("", ["claude"])).toBe(false);
  });

  it("returns false for whitespace-only text", () => {
    expect(matchesTextOnly("   ", ["claude"])).toBe(false);
  });

  it("skips empty triggers", () => {
    expect(matchesTextOnly("hello", ["", "  "])).toBe(false);
  });

  it("handles multi-word triggers", () => {
    expect(matchesTextOnly("hey claude do something", ["hey claude"])).toBe(true);
  });

  it("handles punctuation around trigger in text", () => {
    expect(matchesTextOnly("hello, claude! what's up", ["claude"])).toBe(true);
  });
});

describe("stripWake", () => {
  it("removes the trigger and returns the command", () => {
    expect(stripWake("claude hello world", ["claude"])).toBe("hello world");
  });

  it("removes multiple trigger variants", () => {
    expect(stripWake("hey clawd hello", ["claude", "clawd", "hey"])).toBe("hello");
  });

  it("is case-insensitive", () => {
    expect(stripWake("CLAUDE hello", ["claude"])).toBe("hello");
  });

  it("trims punctuation from result", () => {
    expect(stripWake("claude, what time is it?", ["claude"])).toBe("what time is it");
  });

  it("handles no matching trigger gracefully", () => {
    expect(stripWake("hello world", ["claude"])).toBe("hello world");
  });

  it("handles text that is only the trigger", () => {
    expect(stripWake("claude", ["claude"])).toBe("");
  });

  it("removes all occurrences of the trigger", () => {
    expect(stripWake("claude say claude again", ["claude"])).toBe("say  again");
  });
});
