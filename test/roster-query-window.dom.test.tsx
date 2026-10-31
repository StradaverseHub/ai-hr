import React from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({window:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=>createTranslator({locale:'en',messages:en.roster})}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>true}));
vi.mock('../core/read',()=>({listCompanies:async()=>[{id:'company',name:'Fictional company'}],listDepartments:async()=>[]}));
vi.mock('../core/roster',()=>({rosterExceptionCount:async()=>0,rosterWindowView:state.window}));
vi.mock('../app/(app)/roster/my-team-scope',()=>({rosterTeamContext:async()=>null,rosterTeamWindow:vi.fn()}));
vi.mock('../app/(app)/roster/actions',()=>({copyRosterAction:vi.fn(),generateRosterAction:vi.fn()}));
vi.mock('../components/roster-grid',()=>({RosterGrid:()=>null,RosterTemplateButton:()=>null}));
import Page from '../app/(app)/roster/page';
beforeEach(()=>{state.window.mockImplementation(async(_s,p)=>({from:p.from,to:p.to,dates:[],employees:[],allEmployees:[],shifts:[],cells:{},usual:{},dayContext:{}}));});
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
