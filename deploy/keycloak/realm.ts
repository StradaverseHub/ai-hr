import { INITIAL_SYSTEM_ADMIN_EMAIL } from '../../lib/identity/bootstrap';
/** Realm template contains public policy only. Secrets and accounts are supplied once by the operator. */
export function realmDefinition(origin: string, realm = 'ai-hr') {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || !/^[a-zA-Z0-9_-]+$/.test(realm)) throw new Error('A trusted HTTPS origin and realm name are required.');
  const audience = { name: 'hr-api', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
    config: { 'included.custom.audience': 'aihr-api', 'access.token.claim': 'true', 'id.token.claim': 'false' } };
  return {
    realm, enabled: true, displayName: 'AI HR', sslRequired: 'external',
    registrationAllowed: false, duplicateEmailsAllowed: false, loginWithEmailAllowed: true, editUsernameAllowed: false,
    verifyEmail: true, resetPasswordAllowed: false, rememberMe: false,
    bruteForceProtected: true, permanentLockout: false, failureFactor: 5, waitIncrementSeconds: 60,
    maxFailureWaitSeconds: 900, quickLoginCheckMilliSeconds: 1000, minimumQuickLoginWaitSeconds: 60,
    accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 28800,
    revokeRefreshToken: true, refreshTokenMaxReuse: 0,
    passwordPolicy: 'length(14) and notUsername(undefined) and notEmail(undefined)',
    eventsEnabled: true, eventsExpiration: 90 * 86400, adminEventsEnabled: true, adminEventsDetailsEnabled: false,
    defaultSignatureAlgorithm: 'RS256',
    clients: [
      { clientId: 'aihr-web', protocol: 'openid-connect', enabled: true, publicClient: false,
        standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
        fullScopeAllowed: false, redirectUris: [`${origin}/callback`, `${origin}/invite/*`], webOrigins: [origin],
        attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': `${origin}/login` }, protocolMappers: [audience] },
      { clientId: 'aihr-mobile', protocol: 'openid-connect', enabled: true, publicClient: true,
        standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
        fullScopeAllowed: false, redirectUris: ['aihr://auth/callback'], webOrigins: [],
        attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': 'aihr://auth/callback' }, protocolMappers: [audience] },
      { clientId: 'aihr-invitations', protocol: 'openid-connect', enabled: true, publicClient: false,
        standardFlowEnabled: false, implicitFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: true,
        fullScopeAllowed: false, redirectUris: [], webOrigins: [] },
    ],
  };
}
export { INITIAL_SYSTEM_ADMIN_EMAIL };
