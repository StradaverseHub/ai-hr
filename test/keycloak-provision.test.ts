import { describe, expect, it, vi } from 'vitest';
import { provisionIdentityRealm, type IdentityAdmin } from '../deploy/keycloak/provision';

const roles = ['manage-users', 'query-users', 'realm-admin', 'manage-clients', 'manage-realm'].map(name => ({ id: name, name }));
const credentials = { webSecret: 'test-web-secret', invitationsSecret: 'test-invitation-secret', emailSettingsSecret:'test-email-secret', initialPassword: 'test-owner-password' };
function fixture(missingRole?: string) {
  const emails=new Map<string,Map<string,string>>();
  return vi.fn<IdentityAdmin>(async (path, method = 'GET', body) => {
    if(path==='/realms'&&method==='POST')emails.set((body as {realm:string}).realm,new Map());
    const userPath=path.match(/^\/realms\/([^/]+)\/users(?:\/([^/]+))?$/);
    if(userPath&&(method==='PUT'||method==='POST')){
      const email=(body as {email?:string}).email,id=userPath[2]??'owner',realmEmails=emails.get(userPath[1])!;
      if(email){
        if([...realmEmails].some(([other,value])=>other!==id&&value===email))throw new Error('Duplicate realm email');
        realmEmails.set(id,email);
      }
    }
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
  it('keeps the owner email unique while the private SMTP sender uses that same fixed recipient',async()=>{
    const admin=fixture();await provisionIdentityRealm(admin,'https://hr.test',credentials);
    const realms=admin.mock.calls.filter(c=>c[0]==='/realms'&&c[1]==='POST').map(c=>c[2]) as Array<{realm:string;duplicateEmailsAllowed:boolean;registrationAllowed:boolean;clients:Array<{clientId:string}>}>;
    expect(realms.map(r=>r.realm)).toEqual(['ai-hr','ai-hr-email-test']);
    expect(realms.every(r=>r.duplicateEmailsAllowed===false&&r.registrationAllowed===false)).toBe(true);
    expect(realms[1].clients.map(c=>c.clientId)).toEqual(['aihr-email-settings']);
    expect(admin.mock.calls.find(c=>c[0]==='/realms/ai-hr/users/email-user'&&c[1]==='PUT')).toBeUndefined();
    expect(admin.mock.calls.find(c=>c[0]==='/realms/ai-hr-email-test/users/email-user'&&c[1]==='PUT')?.[2]).toEqual({email:'yanli.lam@stradaverse.ai',emailVerified:true});
  });
});
