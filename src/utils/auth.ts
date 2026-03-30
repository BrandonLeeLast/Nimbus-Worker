// Helper for password hashing and verification using Web Crypto API (Standard in Cloudflare Workers)
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    data,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hash = new Uint8Array(derivedBits);
  
  // Combine salt and hash for storage
  const combined = new Uint8Array(salt.length + hash.length);
  combined.set(salt);
  combined.set(hash, salt.length);
  
  return btoa(String.fromCharCode(...combined));
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const combined = new Uint8Array(
    atob(storedHash)
      .split('')
      .map((c) => c.charCodeAt(0))
  );
  
  const salt = combined.slice(0, 16);
  const originalHash = combined.slice(16);
  
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    data,
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const currentHash = new Uint8Array(derivedBits);
  
  // Constant-time comparison
  if (originalHash.length !== currentHash.length) return false;
  let result = 0;
  for (let i = 0; i < originalHash.length; i++) {
    result |= originalHash[i] ^ currentHash[i];
  }
  return result === 0;
}
