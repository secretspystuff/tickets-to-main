export type OsLabel =
  | "early-linux-probe"
  | "unqualified-windows"
  | "unqualified-macos"
  | "unqualified-other";

/** Windows and macOS are required later. Linux stays an early probe. None of these are a qualified installer. */
export function osLabel(platform: NodeJS.Platform): OsLabel {
  if (platform === "linux") return "early-linux-probe";
  if (platform === "win32") return "unqualified-windows";
  if (platform === "darwin") return "unqualified-macos";
  return "unqualified-other";
}

export function osWords(label: OsLabel): string {
  if (label === "early-linux-probe") return "linux. Early probe.";
  if (label === "unqualified-windows") return "windows. Unqualified.";
  if (label === "unqualified-macos") return "macos. Unqualified.";
  return "this operating system. Unqualified.";
}

const COMPUTER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Host names are a label in the connection, never a board identity. */
export function computerName(raw: string): string | null {
  const name = raw.trim();
  return COMPUTER_NAME.test(name) ? name : null;
}
