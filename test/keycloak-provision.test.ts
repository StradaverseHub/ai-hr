import { describe, expect, it, vi } from 'vitest';
import { provisionIdentityRealm, type IdentityAdmin } from '../deploy/keycloak/provision';

const roles = ['manage-users', 'query-users', 'realm-admin', 'manage-clients', 'manage-realm'].map(name => ({ id: name, name }));
const credentials = { webSecret: 'test-web-secret', invitationsSecret: 'test-invitation-secret', emailSettingsSecret:'test-email-secret', initialPassword: 'test-owner-password' };
function fixture(missingRole?: string) {
  return vi.fn<IdentityAdmin>(async (path, method = 'GET') => {
    if (method !== 'GET') return;
    if (path.endsWith('/clients')) return [{ id: 'management', clientId: 'realm-management' }, { id: 'invitations', clientId: 'aihr-invitations' }, {id:'email',clientId:'aihr-email-settings'}];
    if (path.endsWith('/service-account-user')) return { id: path.includes('/email/')?'email-user':'service-user' };
    if (path.endsWith('/roles')) return roles.filter(r => r.name !== missingRole);
    if (path.includes('/users?')) return [{ id: 'owner' }];
    throw new Error('Unexpected identity request');
  });
}
describe('private Keycloak realm enrollment', () => {
  it('grants matching narrow client scopes and service roles, independently of the owner role', async () => {
    const admin = fixture();
    expect(await provisionIdentityRealm(admin, 'https://hr.test', credentials)).toEqual({ realm: 'ai-hr', ownerSubject: 'owner' });
    const posts = admin.mock.calls.filter(c => c[1] === 'POST');
    for (const path of ['/clients/invitations/scope-mappings/clients/management', '/users/service-user/role-mappings/clients/management']) {
      const call = posts.find(c => c[0] === `/realms/ai-hr${path}`)!;
      expect(call[2]).toEqual(roles.filter(r => ['manage-users', 'query-users'].includes(r.name)));
    }
    expect(posts.find(c => c[0] === '/realms/ai-hr/users/owner/role-mappings/clients/management')?.[2]).toEqual([roles[2]]);
    const definition = posts.find(c => c[0] === '/realms')?.[2] as { clients: Array<{ clientId: string; fullScopeAllowed: boolean }> };
    expect(definition.clients.every(c => c.fullScopeAllowed === false)).toBe(true);
    const owner = posts.find(c => c[0] === '/realms/ai-hr/users')?.[2] as { email: string; requiredActions: string[] };
    expect(owner.email).toBe('yanli.lam@stradaverse.ai');
    expect(owner.requiredActions).toEqual(['UPDATE_PASSWORD', 'CONFIGURE_TOTP']);
  });
  it.each(['manage-users', 'query-users', 'realm-admin', 'manage-realm'])('fails bootstrap if the required role %s is absent', async missing => {
    const admin = fixture(missing);
    await expect(provisionIdentityRealm(admin, 'https://hr.test', credentials)).rejects.toThrow('permissions are missing');
    expect(admin.mock.calls.some(c => c[0].includes('/users/owner/'))).toBe(false);
  });
});
