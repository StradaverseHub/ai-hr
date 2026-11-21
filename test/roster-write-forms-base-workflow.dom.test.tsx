/** Roster Generate / Copy keep the base workflow behind the paged grid: shown to an administrator once a
 * company is chosen (whatever the team scope's roster-edit flag), one submit straight to the server action,
 * and targeting the whole filtered workforce rather than the grid's current page. No database. */
import React from 'react';
import {beforeEach,expect,it,vi} from 'vitest';
import {render} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({window:vi.fn(),employees:vi.fn(),team:vi.fn(),generate:vi.fn(),copy:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=> 'en',getTranslations:async()=>createTranslator({locale:'en',messages:en.roster})}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>true}));
vi.mock('../core/read',()=>({listCompanies:async()=>[{id:'company',name:'Fictional company'}],listDepartments:async()=>[]}));
vi.mock('../core/roster',()=>({rosterExceptionCount:async()=>0,rosterWindowEmployees:state.employees}));
vi.mock('../core/roster-presentation',()=>({rosterWindowPage:state.window}));
vi.mock('../components/pager',()=>({Pager:()=>null}));
vi.mock('../app/roster/my-team-scope',()=>({rosterTeamContext:state.team,rosterTeamWindow:()=>({kind:'month',month:'2026-11',from:'2026-11-01',to:'2026-11-30'})}));
vi.mock('../app/roster/actions',()=>({copyRosterAction:state.copy,generateRosterAction:state.generate}));
vi.mock('../components/roster-grid',()=>({RosterGrid:()=>null,RosterTemplateButton:()=>null}));
import Page from '../app/roster/page';

const person=(i:number)=>({employmentId:`e${i}`,name:`Fictional roster person ${i}`,code:`R${i}`});
const everyone=Array.from({length:30},(_,i)=>person(i));
beforeEach(()=>{
 vi.clearAllMocks();state.team.mockResolvedValue(null);
 // The grid is paged: only the first 25 of 30 people are hydrated.
 state.window.mockImplementation(async(_s,p)=>({from:p.from,to:p.to,dates:[],employees:everyone.slice(0,25),total:30,businessUnitOptions:[],departmentOptions:[],
  shifts:[{id:'shift',code:'DAY',name:'Fictional day shift'}],cells:{},usual:{},dayContext:{}}));
 state.employees.mockResolvedValue({employees:everyone,allEmployees:everyone});
});
async function page(query:Record<string,string>){return render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve(query)})}</NextIntlClientProvider>);}
const forms=(view:ReturnType<typeof render>)=>[...view.container.querySelectorAll('form')];

it('posts Generate and Copy once, through the server actions, for the whole filtered workforce beyond the grid page',async()=>{
 const view=await page({companyId:'company',dept:'d1',q:'roster'});
 expect(view.container.querySelector('form[action="/roster/prepare"]')).toBeNull();
 expect(view.container.querySelector('input[name="command"],input[name="selectionIds"],input[name="stage"]')).toBeNull();
 const generate=forms(view).find(form=>form.querySelector('select[name="shiftId"]'))!;
 const copy=forms(view).find(form=>form.querySelector('input[name="targetFrom"]'))!;
 expect(generate).toBeTruthy();expect(copy).toBeTruthy();
 // One submit button each, no intermediate review stage.
 expect(generate.querySelectorAll('button')).toHaveLength(1);expect(copy.querySelectorAll('button')).toHaveLength(1);
 expect([...generate.querySelectorAll('select[name="employmentIds"] option')].map(o=>(o as HTMLOptionElement).value)).toEqual(everyone.map(e=>e.employmentId));
 expect([...copy.querySelectorAll('input[type="hidden"][name="employmentIds"]')].map(i=>(i as HTMLInputElement).value)).toEqual(everyone.map(e=>e.employmentId));
 expect(state.employees).toHaveBeenCalledWith({},{companyIds:['company'],departmentId:'d1',q:'roster'});
 // Each form carries the view's query so the action can re-resolve the team scope server-side.
 for(const f of [generate,copy])expect(f.querySelector('input[type="hidden"][name="populationQuery"]')).not.toBeNull();
});

it('shows both forms to an administrator in a team scope that cannot edit the roster grid, as the base screen did',async()=>{
 state.team.mockResolvedValue({query:{view:'month'},scope:{companyIds:['company'],employmentIds:everyone.map(e=>e.employmentId),canEditRoster:false,from:'2026-11-01',to:'2026-11-30'}});
 const view=await page({companyId:'company',myTeam:'view=month'});
 expect(view.container.querySelector('select[name="shiftId"]')).not.toBeNull();
 expect(view.container.querySelector('input[name="targetFrom"]')).not.toBeNull();
 expect(state.employees).toHaveBeenCalledWith({},expect.objectContaining({employmentIds:everyone.map(e=>e.employmentId)}));
});

it('asks for a company first and reads no write targets across companies',async()=>{
 const view=await page({});
 expect(view.container.querySelector('select[name="shiftId"]')).toBeNull();
 expect(view.container.textContent).toContain(en.roster.pickCompanyToEdit);
 expect(state.employees).not.toHaveBeenCalled();
});
