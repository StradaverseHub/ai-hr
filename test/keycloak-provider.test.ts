import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendIdentityInvitation } from '../lib/identity/provider';

const email = 'invited@example.invalid';
const destination = `/invite/${'a'.repeat(43)}/activate`;
beforeEach(() => {
  for (const [key, value] of Object.entries({ AUTH_PROVIDER: 'keycloak', AUTH_PUBLIC_ORIGIN: 'https://hr.test',
    KEYCLOAK_ISSUER: 'https://hr.test/identity/realms/ai-hr', KEYCLOAK_WEB_CLIENT_ID: 'web',
    KEYCLOAK_WEB_CLIENT_SECRET: 'test-web-secret', KEYCLOAK_MOBILE_CLIENT_ID: 'mobile', KEYCLOAK_API_AUDIENCE: 'api',
    AUTH_SESSION_KEY: 'f'.repeat(64), KEYCLOAK_ADMIN_CLIENT_ID: 'invitations', KEYCLOAK_ADMIN_CLIENT_SECRET: 'test-service-secret',
    KEYCLOAK_EMAIL_ENABLED: 'true', KEYCLOAK_BACKCHANNEL_ORIGIN: 'http://127.0.0.1:18080',
  })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Keycloak invitation enrollment', () => {
  it('preserves password enrollment across a failed delivery and a retry that finds the new account', async () => {
    let account: Record<string, unknown> | undefined;
    let deliveries = 0;
    const remote = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('http://127.0.0.1:18080');
      expect(init?.redirect).toBe('error');
      if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'disposable-service-token' });
      if (url.pathname.endsWith('/execute-actions-email')) {
        deliveries++;
        expect(url.searchParams.get('redirect_uri')).toBe('https://hr.test' + destination);
        return new Response(null, { status: deliveries === 1 ? 500 : 204 });
      }
      if (init?.method === 'POST') {
        account = { ...JSON.parse(String(init.body)), id: 'created-user' };
        return new Response(null, { status: 201 });
      }
      return Response.json(account ? [account] : []);
    });
    vi.stubGlobal('fetch', remote);
    await expect(sendIdentityInvitation(email, destination)).rejects.toThrow('unavailable');
    expect(account?.requiredActions).toEqual(['UPDATE_PASSWORD']);
    expect(await sendIdentityInvitation(email, destination)).toEqual({ invitationId: 'created-user' });
    expect(remote.mock.calls.filter(c => c[1]?.method === 'POST' && String(c[0]).endsWith('/users'))).toHaveLength(1);
    expect(deliveries).toBe(2);
  });
  it('does not force password setup on an existing directory/SSO account', async () => {
    const remote = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'disposable-service-token' });
      if (url.pathname.endsWith('/execute-actions-email')) {
        expect(JSON.parse(String(init?.body))).toEqual(['VERIFY_EMAIL']);
        return new Response(null, { status: 204 });
      }
      return Response.json([{ id: 'directory-user', email }]);
    });
    vi.stubGlobal('fetch', remote);
    await sendIdentityInvitation(email, destination);
    expect(remote.mock.calls.some(c => c[1]?.method === 'POST' && String(c[0]).endsWith('/users'))).toBe(false);
  });
  it('refuses delivery while SMTP is not configured', async () => {
    vi.stubEnv('KEYCLOAK_EMAIL_ENABLED', 'false');
    const remote = vi.fn(); vi.stubGlobal('fetch', remote);
    await expect(sendIdentityInvitation(email, destination)).rejects.toThrow('SMTP relay');
    expect(remote).not.toHaveBeenCalled();
  });
  it('refuses an arbitrary activation destination before sending credentials', async () => {
    const remote = vi.fn(); vi.stubGlobal('fetch', remote);
    await expect(sendIdentityInvitation(email, 'https://evil.test')).rejects.toThrow('Invalid invitation destination');
    expect(remote).not.toHaveBeenCalled();
  });
});
