/** Public signed routing data only. Parsing never fetches a URL, enrolls a user or grants a session. */
import { validCompanyProfile } from './mobile-connection';

export const WORKPLACE_SETUP_PATH = '/login/mobile-setup';
const MAX_LINK_LENGTH = 24_000;
const MAX_SETUP_LENGTH = 16_384;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encoding only, not cryptography. Hermes must not depend on browser atob/btoa globals. */
export function setupBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_LINK_LENGTH || value.length % 4 === 1)
    throw new Error('Invalid workplace setup encoding.');
  const output: number[] = [];
  let buffer = 0, bits = 0;
  for (const character of value) {
    buffer = (buffer << 6) | BASE64URL.indexOf(character); bits += 6;
    if (bits >= 8) { bits -= 8; output.push((buffer >>> bits) & 255); }
  }
  if (bits && (buffer & ((1 << bits) - 1)) !== 0) throw new Error('Invalid workplace setup encoding.');
  return Uint8Array.from(output);
}
function encodeBytes(bytes: Uint8Array): string {
  let output = '', buffer = 0, bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; output += BASE64URL[(buffer >>> bits) & 63]; }
  }
  if (bits) output += BASE64URL[(buffer << (6 - bits)) & 63];
  return output;
}

function encode(text: string): string {
  const bytes = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return encodeBytes(Uint8Array.from(bytes, character => character.charCodeAt(0)));
}
function decode(text: string): string {
  const decoded = decodeURIComponent(Array.from(setupBytes(text), byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
  if (encode(decoded) !== text) throw new Error('Invalid workplace setup encoding.');
  return decoded;
}

/** Structural validation here; the installed app independently verifies the signature with its own key. */
export function workplaceSetupProfile(raw: string) {
  if (raw.length > MAX_SETUP_LENGTH) throw new Error('Workplace setup is too large.');
  const envelope = JSON.parse(raw);
  if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).sort().join(',') !== 'keyId,payload,signature' ||
      typeof envelope.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(envelope.keyId) ||
      typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string' ||
      !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw new Error('Invalid workplace setup.');
  const profile = validCompanyProfile(JSON.parse(decode(envelope.payload)));
  if (profile.authProvider !== 'internal' || !profile.organization) throw new Error('A workplace setup must include its organization code.');
  return profile;
}

export function workplaceSetupLinks(raw: string) {
  const profile = workplaceSetupProfile(raw);
  // Compact the envelope once; signatures authenticate payload bytes, not envelope whitespace.
  const encoded = encode(JSON.stringify(JSON.parse(raw)));
  const fragment = '#setup=' + encoded;
  const web = profile.apiOrigin + WORKPLACE_SETUP_PATH + fragment;
  if (web.length > MAX_LINK_LENGTH) throw new Error('Workplace setup is too large.');
  return { web, app: 'aihr://company' + fragment };
}

export function isWorkplaceSetupLink(value: string): boolean {
  if (value.length > MAX_LINK_LENGTH) return value.startsWith('aihr://company') || value.includes(WORKPLACE_SETUP_PATH);
  try {
    const url = new URL(value);
    return (url.protocol === 'aihr:' && url.hostname === 'company') || url.pathname === WORKPLACE_SETUP_PATH;
  } catch { return false; }
}

export function readWorkplaceSetupLink(value: string): string {
  if (value.length > MAX_LINK_LENGTH || !isWorkplaceSetupLink(value)) throw new Error('Invalid workplace setup link.');
  const url = new URL(value);
  const native = url.protocol === 'aihr:' && url.hostname === 'company' && !url.pathname && !url.port;
  const web = url.protocol === 'https:' && url.pathname === WORKPLACE_SETUP_PATH;
  if ((!native && !web) || url.username || url.password || url.search || !/^#setup=[A-Za-z0-9_-]+$/.test(url.hash))
    throw new Error('Invalid workplace setup link.');
  const raw = decode(url.hash.slice('#setup='.length));
  const profile = workplaceSetupProfile(raw);
  if (web && url.origin !== profile.apiOrigin) throw new Error('Workplace setup belongs to another server.');
  return raw;
}
