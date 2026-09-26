import { createHmac } from "node:crypto";

/**
 * Deterministic, keyed, case-preserving substitution cipher (CONTRACTS §4).
 * a-z is permuted, A-Z uses the SAME permutation (upper-cased), 0-9 is permuted.
 * Everything else (punctuation, spaces, '@', non-ASCII) passes through.
 * Because it is a per-character bijection that commutes with ASCII lower(), it preserves
 * both exact equality and lower() equality.
 */
export interface Masker {
  mask(s: string | null): string | null;
  maskEmail(s: string | null): string | null;
}

function keyedPermutation(key: string, label: string, n: number): number[] {
  // Byte stream from HMAC-SHA256 in counter mode; rejection sampling avoids modulo bias.
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  const nextByte = () => {
    if (pos >= buf.length) {
      buf = createHmac("sha256", key).update(`${label}:${counter++}`).digest();
      pos = 0;
    }
    return buf[pos++];
  };
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const range = i + 1;
    const limit = 256 - (256 % range);
    let b: number;
    do b = nextByte(); while (b >= limit);
    const j = b % range;
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

export function createMasker(key: string): Masker {
  if (!key) throw new Error("mask key is empty");
  const letters = keyedPermutation(key, "letters", 26);
  const digits = keyedPermutation(key, "digits", 10);
  const map = new Map<string, string>();
  for (let i = 0; i < 26; i++) {
    map.set(String.fromCharCode(97 + i), String.fromCharCode(97 + letters[i]));
    map.set(String.fromCharCode(65 + i), String.fromCharCode(65 + letters[i]));
  }
  for (let i = 0; i < 10; i++) map.set(String(i), String(digits[i]));

  const mask = (s: string | null): string | null => {
    if (s == null) return s;
    let out = "";
    for (const ch of s) out += map.get(ch) ?? ch;
    return out;
  };
  // Only the local part is masked; the domain (after the LAST '@') is kept.
  const maskEmail = (s: string | null): string | null => {
    if (s == null) return s;
    const at = s.lastIndexOf("@");
    if (at < 0) return mask(s);
    return mask(s.slice(0, at)) + s.slice(at);
  };
  return { mask, maskEmail };
}

/** Which columns get masked, and how. Everything else passes through. */
/**
 * Columns masked by export_table. Default is shopkart's; override per project with
 * PGWARDEN_MASK="table.column:email|text,..." (e.g. "mcp_servers.author:text").
 */
export const MASKED_COLUMNS: Record<string, Record<string, "email" | "text">> = parseMaskSpec(
  process.env.PGWARDEN_MASK ?? "users.email:email,users.full_name:text,users.phone:text",
);

function parseMaskSpec(spec: string): Record<string, Record<string, "email" | "text">> {
  const out: Record<string, Record<string, "email" | "text">> = {};
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [col, kind] = part.split(":");
    const [table, column] = col.split(".");
    if (!table || !column || (kind !== "email" && kind !== "text")) throw new Error(`bad PGWARDEN_MASK entry "${part}"`);
    (out[table] ??= {})[column] = kind;
  }
  return out;
}
