import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {MODULE_CATALOG} from '../packs/catalog';
import {MODULE_JOBS,JOB_FACT_FIELDS} from '../lib/ai/module-jobs';
import {presentCanonicalModuleData} from '../lib/ai/module-job-presentation';
import type {AgentModuleCode} from '../lib/ai/module-agents';
const bound=(rows:unknown[])=>({rows,truncated:false});
const cases:readonly [AgentModuleCode,unknown,string|number][]=[
 ['employees',bound([{employeeCode:'ME-01',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active',salary:'PRIVATE_POISON'}]),'ME-01'],
 ['org',bound([{reportingLines:[{name:'Canonical own manager',employeeCode:'M-01',lineType:'administrative',salary:'PRIVATE_POISON'}]}]),'M-01'],
 ['leave',bound([{balances:[{leaveType:'Canonical annual',available:37.25,taken:2,pending:1,withheld:false,balance:'PRIVATE_POISON'}]}]),37.25],
 ['ess',{employees:1,ready:0,gaps:[{id:'no_bank_account',count:1,blocks:'payment',people:'PRIVATE_POISON'}]},'payment'],
 ['approvals',bound([{leaveType:'Canonical annual',status:'pending',startDate:'2026-10-01',endDate:'2026-10-02',days:'2.00',reason:'PRIVATE_POISON'}]),'pending'],
 ['knowledge_base',bound([{title:'Canonical permitted policy',category:'Work',updatedAt:new Date('2026-01-01'),body:'PRIVATE_POISON'}]),'Work'],
 ['payroll',bound([{id:'11111111-1111-1111-1111-111111111111',payPeriod:'2026-10',company:'Canonical employer',gross:'1234.5678',deductions:'12.0000',net:'1222.5678',currency:'MYR',runType:'regular',runSeq:1,bank:'PRIVATE_POISON'}]),'1234.5678'],
 ['attendance',bound([{date:'2026-10-01',status:'present',workedMinutes:471,otMinutes:30,geolocation:'PRIVATE_POISON'}]),471],
 ['claims',{hasEmployment:true,truncated:false,claims:[{claimType:'Travel',status:'draft',incurredOn:'2026-10-01',createdAt:'2026-10-01T00:00:00Z',decidedAt:null,paidAt:null,amount:'PRIVATE_POISON'}]},'draft'],
 ['performance',bound([{cycleName:'Canonical review',status:'not_started',released:false,periodEnd:'2026-12-31',finalScore:'PRIVATE_POISON'}]),'not_started'],
 ['rewards',bound([{cycle:'Canonical rewards',company:'Canonical employer',unit:'Finance',kind:'annual',year:2026,status:'draft',revision:2,budget:'PRIVATE_POISON'}]),'Finance'],
 ['lifecycle',{status:'in_progress',progress:{done:1,total:3,percent:33},steps:[{label:'Canonical applicable step',applicable:true,done:true,serial:'PRIVATE_POISON'}]},33],
 ['toil',bound([{active:2,taken:1,expired:0,convertedToPay:0,leaveUnit:'day',soonestExpiry:'2026-12-31',rows:bound([{workedDate:'2026-10-01',expiresOn:'2026-12-31',daysCredited:3,daysTaken:1,remaining:2,status:'active',salary:'PRIVATE_POISON'}])}]),2],
 ['multi_cycle_payroll',bound([{cycleName:'Canonical cycle',payPeriod:'2026-10',runType:'regular',runSeq:2,amount:'PRIVATE_POISON'}]),2],
 ['typed_pay_components',bound([{payPeriod:'2026-10',currency:'MYR',lines:bound([{name:'Canonical allowance',code:'ITEM-01',amount:'123.4567',formula:'PRIVATE_POISON'}])}]),'123.4567'],
 ['country-my',{employees:1,ready:0,gaps:[{id:'no_identity',count:1,blocks:'statutory_filing',identity:'PRIVATE_POISON'}]},'statutory_filing'],
 ['notifications',bound([{createdAt:new Date('2026-10-01T01:00:00Z'),readAt:null,title:'PRIVATE_POISON',body:'PRIVATE_POISON',linkPath:'PRIVATE_POISON'}]),'2026-10-01T01:00:00.000Z'],
 ['system_explorer',{withheldTables:6,tables:bound([{table:'employment',module:'employees',rows:'PRIVATE_POISON'}])},6],
 ['assistant',{capabilities:[{module:'leave',capability:'own_leave_balances',secret:'PRIVATE_POISON'}]},'leave'],
 ['system_testing',bound([{caseNo:42,title:'Assigned canonical test',moduleCode:'leave',status:'not_started',ordinal:1,updatedAt:null,description:'PRIVATE_POISON'}]),42],
];
describe('independent deterministic fact-presentation contracts for every canonical module',()=>{
 it('covers exactly the current catalogue and refuses unsupported future modules',()=>{
  expect(cases.map(([module])=>module).sort()).toEqual(MODULE_CATALOG.map(row=>row.code).sort());
  expect(new Set(MODULE_JOBS.map(([module])=>module)).size).toBe(20);
  expect(()=>presentCanonicalModuleData('future_module' as AgentModuleCode,bound([]))).toThrow();
 });
 it.each(cases)('%s copies only the expected canonical fields and never renders model/raw payload additions',(module,data,expected)=>{
  const result=presentCanonicalModuleData(module,data),text=JSON.stringify(result);
  expect(text).toContain(String(expected));expect(text).not.toContain('PRIVATE_POISON');expect(result.cards.length).toBeGreaterThan(0);
  for(const card of result.cards)for(const fact of card.facts)expect(JOB_FACT_FIELDS).toContain(fact.field);
  expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.cards)).toBe(true);
 });
 it('keeps missing monetary facts unknown and preserves recorded decimals without arithmetic or rounding',()=>{
  const view=presentCanonicalModuleData('payroll',bound([{payPeriod:'2026-10',gross:'1234.5678',deductions:null,net:null,currency:null}]));
  expect(view.cards[0].facts.find(row=>row.field==='gross')?.value).toBe('1234.5678');
  expect(view.cards[0].facts.find(row=>row.field==='net')?.value).toBeNull();
  expect(view.cards[0].facts.find(row=>row.field==='currency')?.value).toBeNull();
 });
 it('keeps hidden leave amounts absent and current limited sets explicitly capped',()=>{
  const hidden=presentCanonicalModuleData('leave',bound([{balances:[{leaveType:'Annual',available:null,taken:2,pending:null,withheld:true}]}]));
  expect(hidden.cards[0].facts.map(row=>row.field)).toEqual(['taken']);expect(hidden.cards[0].withheld).toBe(true);
  expect(presentCanonicalModuleData('employees',bound(Array.from({length:26},(_,i)=>({employeeCode:String(i)})))).truncated).toBe(true);
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s has meaningful translated jobs/fields/states rather than raw module labels',locale=>{
  const messages=JSON.parse(readFileSync(new URL('../messages/'+locale+'.json',import.meta.url),'utf8')).assistant.workspace.jobs;
  for(const [module] of MODULE_JOBS){expect(typeof messages['module_'+module]).toBe('string');expect(messages['module_'+module].trim()).toBeTruthy();expect(messages['module_'+module]).not.toBe(module);expect(messages['help_'+module].trim()).toBeTruthy();}
  for(const field of JOB_FACT_FIELDS)expect(messages['field_'+field]).toBeTruthy();
 });
});
