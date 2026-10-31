/** Render regression only: synthetic view/session adapters are not consent or human Auth evidence. */
import {createHash} from 'node:crypto';
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({scope:vi.fn(),module:vi.fn(),internal:vi.fn(),keycloak:vi.fn(),internalIdentity:vi.fn(),keycloakIdentity:vi.fn(),workosIdentity:vi.fn(),preferences:vi.fn(),save:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:m.scope}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../lib/authz',()=>({requireModule:m.module}));
vi.mock('../lib/internal-auth/config',()=>({internalSelected:m.internal}));
vi.mock('../lib/internal-auth/web-session',()=>({currentInternalIdentity:m.internalIdentity}));
vi.mock('../lib/identity/config',()=>({keycloakSelected:m.keycloak}));
vi.mock('../lib/identity/session',()=>({currentIdentitySession:m.keycloakIdentity}));
vi.mock('../lib/workos',()=>({currentWorkosSession:m.workosIdentity}));
vi.mock('../lib/identity/email-ipc',()=>({identityEmailRequest:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true}));
vi.mock('../core/letter-email-preferences',()=>({readLetterEmailPreferences:async()=>({preference:null,current:false,enabledByPolicy:false})}));
vi.mock('../core/notification-email',()=>({readNotificationEmailPreferences:m.preferences,saveNotificationEmailPreferences:m.save}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=> (key:string)=>key}));
vi.mock('../components/ui',async()=>{
 const {createElement}=await import('react');
 const box=({children}:{children?:React.ReactNode})=>createElement('div',null,children);
 return {PageHeader:()=>null,Card:box,SectionHeader:()=>null,ErrorBanner:({message}:{message?:string})=>message?createElement('p',{role:'alert'},message):null,Field:box,inputCls:'test',btnPrimary:'test'};
});
import PreferencesPage from '../app/(app)/me/notifications/page';
const userId='user-current',employmentId='own-employment';
const identity={issuer:'https://localhost:3543/auth/fixture-tenant',subject:'internal-subject',email:'recipient@report-acceptance.invalid',emailVerified:true};
const preference={recipientEmploymentId:employmentId,category:'employee_master_reports',enabled:true,emailConsentUserId:userId,emailAfterSequence:42,emailLocale:'en',reportConsentVerifiedAt:new Date('2026-10-16T00:00:00Z'),reportConsentIssuer:identity.issuer,reportConsentSubject:identity.subject,reportConsentAddressHash:createHash('sha256').update(identity.email).digest('hex')};
function view(preferences:unknown[]=[]){m.preferences.mockResolvedValue({employments:[{id:employmentId,code:'REPORT-RECIPIENT'}],preferences,policy:[{category:'employee_master_reports',enabled:true}]});}
async function page(){render(await PreferencesPage({searchParams:Promise.resolve({})}));const checkbox=document.querySelector<HTMLInputElement>('input[name="category"][value="employee_master_reports"]');expect(checkbox).not.toBeNull();return checkbox!;}
beforeEach(()=>{vi.clearAllMocks();m.scope.mockResolvedValue({s:{tenantId:'fixture-tenant',userId,personId:'own-person'},scopeIds:[]});m.module.mockResolvedValue(undefined);m.internal.mockReturnValue(true);m.keycloak.mockReturnValue(false);m.internalIdentity.mockResolvedValue(identity);m.keycloakIdentity.mockResolvedValue({...identity,issuer:'https://keycloak.test/realms/fixture',subject:'keycloak-subject'});m.workosIdentity.mockResolvedValue(null);view();});
afterEach(cleanup);
describe('canonical provider report-email consent page',()=>{
 it('enables actual selected-internal consent controls instead of requiring Keycloak',async()=>{
  expect(await page()).not.toBeDisabled();expect(screen.queryByText('identityRequired')).not.toBeInTheDocument();expect(m.internalIdentity).toHaveBeenCalledOnce();expect(m.keycloakIdentity).not.toHaveBeenCalled();expect(m.workosIdentity).not.toHaveBeenCalled();expect(m.module).toHaveBeenCalledWith('notifications');
 });
 it('recognises only the exact current internal user/issuer/subject/address binding',async()=>{
  view([preference]);expect(await page()).toBeChecked();expect(document.querySelector<HTMLInputElement>('input[name="employmentId"]')?.value).toBe(employmentId);expect(m.save).not.toHaveBeenCalled();
 });
 it.each([{emailConsentUserId:'other-user'},{reportConsentIssuer:'https://other.test/auth/fixture-tenant'},{reportConsentSubject:'other-subject'},{reportConsentAddressHash:'0'.repeat(64)},{emailAfterSequence:null},{reportConsentVerifiedAt:null}])('does not display stale/foreign consent as current: %j',async changed=>{view([{...preference,...changed}]);expect(await page()).not.toBeChecked();});
 it('preserves the selected Keycloak provider through the same canonical owner',async()=>{
  m.internal.mockReturnValue(false);m.keycloak.mockReturnValue(true);expect(await page()).not.toBeDisabled();expect(m.keycloakIdentity).toHaveBeenCalledOnce();expect(m.internalIdentity).not.toHaveBeenCalled();
 });
 it('does not invent verified email or an issuer for a legacy WorkOS session',async()=>{
  m.internal.mockReturnValue(false);m.workosIdentity.mockResolvedValue({subject:'legacy-subject',email:identity.email,emailVerified:true,issuer:'caller-claim'});expect(await page()).toBeDisabled();expect(screen.getByText('identityRequired')).toBeInTheDocument();expect(m.workosIdentity).toHaveBeenCalledOnce();
 });
 it.each([null,{...identity,emailVerified:false},{...identity,issuer:undefined},{...identity,subject:''},{...identity,email:null}])('does not enable new consent without complete canonical proof: %j',async value=>{m.internalIdentity.mockResolvedValue(value);expect(await page()).toBeDisabled();expect(screen.getByRole('button',{name:'save'})).not.toBeDisabled();expect(m.save).not.toHaveBeenCalled();});
 it('keeps the withdrawal form available when the selected provider is unavailable, without falling back',async()=>{
  m.internalIdentity.mockRejectedValue(Error('private provider failure'));expect(await page()).toBeDisabled();expect(screen.getByText('identityRequired')).toBeInTheDocument();expect(screen.getByRole('button',{name:'save'})).not.toBeDisabled();expect(m.keycloakIdentity).not.toHaveBeenCalled();expect(m.workosIdentity).not.toHaveBeenCalled();expect(document.body.textContent).not.toContain('private provider failure');
 });
 it('retains actual session/module refusals before reading preferences or identity',async()=>{
  m.module.mockRejectedValue(Error('module refused'));await expect(PreferencesPage({searchParams:Promise.resolve({})})).rejects.toThrow('module refused');expect(m.preferences).not.toHaveBeenCalled();expect(m.internalIdentity).not.toHaveBeenCalled();
 });
});
