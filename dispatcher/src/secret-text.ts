/** The key prefix, split so the public tree does not carry a literal key. */
export const KEY_MARK = "tp" + "_";

const DECODE_LIMIT = 8;

/**
 * Decode percent-encoding until the text is stable.
 * A broken escape, or encoding that is still nested after the limit, is refused.
 */
export function unfold(value: string): string | null {
  let current = value;
  for (let i = 0; i < DECODE_LIMIT; i += 1) {
    if (!current.includes("%")) return current;
    try {
      const next = decodeURIComponent(current);
      if (next === current) return current;
      current = next;
    } catch {
      return null;
    }
  }
  return current.includes("%") ? null : current;
}
