/** Run as the server administrator AFTER install.sh. Never logs credentials or mails any user. */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { INITIAL_SYSTEM_ADMIN_EMAIL } from './realm';
import { provisionIdentityRealm } from './provision';

async function main() {
  if (process.getuid?.() !== 0) throw new Error('Administrator access required.');
  const origin = process.env.AUTH_PUBLIC_ORIGIN!;
  if (existsSync('/etc/aihr-keycloak/app.env')) throw new Error('Realm credentials already exist. Do not overwrite them.');
  const env = Object.fromEntries(readFileSync('/etc/aihr-keycloak/service.env','utf8').split('\n').filter(l => l.includes('=')).map(l => { const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1)]; }));
  const base = 'http://127.0.0.1:8080/identity';
  const tokenResponse = await fetch(`${base}/realms/master/protocol/openid-connect/token`, { method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
    body:new URLSearchParams({ grant_type:'password', client_id:'admin-cli', username:env.KC_BOOTSTRAP_ADMIN_USERNAME, password:env.KC_BOOTSTRAP_ADMIN_PASSWORD }) });
  if (!tokenResponse.ok) throw new Error('Bootstrap authentication failed.');
  const token = (await tokenResponse.json()).access_token as string;
  async function admin(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/admin${path}`, { method, body:body === undefined ? undefined : JSON.stringify(body),
      headers:{ authorization:`Bearer ${token}`, 'content-type':'application/json' }, redirect:'error', signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Identity setup failed (${response.status}) for ${path.split('?')[0]}. Inspect the private service log.`);
    return response.status === 204 || response.status === 201 ? undefined : response.json();
  }
  const secret = () => randomBytes(32).toString('hex');
  const webSecret = secret(), invitationsSecret = secret(), emailSettingsSecret = secret(), initialPassword = secret();
  const provisioned = await provisionIdentityRealm(admin, origin, { webSecret, invitationsSecret, emailSettingsSecret, initialPassword });
  const realm = { realm: provisioned.realm };
  // Prove effective client scope/role intersection before removing bootstrap access.
  const serviceTokenResponse = await fetch(`${base}/realms/${realm.realm}/protocol/openid-connect/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'aihr-invitations', client_secret: invitationsSecret }),
  });
  if (!serviceTokenResponse.ok) throw new Error('Invitation service authentication failed.');
  const serviceToken = (await serviceTokenResponse.json()).access_token;
  if (typeof serviceToken !== 'string') throw new Error('Invitation service credential is invalid.');
  const serviceProbe = await fetch(`${base}/admin/realms/${realm.realm}/users?max=1`, {
    headers: { authorization: `Bearer ${serviceToken}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!serviceProbe.ok) throw new Error('Invitation service permissions failed verification.');
  writeFileSync('/etc/aihr-keycloak/app.env',[
    'AUTH_PROVIDER=keycloak',`AUTH_PUBLIC_ORIGIN=${origin}`,`KEYCLOAK_ISSUER=${origin}/identity/realms/${realm.realm}`,
    'KEYCLOAK_WEB_CLIENT_ID=aihr-web',`KEYCLOAK_WEB_CLIENT_SECRET=${webSecret}`,'KEYCLOAK_MOBILE_CLIENT_ID=aihr-mobile',
    'KEYCLOAK_API_AUDIENCE=aihr-api',`AUTH_SESSION_KEY=${secret()}`,'KEYCLOAK_BACKCHANNEL_ORIGIN=http://127.0.0.1:8080',
    'KEYCLOAK_ADMIN_CLIENT_ID=aihr-invitations',`KEYCLOAK_ADMIN_CLIENT_SECRET=${invitationsSecret}`,'KEYCLOAK_EMAIL_ENABLED=true',
  ].join('\n')+'\n',{mode:0o600});
  writeFileSync('/etc/aihr-keycloak/email-agent.env',[`IDENTITY_EMAIL_CLIENT_SECRET=${emailSettingsSecret}`,`IDENTITY_EMAIL_REVISION_KEY=${secret()}`,`IDENTITY_EMAIL_TEST_RECIPIENT=${INITIAL_SYSTEM_ADMIN_EMAIL}`].join('\n')+'\n',{mode:0o600});
  writeFileSync('/etc/aihr-keycloak/initial-owner.json',JSON.stringify({email:INITIAL_SYSTEM_ADMIN_EMAIL,subject:provisioned.ownerSubject,issuer:`${origin}/identity/realms/${realm.realm}`,temporaryPassword:initialPassword})+'\n',{mode:0o600});
  // The real owner is realm administrator. Remove the temporary master bootstrap administrator.
  const bootstrapUsers = await admin(`/realms/master/users?${new URLSearchParams({username:env.KC_BOOTSTRAP_ADMIN_USERNAME,exact:'true'})}`);
  if (bootstrapUsers.length !== 1) throw new Error('Bootstrap administrator is ambiguous.');
  await admin(`/realms/master/users/${bootstrapUsers[0].id}`,'DELETE');
  writeFileSync('/etc/aihr-keycloak/service.env',readFileSync('/etc/aihr-keycloak/service.env','utf8').split('\n').filter(l=>!l.startsWith('KC_BOOTSTRAP_ADMIN_')).join('\n'),{mode:0o600});
  console.log('Realm configured. Owner credentials are in a root-only file; arrange secure handoff and remove that file after first login. No HR access exists until the audited account-link step.');
}
main().catch(()=>{console.error('Keycloak realm setup failed. No authentication cutover was performed. Inspect the private service and setup files before retrying.');process.exitCode=1;});
