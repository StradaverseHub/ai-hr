/**
 * ADR-0088 §1 — the mobile API's WorkOS access-token verifier (lib/mobile-api/jwt.ts). Pure: a locally
 * generated RSA key stands in for WorkOS's, so every refusal is exercised against a token that would
 * verify but for the one thing each case changes. No DB, no network.
 */
import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '../lib/auth-errors';
import {
  JwksUnavailableError,
  parseBearer,
  verifyAccessToken,
  workosJwks,
  type Jwk,
  type JwksSource,
} from '../lib/mobile-api/jwt';

const CLIENT_ID = 'client_mobile_test';
const NOW = 1_900_000_000; // a fixed clock; expiry is tested against it, never against a sleep

function keypair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, publicKey, jwk };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signToken(
  privateKey: KeyObject,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' },
): string {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${cryptoSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const K1 = keypair('k1');
const staticJwks = (keys: Jwk[]): JwksSource => async () => keys;
const good = { client_id: CLIENT_ID, sub: 'user_01ABC', sid: 'session_01XYZ', iss: 'https://api.workos.com/', exp: NOW + 300, iat: NOW - 10 };

async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('verifyAccessToken — a valid token', () => {
  it('returns the subject, session id and expiry', async () => {
    const out = await verifyAccessToken(signToken(K1.privateKey, good), { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW });
    expect(out).toEqual({ subject: 'user_01ABC', sessionId: 'session_01XYZ', expiresAt: NOW + 300 });
  });

  it('accepts a key published without `alg`/`use` (both are optional in a JWK)', async () => {
    const { alg: _a, use: _u, ...bare } = K1.jwk;
    const out = await verifyAccessToken(signToken(K1.privateKey, good), { clientId: CLIENT_ID, jwks: staticJwks([bare]), now: NOW });
    expect(out.subject).toBe('user_01ABC');
  });

  it('tolerates 30 s of clock skew at expiry, and not 31', async () => {
    const t = signToken(K1.privateKey, { ...good, exp: NOW - 29 });
    expect((await verifyAccessToken(t, { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW })).subject).toBe('user_01ABC');
    const late = signToken(K1.privateKey, { ...good, exp: NOW - 31 });
    expect(await refusal(verifyAccessToken(late, { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW }))).toBeInstanceOf(
      AuthRequiredError,
    );
  });
});

describe('verifyAccessToken — every refusal is an AuthRequiredError (401: sign in again)', () => {
  const jwks = staticJwks([K1.jwk]);
  const cases: Array<[string, () => string]> = [
    ['wrong issuer under a trusted key', () => signToken(K1.privateKey, { ...good, iss: 'https://attacker.example/' })],
    ['no issuer', () => signToken(K1.privateKey, { ...good, iss: undefined })],
    ['expired', () => signToken(K1.privateKey, { ...good, exp: NOW - 60 })],
    ['no exp claim', () => signToken(K1.privateKey, { ...good, exp: undefined })],
    ['exp not a number', () => signToken(K1.privateKey, { ...good, exp: String(NOW + 300) })],
    ['nbf in the future', () => signToken(K1.privateKey, { ...good, nbf: NOW + 120 })],
    ['no subject', () => signToken(K1.privateKey, { ...good, sub: undefined })],
    ['empty subject', () => signToken(K1.privateKey, { ...good, sub: '' })],
    ['alg none, unsigned', () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(good)}.`],
    ['alg none with a junk signature', () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(good)}.AAAA`],
    [
      // The classic key-confusion attack: HMAC the token with the PUBLIC key as the shared secret.
      'HS256 signed with the public key as secret',
      () => {
        const input = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(good)}`;
        const secret = K1.publicKey.export({ format: 'pem', type: 'spki' });
        return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
      },
    ],
    ['RS384 in the header', () => signToken(K1.privateKey, good, { alg: 'RS384', kid: 'k1' })],
    ['no kid', () => signToken(K1.privateKey, good, { alg: 'RS256' })],
    ['signed by a different key under the same kid', () => signToken(keypair('k1').privateKey, good)],
    [
      'payload tampered after signing (sub swapped)',
      () => {
        const [h, , s] = signToken(K1.privateKey, good).split('.');
        return `${h}.${b64({ ...good, sub: 'user_SOMEONE_ELSE' })}.${s}`;
      },
    ],
    ['two segments', () => signToken(K1.privateKey, good).split('.').slice(0, 2).join('.')],
    ['header is not JSON', () => `bm90anNvbg.${b64(good)}.AAAA`],
    ['payload is a JSON array', () => signToken(K1.privateKey, [] as unknown as Record<string, unknown>)],
  ];
  it.each(cases)('%s', async (_name, make) => {
    expect(await refusal(verifyAccessToken(make(), { clientId: CLIENT_ID, jwks, now: NOW }))).toBeInstanceOf(AuthRequiredError);
  });

  it('refuses a key whose published alg is not RS256, even though the signature is valid', async () => {
    const t = signToken(K1.privateKey, good);
    const e = await refusal(verifyAccessToken(t, { clientId: CLIENT_ID, jwks: staticJwks([{ ...K1.jwk, alg: 'RS512' }]), now: NOW }));
    expect(e).toBeInstanceOf(AuthRequiredError);
    // Non-vacuity: the same token with the same key published as RS256 verifies.
    expect((await verifyAccessToken(t, { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW })).subject).toBe(good.sub);
  });

  it('refuses a key published for encryption (`use: enc`)', async () => {
    const t = signToken(K1.privateKey, good);
    const e = await refusal(verifyAccessToken(t, { clientId: CLIENT_ID, jwks: staticJwks([{ ...K1.jwk, use: 'enc' }]), now: NOW }));
    expect(e).toBeInstanceOf(AuthRequiredError);
  });
});

describe('verifyAccessToken — deployment claim profile', () => {
  it('requires this application’s signed client_id even when another application shares the signing key', async () => {
    const opts = { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW };
    expect((await verifyAccessToken(signToken(K1.privateKey, good), opts)).subject).toBe(good.sub);
    for (const client_id of [undefined, 'client_other_app', 42, [CLIENT_ID], '']) {
      await expect(verifyAccessToken(signToken(K1.privateKey, { ...good, client_id }), opts)).rejects.toBeInstanceOf(AuthRequiredError);
    }
    await expect(verifyAccessToken(signToken(K1.privateKey, { ...good, client_id: '' }), { ...opts, clientId: '' })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('requires exactly the configured custom issuer', async () => {
    const token = signToken(K1.privateKey, { ...good, iss: 'https://auth.example.com/' });
    const opts = { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW, issuer: 'https://auth.example.com/' };
    expect((await verifyAccessToken(token, opts)).subject).toBe(good.sub);
    await expect(verifyAccessToken(signToken(K1.privateKey, good), opts)).rejects.toBeInstanceOf(AuthRequiredError);
  });
  it('enforces an explicitly configured audience, including standard array claims', async () => {
    const opts = { clientId: CLIENT_ID, jwks: staticJwks([K1.jwk]), now: NOW, audience: 'aihr-mobile' };
    for (const aud of ['aihr-mobile', ['other', 'aihr-mobile']]) {
      expect((await verifyAccessToken(signToken(K1.privateKey, { ...good, aud }), opts)).subject).toBe(good.sub);
    }
    for (const aud of [undefined, 'different-app', ['different-app'], [42, 'aihr-mobile']]) {
      await expect(verifyAccessToken(signToken(K1.privateKey, { ...good, aud }), opts)).rejects.toBeInstanceOf(AuthRequiredError);
    }
  });
});

describe('verifyAccessToken — key rotation', () => {
  it('an unknown kid triggers exactly one forced refresh, and a rotated-in key then verifies', async () => {
    const K2 = keypair('k2');
    const src = vi.fn<JwksSource>(async ({ refresh }) => (refresh ? [K1.jwk, K2.jwk] : [K1.jwk]));
    const t = signToken(K2.privateKey, good, { alg: 'RS256', kid: 'k2' });
    expect((await verifyAccessToken(t, { clientId: CLIENT_ID, jwks: src, now: NOW })).subject).toBe(good.sub);
    expect(src.mock.calls.map((c) => c[0].refresh)).toEqual([false, true]);
  });

  it('a kid that is still unknown after the refresh is refused, with no second refresh', async () => {
    const src = vi.fn<JwksSource>(async () => [K1.jwk]);
    const t = signToken(keypair('k9').privateKey, good, { alg: 'RS256', kid: 'k9' });
    expect(await refusal(verifyAccessToken(t, { clientId: CLIENT_ID, jwks: src, now: NOW }))).toBeInstanceOf(AuthRequiredError);
    expect(src).toHaveBeenCalledTimes(2);
  });

  it('a known kid never forces a refresh', async () => {
    const src = vi.fn<JwksSource>(async () => [K1.jwk]);
    await verifyAccessToken(signToken(K1.privateKey, good), { clientId: CLIENT_ID, jwks: src, now: NOW });
    expect(src).toHaveBeenCalledTimes(1);
  });
});

describe('parseBearer', () => {
  const t = 'aaa.bbb.ccc';
  it.each([
    [`Bearer ${t}`, t],
    [`bearer ${t}`, t],
    [`BEARER   ${t}  `, t],
  ])('%j → the token', (h, want) => expect(parseBearer(h)).toBe(want));
  it.each([
    [null],
    [undefined],
    [''],
    ['Basic ZGVtbzpzZWtyZXQ='],
    [`Bearer`],
    [`Bearer aaa.bbb`],
    [`Bearer aaa.bbb.ccc.ddd`],
    [`Bearer aaa.b b.ccc`],
    [`Token ${t}`],
  ])('%j → null', (h) => expect(parseBearer(h)).toBeNull());
});

describe('workosJwks — the production key source', () => {
  const okResponse = (keys: Jwk[]) => new Response(JSON.stringify({ keys }), { status: 200 });
  let n = 0;
  const freshClient = () => `client_test_${Date.now()}_${n++}`; // the cache is module-level, keyed by URL

  it('fetches the client-scoped WorkOS URL and caches it', async () => {
    const clientId = freshClient();
    const fetchImpl = vi.fn(async () => okResponse([K1.jwk]));
    const src = workosJwks(clientId, fetchImpl as unknown as typeof fetch);
    expect(await src({ refresh: false })).toEqual([K1.jwk]);
    expect(await src({ refresh: false })).toEqual([K1.jwk]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(`https://api.workos.com/sso/jwks/${clientId}`);
  });

  it('rate-limits forced refreshes: a burst of unknown kids costs one fetch, not one each', async () => {
    const fetchImpl = vi.fn(async () => okResponse([K1.jwk]));
    const src = workosJwks(freshClient(), fetchImpl as unknown as typeof fetch);
    await src({ refresh: false });
    for (let i = 0; i < 5; i++) await src({ refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('with no cached keys, an outage is JwksUnavailableError (503: retry), not AuthRequiredError', async () => {
    const src = workosJwks(freshClient(), (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch);
    const e = await refusal(src({ refresh: false }));
    expect(e).toBeInstanceOf(JwksUnavailableError);
    expect(e).not.toBeInstanceOf(AuthRequiredError);
  });

  it('a non-2xx or a body with no keys array is JwksUnavailableError too', async () => {
    const src500 = workosJwks(freshClient(), (async () => new Response('x', { status: 500 })) as unknown as typeof fetch);
    expect(await refusal(src500({ refresh: false }))).toBeInstanceOf(JwksUnavailableError);
    const srcBad = workosJwks(freshClient(), (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    expect(await refusal(srcBad({ refresh: false }))).toBeInstanceOf(JwksUnavailableError);
  });

  it('serves the cached keys through an outage on refresh rather than signing everyone out', async () => {
    vi.useFakeTimers();
    try {
      let down = false;
      const fetchImpl = vi.fn(async () => {
        if (down) throw new Error('ETIMEDOUT');
        return okResponse([K1.jwk]);
      });
      const src = workosJwks(freshClient(), fetchImpl as unknown as typeof fetch);
      await src({ refresh: false });
      down = true;
      vi.advanceTimersByTime(11 * 60_000); // past the TTL: a real refetch is attempted, and fails
      expect(await src({ refresh: false })).toEqual([K1.jwk]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never accepts cached signing keys older than thirty minutes during an outage', async () => {
    vi.useFakeTimers();
    try {
      let down = false;
      const fetchImpl = vi.fn(async () => { if (down) throw new Error('offline'); return okResponse([K1.jwk]); });
      const src = workosJwks(freshClient(), fetchImpl as unknown as typeof fetch);
      await src({ refresh: false }); down = true;
      vi.advanceTimersByTime(29 * 60_000);
      expect(await src({ refresh: false })).toEqual([K1.jwk]);
      vi.advanceTimersByTime(60_000);
      await expect(src({ refresh: false })).rejects.toBeInstanceOf(JwksUnavailableError);
    } finally { vi.useRealTimers(); }
  });

  it('coalesces concurrent cold requests and throttles failed fetches', async () => {
    let release!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const src = workosJwks(freshClient(), fetchImpl as unknown as typeof fetch);
    const first = src({ refresh: false }); const second = src({ refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(new Response('', { status: 503 }));
    await expect(first).rejects.toBeInstanceOf(JwksUnavailableError);
    await expect(second).rejects.toBeInstanceOf(JwksUnavailableError);
    await expect(src({ refresh: true })).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a shared outage keeps known-key verification available but never calls a rotated token invalid', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>(async () => okResponse([K1.jwk]));
      const src = workosJwks(freshClient(), fetchImpl);
      await src({ refresh: false });
      vi.advanceTimersByTime(11 * 60_000);
      let release!: (value: Response) => void;
      fetchImpl.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
      const cached = src({ refresh: false });
      const rotated = refusal(src({ refresh: true }));
      expect(fetchImpl).toHaveBeenCalledTimes(2); // both callers share the failed network request
      release(new Response('', { status: 503 }));
      expect(await cached).toEqual([K1.jwk]);
      expect(await rotated).toBeInstanceOf(JwksUnavailableError);
      // Non-vacuity: a token actually signed by the new key cannot be verified by the old cache.
      const rotatedKey = keypair('rotated');
      const token = signToken(rotatedKey.privateKey, { ...good, exp: Math.floor(Date.now() / 1000) + 300 }, { alg: 'RS256', kid: rotatedKey.jwk.kid });
      expect(await refusal(verifyAccessToken(token, { clientId: CLIENT_ID, jwks: src }))).toBeInstanceOf(JwksUnavailableError);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // the outage retry remains throttled
    } finally { vi.useRealTimers(); }
  });

  it('rejects malformed key entries as an availability error', async () => {
    const src = workosJwks(freshClient(), (async () => new Response(JSON.stringify({ keys: [null] }))) as typeof fetch);
    await expect(src({ refresh: false })).rejects.toBeInstanceOf(JwksUnavailableError);
  });
});
