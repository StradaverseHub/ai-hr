import { seal, unseal } from './seal';
/** Optimistic middleware validation; every protected data operation still resolves the live DB session. */
export async function sealSessionHandle(handle: string, expiry = Math.floor(Date.now()/1000)+8*3600) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(handle)) throw new Error('Invalid session handle.');
  return seal({handle},'browser-handle',expiry);
}
export async function readSessionHandle(cookie: string | undefined): Promise<string | null> {
  if (!cookie || cookie.length > 1000) return null;
  try {
    const value = await unseal(cookie,'browser-handle');
    return typeof value.handle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.handle) ? value.handle : null;
  } catch { return null; }
}
