import { INITIAL_SYSTEM_ADMIN_EMAIL, realmDefinition } from './realm';
import { IDENTITY_EMAIL_TEST_REALM } from '../../lib/identity/bootstrap';

export type IdentityAdmin = (path: string, method?: string, body?: unknown) => Promise<unknown>;

/** Bootstrap through the private Admin API; never grants application/HR permissions. */
export async function provisionIdentityRealm(admin: IdentityAdmin, origin: string, credentials: {
  webSecret: string; invitationsSecret: string; emailSettingsSecret: string; initialPassword: string;
}) {
  const realm = realmDefinition(origin);
  const clients = realm.clients.map(c => ({ ...c,
    ...(c.clientId === 'aihr-web' ? { secret: credentials.webSecret }
      : c.clientId === 'aihr-email-settings' ? { secret: credentials.emailSettingsSecret }
      : c.clientId === 'aihr-invitations' ? { secret: credentials.invitationsSecret } : {}),
  }));
  await admin('/realms', 'POST', { ...realm, clients });
  const prefix = `/realms/${realm.realm}`;
  const allClients = await admin(`${prefix}/clients`) as Array<{ id: string; clientId: string }>;
  const management = allClients.find(c => c.clientId === 'realm-management');
  const invitations = allClients.find(c => c.clientId === 'aihr-invitations');
  if (!management || !invitations) throw new Error('Required identity clients are missing.');
  const serviceUser = await admin(`${prefix}/clients/${invitations.id}/service-account-user`) as { id: string };
  if (!serviceUser || typeof serviceUser.id !== 'string') throw new Error('Invitation service account is missing.');
  const managedRoles = await admin(`${prefix}/clients/${management.id}/roles`) as Array<{ id: string; name: string }>;
  const invitationRoles = ['manage-users', 'query-users'].map(name => {
    const role = managedRoles.find(r => r.name === name);
    if (!role) throw new Error('Required invitation permissions are missing.');
    return role;
  });
  // Effective service permissions are the intersection of its assigned roles and client scopes.
  await admin(`${prefix}/clients/${invitations.id}/scope-mappings/clients/${management.id}`, 'POST', invitationRoles);
  await admin(`${prefix}/users/${serviceUser.id}/role-mappings/clients/${management.id}`, 'POST', invitationRoles);
  const emailClient = allClients.find(c => c.clientId === 'aihr-email-settings');
  const emailRole = managedRoles.find(r => r.name === 'manage-realm');
  if (!emailClient || !emailRole) throw new Error('Required email settings permissions are missing.');
  const emailUser = await admin(`${prefix}/clients/${emailClient.id}/service-account-user`) as {id:string};
  if (!emailUser?.id) throw new Error('Email settings service account is missing.');
  await admin(`${prefix}/clients/${emailClient.id}/scope-mappings/clients/${management.id}`, 'POST', [emailRole]);
  await admin(`${prefix}/users/${emailUser.id}/role-mappings/clients/${management.id}`, 'POST', [emailRole]);
  const ownerRole = managedRoles.find(r => r.name === 'realm-admin');
  if (!ownerRole) throw new Error('Required owner permissions are missing.');
  await admin(`${prefix}/users`, 'POST', {
    username: INITIAL_SYSTEM_ADMIN_EMAIL, email: INITIAL_SYSTEM_ADMIN_EMAIL,
    enabled: true, emailVerified: true, requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
    credentials: [{ type: 'password', value: credentials.initialPassword, temporary: true }],
  });
  const owners = await admin(`${prefix}/users?${new URLSearchParams({ username: INITIAL_SYSTEM_ADMIN_EMAIL, exact: 'true' })}`);
  if (!Array.isArray(owners) || owners.length !== 1 || typeof owners[0].id !== 'string') throw new Error('Bootstrap owner is ambiguous.');
  await admin(`${prefix}/users/${owners[0].id}/role-mappings/clients/${management.id}`, 'POST', [ownerRole]);
  // Service accounts participate in realm email uniqueness. Test in a private realm so the
  // fixed recipient can equal the real owner's address without creating a duplicate identity.
  const testRealm = realmDefinition(origin, IDENTITY_EMAIL_TEST_REALM);
  await admin('/realms', 'POST', {...testRealm,displayName:'AI HR SMTP checks',loginWithEmailAllowed:false,
    clients:[clients.find(c=>c.clientId==='aihr-email-settings')!]});
  const testPrefix=`/realms/${IDENTITY_EMAIL_TEST_REALM}`;
  const testClients=await admin(`${testPrefix}/clients`) as Array<{id:string;clientId:string}>;
  const testManagement=testClients.find(c=>c.clientId==='realm-management');
  const testClient=testClients.find(c=>c.clientId==='aihr-email-settings');
  if(!testManagement||!testClient)throw new Error('SMTP test clients are missing.');
  const testUser=await admin(`${testPrefix}/clients/${testClient.id}/service-account-user`) as {id:string};
  const testRoles=await admin(`${testPrefix}/clients/${testManagement.id}/roles`) as Array<{id:string;name:string}>;
  const testRole=testRoles.find(r=>r.name==='manage-realm');
  if(!testUser?.id||!testRole)throw new Error('SMTP test permissions are missing.');
  await admin(`${testPrefix}/clients/${testClient.id}/scope-mappings/clients/${testManagement.id}`,'POST',[testRole]);
  await admin(`${testPrefix}/users/${testUser.id}/role-mappings/clients/${testManagement.id}`,'POST',[testRole]);
  await admin(`${testPrefix}/users/${testUser.id}`,'PUT',{email:INITIAL_SYSTEM_ADMIN_EMAIL,emailVerified:true});
  return { realm: realm.realm, ownerSubject: owners[0].id as string };
}
