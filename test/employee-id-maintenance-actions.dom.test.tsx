/** Render the actual setup page with server policy projections; backend authority has native DB coverage. */
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import {afterEach,it,expect,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';
import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import type {ConfigRow} from '../core/employee-id-config';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',view:true,add:false,edit:false,remove:true}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>createTranslator({locale:state.locale,messages:catalogues[state.locale],namespace:'employeeIdConfig'})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
vi.mock('next/link',()=>({default:({href,children,...props}:React.ComponentProps<'a'>)=><a href={href} {...props}>{children}</a>}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'fictional'},scopeIds:['company-a']})}));
vi.mock('@/core/read',()=>({listCompanies:async()=>[{id:'company-a',name:'Company A'}]}));
vi.mock('@/components/pager',()=>({Pager:()=>null}));
vi.mock('@/app/admin/settings/employee-id/actions',()=>({createConfigAction:vi.fn(),updateConfigAction:vi.fn(),setStatusAction:vi.fn(),deleteConfigAction:vi.fn()}));
vi.mock('@/core/employee-id-config',async importOriginal=>({
 ...await importOriginal<typeof import('../core/employee-id-config')>(),
 listConfigsForMaintenance:async()=>state.view?[row]:[],
 employeeIdMaintenanceActions:async()=>[{companyId:'company-a',view:state.view,add:state.add,edit:state.edit,delete:state.remove},{companyId:null,view:false,add:false,edit:false,delete:false}],
}));
const row:ConfigRow={id:'config-a',companyId:'company-a',companyName:'Company A',templateName:'Fictional retained format',prefix:'FICTION',suffix:'',startNumber:1,numberLength:4,increment:1,allowManualOverride:true,currentRunningNumber:0,status:'active',updatedAt:new Date('2026-01-01T00:00:00Z')};
import Page from '../app/admin/settings/employee-id/page';
async function show(params:{edit?:string;new?:string}={}){
 const page=await Page({searchParams:Promise.resolve(params)});render(<NextIntlClientProvider locale={state.locale} messages={catalogues[state.locale]} timeZone="Asia/Kuala_Lumpur">{page}</NextIntlClientProvider>);
 return catalogues[state.locale].employeeIdConfig;
}
afterEach(()=>{cleanup();Object.assign(state,{locale:'en',view:true,add:false,edit:false,remove:true});});
it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('retains independent Delete with a read-only existing format in %s',async locale=>{
 state.locale=locale;const t=await show({edit:row.id});
 expect(screen.getByDisplayValue(row.prefix).matches(':disabled')).toBe(true);
 expect(screen.getByRole('button',{name:t.save}).matches(':disabled')).toBe(true);
 expect(screen.getByRole('button',{name:t.delete}).matches(':disabled')).toBe(false);
 expect(screen.queryByRole('link',{name:t.edit})).toBeNull();expect(screen.queryByRole('link',{name:t.createNew})).toBeNull();
 expect(screen.queryByRole('button',{name:t.deactivate})).toBeNull();
});
it('offers only native-permitted company scopes when Add is available independently of Edit',async()=>{
 state.add=true;const t=await show({new:'1'});
 const choices=within(screen.getByRole('combobox',{name:new RegExp('^'+t.fieldScope)})).getAllByRole('option');expect(choices.map(option=>option.textContent)).toEqual(['Company A']);
 expect(screen.getByRole('button',{name:t.save}).matches(':disabled')).toBe(false);
 expect(screen.queryByRole('link',{name:t.edit})).toBeNull();
});
it('refuses the maintenance route when no in-scope View purpose is available',async()=>{
 state.view=false;await expect(Page({searchParams:Promise.resolve({new:'1'})})).rejects.toThrow('NOT_FOUND');
});
