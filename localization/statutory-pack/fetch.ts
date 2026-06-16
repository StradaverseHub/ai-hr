/**
 * Hardened text fetch for the remote pull (ADR-0020 §5). Signature verification protects pack CONTENT; the
 * TRANSPORT is hardened independently: https-only, host allowlist, **reject any hostname that resolves to a
 * private/link-local IP** (anti-SSRF), **no redirect following**, a hard **max-bytes streamed cap** (anti
 * payload-bomb), and a **timeout**. The configured endpoint is deploy-config only (never request input).
 */
import { promises as dns } from 'node:dns';
import { isPublicIp } from './ip-guard';

export class SafeFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export type SafeFetchOpts = {
  maxBytes?: number;
  timeoutMs?: number;
  /** Hostnames permitted (the pull is pinned to its configured endpoint's host). */
  allowedHosts?: string[];
};

/** Fetch a small text resource over a hardened transport, or throw SafeFetchError. */
export async function safeFetchText(rawUrl: string, opts: SafeFetchOpts = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? 2_000_000; // 2 MB — packs are small
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError('BAD_URL', `Malformed URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') throw new SafeFetchError('NOT_HTTPS', 'Only https URLs are allowed');
  if (opts.allowedHosts && !opts.allowedHosts.includes(url.hostname)) {
    throw new SafeFetchError('HOST_NOT_ALLOWED', `Host ${url.hostname} is not in the allowlist`);
  }

  // Resolve and reject any private/link-local address (SSRF / DNS-rebind probe guard).
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(url.hostname, { all: true });
  } catch (e) {
    throw new SafeFetchError('DNS', `DNS resolution failed: ${(e as Error).message}`);
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicIp(a.address))) {
    throw new SafeFetchError('PRIVATE_ADDRESS', `${url.hostname} resolves to a non-public address`);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'error', // no redirect following
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new SafeFetchError('HTTP', `HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared && declared > maxBytes) throw new SafeFetchError('TOO_LARGE', 'Content-Length exceeds cap');

    // Stream with a hard byte cap (defends against a lying / missing Content-Length).
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new SafeFetchError('TOO_LARGE', 'Stream exceeded max bytes');
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    if ((e as Error).name === 'AbortError') throw new SafeFetchError('TIMEOUT', 'Fetch timed out');
    throw new SafeFetchError('FETCH', (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}
