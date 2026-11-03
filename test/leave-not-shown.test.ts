/** Eval 41665308001, emp-balance-1 (issue 18), over the real read and the real tool provider: an employee with Annual Leave,
 * Medical Leave hiding its brought-forward and forfeited lines from employees (the smart-eval fixture's configuration) and
 * an Unpaid Leave type with no entitlement. A balance row names the fields it leaves out (notShown) instead of a row-wide
 * withheld flag, so the model reads the shown Medical Leave figure beside exactly what is hidden. Scripted model,
 * fictional data; no provider. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {ASSISTANT_TOOLS} from '../core/assistant-tools';
import {todayInKualaLumpur} from '../lib/hr-date';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-not-shown-passphrase');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
type Row=Record<string,unknown>;
async function employee(){
 const admin=adminCtx(base);
 const [medical]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true,
  essViewConfig:{broughtForward:false,forfeited:false}}).returning({id:schema.leaveType.id});
 await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'UNPAID',name:'Unpaid Leave',paid:false});
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Not Shown Employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,
  departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 for(const [leaveTypeId,days] of [[base.annualLeaveTypeId,'17.25'],[medical.id,'11.5']] as const)
  await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});
 const userId=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return{ctx,mine,medicalId:medical.id};
}
const byType=(rows:readonly Row[],leaveType:string)=>{const row=rows.find(candidate=>candidate.leaveType===leaveType);if(!row)throw Error('Missing '+leaveType+' row.');return row;};
/** The disclosed JSON of the latest tool message the model was sent. */
function lastToolResult(request:ModelRequest):unknown{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}

describe('my_leave_balances for Annual, a partly hidden Medical and an Unpaid leave type',()=>{
 it('the real read: Medical Leave keeps its available figure and names only accrued and balance as not shown',async()=>{
  const {ctx,mine,medicalId}=await employee(),tool=ASSISTANT_TOOLS.find(row=>row.spec.name==='my_leave_balances')!;
  const outcome=await tool.run(ctx,{}) as unknown as {ok:boolean;employments:{employmentId:string;balances:Row[]}[]};
  expect(outcome.ok).toBe(true);expect(outcome.employments.map(row=>row.employmentId)).toEqual([mine.employmentId]);
  const rows=outcome.employments[0].balances;
  expect(byType(rows,'Annual Leave')).toMatchObject({leaveTypeId:base.annualLeaveTypeId,taken:0,pending:0,available:17.25,accrued:17.25,balance:17.25,notShown:[]});
  expect(byType(rows,'Medical Leave')).toEqual({leaveTypeId:medicalId,leaveType:'Medical Leave',taken:0,pending:0,available:11.5,sharedPoolName:null,notShown:['accrued','balance']});
  expect(byType(rows,'Unpaid Leave')).toMatchObject({available:0,notShown:[]});for(const row of rows)expect(row).not.toHaveProperty('withheld');
 });
 it('a harness turn sends the model no withheld flag, and the person reads 17.25 and 11.5',async()=>{
  const {ctx}=await employee(),seen:{rows?:Row[]}={};
  const model=scriptedModel([{calls:[{name:'my_leave_balances'}]},request=>{const rows=(lastToolResult(request) as {employments:{balances:Row[]}[]}).employments[0].balances;seen.rows=rows;
   const place=(name:string)=>/\{\{F\d+\}\}/.exec(String(byType(rows,name).available))![0];
   return{final:{reply:`Annual Leave: **${place('Annual Leave')}** days; Medical Leave: **${place('Medical Leave')}** days.`,mode:'answer'}};}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question:'how much leave do i have left',
   scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  expect(result.trace.calls[0]).toMatchObject({tool:'my_leave_balances',status:'ok'});
  const sent=model.requests.flatMap(request=>request.messages.filter(message=>message.role==='tool').map(message=>String(message.content)));
  expect(sent).toHaveLength(1);expect(sent[0]).not.toMatch(/withheld/i);expect(sent[0]).not.toContain('11.5');expect(sent[0]).not.toContain('17.25');
  const medical=byType(seen.rows??[],'Medical Leave');
  expect(medical.notShown).toEqual(['accrued','balance']);expect(String(medical.available)).toMatch(/^\{\{F\d+\}\} \(between 10 and 20\)$/);
  expect(medical).not.toHaveProperty('accrued');expect(medical).not.toHaveProperty('balance');
  expect(byType(seen.rows??[],'Annual Leave').notShown).toEqual([]);
  expect(result.reply).toBe('Annual Leave: **17.25** days; Medical Leave: **11.5** days.');
  expect(result.trace.disclosure[0]).toMatchObject({tool:'my_leave_balances',entity:'leave_balance',undeclared:[],removed:[]});
 });
});
