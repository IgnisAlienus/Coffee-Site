import type { ToastSession } from './toast.ts';

async function cacheKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function sealSession(
  session: ToastSession,
  secret: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await cacheKey(secret),
    new TextEncoder().encode(JSON.stringify(session)),
  );
  return `${btoa(String.fromCharCode(...nonce))}.${btoa(String.fromCharCode(...new Uint8Array(ciphertext)))}`;
}

export async function openSession(
  value: string,
  secret: string,
): Promise<ToastSession | null> {
  try {
    const [nonce, ciphertext] = value
      .split('.')
      .map((part) =>
        Uint8Array.from(atob(part), (character) => character.charCodeAt(0)),
      );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      await cacheKey(secret),
      ciphertext,
    );
    const session = JSON.parse(new TextDecoder().decode(plaintext));
    return typeof session.accessToken === 'string' &&
      session.accessToken &&
      Number.isFinite(session.expiresAt)
      ? session
      : null;
  } catch {
    return null;
  }
}
