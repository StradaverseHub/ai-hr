import { INITIAL_SYSTEM_ADMIN_EMAIL, realmDefinition } from './realm';

export type IdentityAdmin = (path: string, method?: string, body?: unknown) => Promise<unknown>;

/** Bootstrap through the private Admin API; never grants application/HR permissions. */
export async function provisionIdentityRealm(admin: IdentityAdmin, origin: string, credentials: {
  webSecret: string; invitationsSecret: string; initialPassword: string;
}) {
  const realm = realmDefinition(origin);
  const clients = realm.clients.map(c => ({ ...c,
    ...(c.clientId === 'aihr-web' ? { secret: credentials.webSecret }
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
  return { realm: realm.realm, ownerSubject: owners[0].id as string };
}
