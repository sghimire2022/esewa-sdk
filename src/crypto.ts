/**
 * Runtime-agnostic crypto helpers built on the Web Crypto API
 * (`globalThis.crypto.subtle`), available in Node 18+, Bun, Deno,
 * Cloudflare Workers, Vercel Edge and modern browsers.
 */

const encoder = new TextEncoder();

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "esewa-sdk: Web Crypto (globalThis.crypto.subtle) is not available in this runtime. Use Node 18+ or a modern runtime.",
    );
  }
  return subtle;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = getSubtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

/** HMAC-SHA256 of `message` keyed by `secret`, returned as standard base64. */
export async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await getSubtle().sign("HMAC", key, encoder.encode(message));
  return bytesToBase64(new Uint8Array(sig));
}

/** Constant-time string comparison, so signature checks don't leak timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Decodes base64 / base64url (tolerates missing padding and whitespace) to a UTF-8 string. */
export function base64ToUtf8(input: string): string {
  // A literal space can only appear if a "+" was form-decoded on the way in, so restore it.
  let s = input.trim().replace(/ /g, "+").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function utf8ToBase64(input: string): string {
  return bytesToBase64(encoder.encode(input));
}
