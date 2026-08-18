import { describe, it, expect } from "vitest";
import { meaningfulTerms, wordOccurrences } from "../src/_text-search.js";

// Regression coverage for the bug found live-testing memory_add's 4.6.0
// conflict-hint feature: raw substring counting let short stop words like
// "is"/"the" match inside unrelated words ("is" inside "distances"),
// causing two completely unrelated memories to register as "related".

describe("meaningfulTerms", () => {
  it("drops stop words entirely", () => {
    expect(meaningfulTerms("is the a to of")).toEqual([]);
  });

  it("keeps real content words, lowercased, punctuation stripped", () => {
    expect(meaningfulTerms("The user's favorite pizza topping is pepperoni.")).toEqual([
      "user", "favorite", "pizza", "topping", "pepperoni",
    ]);
  });

  it("drops single-character tokens", () => {
    expect(meaningfulTerms("a b I x")).toEqual([]);
  });
});

describe("wordOccurrences", () => {
  it("does not match a term as a substring of an unrelated word", () => {
    // "is" must not match inside "distances" or "this"
    expect(wordOccurrences("the user prefers metric distances", "is")).toBe(0);
    expect(wordOccurrences("this is a test", "is")).toBe(1); // the standalone "is", not the one inside "this"
  });

  it("counts real standalone occurrences, case-insensitively pre-lowercased", () => {
    expect(wordOccurrences("staking staking yields staking", "staking")).toBe(3);
  });

  it("returns 0 for no match", () => {
    expect(wordOccurrences("completely unrelated content", "staking")).toBe(0);
  });
});
