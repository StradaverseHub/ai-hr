/** Actual maintenance page, fictional bounded server sources; no Entra/identity/network commands. */
import {cleanup,render,screen} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import {afterEach,it,expect,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';
import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',view:true,edit:false,execute:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>createTranslator({locale:state.locale,messages:catalogues[state.locale],namespace:'entra'})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
vi.mock('@/core/organisation-access',()=>({settingsActionAccess:async()=>({view:state.view,add:false,edit:state.edit,delete:false})}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'fictional',userId:'fictional-admin'}})}));
vi.mock('@/lib/entra/store',()=>({requireEntraAdmin:async()=>{},registeredOrganization:async()=>({code:'Fictional organization'}),connector:async()=>({revision:'fictional',mode:'cloud',organization:'Fictional organization',domain:'fixture.invalid',directoryTenantId:'fictional-directory',enabled:false,provisioningEnabled:false,immutableMatchingConfirmed:false})}));
vi.mock('@/db/client',()=>({withTenant:async(_ctx:unknown,work:(tx:{execute:typeof state.execute})=>Promise<unknown>)=>work({execute:state.execute})}));
vi.mock('@/app/admin/settings/entra/actions',()=>({saveEntra:vi.fn(),testEntra:vi.fn(),bindEntra:vi.fn(),retryEntra:vi.fn(),reconcileEntra:vi.fn()}));
import Page from '../app/admin/settings/entra/page';
afterEach(()=>{cleanup();state.locale='en';state.view=true;state.edit=false;vi.clearAllMocks();});
it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('retains status and existing configuration while all mutation controls are disabled in %s',async locale=>{
 state.locale=locale;state.execute.mockResolvedValueOnce([{person_id:'fictional-person',status:'failed',object_id:null,attempts:1}]).mockResolvedValueOnce([{user_id:'fictional-user',person_id:'fictional-person',full_name:'Fictional account'}]);
 render(await Page({searchParams:Promise.resolve({})}));const t=catalogues[locale].entra;
 for(const name of [t.save,t.test,t.link,t.retry])expect(screen.getByRole('button',{name}).matches(':disabled')).toBe(true);
 expect(screen.getByDisplayValue('Fictional organization').matches(':disabled')).toBe(true);expect(screen.getByText('Fictional account')).toBeTruthy();
});
it('refuses a revoked maintenance View before reading configuration or account sources',async()=>{
 state.view=false;await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow('NOT_FOUND');expect(state.execute).not.toHaveBeenCalled();
});
