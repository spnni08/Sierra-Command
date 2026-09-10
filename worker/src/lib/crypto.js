// AES-GCM encryption for API credentials at rest, using the Web Crypto API
// (built into the Workers runtime — no external KMS dependency needed).
//
// Why this approach: Worker Secrets alone can't encrypt *per-row* data in D1,
// and D1 has no native column encryption. AES-256-GCM with a single master
// key held as a Worker secret (`CREDENTIALS_ENCRYPTION_KEY`, never in the repo
// or the DB) is the simplest scheme that keeps ciphertext-only data at rest
// in D1: if the DB leaks, the secret held only in the Worker's environment
// is still required to decrypt. A per-record salt (via a random IV) prevents
// identical plaintexts from producing identical ciphertext.

async function importKey(base64Key) {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext, base64Key) {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptSecret(encoded, base64Key) {
  const key = await importKey(base64Key);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
