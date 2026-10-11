import { beforeEach,describe,expect,it,vi } from 'vitest';
import { render,screen,cleanup } from '@testing-library/react';
import en from '../messages/en.json';
const m=vi.hoisted(()=>({policy:vi.fn(),deliveries:vi.fn(),relay:vi.fn(),preferences:vi.fn(),identity:vi.fn(),internal:vi.fn(),group:vi.fn()}));
const t=(key:string)=>key.split('.').reduce((v:any,k)=>v?.[k],en.workflowEmail)??key;
vi.mock('next-intl/server',()=>({getTranslations:async()=>t,getLocale:async()=>'en'}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{userId:'user'}}),scopedSession:async()=>({s:{userId:'user'}})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn(),isGroupAdmin:m.group}));
vi.mock('../lib/identity/config',()=>({keycloakSelected:m.internal}));vi.mock('../lib/identity/session',()=>({currentIdentitySession:m.identity}));
vi.mock('../core/notification-email',()=>({readNotificationEmailPolicy:m.policy,readNotificationEmailDeliveries:m.deliveries,readNotificationEmailPreferences:m.preferences}));
vi.mock('../core/notification-email-delivery',()=>({readNotificationEmailTransport:m.relay}));
vi.mock('../app/admin/settings/notifications/actions',()=>({saveWorkflowEmailPolicy:vi.fn(),retryWorkflowEmail:vi.fn()}));
vi.mock('../app/me/notifications/actions',()=>({saveMyWorkflowEmailPreferences:vi.fn()}));
import AdminPage from '../app/admin/settings/notifications/page';
import MyPage from '../app/me/notifications/page';
beforeEach(()=>{cleanup();vi.clearAllMocks();m.policy.mockResolvedValue([]);m.deliveries.mockResolvedValue([]);m.relay.mockResolvedValue(null);m.group.mockReturnValue(true);m.internal.mockReturnValue(false);m.identity.mockResolvedValue(null);m.preferences.mockResolvedValue({employments:[{id:'employment',code:'EMP-01'}],preferences:[],policy:[]});});
describe('workflow email configuration screens',()=>{
 it('does not claim mail is active when the root-installed service has not been upgraded',async()=>{
  render(await AdminPage({searchParams:Promise.resolve({})}));expect(screen.getByText(en.workflowEmail.upgradeRequired)).toBeTruthy();expect(screen.getAllByRole('checkbox')).toHaveLength(13);expect(screen.getAllByRole('checkbox').every(c=>!(c as HTMLInputElement).checked)).toBe(true);
 });
 it('makes tenant controls read-only for a company administrator',async()=>{
  m.group.mockReturnValue(false);render(await AdminPage({searchParams:Promise.resolve({})}));expect(screen.queryByRole('button',{name:en.workflowEmail.savePolicy})).toBeNull();expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
 });
 it('describes accepted mail honestly and requires duplicate acknowledgement before a failed send retry',async()=>{
  m.relay.mockResolvedValue({version:1,ready:true});m.deliveries.mockResolvedValue([{id:'delivery',category:'payroll',status:'failed',attempts:1,error:'uncertain',createdAt:new Date(),sentAt:null}]);
  render(await AdminPage({searchParams:Promise.resolve({})}));expect(screen.getByText(en.workflowEmail.deliveriesHelp)).toBeTruthy();const checkbox=screen.getByRole('checkbox',{name:en.workflowEmail.retryAck}) as HTMLInputElement;expect(checkbox.required).toBe(true);expect(checkbox.checked).toBe(false);
 });
 it('does not let a demo login opt in, while leaving consent withdrawal representable',async()=>{
  render(await MyPage({searchParams:Promise.resolve({})}));expect(screen.getByText(en.workflowEmail.identityRequired)).toBeTruthy();expect(screen.getAllByRole('checkbox').every(c=>(c as HTMLInputElement).disabled)).toBe(true);
  cleanup();m.preferences.mockResolvedValue({employments:[{id:'employment',code:'EMP-01'}],preferences:[{recipientEmploymentId:'employment',category:'leave',enabled:true,emailConsentUserId:'user',emailAfterSequence:0,emailLocale:'en'}],policy:[]});
  render(await MyPage({searchParams:Promise.resolve({})}));const consent=screen.getByRole('checkbox',{name:new RegExp('^Leave')}) as HTMLInputElement;expect(consent.disabled).toBe(false);expect(consent.checked).toBe(true);
 });
 it('renders a separate preference form for concurrent employments',async()=>{
  m.internal.mockReturnValue(true);m.identity.mockResolvedValue({emailVerified:true});m.preferences.mockResolvedValue({employments:[{id:'one',code:'EMP-01'},{id:'two',code:'EMP-02'}],preferences:[],policy:[]});
  render(await MyPage({searchParams:Promise.resolve({})}));expect(screen.getAllByRole('button',{name:en.workflowEmail.save})).toHaveLength(2);expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[name=employmentId]')).map(i=>i.value)).toEqual(['one','two']);
 });
});
