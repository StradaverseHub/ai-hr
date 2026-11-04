/** Eval 41665308001, emp-balance-1 (issue 18): what the model is sent for a leave balance row the company partly hides.
 * Medical Leave hides its brought-forward and forfeited lines from employees, so the Mine projection leaves out accrued
 * and balance. It used to say so with a row-wide withheld:true, which the model read beside the shown Medical Leave
 * figure as "the available amount isn't shown". The row now names what it does not show (notShown) and carries no
 * row-wide flag; the card's "partly hidden" note and the specialist guards read notShown. Real projection, real
 * disclosure, real presentation and specialist, the real turn runner with a scripted model and fictional tools: no
 * database, no provider. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {projectMineLeaveBalance} from '../core/assistant-leave-projection';
import {resolveEssView} from '../core/ess-view';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {leaveBalancePartlyHidden,presentCanonicalModuleData} from '../lib/ai/module-job-presentation';
import {presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import {FICTIONAL,fakeTools} from './harness-ratchet/fake-tools';
import {scriptedModel} from './harness-ratchet/scripted-model';

const ANNUAL='22222222-2222-4222-8222-222222222222',MEDICAL='44444444-4444-4444-8444-444444444444',UNPAID='55555555-5555-4555-8555-555555555555';
const balance=(leaveTypeId:string,leaveType:string,days:number,hidden:Record<string,boolean>|null)=>projectMineLeaveBalance({leaveTypeId,leaveType,
 accrued:days,taken:0,pending:0,balance:days,available:days,essView:resolveEssView(hidden),sharedBalance:null});
/** Annual Leave shown in full, Medical Leave hiding its brought-forward and forfeited lines, Unpaid Leave with nothing. */
const balances=()=>[balance(ANNUAL,'Annual Leave',17.25,null),balance(MEDICAL,'Medical Leave',11.5,{broughtForward:false,forfeited:false}),balance(UNPAID,'Unpaid Leave',0,null)];
const balancesOutcome=()=>({ok:true,employments:[{employmentId:FICTIONAL.ownEmployment,company:FICTIONAL.company,balances:balances()}]});
type Row=Record<string,unknown>;
const rowsOf=(value:unknown)=>(value as {employments:{balances:Row[]}[]}).employments[0].balances;
const byType=(rows:readonly Row[],leaveType:string)=>{const row=rows.find(candidate=>candidate.leaveType===leaveType);if(!row)throw Error('Missing '+leaveType+' row.');return row;};
const FIGURE=/^(\{\{F\d+\}\}) \(([^)]+)\)$/;
const figure=(ledger:DisclosureLedger,value:unknown)=>{const match=FIGURE.exec(String(value));if(!match)throw Error('Not a figure placeholder: '+String(value));
 return{placeholder:match[1],band:match[2],value:ledger.figures.get(match[1])?.value};};

describe('my_leave_balances as the model reads it',()=>{
 it('carries no withheld flag; Medical Leave keeps its available figure and names only accrued and balance as not shown',()=>{
  const ledger=new DisclosureLedger('me'),{value,applied}=discloseToolOutput('my_leave_balances','leave_balance',balancesOutcome(),ledger);
  expect(JSON.stringify(value)).not.toMatch(/withheld/i);
  const rows=rowsOf(value),medical=byType(rows,'Medical Leave'),annual=byType(rows,'Annual Leave'),unpaid=byType(rows,'Unpaid Leave');
  expect(figure(ledger,medical.available)).toMatchObject({band:'between 10 and 20',value:11.5});
  expect(medical.notShown).toEqual(['accrued','balance']);expect(medical).not.toHaveProperty('accrued');expect(medical).not.toHaveProperty('balance');
  expect(figure(ledger,annual.available)).toMatchObject({band:'between 10 and 20',value:17.25});expect(annual.notShown).toEqual([]);
  expect(figure(ledger,annual.balance).value).toBe(17.25);
  expect(figure(ledger,unpaid.available).value).toBe(0);expect(unpaid.notShown).toEqual([]);
  // Every key of every row is declared: nothing is dropped as unknown and nothing declared is removed.
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);
 });
 it('names a hidden available figure as not shown, and no figure of it leaves',()=>{
  const ledger=new DisclosureLedger('me'),outcome={ok:true,employments:[{employmentId:FICTIONAL.ownEmployment,company:FICTIONAL.company,
   balances:[balance(MEDICAL,'Medical Leave',11.5,{available:false})]}]};
  const row=rowsOf(discloseToolOutput('my_leave_balances','leave_balance',outcome,ledger).value)[0];
  expect(row.available).toBeNull();expect(row.notShown).toEqual(['available','sharedPoolName','accrued','balance']);
  expect([...ledger.figures.values()].map(entry=>entry.value)).not.toContain(11.5);
 });
 it('my_module_work (leave): the same row, no withheld flag, notShown beside the shown figures',()=>{
  const ledger=new DisclosureLedger('me'),outcome={ok:true,module:'leave',data:{rows:[{employmentId:FICTIONAL.ownEmployment,company:FICTIONAL.company,
   balances:[balance(MEDICAL,'Medical Leave',11.5,{broughtForward:false,forfeited:false})]}],truncated:false},humanActions:[]};
  const {value,applied}=discloseToolOutput('my_module_work','module_work',outcome,ledger);
  const row=(value as {data:{rows:{balances:Row[]}[]}}).data.rows[0].balances[0];
  expect(JSON.stringify(value)).not.toMatch(/withheld/i);expect(row.notShown).toEqual(['accrued','balance']);expect(figure(ledger,row.available).value).toBe(11.5);
  expect(applied.undeclared).toEqual([]);
 });
});

