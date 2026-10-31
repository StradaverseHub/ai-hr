/** ADR-0151 §4.2/§4.6a — the agent learns a new screen in the same change that adds it. Every server-action
 * export and every mutating route method must be classified in lib/ai/agent-capability-inventory.ts, and
 * the classification must respect the tier rules: Automatic only for reads, registered entries only for
 * declared module actions, and a closed set of handoff and internal reasons. Source scan only; no database. */
import {describe,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
import {PayrollReopen as PayrollReopenContract} from '../lib/assistant-actions/reviewed-payroll-reopen-contract';
import {AGENT_PRINCIPAL_SPECIALISTS,AGENT_CAPABILITY_INVENTORY,AGENT_ACTION_TIER_CEILING,AGENT_ACTION_CATEGORY,AGENT_HANDOFF_REASONS,AGENT_INTERNAL_REASONS,agentCapabilityCoverage} from '../lib/ai/agent-capability-inventory';
import {NATIVE_OUTCOME_ACTIONS} from '../lib/ai/module-native-outcomes';

const ROOT=path.resolve(__dirname,'..');
const read=(rel:string)=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const USE_SERVER=/^(\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*['"]use server['"]/;
const FN=/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm;
const CONST=/^export\s+const\s+([A-Za-z0-9_$]+)\s*[:=]/gm;
const BRACE=/^export\s*\{([^}]*)\}/gm;
const MUTATING=new Set(['POST','PUT','PATCH','DELETE']);
const READ_VERB=/^(my|admin|own|hr)?(load|get|list|preview|search|read|fetch|count|check|lookup|find|validate|calculate|estimate|suggest|explain|view|compare|show|describe|inspect)/i;

function names(src:string){
 const found=[...src.matchAll(FN),...src.matchAll(CONST)].map(m=>m[1]);
 for(const m of src.matchAll(BRACE))for(const part of m[1].split(',')){const item=part.trim();if(item&&!item.startsWith('type '))found.push(item.split(' as ').pop()!.trim());}
 return [...new Set(found)].sort();
}
/** The same entry points the inventory was generated from: tracked application source outside tests. */
function scan(){
 const files=execFileSync('git',['ls-files','*.ts','*.tsx'],{cwd:ROOT,encoding:'utf8'}).split('\n').filter(Boolean)
  .filter(file=>!/^(test|node_modules|mobile|scripts|e2e)\//.test(file));
 const actual:Record<string,string[]>={};
 for(const file of files){
  const src=read(file);
  if(USE_SERVER.test(src.trimStart()))actual[file]=names(src);
  else if(file.startsWith('app/')&&/(^|\/)route\.tsx?$/.test(file)){const methods=names(src).filter(name=>MUTATING.has(name));if(methods.length)actual[`${file}#route`]=methods;}
 }
 return actual;
}
/** Body of one export, up to the next top-level declaration. */
function body(file:string,name:string){
 const src=read(file.split('#')[0]);const start=src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`));
 if(start<0)return '';const rest=src.slice(start+1);const next=rest.search(/\n(?:export\s|async function |function |const [A-Za-z]+ *= *async)/);
 return next<0?src.slice(start):src.slice(start,start+1+next);
}

describe('ADR-0151 agent capability inventory',()=>{
 const actual=scan();
 const inventory=AGENT_CAPABILITY_INVENTORY;

 it('classifies every server-action export and mutating route method, and nothing that no longer exists',()=>{
  const missing:string[]=[],stale:string[]=[];
  for(const [file,exports] of Object.entries(actual))for(const name of exports)if(!inventory[file]?.[name])missing.push(`${file} › ${name}`);
  for(const [file,entries] of Object.entries(inventory))for(const name of Object.keys(entries))if(!actual[file]?.includes(name))stale.push(`${file} › ${name}`);
  expect(missing,'Classify these new entry points in lib/ai/agent-capability-inventory.ts (ADR-0151 §4.2)').toEqual([]);
  expect(stale,'Remove or rename these entries in lib/ai/agent-capability-inventory.ts').toEqual([]);
  // Non-vacuous: the scan really found the application's entry points.
  expect(Object.keys(actual).length).toBeGreaterThan(150);
  expect(actual['app/leave/actions.ts']).toContain('requestLeaveAction');
 });

 it('registers only declared module actions, and every declared action has a tier ceiling',()=>{
  const declared=new Set([...Object.keys(NATIVE_OUTCOME_ACTIONS),'approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase','employees.review_overdue.remind','attendance.missing_clock.remind','employees.passport_expiry.remind','lifecycle.step.chase']);
  expect(new Set(Object.keys(AGENT_ACTION_TIER_CEILING))).toEqual(declared);
  for(const [file,entries] of Object.entries(inventory))for(const [name,value] of Object.entries(entries)){
   if(!value.startsWith('registered:'))continue;
   expect(declared.has(value.slice('registered:'.length)),`${file} › ${name} names an undeclared action`).toBe(true);
  }
 });

 it('allows Automatic only for reads that do not revalidate a page',()=>{
  const refused:string[]=[];
  for(const [file,entries] of Object.entries(inventory))for(const [name,value] of Object.entries(entries)){
   if(value!=='backlog:automatic')continue;
   if(!READ_VERB.test(name)||/Check(In|Out)/.test(name)||/revalidate(Path|Tag)\(/.test(body(file,name)))refused.push(`${file} › ${name}`);
  }
  expect(refused).toEqual([]);
  // Registered effects are never Automatic (§4.4), except the WP13 reminders and chasers, which change no record.
  const automatic=Object.entries(AGENT_ACTION_TIER_CEILING).filter(([,tier])=>tier==='automatic').map(([id])=>id);
  expect(automatic.sort()).toEqual(['approvals.attendance.chase','approvals.claim.chase','approvals.toil.chase','attendance.missing_clock.remind','employees.passport_expiry.remind','employees.review_overdue.remind','lifecycle.step.chase']);
  for(const id of automatic)expect(['chaser','reminder']).toContain(AGENT_ACTION_CATEGORY[id as keyof typeof AGENT_ACTION_CATEGORY]);
 });

 it('keeps unsupported sensitive actions as handoffs and Payroll reopening in explicit human review',()=>{
  const expectations:[string,string,string][]=[
   ['app/admin/actions.ts','assignRoleAction','handoff:access_and_authentication'],
   ['app/admin/privacy/actions.ts','erasePersonPiiAction','handoff:privacy_erasure'],
   ['app/payroll/actions.ts','resetAction','registered:payroll.reset'],
   ['app/approvals/actions.ts','decideResignationAction','handoff:employment_exit_or_discipline'],
   ['app/control-tower/agents/actions.ts','setAiAllowanceAction','handoff:ai_governance'],
   ['app/operator/actions.ts','setCustomerFeedbackMenuAction','handoff:platform_operator'],
  ];
  for(const [file,name,value] of expectations)expect(inventory[file]?.[name],`${file} › ${name}`).toBe(value);
  expect(inventory['app/payroll/actions.ts']?.unlockAction).toBe('registered:payroll.reopen');
  expect(AGENT_ACTION_TIER_CEILING['payroll.reopen']).toBe('approve');
  expect(AGENT_ACTIONS.find(action=>action.id==='payroll.reopen')).toMatchObject({
   module:'payroll',policy:{tier:'approve',category:'payroll'},store:'generic_own',browserOwner:'payrollReopen',
   screen:{entryPoints:['app/payroll/actions.ts#unlockAction']},review:{route:'/assistant/payroll-reopen',handoff:'review_page'},
   humanInputs:['batchId','reason','confirmReopenClosedRun','acknowledgeRecordedDownstreamWarnings'],
  });
  expect(parseModuleAgentActionNomination({module:'payroll',action:'payroll.reopen',phase:'prepare'})).toMatchObject({kind:'prepare',requiresHumanSelection:true,effect:'none',adapter:'module_payroll_reopen_review_v1'});
  for(const extra of [{batchId:'model batch'},{reason:'model reason'},{confirmReopenClosedRun:true},{acknowledgeRecordedDownstreamWarnings:true}])expect(()=>parseModuleAgentActionNomination({module:'payroll',action:'payroll.reopen',phase:'prepare',...extra})).toThrow();
  expect(()=>parseModuleAgentActionNomination({module:'payroll',action:'payroll.reopen',phase:'confirm'})).toThrow();
  const human={action:'payroll.reopen',contractVersion:1,batchId:'10000000-0000-4000-8000-000000000001',reason:'Correct the reviewed run.',confirmReopenClosedRun:true,acknowledgeRecordedDownstreamWarnings:true};
  expect(PayrollReopenContract.Human.safeParse(human).success).toBe(true);
  for(const consent of ['confirmReopenClosedRun','acknowledgeRecordedDownstreamWarnings']){
   const missing:Record<string,unknown>={...human};delete missing[consent];expect(PayrollReopenContract.Human.safeParse(missing).success).toBe(false);
   expect(PayrollReopenContract.Human.safeParse({...human,[consent]:false}).success).toBe(false);
  }

  for(const entries of Object.values(inventory))for(const value of Object.values(entries)){
   const [kind,reason]=value.split(':');
   if(kind==='handoff')expect(AGENT_HANDOFF_REASONS as readonly string[]).toContain(reason);
   if(kind==='internal')expect(AGENT_INTERNAL_REASONS as readonly string[]).toContain(reason);
   expect(['registered','backlog','handoff','internal']).toContain(kind);
  }
 });

 it('lets the agent principal run only Automatic specialists that exist and match its switches (ADR-0151 §4.5)',()=>{
  // The same switches migration 0672 names in its attribution read and its event stamp check.
  // WP13 (0697) replaced both policies with the same rule plus the two reminder specialists.
  const migration=['0672_ai_agent_principal','0817_automatic_chasers','0819_automatic_followups'].map(tag=>fs.readFileSync(path.join(process.cwd(),`db/migrations/${tag}.sql`),'utf8')).join('\n');
  expect(Object.keys(AGENT_PRINCIPAL_SPECIALISTS).sort()).toEqual(['approval_chasers','claims_triage','clock_reminders','document_reminders','lifecycle_chasers','readiness_reminders','review_chasers']);
  for(const entry of Object.values(AGENT_PRINCIPAL_SPECIALISTS))expect(migration).toContain(`'${entry.setting}'`);
  for(const [feature,entry] of Object.entries(AGENT_PRINCIPAL_SPECIALISTS)){
   expect(entry.tier,feature).toBe('automatic');
   const [file,fn]=entry.service.split('#');
   expect(fs.readFileSync(path.join(process.cwd(),file),'utf8'),entry.service).toMatch(new RegExp(`export async function ${fn}\\(`));
  }
 });

 it('reports coverage counts that add up to the classified entry points',()=>{
  const counts=agentCapabilityCoverage(),total=Object.values(inventory).reduce((sum,entries)=>sum+Object.keys(entries).length,0);
  expect(Object.values(counts).reduce((a,b)=>a+b,0)).toBe(total);
  expect(counts.registered).toBeGreaterThanOrEqual(19);
 });
});
