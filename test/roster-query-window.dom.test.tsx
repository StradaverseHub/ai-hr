import React from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render} from '@testing-library/react';
import {renderToReadableStream} from 'react-dom/server';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({window:vi.fn(),count:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=>createTranslator({locale:'en',messages:en.roster})}));
vi.mock('next/link',()=>({default:({children,prefetch:_prefetch,...props}:React.ComponentProps<'a'>&{prefetch?:boolean})=><a {...props}>{children}</a>}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>true}));
vi.mock('../core/read',()=>({listCompanies:async()=>[{id:'company',name:'Fictional company'}],listDepartments:async()=>[]}));
vi.mock('../core/roster',()=>({rosterExceptionCount:state.count}));
vi.mock('../db/client',async importOriginal=>({...await importOriginal<typeof import('../db/client')>(),withBackgroundReadWork:(_:string,read:()=>Promise<unknown>)=>read()}));
vi.mock('../core/roster-presentation',()=>({rosterWindowPage:state.window}));
vi.mock('../components/pager',()=>({Pager:()=>null}));
vi.mock('../app/roster/my-team-scope',()=>({rosterTeamContext:async()=>null,rosterTeamWindow:vi.fn()}));
vi.mock('../app/roster/actions',()=>({copyRosterAction:vi.fn(),generateRosterAction:vi.fn()}));
vi.mock('../components/roster-grid',()=>({RosterGrid:()=> <div data-testid="roster-grid"/>,RosterTemplateButton:()=>null}));
import Page from '../app/roster/page';
beforeEach(()=>{
 state.count.mockReset().mockResolvedValue(0);
 state.window.mockImplementation(async(_s,p)=>({from:p.from,to:p.to,dates:[],
  employees:[{employmentId:'fixture',name:'Fictional employee'}],total:1,businessUnitOptions:[],departmentOptions:[],
  shifts:[{id:'regular',code:'DAY',name:'Fictional day shift'}],cells:{},usual:{},dayContext:{}}));
});
async function page(query:Record<string,string>){return <NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve(query)})}</NextIntlClientProvider>;}

it('streams the grid and scoped Exceptions link before the count resolves',async()=>{
 let finish!:(value:number)=>void;
 state.count.mockReturnValueOnce(new Promise<number>(resolve=>{finish=resolve;}));
 const stream=await renderToReadableStream(await page({month:'2026-11'}));
 const reader=stream.getReader();
 const decoder=new TextDecoder();
 let shell='';
 try {
  while (!shell.includes('data-testid="roster-grid"') || !shell.includes('data-roster-exception-count="pending"')) {
   const chunk=await reader.read();
   if (chunk.done) break;
   shell+=decoder.decode(chunk.value,{stream:true});
  }
  expect(shell).toContain('data-testid="roster-grid"');
  expect(shell).toContain('data-roster-exception-count="pending"');
  expect(shell).toContain('/roster/exceptions?view=month&amp;month=2026-11');
  expect(state.count).toHaveBeenCalledWith({},expect.objectContaining({companyIds:['company'],from:'2026-11-01',to:'2026-11-30'}));
 } finally {
  finish(7);
 }
 let remainder='';
 for (let chunk=await reader.read(); !chunk.done; chunk=await reader.read()) {
  remainder+=decoder.decode(chunk.value,{stream:true});
 }
 remainder+=decoder.decode();
 expect(remainder).toContain('data-roster-exception-count="ready">Exceptions (7)</span>');
});

it('keeps the exception link usable when its count cannot be read',async()=>{
 state.count.mockRejectedValueOnce(Error('Fictional count failure'));
 const stream=await renderToReadableStream(await page({month:'2026-11'}));
 const html=await new Response(stream).text();
 expect(html).toContain('data-testid="roster-grid"');
 expect(html).toContain('/roster/exceptions?view=month&amp;month=2026-11');
 expect(html).toContain(`data-roster-exception-count="unavailable">${en.roster.exceptionsTitle}</span>`);
});
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
