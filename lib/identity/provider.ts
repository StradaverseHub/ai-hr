import { internalSelected } from '../internal-auth/config';
import { identityEmailRequest } from './email-ipc';
import { keycloakConfig, keycloakSelected, safeReturnTo } from './config';
import { AccountEmailDeliveryError,recoveryEmailSchema } from '../account-email-model';

export async function currentProviderSession() {
  if (internalSelected()) return (await import('../internal-auth/web-session')).currentInternalIdentity();
  if (keycloakSelected()) return (await import('./session')).currentIdentitySession();
  const session = await (await import('../workos')).currentWorkosSession();
  return session ? { ...session, issuer: undefined, emailVerified: false } : null;
}
export async function providerSignInUrl(returnTo?: string) {
  if (internalSelected()) return `/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
  if (keycloakSelected()) return `/login/start?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`;
  return (await import('../workos')).signInUrl(returnTo);
}
export async function endProviderSession(returnTo?: string): Promise<void> {
  if (internalSelected()) return (await import('../internal-auth/web-session')).endInternalSession(returnTo);
  if (keycloakSelected()) return (await import('./session')).endIdentitySession();
  return (await import('../workos')).endWorkosSession(returnTo);
}
/** The service credential is server-only and holds realm user-management permissions, never HR grants. */
export async function sendIdentityInvitation(email: string, activationPath: string) {
  if ((process.env.KEYCLOAK_EMAIL_ENABLED !== 'true' || !await identityEmailRequest<{ready:boolean}>({op:'readiness'}).then(r=>r.ready===true,()=>false))) throw new Error('Keycloak email delivery is not configured. Ask your administrator to configure the SMTP relay.');
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
    // Persist enrollment before attempting mail: a delivery failure/retry must not leave a local
    // account without a password-enrollment action when it is later found as an existing user.
    await admin('/users', { method: 'POST', body: JSON.stringify({ username: email, email, enabled: true, emailVerified: false, requiredActions: ['UPDATE_PASSWORD'] }) });
    users = await search();
  }
  if (users.length !== 1 || users[0].email?.toLowerCase() !== email.toLowerCase() || !/^[a-zA-Z0-9_-]+$/.test(users[0].id)) throw new Error('Invitation account could not be resolved uniquely.');
  const params = new URLSearchParams({ client_id: config.webClientId, redirect_uri: config.origin + activationPath, lifespan: String(7 * 86400) });
  await admin(`/users/${users[0].id}/execute-actions-email?${params}`, { method: 'PUT', body: JSON.stringify(created ? ['VERIFY_EMAIL', 'UPDATE_PASSWORD'] : ['VERIFY_EMAIL']) });
  return { invitationId: users[0].id };
}

/** Provider-owned one-time recovery. No password, reset token or action link returns to the app. */
export async function sendIdentityPasswordReset(input:string):Promise<void>{
  const email=recoveryEmailSchema.parse(input.trim());
  if(process.env.KEYCLOAK_EMAIL_ENABLED!=='true'||!await identityEmailRequest<{ready:boolean}>({op:'readiness'}).then(result=>result.ready===true,()=>false))throw new AccountEmailDeliveryError('relayUnavailable');
  const config=keycloakConfig(),clientId=process.env.KEYCLOAK_ADMIN_CLIENT_ID,secret=process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  if(!clientId||!secret)throw new AccountEmailDeliveryError('providerUnavailable');
  const transport=(await import('./oidc')).identityFetch(config);
  const response=await transport(`${config.issuer}/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:secret})});
  if(!response.ok)throw new AccountEmailDeliveryError('providerUnavailable');
  const credential:unknown=await response.json();
  if(!credential||typeof credential!=='object'||!('access_token' in credential)||typeof credential.access_token!=='string')throw new AccountEmailDeliveryError('providerUnavailable');
  const base=config.issuer.replace('/realms/','/admin/realms/');
  const admin=async(path:string,init:RequestInit={})=>{
    const url=new URL(base+path),target=config.backchannel?new URL(url.pathname+url.search,config.backchannel):url;
    return fetch(target,{...init,headers:{'content-type':'application/json',authorization:`Bearer ${credential.access_token}`},redirect:'error',signal:AbortSignal.timeout(10_000)});
  };
  const found=await admin(`/users?${new URLSearchParams({email,exact:'true'})}`);
  if(!found.ok)throw new AccountEmailDeliveryError('providerUnavailable');
  const users:unknown=await found.json();
  if(!Array.isArray(users)||users.length!==1)throw new AccountEmailDeliveryError('notEligible');
  const user=users[0] as {id?:unknown;email?:unknown;enabled?:unknown;emailVerified?:unknown;federationLink?:unknown;serviceAccountClientId?:unknown};
  if(typeof user.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(user.id)||typeof user.email!=='string'||user.email.toLowerCase()!==email||user.enabled!==true||user.emailVerified!==true||user.federationLink||user.serviceAccountClientId)throw new AccountEmailDeliveryError('notEligible');
  // Keycloak's configured action-token lifetime applies. Omit redirect/client overrides rather than
  // adding a new redirect to the web client's restricted callback allowlist.
  const sent=await admin(`/users/${user.id}/execute-actions-email`,{method:'PUT',body:JSON.stringify(['UPDATE_PASSWORD'])});
  if(!sent.ok)throw new AccountEmailDeliveryError(sent.status>=400&&sent.status<500?'providerUnavailable':'uncertain');
}
