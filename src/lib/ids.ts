const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 24;

/**
 * Prefixed, URL-safe, sortable-enough identifiers: `run_k3f9...`.
 *
 * The prefix is worth the eight extra bytes — a bare UUID in a log line or a
 * support ticket tells you nothing about what it identifies, and run IDs show
 * up in shareable replay URLs where readability matters.
 */
export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // 256 is not a multiple of 36, so the low values are very slightly more
    // likely. At 24 characters the bias is far below anything that matters
    // for collision resistance here.
    out += ALPHABET[byte % ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

export const ID_PREFIXES = [
  "ws", // workspace
  "wsm", // workspace member
  "tpl", // template
  "tplv", // template version
  "run", // run
  "art", // run artifact
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
