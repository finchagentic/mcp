import { describe, it, expect } from "vitest";
import { dedupClinkInput } from "../src/clink-input.js";

describe("dedupClinkInput", () => {
  it("collapses an exactly-doubled string to its first half", () => {
    expect(dedupClinkInput("finch_sk_xxfinch_sk_xx")).toBe("finch_sk_xx");
    expect(dedupClinkInput("22")).toBe("2");
    expect(dedupClinkInput("aa")).toBe("a");
  });

  it("leaves non-doubled input untouched", () => {
    expect(dedupClinkInput("finch_sk_abc123")).toBe("finch_sk_abc123");
    expect(dedupClinkInput("1")).toBe("1");
    expect(dedupClinkInput("abc")).toBe("abc");
  });

  it("does not falsely collapse even-length input that merely happens to repeat", () => {
    // "abab" halves are "ab"/"ab" - genuinely doubled, should collapse
    expect(dedupClinkInput("abab")).toBe("ab");
    // "abcd" halves are "ab"/"cd" - not doubled, must be left alone
    expect(dedupClinkInput("abcd")).toBe("abcd");
  });

  it("handles empty input without throwing", () => {
    expect(dedupClinkInput("")).toBe("");
  });
});
