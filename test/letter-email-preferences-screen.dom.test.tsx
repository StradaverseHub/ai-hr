/** Screen behavior uses synthetic adapters; database tests own identity/consent enforcement. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const m=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',global:false,enabled:true,legacy:vi.fn(),account:vi.fn(),identity:vi.fn(),module:vi.fn()}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fixture',userId:'account-only-reviewer'},scopeIds:['00000000-0000-4000-8000-000000000001']})}));
vi.mock('../lib/authz',()=>({requireModule:m.module}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:(_ctx:unknown,code:string,company?:string)=>code==='notifications'&&(company?m.enabled&&company==='00000000-0000-4000-8000-000000000001':m.global)}));
vi.mock('../core/notification-email',()=>({readNotificationEmailPreferences:m.legacy}));
vi.mock('../core/letter-email-preferences',()=>({readLetterEmailPreferences:m.account}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:m.identity}));
vi.mock('../app/(app)/me/notifications/actions',()=>({saveMyWorkflowEmailPreferences:vi.fn(),saveMyLetterEmailPreferences:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>m.locale,getTranslations:async()=>createTranslator({locale:m.locale,messages:catalogues[m.locale],namespace:'workflowEmail'})}));
import Page from '../app/(app)/me/notifications/page';
const identity={issuer:'https://identity.fixture.test',subject:'verified-user',email:'verified@fixture.test',emailVerified:true};
beforeEach(()=>{vi.clearAllMocks();m.locale='en';m.global=false;m.enabled=true;m.legacy.mockResolvedValue({employments:[],preferences:[],policy:[]});m.account.mockResolvedValue({preference:null,current:false,enabledByPolicy:false});m.identity.mockResolvedValue(identity);m.module.mockResolvedValue(undefined);});afterEach(cleanup);
it.each(['en','ms','zh','ta','th','vi'] as const)('offers account-only Letters consent in %s through a company entitlement',async locale=>{
 m.locale=locale;render(await Page({searchParams:Promise.resolve({})}));const copy=catalogues[locale].workflowEmail;
 expect(screen.getByText(copy.letterAccountTitle)).toBeTruthy();expect(screen.getByText(copy.letterAccountHelp)).toBeTruthy();expect(screen.getByRole('checkbox',{name:name=>name.startsWith(copy.letterAccountConsent)})).not.toBeDisabled();expect(screen.getByLabelText(copy.letterAccountLanguage)).toHaveValue(locale);expect(screen.getByRole('button',{name:copy.letterAccountSave})).toBeTruthy();expect(document.querySelector('input[name="employmentId"]')).toBeNull();expect(m.legacy).not.toHaveBeenCalled();expect(m.module).not.toHaveBeenCalled();expect(document.body.textContent).not.toContain(identity.email);
});
it('keeps existing consent withdrawable during provider outage and refuses to show a stale binding as current',async()=>{
 m.account.mockResolvedValue({current:true,enabledByPolicy:true,preference:{enabled:true,emailLocale:'ms',emailConsentIssuer:identity.issuer,emailConsentSubject:identity.subject,emailConsentAddressHash:'stored-current-hash'}});m.identity.mockRejectedValue(Error('private provider failure'));
 render(await Page({searchParams:Promise.resolve({})}));const checkbox=screen.getByRole('checkbox');expect(checkbox).toBeChecked();expect(checkbox).not.toBeDisabled();expect(screen.getByRole('button',{name:en.workflowEmail.letterAccountSave})).not.toBeDisabled();expect(document.body.textContent).not.toContain('private provider failure');
 cleanup();m.account.mockResolvedValue({current:false,enabledByPolicy:true,preference:{enabled:true,emailLocale:'en'}});render(await Page({searchParams:Promise.resolve({})}));expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('checkbox')).toBeDisabled();
});
it('refuses unavailable company and tenant modules before reading preferences',async()=>{
 m.enabled=false;m.module.mockRejectedValue(Error('module unavailable'));await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow('module unavailable');expect(m.account).not.toHaveBeenCalled();expect(m.legacy).not.toHaveBeenCalled();
});
