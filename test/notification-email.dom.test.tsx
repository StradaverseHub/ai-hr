import { beforeEach,describe,expect,it,vi } from 'vitest';
import { render,screen,cleanup } from '@testing-library/react';
import en from '../messages/en.json';
const m=vi.hoisted(()=>({policy:vi.fn(),deliveries:vi.fn(),relay:vi.fn(),preferences:vi.fn(),identity:vi.fn(),internal:vi.fn(),group:vi.fn(),accounts:vi.fn()}));
const t=(key:string)=>key.split('.').reduce((v:any,k)=>v?.[k],en.workflowEmail)??key;
vi.mock('next-intl/server',()=>({getTranslations:async()=>t,getLocale:async()=>'en'}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{userId:'user'}}),scopedSession:async()=>({s:{userId:'user'},scopeIds:[]})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn(),isGroupAdmin:m.group}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:m.identity}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>true}));
vi.mock('../core/letter-email-preferences',()=>({readLetterEmailPreferences:async()=>({preference:null,current:false,enabledByPolicy:false})}));
vi.mock('../core/notification-email',()=>({readNotificationEmailPolicy:m.policy,readNotificationEmailDeliveries:m.deliveries,readNotificationEmailPreferences:m.preferences}));
vi.mock('../core/notification-email-delivery',()=>({readNotificationEmailTransport:m.relay}));
vi.mock('../core/account-email',()=>({readAccountEmailDeliveries:m.accounts}));
vi.mock('../components/account-email-deliveries',()=>({AccountEmailDeliveries:()=>null}));
vi.mock('../app/(app)/admin/settings/notifications/actions',()=>({saveWorkflowEmailPolicy:vi.fn(),retryWorkflowEmail:vi.fn()}));
vi.mock('../app/(app)/me/notifications/actions',()=>({saveMyWorkflowEmailPreferences:vi.fn(),saveMyLetterEmailPreferences:vi.fn()}));
import AdminPage from '../app/(app)/admin/settings/notifications/page';
import MyPage from '../app/(app)/me/notifications/page';
beforeEach(()=>{cleanup();vi.clearAllMocks();m.accounts.mockResolvedValue([]);m.policy.mockResolvedValue([]);m.deliveries.mockResolvedValue([]);m.relay.mockResolvedValue(null);m.group.mockReturnValue(true);m.internal.mockReturnValue(false);m.identity.mockResolvedValue(null);m.preferences.mockResolvedValue({employments:[{id:'employment',code:'EMP-01'}],preferences:[],policy:[]});});
describe('workflow email configuration screens',()=>{
 it('does not claim mail is active when the root-installed service has not been upgraded',async()=>{
  render(await AdminPage({searchParams:Promise.resolve({})}));
  expect(screen.getByText(en.workflowEmail.upgradeRequired)).toBeTruthy();
  // Explicit product contract, independent of the category array that renders the screen.
  const expectedCategories = ['attendance','claims','delegation','leave','letters','notice','offboarding','onboarding','payroll','performance','profile','readiness','review','rewards','toil','employee_master_reports'] as const;
  expect(screen.getAllByRole('checkbox')).toHaveLength(expectedCategories.length);
  for (const category of expectedCategories) {
   // A singular exact-name query also refuses duplicate controls or an absent category.
   expect(screen.getByRole('checkbox',{name:en.workflowEmail.categories[category]})).not.toBeChecked();
  }
 });
 it('makes tenant controls read-only for a company administrator',async()=>{
  m.group.mockReturnValue(false);render(await AdminPage({searchParams:Promise.resolve({})}));expect(screen.queryByRole('button',{name:en.workflowEmail.savePolicy})).toBeNull();expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
 });
 it('describes accepted mail honestly and requires duplicate acknowledgement before a failed send retry',async()=>{
  m.relay.mockResolvedValue({version:1,ready:true});m.deliveries.mockResolvedValue([{id:'delivery',recipientCode:'EMP-009',category:'payroll',status:'failed',attempts:1,error:'uncertain',createdAt:new Date(),sentAt:null}]);
  render(await AdminPage({searchParams:Promise.resolve({})}));expect(screen.getByText(en.workflowEmail.deliveriesHelp)).toBeTruthy();expect(screen.getByText(en.workflowEmail.recipientCode+': EMP-009')).toBeTruthy();expect(screen.getByText(en.workflowEmail.deliveryReference+': delivery')).toBeTruthy();const checkbox=screen.getByRole('checkbox',{name:en.workflowEmail.retryAck}) as HTMLInputElement;expect(checkbox.required).toBe(true);expect(checkbox.checked).toBe(false);
 });
 it('shows missing SMTP as a failed delivery with an individual retry and explains that HR work continues',async()=>{
  m.relay.mockResolvedValue({version:1,ready:false});m.deliveries.mockResolvedValue([{id:'offline-delivery',category:'performance',status:'failed',attempts:1,error:'relayUnavailable',createdAt:new Date(),sentAt:null}]);
  render(await AdminPage({searchParams:Promise.resolve({})}));
  expect(screen.getByText(en.workflowEmail.relayOff)).toBeTruthy();expect(screen.getByText(en.workflowEmail.errors.relayUnavailable)).toBeTruthy();
  expect(screen.getByText(en.workflowEmail.statuses.failed)).toBeTruthy();expect(screen.getByRole('button',{name:en.workflowEmail.retry})).toBeTruthy();
  expect((document.querySelector('input[name=deliveryId]') as HTMLInputElement).value).toBe('offline-delivery');
  expect(screen.getByText(en.workflowEmail.deliveriesHelp)).toBeTruthy();
 });
 it('does not let a demo login opt in, while leaving consent withdrawal representable',async()=>{
  render(await MyPage({searchParams:Promise.resolve({})}));expect(screen.getByText(en.workflowEmail.identityRequired)).toBeTruthy();expect(screen.getAllByRole('checkbox').every(c=>(c as HTMLInputElement).disabled)).toBe(true);
  cleanup();m.preferences.mockResolvedValue({employments:[{id:'employment',code:'EMP-01'}],preferences:[{recipientEmploymentId:'employment',category:'leave',enabled:true,emailConsentUserId:'user',emailAfterSequence:0,emailLocale:'en'}],policy:[]});
  render(await MyPage({searchParams:Promise.resolve({})}));const consent=screen.getByRole('checkbox',{name:new RegExp('^Leave')}) as HTMLInputElement;expect(consent.disabled).toBe(false);expect(consent.checked).toBe(true);
 });
 it('renders a separate preference form for concurrent employments',async()=>{
  m.identity.mockResolvedValue({emailVerified:true,issuer:'https://fixture.test/auth/tenant',subject:'fixture-user',email:'fictional@demo.test'});m.preferences.mockResolvedValue({employments:[{id:'one',code:'EMP-01'},{id:'two',code:'EMP-02'}],preferences:[],policy:[]});
  render(await MyPage({searchParams:Promise.resolve({})}));expect(screen.getAllByRole('button',{name:en.workflowEmail.save})).toHaveLength(2);expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[name=employmentId]')).map(i=>i.value)).toEqual(['one','two']);expect(screen.queryByRole('checkbox',{name:en.workflowEmail.categories.letters})).toBeNull();expect(screen.getAllByRole('checkbox').every(c=>!(c as HTMLInputElement).disabled)).toBe(true);
 });
});
