/** The key prefix, split so the public tree does not carry a literal key. */
export const KEY_MARK = "tp" + "_";

const DECODE_LIMIT = 8;
const CREDENTIAL_SHAPES = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:tp|tpj|tps)_[A-Za-z0-9_-]{20,}|(?:sk-ant-|sk-proj-|sk-|xai-)[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/;
const REDACT_CREDENTIALS = new RegExp(`\\b${CREDENTIAL_SHAPES.source}`, "g");
const KEY_HEADER_START = "-----BEGIN";
const KEY_HEADER_END = "PRIVATE KEY-----";

export function redactCredentialShapes(value: string): string {
  return value.replace(REDACT_CREDENTIALS, "[redacted]");
}

export function hasCredentialShape(value: string): boolean {
  if (CREDENTIAL_SHAPES.test(value)) return true;
  if (!value.includes(KEY_HEADER_END)) return false;
  return value.split(/[\r\n]/).some(line => {
    const start = line.indexOf(KEY_HEADER_START);
    return start !== -1 && line.includes(KEY_HEADER_END, start + KEY_HEADER_START.length);
  });
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
