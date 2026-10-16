/** Provider glue tests, not human sign-in acceptance or authorization DB proof. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({internal:vi.fn(),keycloak:vi.fn(),demo:vi.fn(),fresh:vi.fn(),internalSession:vi.fn(),identity:vi.fn(),handle:vi.fn(),hash:vi.fn(),workos:vi.fn(),companies:vi.fn(),scope:vi.fn(),get:vi.fn(),set:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('next/headers',()=>({cookies:async()=>({get:mock.get,set:mock.set})}));
vi.mock('../lib/session',()=>({getFreshSession:mock.fresh}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:mock.demo}));
vi.mock('../lib/internal-auth/config',()=>({internalSelected:mock.internal,INTERNAL_SESSION_COOKIE:'internal-cookie'}));
vi.mock('../lib/identity/config',()=>({keycloakSelected:mock.keycloak,WEB_SESSION_COOKIE:'oidc-cookie'}));
vi.mock('../lib/internal-auth/service',()=>({readSession:mock.internalSession}));
vi.mock('../lib/identity/session',()=>({currentIdentitySession:mock.identity,sessionHash:mock.hash}));
vi.mock('../lib/identity/cookie',()=>({readSessionHandle:mock.handle}));
vi.mock('../lib/workos',()=>({currentWorkosConversationSession:mock.workos}));
vi.mock('../core/read',()=>({allowedCompanies:mock.companies}));
vi.mock('../lib/scope',()=>({getScopeIds:mock.scope}));
import {resolveAssistantSession,ensureAssistantDemoNonce} from '../lib/assistant-session';
const user='123e4567-e89b-42d3-a456-426614174000',family='123e4567-e89b-42d3-a456-426614174001';
beforeEach(()=>{vi.resetAllMocks();mock.internal.mockReturnValue(false);mock.keycloak.mockReturnValue(false);mock.demo.mockReturnValue(false);mock.fresh.mockResolvedValue({tenantId:'fictional',userId:user});mock.get.mockReturnValue({value:'opaque-fixture'});mock.companies.mockResolvedValue([{id:'company-b'},{id:'company-a'}]);mock.scope.mockResolvedValue(['company-b','company-a','company-a']);});
describe('fresh canonical conversation session',()=>{
 it('uses verified internal family, not credential/session-key material and no provider fallback',async()=>{
  mock.internal.mockReturnValue(true);mock.internalSession.mockResolvedValue({issuer:'https://fictional.invalid/auth/internal',subject:'subject',family,credential:{totpSecret:'never-return'},sessionKey:'never-return'});
  const value=await resolveAssistantSession();expect(value.signInHash).toMatch(/^[a-f0-9]{64}$/);expect(value.scopeIds).toEqual(['company-a','company-b']);expect(JSON.stringify(value)).not.toMatch(/never-return|totpSecret|sessionKey/);expect(mock.workos).not.toHaveBeenCalled();
  mock.internalSession.mockResolvedValue(null);await expect(resolveAssistantSession()).rejects.toMatchObject({code:'sessionUnavailable'});expect(mock.workos).not.toHaveBeenCalled();
 });
 it('binds Keycloak only with verified identity AND canonical decoded opaque handle',async()=>{
  mock.keycloak.mockReturnValue(true);mock.identity.mockResolvedValue({issuer:'https://fictional.invalid/realms/fixture',subject:'subject'});mock.handle.mockResolvedValue('a'.repeat(43));mock.hash.mockReturnValue('b'.repeat(64));expect((await resolveAssistantSession()).signInHash).toMatch(/^[a-f0-9]{64}$/);
  mock.handle.mockResolvedValue(null);await expect(resolveAssistantSession()).rejects.toMatchObject({code:'sessionUnavailable'});expect(mock.workos).not.toHaveBeenCalled();
 });
 it('requires the verified WorkOS sign-in session ID, not subject-only identity',async()=>{
  mock.workos.mockResolvedValue({subject:'subject',sessionId:'verified-session'});const first=await resolveAssistantSession();mock.workos.mockResolvedValue({subject:'subject',sessionId:'new-login'});expect((await resolveAssistantSession()).signInHash).not.toBe(first.signInHash);
  mock.workos.mockResolvedValue(null);await expect(resolveAssistantSession()).rejects.toMatchObject({code:'sessionUnavailable'});
 });
 it('refuses a sign-in change during principal resolution and a scope above the fixed bound',async()=>{
  mock.workos.mockResolvedValueOnce({subject:'subject',sessionId:'login-a'}).mockResolvedValueOnce({subject:'subject',sessionId:'login-b'});await expect(resolveAssistantSession()).rejects.toMatchObject({code:'sessionUnavailable'});expect(mock.companies).not.toHaveBeenCalled();
  mock.workos.mockResolvedValue({subject:'subject',sessionId:'stable'});mock.scope.mockResolvedValue(Array.from({length:101},(_,n)=>'company-'+n));await expect(resolveAssistantSession()).rejects.toMatchObject({code:'unavailable'});
 });
 it('creates a demo-only partition nonce after canonical sign-in and never creates an auth principal',async()=>{
  mock.demo.mockReturnValue(true);mock.get.mockReturnValue(undefined);await ensureAssistantDemoNonce();expect(mock.fresh).toHaveBeenCalledOnce();expect(mock.set).toHaveBeenCalledWith('assistant_demo_signin',expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),expect.objectContaining({httpOnly:true,path:'/'}));
  mock.set.mockClear();mock.demo.mockReturnValue(false);await ensureAssistantDemoNonce();expect(mock.set).not.toHaveBeenCalled();
 });
});
