/** @vitest-environment jsdom */
/** Authored UNRUN interaction/copy contracts. Actual browser/locale/a11y experience still required. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en',data:{rows:[{employeeCode:'CANONICAL-01',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false} as unknown,fail:false}));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,params?:Record<string,string|number>)=>{
 let value:unknown=copies[state.locale];for(const name of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[name];
 if(typeof value!=='string')throw Error('Missing test translation '+namespace+'.'+key);
 return value.replace(/\{(\w+)\}/g,(_whole,field:string)=>String(params?.[field]??'{'+field+'}'));
}}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>[]}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:vi.fn(async(_ctx:unknown,module:string,consume:(read:unknown)=>Promise<unknown>)=>consume({moduleWork:async()=>{
 if(state.fail)throw Error('PRIVATE_DATABASE_ERROR_BODY');const binding=MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)!;
 return {module,capability:binding[1],scope:'current-caller',data:state.data};
}}))}));
import {withAssistantRead} from '../core/assistant-read-session';
import {loadCanonicalModuleJob,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {CanonicalModuleJob,ModuleJobChooser,GroundedWorkspaceReply} from '../components/assistant/module-jobs';
import {AGENT_MODULE_CODES,MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import type {SessionContext} from '../db/client';
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viMessages};
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]};
beforeEach(()=>{vi.clearAllMocks();state.locale='en';state.fail=false;state.data={rows:[{employeeCode:'CANONICAL-01',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false};});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('deterministic current-user job cards',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('%s presents meaningful canonical facts with accessible headings and refresh controls',async locale=>{
  state.locale=locale;const view=await loadCanonicalModuleJob(ctx,{module:'employees'});render(await CanonicalModuleJob({view,ctx}));
  const copy=(copies[locale] as typeof en).assistant.workspace.jobs;
  expect(screen.getByRole('heading',{name:copy.module_employees})).toBeTruthy();expect(screen.getByText('CANONICAL-01')).toBeTruthy();
  expect(screen.getByText(copy.field_employeeCode)).toBeTruthy();expect(screen.getByRole('button',{name:copy.refresh})).toBeTruthy();
  const refresh=screen.getByRole('button',{name:copy.refresh}).closest('form')!;expect(refresh.getAttribute('method')).toBe('get');
  expect(new FormData(refresh).get('job')).toBe('employees');expect(screen.queryByText('fictional-user')).toBeNull();
 });
 it('discovers20 real tasks without reading any of them or placing HR facts/subjects into links',async()=>{
  const view=render(await ModuleJobChooser({modules:AGENT_MODULE_CODES,selected:'leave'}));
  expect(screen.getAllByRole('link')).toHaveLength(20);expect(withAssistantRead).not.toHaveBeenCalled();
  for(const link of view.container.querySelectorAll('a')){const url=new URL(link.href);expect([...url.searchParams.keys()]).toEqual(['job']);expect(AGENT_MODULE_CODES).toContain(url.searchParams.get('job'));}
  expect(view.container.querySelector('[aria-current="page"]')?.textContent).toContain(en.assistant.workspace.jobs.module_leave);
 });
 it('refuses model-forged, serialized, cross-user and expired views before rendering their facts',async()=>{
  const issued=await loadCanonicalModuleJob(ctx,{module:'employees'});
  const fake=JSON.parse(JSON.stringify(issued)) as CanonicalModuleJobView;
  const view=render(await CanonicalModuleJob({view:fake,ctx}));expect(screen.queryByText('CANONICAL-01')).toBeNull();expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.jobs.unavailable);view.unmount();
  const cross=render(await CanonicalModuleJob({view:issued,ctx:{...ctx,userId:'different-user'}}));expect(screen.queryByText('CANONICAL-01')).toBeNull();cross.unmount();
  vi.spyOn(Date,'now').mockReturnValue(issued.checkedAt+31000);render(await CanonicalModuleJob({view:issued,ctx}));expect(screen.queryByText('CANONICAL-01')).toBeNull();
 });
 it('uses the same bounded public access wording for an inaccessible task or a private source error',async()=>{
  state.fail=true;const view=await loadCanonicalModuleJob(ctx,{module:'employees'});const rendered=render(await CanonicalModuleJob({view,ctx}));
  expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.jobs.unavailable);expect(rendered.container.textContent).not.toContain('PRIVATE_DATABASE_ERROR_BODY');
 });
 it('keeps hidden facts omitted and unknown monetary values distinct from recorded zero',async()=>{
  state.data={rows:[{balances:[{leaveType:'Canonical annual',available:null,taken:2,pending:null,withheld:true}]}],truncated:false};
  const mine=await loadCanonicalModuleJob(ctx,{module:'leave'});const first=render(await CanonicalModuleJob({view:mine,ctx}));
  expect(screen.queryByText(en.assistant.workspace.jobs.field_available)).toBeNull();expect(screen.getByText(en.assistant.workspace.jobs.withheld)).toBeTruthy();first.unmount();
  state.data={rows:[{payPeriod:'2026-10',gross:'0.00',deductions:null,net:null,currency:null}],truncated:false};
  const pay=await loadCanonicalModuleJob(ctx,{module:'payroll'});render(await CanonicalModuleJob({view:pay,ctx}));
  expect(screen.getByText('0.00')).toBeTruthy();expect(screen.getAllByText(en.assistant.workspace.jobs.unknown).length).toBeGreaterThan(0);
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s gives fixed useful help for a source-free or withheld model answer',async locale=>{
  state.locale=locale;const reply={mode:'generic' as const,views:[],fallbackModules:[],partial:false,tools:[]};
  const first=render(await GroundedWorkspaceReply({reply,ctx}));expect(screen.getByText((copies[locale] as typeof en).assistant.workspace.answers.generic)).toBeTruthy();first.unmount();
  render(await GroundedWorkspaceReply({reply:{...reply,mode:'unavailable',fallbackModules:['leave']},ctx}));
  expect(screen.getByText((copies[locale] as typeof en).assistant.workspace.answers.unavailable)).toBeTruthy();
  expect(screen.getByRole('link').getAttribute('href')).toBe('/assistant?job=leave');
 });

});
