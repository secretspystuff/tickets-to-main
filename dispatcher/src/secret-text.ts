/** The key prefix, split so the public tree does not carry a literal key. */
export const KEY_MARK = "tp" + "_";

const DECODE_LIMIT = 8;
const CREDENTIAL_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:tp|tpj|tps)_[A-Za-z0-9_-]{20,}|(?:sk-ant-|sk-proj-|sk-|xai-)[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/;
const REDACT_CREDENTIALS = new RegExp(CREDENTIAL_SHAPES.source, "g");
const KEY_BEGIN = /\bBEGIN/g;
const KEY_END = /\bEND/g;
const KEY_LABEL = "PRIVATE KEY";

export function redactCredentialShapes(value: string): string {
  return value.replace(REDACT_CREDENTIALS, "[redacted]");
}

export function hasCredentialShape(value: string): boolean {
  return CREDENTIAL_SHAPES.test(value) || (value.includes(KEY_LABEL) && keyMarker(value, KEY_BEGIN, 0) !== null);
}

function keyMarker(value: string, word: RegExp, offset: number): { start: number; end: number } | null {
  word.lastIndex = offset;
  for (let match = word.exec(value); match; match = word.exec(value)) {
    const label = value.indexOf(KEY_LABEL, word.lastIndex);
    if (label === -1) return null;
    const gap = value.slice(word.lastIndex, label);
    const lineBreak = Math.max(gap.lastIndexOf("\n"), gap.lastIndexOf("\r"));
    if (lineBreak !== -1) {
      word.lastIndex += lineBreak + 1;
      continue;
    }
    let start = match.index;
    let end = label + KEY_LABEL.length;
    while (start > offset && value[start - 1] === "-") start -= 1;
    while (value[end] === "-") end += 1;
    return { start, end };
  }
  return null;
}

export function redactPrivateKeys(value: string): string {
  if (!value.includes(KEY_LABEL)) return value;
  let output = "";
  let offset = 0;
  for (;;) {
    const header = keyMarker(value, KEY_BEGIN, offset);
    if (!header) return output + value.slice(offset);
    output += value.slice(offset, header.start) + "[redacted]";
    const footer = keyMarker(value, KEY_END, header.end);
    if (!footer) return output;
    offset = footer.end;
  }
}

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
