// Deduplicates doubled input from a known Clink v1.7.6 terminal bug (garbled/
// doubled keystrokes, e.g. "finch_sk_xxfinch_sk_xx" -> "finch_sk_xx"). Used by
// every raw-input prompt in cli.ts (login, setup wizard provider/URL prompts)
// before validating what the user typed.
export function dedupClinkInput(s: string): string {
  if (s.length > 0 && s.length % 2 === 0) {
    const half = s.length / 2;
    if (s.slice(0, half) === s.slice(half)) return s.slice(0, half);
  }
  return s;
}