describe('the product still marks a partly hidden row',()=>{
 it('reads notShown for the card note: Medical Leave partly hidden, Annual and Unpaid not',()=>{
  expect(balances().map(row=>[row.leaveType,leaveBalancePartlyHidden(row)])).toEqual([['Annual Leave',false],['Medical Leave',true],['Unpaid Leave',false]]);
  const cards=presentGroundedToolOutcome('my_leave_balances',balancesOutcome())!.cards;
  expect(cards.map(card=>card.withheld)).toEqual([false,true,false]);
  expect(cards[1].facts.map(fact=>[fact.field,fact.value])).toEqual([['company',FICTIONAL.company],['available',11.5],['taken',0],['pending',0]]);
 });
 it('fails closed: a malformed notShown counts as hidden, and a legacy withheld:true row still does',()=>{
  for(const notShown of [null,'accrued',['balance'],{}])expect(leaveBalancePartlyHidden({notShown}),JSON.stringify(notShown)).toBe(true);
  expect(leaveBalancePartlyHidden({withheld:true,notShown:[]})).toBe(true);
  expect(leaveBalancePartlyHidden({notShown:[]})).toBe(false);expect(leaveBalancePartlyHidden({withheld:false})).toBe(false);
 });
 it('the leave specialist refuses a partly hidden row that smuggles a decomposition alias back, and keeps its withheld finding',()=>{
  const source=(rows:Row[])=>({module:'leave' as const,scope:'current-caller',capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]==='leave')![1],data:{rows:[{balances:rows}],truncated:false}});
  const candidate={kind:'canonical_specialist_v1',module:'leave',playbook:'canonical_domain_v1'};
  const medical=balance(MEDICAL,'Medical Leave',11.5,{broughtForward:false,forfeited:false});
  for(const alias of ['accrued','balance'])expect(()=>executeCanonicalSpecialist(candidate,source([{...medical,[alias]:98765}]))).toThrow();
  expect(executeCanonicalSpecialist(candidate,source([medical])).findings).toContain('withheld_not_reconstructable');
  expect(executeCanonicalSpecialist(candidate,source([balance(ANNUAL,'Annual Leave',17.25,null)])).findings).not.toContain('withheld_not_reconstructable');
  expect(presentCanonicalModuleData('leave',source([medical]).data).cards[0].withheld).toBe(true);
 });
});

const employee:SessionContext={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId:'00000000-0000-4000-8000-0000000000cc',
 roles:['employee'],grants:[{role:'employee',companyId:null}]};
afterEach(()=>{vi.unstubAllEnvs();});
/** The disclosed JSON of the latest tool message the model was sent. */
function lastToolResult(request:ModelRequest):unknown{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}
describe('a harness turn: "how much leave do i have left"',()=>{
 it('sends the model no withheld flag in the leave read or its description, and the person sees both real figures',async()=>{
  const {provider}=fakeTools({outputs:{my_leave_balances:()=>({ok:true,content:balancesOutcome()})}});
  const seen:{medical?:Row;annual?:Row}={};
  const model=scriptedModel([{calls:[{name:'my_leave_balances'}]},request=>{const rows=rowsOf(lastToolResult(request)),medical=byType(rows,'Medical Leave'),annual=byType(rows,'Annual Leave');
   seen.medical=medical;seen.annual=annual;const place=(row:Row)=>FIGURE.exec(String(row.available))![1];
   return{final:{reply:`You have **${place(annual)}** days of Annual Leave and **${place(medical)}** days of Medical Leave.`,mode:'answer'}};}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId:'conversation-not-shown',question:'how much leave do i have left',
   scope:{companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'},model,memory:new InMemoryTaskMemoryStore(),tools:provider});
  expect(result.trace.calls[0]).toMatchObject({tool:'my_leave_balances',status:'ok'});
  const toolMessages=model.requests.flatMap(request=>request.messages.filter(message=>message.role==='tool').map(message=>String(message.content)));
  expect(toolMessages).toHaveLength(1);expect(toolMessages[0]).not.toMatch(/withheld/i);
  const spec=model.requests[0].tools.find(tool=>tool.name==='my_leave_balances');expect(spec?.description).toMatch(/\bnotShown\b/);expect(spec?.description).not.toMatch(/withheld/i);
  expect(seen.medical).toMatchObject({notShown:['accrued','balance']});expect(String(seen.medical?.available)).toMatch(FIGURE);expect(seen.annual).toMatchObject({notShown:[]});
  expect(result.reply).toBe('You have **17.25** days of Annual Leave and **11.5** days of Medical Leave.');
  expect(result.trace.disclosure[0]).toMatchObject({tool:'my_leave_balances',entity:'leave_balance',undeclared:[],removed:[]});
 });
});
