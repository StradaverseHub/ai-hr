/** Run as the server administrator AFTER install.sh. Never logs credentials or mails any user. */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { realmDefinition, INITIAL_SYSTEM_ADMIN_EMAIL } from './realm';

async function main() {
  if (process.getuid?.() !== 0) throw new Error('Administrator access required.');
  const origin = process.env.AUTH_PUBLIC_ORIGIN!;
  const realm = realmDefinition(origin);
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
  const webSecret = secret(), invitationsSecret = secret(), initialPassword = secret();
  const clients = realm.clients.map(c => ({ ...c, ...(c.clientId === 'aihr-web' ? { secret:webSecret } : c.clientId === 'aihr-invitations' ? { secret:invitationsSecret } : {}) }));
  await admin('/realms','POST',{...realm,clients});
  const prefix = `/realms/${realm.realm}`;
  const allClients = await admin(`${prefix}/clients`) as Array<{id:string;clientId:string}>;
  const management = allClients.find(c=>c.clientId==='realm-management')!;
  const invitations = allClients.find(c=>c.clientId==='aihr-invitations')!;
  const serviceUser = await admin(`${prefix}/clients/${invitations.id}/service-account-user`);
  const managedRoles = await admin(`${prefix}/clients/${management.id}/roles`) as Array<{id:string;name:string}>;
  await admin(`${prefix}/users/${serviceUser.id}/role-mappings/clients/${management.id}`,'POST',managedRoles.filter(r=>['manage-users','query-users'].includes(r.name)));
  await admin(`${prefix}/users`,'POST',{ username:INITIAL_SYSTEM_ADMIN_EMAIL, email:INITIAL_SYSTEM_ADMIN_EMAIL,
    enabled:true, emailVerified:true, requiredActions:['UPDATE_PASSWORD','CONFIGURE_TOTP'],
    credentials:[{type:'password',value:initialPassword,temporary:true}] });
  const owners = await admin(`${prefix}/users?${new URLSearchParams({username:INITIAL_SYSTEM_ADMIN_EMAIL,exact:'true'})}`);
  if (owners.length !== 1) throw new Error('Bootstrap owner is ambiguous.');
  await admin(`${prefix}/users/${owners[0].id}/role-mappings/clients/${management.id}`,'POST',managedRoles.filter(r=>r.name==='realm-admin'));
  writeFileSync('/etc/aihr-keycloak/app.env',[
    'AUTH_PROVIDER=keycloak',`AUTH_PUBLIC_ORIGIN=${origin}`,`KEYCLOAK_ISSUER=${origin}/identity/realms/${realm.realm}`,
    'KEYCLOAK_WEB_CLIENT_ID=aihr-web',`KEYCLOAK_WEB_CLIENT_SECRET=${webSecret}`,'KEYCLOAK_MOBILE_CLIENT_ID=aihr-mobile',
    'KEYCLOAK_API_AUDIENCE=aihr-api',`AUTH_SESSION_KEY=${secret()}`,'KEYCLOAK_BACKCHANNEL_ORIGIN=http://127.0.0.1:8080',
    'KEYCLOAK_ADMIN_CLIENT_ID=aihr-invitations',`KEYCLOAK_ADMIN_CLIENT_SECRET=${invitationsSecret}`,'KEYCLOAK_EMAIL_ENABLED=false',
  ].join('\n')+'\n',{mode:0o600});
  writeFileSync('/etc/aihr-keycloak/initial-owner.json',JSON.stringify({email:INITIAL_SYSTEM_ADMIN_EMAIL,subject:owners[0].id,issuer:`${origin}/identity/realms/${realm.realm}`,temporaryPassword:initialPassword})+'\n',{mode:0o600});
  // The real owner is realm administrator. Remove the temporary master bootstrap administrator.
  const bootstrapUsers = await admin(`/realms/master/users?${new URLSearchParams({username:env.KC_BOOTSTRAP_ADMIN_USERNAME,exact:'true'})}`);
  if (bootstrapUsers.length !== 1) throw new Error('Bootstrap administrator is ambiguous.');
  await admin(`/realms/master/users/${bootstrapUsers[0].id}`,'DELETE');
  writeFileSync('/etc/aihr-keycloak/service.env',readFileSync('/etc/aihr-keycloak/service.env','utf8').split('\n').filter(l=>!l.startsWith('KC_BOOTSTRAP_ADMIN_')).join('\n'),{mode:0o600});
  console.log('Realm configured. Owner credentials are in a root-only file; arrange secure handoff and remove that file after first login. No HR access exists until the audited account-link step.');
}
main().catch(()=>{console.error('Keycloak realm setup failed. No authentication cutover was performed. Inspect the private service and setup files before retrying.');process.exitCode=1;});
