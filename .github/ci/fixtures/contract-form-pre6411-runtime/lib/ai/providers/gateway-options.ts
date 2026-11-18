/** General AI gateway (0661): a service that accepts OpenAI-style chat requests at a tenant-chosen https
 * address, for example https://router.flatkey.ai/v1. The stored options are exactly {version:1, baseUrl}
 * and mirror app.ai_gateway_options_valid. Before EVERY call the host is resolved and refused if any
 * address is private, loopback, link-local or otherwise internal, so the setting cannot reach the
 * installation's own network (DNS can change after it was saved). */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AiGatewayError } from '../types';

export type GatewayOptions = { version: 1; baseUrl: string };
const URL_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[A-Za-z0-9._~-]+)*\/?$/;
const LOCAL_SUFFIX = /\.(local|localhost|internal|lan|home|corp|intranet)$/;

export function readGatewayOptions(value: unknown): GatewayOptions {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'baseUrl,version' || v.version !== 1) throw new AiGatewayError('Invalid AI gateway settings.');
  const baseUrl = typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '';
  const host = baseUrl.slice('https://'.length).split('/')[0];
  if (baseUrl.length < 12 || baseUrl.length > 300 || !URL_RE.test(baseUrl) || /^[0-9.]+$/.test(host) || LOCAL_SUFFIX.test(host)) throw new AiGatewayError('Invalid AI gateway settings.');
  return { version: 1, baseUrl };
}

/** True for any address a public gateway must never resolve to. */
export function isInternalAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isInternalAddress(mapped[1]);
    return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
  }
  return true;
}

/** Resolves the gateway host and refuses when nothing resolves or any address is internal. */
export async function assertPublicGateway(baseUrl: string | undefined): Promise<void> {
  if (!baseUrl) throw new AiGatewayError('The AI gateway address is missing.');
  const { baseUrl: checked } = readGatewayOptions({ version: 1, baseUrl });
  const host = checked.slice('https://'.length).split('/')[0];
  let addresses: { address: string }[];
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new AiGatewayError('The AI gateway could not be reached.'); }
  if (addresses.length === 0 || addresses.some(entry => isInternalAddress(entry.address))) throw new AiGatewayError('The AI gateway address is not allowed.');
}
