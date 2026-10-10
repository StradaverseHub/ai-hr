import { keycloakConfig, keycloakSelected, safeReturnTo } from './config';

export async function currentProviderSession() {
  if (keycloakSelected()) return (await import('./session')).currentIdentitySession();
  const session = await (await import('../workos')).currentWorkosSession();
  return session ? { ...session, issuer: undefined, emailVerified: false } : null;
}
export async function providerSignInUrl(returnTo?: string) {
  if (keycloakSelected()) return `/login/start?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
  return (await import('../workos')).signInUrl(returnTo);
}
export async function endProviderSession(returnTo?: string): Promise<void> {
  if (keycloakSelected()) return (await import('./session')).endIdentitySession();
  return (await import('../workos')).endWorkosSession(returnTo);
}
/** The service credential is server-only and holds realm user-management permissions, never HR grants. */
export async function sendIdentityInvitation(email: string, activationPath: string) {
  if (process.env.KEYCLOAK_EMAIL_ENABLED !== 'true') throw new Error('Keycloak email delivery is not configured. Ask your administrator to configure the SMTP relay.');
  const config = keycloakConfig();
  const clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  const secret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('Keycloak invitation service is not configured.');
  if (!/^\/invite\/[A-Za-z0-9_-]{43}\/activate$/.test(activationPath)) throw new Error('Invalid invitation destination.');
  const transport = (await import('./oidc')).identityFetch(config);
  const tokenResponse = await transport(`${config.issuer}/protocol/openid-connect/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }) });
  if (!tokenResponse.ok) throw new Error('Keycloak invitation service is unavailable.');
  const token: unknown = await tokenResponse.json();
  if (!token || typeof token !== 'object' || !('access_token' in token) || typeof token.access_token !== 'string') throw new Error('Invalid invitation service response.');
  const adminBase = config.issuer.replace('/realms/', '/admin/realms/');
  async function admin(path: string, init: RequestInit = {}) {
    const url = new URL(adminBase + path);
    const target = config.backchannel ? new URL(url.pathname + url.search, config.backchannel) : url;
    const response = await fetch(target, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${(token as { access_token: string }).access_token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Keycloak invitation service is unavailable.');
    return response;
  }
  const search = () => admin(`/users?${new URLSearchParams({ email, exact: 'true' })}`).then(r => r.json()) as Promise<Array<{ id: string; email: string }>>;
  let users = await search();
  if (!Array.isArray(users)) throw new Error('Invalid invitation account response.');
  const created = users.length === 0;
  if (created) {
    await admin('/users', { method: 'POST', body: JSON.stringify({ username: email, email, enabled: true, emailVerified: false }) });
    users = await search();
  }
  if (users.length !== 1 || users[0].email?.toLowerCase() !== email.toLowerCase() || !/^[a-zA-Z0-9_-]+$/.test(users[0].id)) throw new Error('Invitation account could not be resolved uniquely.');
  const params = new URLSearchParams({ client_id: config.webClientId, redirect_uri: config.origin + activationPath, lifespan: String(7 * 86400) });
  await admin(`/users/${users[0].id}/execute-actions-email?${params}`, { method: 'PUT', body: JSON.stringify(created ? ['VERIFY_EMAIL', 'UPDATE_PASSWORD'] : ['VERIFY_EMAIL']) });
  return { invitationId: users[0].id };
}
