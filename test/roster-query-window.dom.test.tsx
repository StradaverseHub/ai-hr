import React from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
import {act,fireEvent,render} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({window:vi.fn(),exceptions:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=>createTranslator({locale:'en',messages:en.roster})}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'roster-query-test'},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>true}));
vi.mock('../core/read',()=>({listCompanies:async()=>[{id:'company',name:'Fictional company'}],listDepartments:async()=>[]}));
vi.mock('../core/roster',()=>({rosterExceptionCount:state.exceptions}));
vi.mock('../core/roster-presentation',()=>({rosterWindowPage:state.window}));
vi.mock('../components/pager',()=>({Pager:()=>null}));
vi.mock('../app/roster/my-team-scope',()=>({rosterTeamContext:async()=>null,rosterTeamWindow:vi.fn()}));
vi.mock('../app/roster/actions',()=>({copyRosterAction:vi.fn(),generateRosterAction:vi.fn()}));
vi.mock('../components/roster-grid',()=>({RosterGrid:()=>null,RosterTemplateButton:()=>null}));
import Page from '../app/roster/page';
beforeEach(()=>{
 state.exceptions.mockReset().mockResolvedValue(0);
 state.window.mockImplementation(async(_s,p)=>({from:p.from,to:p.to,dates:[],employees:[],total:0,businessUnitOptions:[],departmentOptions:[],shifts:[],cells:{},usual:{},dayContext:{}}));
});
async function page(query:Record<string,string>){return <NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve(query)})}</NextIntlClientProvider>;}
it.each([
 [{view:'month',month:'2026-10'},{view:'month',month:'2026-11'},'month','2026-11'],
 [{view:'week',from:'2026-10-05'},{view:'week',from:'2026-10-12'},'from','2026-10-12'],
 [{view:'custom',from:'2026-10-05',to:'2026-10-07'},{view:'custom',from:'2026-10-08',to:'2026-10-10'},'from','2026-10-08'],
 [{view:'custom',from:'2026-10-05',to:'2026-10-07'},{view:'custom',from:'2026-10-08',to:'2026-10-10'},'to','2026-10-10'],
] as const)('updates the native %s query field when SPA navigation returns a new window',async(before,after,name,value)=>{
 const view=render(await page(before));const field=view.container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;expect(field).not.toBeNull();
 // A native control can retain its dirty current value even after React updates defaultValue.
 fireEvent.change(field,{target:{value:name==='month'?'2026-09':'2026-09-01'}});
 view.rerender(await page(after));expect(view.container.querySelector(`input[name="${name}"]`)).toHaveValue(value);
});

it('renders the roster filters and scoped exceptions link while the count is pending',async()=>{
 let complete!: (count:number)=>void;
 state.exceptions.mockImplementation(()=>new Promise<number>(resolve=>{complete=resolve;}));
 const view=render(await page({view:'week',from:'2026-10-05'}));
 expect(view.container.querySelector('input[name="from"]')).toHaveValue('2026-10-05');
 const link=view.getByRole('link',{name:en.roster.exceptionsTitle,exact:true});
 const url=new URL(link.getAttribute('href')!,'http://localhost');
 expect(url.pathname).toBe('/roster/exceptions');
 expect(url.searchParams.get('from')).toBe('2026-10-05');

 await vi.waitFor(()=>expect(state.exceptions).toHaveBeenCalled());
 await act(async()=>{complete(3);});
 expect(view.getByRole('link',{name:'Exceptions (3)',exact:true})).toBe(link);
 expect(state.exceptions).toHaveBeenCalledWith({tenantId:'roster-query-test'},expect.objectContaining({
  companyIds:['company'],from:'2026-10-05',to:'2026-10-11',
 }));
});
