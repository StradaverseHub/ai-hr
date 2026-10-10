import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose';
import { keycloakConfig } from './config';
import { AuthRequiredError } from '../auth-errors';
import { JwksUnavailableError } from '../mobile-api/jwt';

/** Only operator-approved loopback transport may differ from the public HTTPS issuer. */
export function identityFetch(config: ReturnType<typeof keycloakConfig>, fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== new URL(config.issuer).origin || !url.pathname.startsWith(new URL(config.issuer).pathname + '/')) throw new Error('Unapproved identity endpoint.');
    const target = config.backchannel ? new URL(url.pathname + url.search, config.backchannel) : url;
    const response = await fetchImpl(target, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(init?.signal ? [init.signal] : [])]) });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Identity response exceeds the size limit.'); }
      chunks.push(item.value);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
let flight: { key: string; promise: Promise<oidc.Configuration> } | undefined;
export function oidcClient() {
  const config = keycloakConfig();
  const key = JSON.stringify(config);
  if (flight?.key === key) return flight.promise;
  const fetchIdentity = identityFetch(config);
  const transport: oidc.CustomFetch = (url, options) => fetchIdentity(url, { ...options,
    body: options.body instanceof Uint8Array ? new Uint8Array(options.body).buffer : options.body });
  const promise = oidc.discovery(new URL(config.issuer), config.webClientId, { token_endpoint_auth_method: 'client_secret_post' }, oidc.ClientSecretPost(config.webClientSecret), { [oidc.customFetch]: transport, timeout: 10 }).then(client => {
    const metadata = client.serverMetadata();
    const endpoints = { authorization_endpoint: 'auth', token_endpoint: 'token', jwks_uri: 'certs', end_session_endpoint: 'logout', revocation_endpoint: 'revoke' } as const;
    if (metadata.issuer !== config.issuer) throw new Error('Identity issuer mismatch.');
    for (const [name, path] of Object.entries(endpoints)) if (metadata[name] !== `${config.issuer}/protocol/openid-connect/${path}`) throw new Error(`Unapproved identity endpoint: ${name}`);
    client[oidc.customFetch] = transport;
    client.timeout = 10;
    return client;
  }).catch(error => { if (flight?.key === key) flight = undefined; throw error; });
  flight = { key, promise };
  return promise;
}
let jwks: { key: string; resolver: ReturnType<typeof createRemoteJWKSet> } | undefined;
export async function verifyKeycloakAccessToken(token: string, expectedClient?: string) {
  const config = keycloakConfig();
  const key = config.issuer + ':' + (config.backchannel ?? '');
  if (jwks?.key !== key) {
    const transport = identityFetch(config);
    jwks = { key, resolver: createRemoteJWKSet(new URL(`${config.issuer}/protocol/openid-connect/certs`), { [customFetch]: async (url, init) => {
      try { return await transport(url, init); } catch { throw new JwksUnavailableError('identity provider unavailable'); }
    }, timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 }) };
  }
  try {
    const { payload } = await jwtVerify(token, jwks.resolver, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'], clockTolerance: 30 });
    if ((expectedClient && payload.azp !== expectedClient) || payload.iat! > Date.now() / 1000 + 30 || payload.typ !== 'Bearer' || ![config.webClientId, config.mobileClientId].includes(String(payload.azp)) || typeof payload.sub !== 'string' || !payload.sub) throw new AuthRequiredError('Invalid API access token.');
    return { issuer: config.issuer, subject: payload.sub, expiresAt: payload.exp! };
  } catch (error) {
    if (error instanceof AuthRequiredError || error instanceof JwksUnavailableError) throw error;
    if (error instanceof TypeError || (error instanceof Error && ['JWKSTimeout', 'JOSEError', 'JWKSInvalid', 'JWKInvalid', 'JWKSMultipleMatchingKeys'].includes(error.name))) throw new JwksUnavailableError('identity provider unavailable');
    throw new AuthRequiredError('Invalid API access token.');
  }
}
export { oidc };
