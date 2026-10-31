/** WP7 (review R3, D4/D5; ADR-0151 §4.2) — ONE typed agent action registry. Source and SQL text only; no
 * database. Asserts registry = seeded app.assistant_action_kind rows = capability inventory = tier-ceiling map,
 * that every closed TypeScript list is derived from the registry, and that never-Automatic categories can never
 * be Automatic. Adding an action = one defineAgentAction entry + one INSERT row in a new migration. */
import {describe,expect,expectTypeOf,it,vi} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {
 AGENT_ACTIONS,AGENT_ACTION_IDS,agentActionById,agentActionsByModule,agentActionsByTier,defineAgentAction,getAgentAction,isAgentActionId,
 type AgentAction,type AgentActionDefinition,
} from '../lib/ai/agent-action-registry';
import {AUTOMATIC_CATEGORIES,NEVER_AUTOMATIC_CATEGORIES,type NeverAutomaticCategory} from '../lib/ai/agent-action-tiers';
import {assertAgentActionTier} from '../lib/ai/agent-action-tier-guard';
import {AGENT_ACTION_CATEGORY,AGENT_ACTION_TIER_CEILING,AGENT_CAPABILITY_INVENTORY,AGENT_PRINCIPAL_SPECIALISTS} from '../lib/ai/agent-capability-inventory';
import {MODULE_AGENT_ACTIONS,parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
import {NATIVE_OUTCOME_ACTIONS,NATIVE_REVIEW_ACTIONS} from '../lib/ai/module-native-outcomes';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {ASSISTANT_CONVERSATION_HOLDOUTS} from '../lib/ai/assistant-conversation-holdouts';
import {ASSISTANT_PROPOSAL_MODULE,ASSISTANT_PROPOSABLE_ACTIONS} from '../lib/ai/assistant-action-proposal-hints';
import {AI_FEATURES} from '../lib/ai/features';
import {createModuleActionBrowserHandler,GENERIC_MODULE_ACTIONS} from '../lib/assistant-actions/module-action-http';

const ROOT=path.resolve(__dirname,'..');
const read=(rel:string)=>readFileSync(path.join(ROOT,rel),'utf8');
const anchorExported=(anchor:string)=>{const [file,name]=anchor.split('#');if(!existsSync(path.join(ROOT,file)))return false;
 return new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`).test(read(file));};

/** The live app.assistant_action_kind contents, replayed from every migration in journal order. Supported
 * statements: INSERT rows (one per line), UPDATE ... SET col='v'[,col='v'] WHERE id='x', DELETE ... WHERE id='x'. */
type KindRow={id:string;module:string;tier_ceiling:string;category:string;review_kind:string|null};
function seededKinds(){
 const journal=JSON.parse(read('db/migrations/meta/_journal.json')) as {entries:{tag:string}[]};
 const rows=new Map<string,KindRow>(),files:string[]=[];
 const value=(token:string)=>token.trim()==='NULL'?null:token.trim().replace(/^'|'$/g,'');
 for(const {tag} of journal.entries){
  const source=read(`db/migrations/${tag}.sql`);if(!source.includes('app.assistant_action_kind'))continue;files.push(tag);
  for(const statement of source.split('--> statement-breakpoint')){
   const insert=statement.match(/INSERT INTO app\.assistant_action_kind\(id,module,tier_ceiling,category,review_kind\) VALUES([\s\S]*?);/);
   if(insert)for(const tuple of insert[1].matchAll(/\(([^()]*)\)/g)){
    const [id,module,tier_ceiling,category,review_kind]=tuple[1].split(',').map(value);
    expect(rows.has(id!),`duplicate seed ${id}`).toBe(false);rows.set(id!,{id:id!,module:module!,tier_ceiling:tier_ceiling!,category:category!,review_kind});
   }
   for(const update of statement.matchAll(/UPDATE app\.assistant_action_kind SET ([^;]*?) WHERE id='([^']+)';/g)){
    const row=rows.get(update[2]);expect(row,`update of unseeded ${update[2]}`).toBeDefined();if(!row)continue;
    for(const assignment of update[1].split(',')){const [column,raw]=assignment.split('=');(row as unknown as Record<string,string|null>)[column!.trim()]=value(raw!);}
   }
   for(const removal of statement.matchAll(/DELETE FROM app\.assistant_action_kind WHERE id='([^']+)';/g))rows.delete(removal[1]);
  }
 }
 return {rows,files};
}

describe('the agent action registry',()=>{
 it('declares unique, well-formed ids and closed helpers that fail closed',()=>{
  expect(AGENT_ACTIONS.length).toBeGreaterThanOrEqual(30);
  expect(new Set(AGENT_ACTION_IDS).size).toBe(AGENT_ACTIONS.length);
  expect(AGENT_ACTION_IDS).toEqual(AGENT_ACTIONS.map(action=>action.id));
  for(const action of AGENT_ACTIONS){
   expect(Object.isFrozen(action)&&Object.isFrozen(action.policy)&&Object.isFrozen(action.screen.entryPoints),action.id).toBe(true);
   expect(action.id).toMatch(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_]*)+$/);
   expect(getAgentAction(action.id)).toBe(action);expect(agentActionById(action.id)).toBe(action);expect(isAgentActionId(action.id)).toBe(true);
  }
  for(const forged of ['constructor','__proto__','toString','hasOwnProperty','','leave.APPLY',' leave.apply','payroll.delete',null,1,{}])
   {expect(agentActionById(forged)).toBeNull();expect(isAgentActionId(forged)).toBe(false);}
  for(const module of AGENT_MODULE_CODES)expect(agentActionsByModule(module).every(action=>action.module===module)).toBe(true);
  expect(AGENT_MODULE_CODES.flatMap(module=>agentActionsByModule(module)).length).toBe(AGENT_ACTIONS.length);
  for(const tier of ['automatic','confirm','approve','handoff'] as const)expect(agentActionsByTier(tier).every(action=>action.policy.tier===tier)).toBe(true);
  expect((['automatic','confirm','approve','handoff'] as const).reduce((sum,tier)=>sum+agentActionsByTier(tier).length,0)).toBe(AGENT_ACTIONS.length);
 });

 it('never lets a never-Automatic category be Automatic, by type, at definition and at runtime',()=>{
  expectTypeOf<{category:'pay';tier:'automatic'}>().not.toExtend<AgentActionDefinition['policy']>();
  expectTypeOf<{category:'approvals';tier:'automatic'}>().not.toExtend<AgentActionDefinition['policy']>();
  expectTypeOf<{category:'own_work';tier:'automatic'}>().not.toExtend<AgentActionDefinition['policy']>();
  expectTypeOf<{category:'reminder';tier:'automatic'}>().toExtend<AgentActionDefinition['policy']>();
  expectTypeOf<Extract<AgentAction,{readonly policy:{readonly tier:'automatic';readonly category:NeverAutomaticCategory}}>>().toBeNever();
  for(const action of AGENT_ACTIONS){
   if((NEVER_AUTOMATIC_CATEGORIES as readonly string[]).includes(action.policy.category))expect(action.policy.tier,action.id).not.toBe('automatic');
   const policy=action.policy as AgentActionDefinition['policy'];
   if(policy.tier==='automatic'){expect(AUTOMATIC_CATEGORIES as readonly string[]).toContain(policy.category);expect(()=>assertAgentActionTier(action.id,'automatic'),action.id).not.toThrow();}
   else expect(()=>assertAgentActionTier(action.id,'automatic'),action.id).toThrow();
  }
  const base=AGENT_ACTIONS.find(action=>action.id==='payroll.close')!;
  for(const category of NEVER_AUTOMATIC_CATEGORIES)
   expect(()=>defineAgentAction({...base,id:'payroll.fabricated',policy:{category,tier:'automatic'}} as unknown as AgentActionDefinition)).toThrow('malformed');
  expect(()=>defineAgentAction({...base,id:'payroll.fabricated',policy:{category:'own_work',tier:'automatic'}} as unknown as AgentActionDefinition)).toThrow('malformed');
 });

 it('equals the seeded app.assistant_action_kind rows exactly (registry = SQL)',()=>{
  const {rows,files}=seededKinds();
  expect(files[0]).toBe('0813_assistant_action_kind');
  expect(rows.size).toBe(AGENT_ACTIONS.length);
  const expected=AGENT_ACTIONS.map(action=>({id:action.id,module:action.module,tier_ceiling:action.policy.tier,category:action.policy.category,review_kind:action.store==='human_workflow_only'?null:action.id}));
  expect([...rows.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'))).toEqual(expected.sort((a,b)=>a.id.localeCompare(b.id,'en')));
  // The SQL automatic rule is the same closed category list as WP2's runtime rule.
  const sql=read('db/migrations/0813_assistant_action_kind.sql'),scope=sql.match(/assistant_action_kind_automatic_scope CHECK\(tier_ceiling<>'automatic' OR category IN\(([^)]*)\)\)/);
  expect(scope?.[1].split(',').map(item=>item.replace(/'/g,'')).sort()).toEqual([...AUTOMATIC_CATEGORIES].sort());
  for(const category of NEVER_AUTOMATIC_CATEGORIES)expect(scope?.[1]).not.toContain(`'${category}'`);
 });

 it('replaces every closed SQL action list with a validated reference, dropping the old CHECKs only afterwards',()=>{
  const sql=read('db/migrations/0813_assistant_action_kind.sql');
  const at=(text:string)=>{const index=sql.indexOf(text);expect(index,text).toBeGreaterThanOrEqual(0);return index;};
  const reviewFk=at('ADD CONSTRAINT assistant_review_action_kind_registered\n FOREIGN KEY(action_kind) REFERENCES app.assistant_action_kind(review_kind) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;');
  const associationFk=at('ADD CONSTRAINT ai_native_outcome_association_action_registered\n FOREIGN KEY(action) REFERENCES app.assistant_action_kind(id) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;');
  const validate=at('VALIDATE CONSTRAINT assistant_review_action_kind_registered;'),validateAssociation=at('VALIDATE CONSTRAINT ai_native_outcome_association_action_registered;');
  const precheck=at("RAISE EXCEPTION '0693: app.assistant_own_leave_review has action kinds with no app.assistant_action_kind review row");
  const dropReview=at('DROP CONSTRAINT assistant_review_action_kind;'),dropAssociation=at('DROP CONSTRAINT ai_native_outcome_association_action;');
  expect(precheck).toBeLessThan(reviewFk);expect(Math.max(reviewFk,associationFk)).toBeLessThan(Math.min(validate,validateAssociation));
  expect(Math.max(validate,validateAssociation)).toBeLessThan(Math.min(dropReview,dropAssociation));
  expect(sql).toContain('GRANT SELECT ON app.assistant_action_kind TO ai_hr_app;');expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  expect(sql).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE|TRUNCATE|ALL)[^;]*app\.assistant_action_kind[^;]*TO ai_hr_app/);
  // Replay: after the last migration, neither closed list is live again.
  const journal=JSON.parse(read('db/migrations/meta/_journal.json')) as {entries:{tag:string}[]};
  for(const name of ['assistant_review_action_kind','ai_native_outcome_association_action']){
   let live=false;
   for(const {tag} of journal.entries)for(const statement of read(`db/migrations/${tag}.sql`).split('--> statement-breakpoint')){
    if(new RegExp(`ADD CONSTRAINT ${name} CHECK`).test(statement))live=true;
    if(new RegExp(`DROP CONSTRAINT ${name};`).test(statement))live=false;
   }
   expect(live,name).toBe(false);
  }
 });

 it('matches the capability inventory entry point by entry point, and the tier-ceiling map (registry = inventory = tiers)',()=>{
  const registered=new Map<string,string[]>();
  for(const [file,entries] of Object.entries(AGENT_CAPABILITY_INVENTORY))for(const [name,value] of Object.entries(entries)){
   if(!value.startsWith('registered:'))continue;const id=value.slice('registered:'.length);
   expect(isAgentActionId(id),`${file} › ${name} registers an action outside the registry`).toBe(true);
   registered.set(id,[...(registered.get(id)??[]),`${file}#${name}`]);
  }
  for(const action of AGENT_ACTIONS)expect([...(registered.get(action.id)??[])].sort(),action.id).toEqual([...action.screen.entryPoints].sort());
  expect([...registered.values()].flat().length).toBeGreaterThanOrEqual(27);
  expect(Object.keys(AGENT_ACTION_TIER_CEILING)).toEqual(AGENT_ACTION_IDS);
  expect(Object.keys(AGENT_ACTION_CATEGORY)).toEqual(AGENT_ACTION_IDS);
  for(const action of AGENT_ACTIONS){
   expect(AGENT_ACTION_TIER_CEILING[action.id]).toBe(action.policy.tier);expect(AGENT_ACTION_CATEGORY[action.id]).toBe(action.policy.category);
   if(action.reversal.kind==='entry_point'){const [file,name]=action.reversal.by.split('#');expect(AGENT_CAPABILITY_INVENTORY[file]?.[name],action.reversal.by).toBeDefined();}
   if(action.reversal.kind==='action')expect(isAgentActionId(action.reversal.by),action.reversal.by).toBe(true);
  }
 });

 it('derives the module declarations, nomination parser, native outcomes and handoff routes from the registry',()=>{
  // WP13: Automatic reminders are run by the agent principal, never nominated in chat, so they stay out of the module contract.
  const declared=Object.values(MODULE_AGENT_ACTIONS).flatMap(module=>module.actions.map(action=>action.id));
  expect([...declared].sort()).toEqual(AGENT_ACTIONS.filter(action=>action.policy.tier!=='automatic').map(action=>action.id).sort());
  for(const [module,row] of Object.entries(MODULE_AGENT_ACTIONS)){
   const entries=agentActionsByModule(module as AgentAction['module']).filter(action=>action.policy.tier!=='automatic');
   expect(row.actions.map(action=>action.id).sort()).toEqual(entries.map(action=>action.id).sort());
   // Exactly one action is the module's own public boundary, and it leads (it sets the module phases).
   if(entries.length){expect(entries.filter(action=>action.service===row.publicBoundary).map(action=>action.id),module).toEqual([row.actions[0]!.id]);}
   for(const action of row.actions){const entry=getAgentAction(action.id);
    expect(action).toMatchObject({owner:entry.owner,publicBoundary:entry.service,contractVersion:entry.contractVersion,prepare:entry.prepare,confirm:entry.confirm,outcome:entry.outcome});}
  }
  const nativeEffects=AGENT_ACTIONS.filter(action=>action.outcome!=='notification_only');
  expect(Object.keys(NATIVE_OUTCOME_ACTIONS)).toEqual(nativeEffects.map(action=>action.id));
  for(const action of AGENT_ACTIONS.filter(action=>action.outcome==='notification_only'))expect(Object.hasOwn(NATIVE_OUTCOME_ACTIONS,action.id)).toBe(false);
  for(const action of nativeEffects)expect(NATIVE_OUTCOME_ACTIONS[action.id]).toEqual({module:action.module,semantics:action.semantics});
  expect(NATIVE_REVIEW_ACTIONS).toEqual(AGENT_ACTIONS.filter(action=>action.store!=='human_workflow_only').map(action=>action.id));
  for(const action of AGENT_ACTIONS){
   const nominate=(phase:string,module:string=action.module)=>()=>parseModuleAgentActionNomination({module,action:action.id,phase});
   if(action.prepare.status==='implemented')expect(nominate('prepare')()).toEqual({kind:'prepare',module:action.module,action:action.id,adapter:action.prepare.adapter,requiresHumanSelection:true,effect:'none'});
   else expect(nominate('prepare')).toThrow();
   expect(nominate('confirm')).toThrow();expect(nominate('explain')).toThrow();
   expect(nominate('prepare',action.module==='leave'?'claims':'leave')).toThrow();
  }
  for(const module of AGENT_MODULE_CODES){
   const expected=agentActionsByModule(module).filter(action=>action.review.handoff==='review_page').map(action=>({module,action:action.id,route:action.review.route}));
   if(module!=='employees')expect(moduleHumanActionHandoffs(module).filter(row=>row.action!=='lifecycle.offboarding.workflow').map(row=>({module:row.module,action:row.action,route:row.route})),module).toEqual(expected);
  }
  expect(moduleHumanActionHandoffs('employees').map(row=>row.action)).toEqual(AGENT_ACTIONS.filter(action=>action.module==='employees'&&action.review.handoff!=='none').map(action=>action.id));
 });

 it('anchors every guard, screen, review page, browser owner, evaluation case and pause key to real source',()=>{
  const server=read('core/assistant-actions/module-action-server.ts'),http=read('lib/assistant-actions/module-action-http.ts');
  for(const action of AGENT_ACTIONS){
   expect(anchorExported(action.permission.guard),action.permission.guard).toBe(true);
   expect(existsSync(path.join(ROOT,action.screen.native)),action.screen.native).toBe(true);
   const page=action.review.route.split('?')[0]!;expect(existsSync(path.join(ROOT,'app','(app)',page,'page.tsx')),page).toBe(true);
   if(action.browserOwner&&action.browserOwner!=='root'&&action.browserOwner!=='ownLeave'){
    expect(http,action.browserOwner).toMatch(new RegExp(`\\n ${action.browserOwner}\\?:`));expect(server,action.browserOwner).toMatch(new RegExp(`\\n  ${action.browserOwner}:\\{`));
   }
   expect(action.store==='human_workflow_only').toBe(action.browserOwner===null);
   expect(action.humanInputs==='native_page_only').toBe(action.store==='human_workflow_only');
   expect(action.blastRadius.max).toBeGreaterThanOrEqual(1);
   expect(AI_FEATURES.some(feature=>feature.id===action.pauseKey),action.pauseKey).toBe(true);
   for(const evaluation of action.evaluationCases){
    const cases=ASSISTANT_CONVERSATION_HOLDOUTS.filter(row=>row.id.endsWith(':'+evaluation.case));
    expect(cases.length,evaluation.case).toBeGreaterThan(0);
    for(const row of cases)expect((row.source as {proposal?:string}).proposal,row.id).toBe(action.id);
   }
  }
  // Conversely, every holdout that proposes an action is listed on that action.
  for(const row of ASSISTANT_CONVERSATION_HOLDOUTS){const proposal=(row.source as {proposal?:unknown}).proposal;if(typeof proposal!=='string')continue;
   expect(getAgentAction(proposal as AgentAction['id']).evaluationCases.map(evaluation=>evaluation.case),row.id).toContain(row.id.slice(row.id.indexOf(':')+1));}
  for(const action of ASSISTANT_PROPOSABLE_ACTIONS)expect(ASSISTANT_PROPOSAL_MODULE[action]).toBe(getAgentAction(action).module);
 });
});

describe('WP13 Automatic-tier entries (R18)',()=>{
 const automatic=agentActionsByTier('automatic');
 it('are exactly the owner-ordered reminders, each bounded and run by the agent principal only',()=>{
  expect(automatic.map(action=>action.id)).toEqual(['approvals.claim.chase','approvals.attendance.chase','approvals.toil.chase','employees.review_overdue.remind','attendance.missing_clock.remind','employees.passport_expiry.remind','lifecycle.step.chase']);
  for(const action of automatic){
   expect(['chaser','reminder']).toContain(action.policy.category);
   expect(action).toMatchObject({store:'human_workflow_only',browserOwner:null,humanInputs:'native_page_only',outcome:'notification_only',
    idempotencyKey:'chase_item_stage_cooldown',permission:{actor:'agent_principal'},
    prepare:{status:'human_workflow_only'},confirm:{status:'human_workflow_only'},review:{handoff:'none'},screen:{entryPoints:[]}});
   expect(Object.keys(AGENT_PRINCIPAL_SPECIALISTS)).toContain(action.automatic.specialist);
   expect(AGENT_PRINCIPAL_SPECIALISTS[action.automatic.specialist].service).toBe(action.service);
   for(const bound of [action.automatic.overdueAfterDays,action.automatic.cooldownDays,action.automatic.maxPerItem,action.automatic.maxPerRun])
    expect(Number.isSafeInteger(bound)&&bound>=1).toBe(true);
   // A model can never nominate, prepare or confirm one.
   for(const phase of ['prepare','confirm','explain'])expect(()=>parseModuleAgentActionNomination({module:action.module,action:action.id,phase})).toThrow();
   expect(moduleHumanActionHandoffs(action.module).some(row=>(row.action as string)===action.id)).toBe(false);
  }
  expect(automatic.filter(action=>action.automatic.specialist==='approval_chasers').map(action=>action.automatic.source).sort()).toEqual(['attendance_correction','claim','replacement_leave']);
 });

 it('refuses a malformed Automatic entry at definition',()=>{
  const base=AGENT_ACTIONS.find(action=>action.id==='approvals.claim.chase')! as unknown as AgentActionDefinition;
  const bad=(patch:Record<string,unknown>)=>()=>defineAgentAction({...base,id:'approvals.fabricated.chase',...patch} as unknown as AgentActionDefinition);
  expect(bad({})).not.toThrow();
  expect(bad({automatic:undefined})).toThrow('malformed');
  expect(bad({policy:{tier:'automatic',category:'approvals'}})).toThrow('malformed');
  expect(bad({permission:{actor:'assigned_approver',guard:base.permission.guard}})).toThrow('malformed');
  expect(bad({outcome:'canonical_receipt_required'})).toThrow('malformed');
  expect(bad({automatic:{...base.automatic!,maxPerRun:0}})).toThrow('malformed');
  expect(bad({automatic:{...base.automatic!,cooldownDays:1.5}})).toThrow('malformed');
  const confirm=AGENT_ACTIONS.find(action=>action.id==='leave.cancel')! as unknown as AgentActionDefinition;
  expect(()=>defineAgentAction({...confirm,id:'leave.fabricated',automatic:base.automatic} as unknown as AgentActionDefinition)).toThrow('malformed');
  expect(()=>defineAgentAction({...confirm,id:'leave.fabricated',permission:{actor:'agent_principal',guard:confirm.permission.guard}} as unknown as AgentActionDefinition)).toThrow('malformed');
 });
});

describe('browser dispatch derived from the registry',()=>{
 it('routes each generic action packet to exactly the owner its registry entry names',async()=>{
  const owners=[...new Set(GENERIC_MODULE_ACTIONS.map(action=>getAgentAction(action).browserOwner))];
  expect(owners.length).toBe(GENERIC_MODULE_ACTIONS.length);
  for(const action of GENERIC_MODULE_ACTIONS){
   const reject=vi.fn(async()=>{throw Error('wrong owner');}),handlers:Record<string,{list:ReturnType<typeof vi.fn>}>={};
   for(const owner of owners)handlers[owner]={list:vi.fn(async()=>({kind:'unavailable'}))};
   const handle=createModuleActionBrowserHandler({authenticate:vi.fn(async()=>({actual:'fictional session'})),list:reject,prepare:reject,reopen:reject,confirm:reject,discard:reject,...handlers} as unknown as Parameters<typeof createModuleActionBrowserHandler>[0],{publicOrigin:'https://fixture.test'});
   await handle(new Request('https://fixture.test/api/assistant/module-actions',{method:'POST',headers:{Origin:'https://fixture.test','Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:JSON.stringify({action,operation:'list'})}));
   for(const owner of owners)expect(handlers[owner]!.list,`${action} -> ${owner}`).toHaveBeenCalledTimes(owner===getAgentAction(action).browserOwner?1:0);
   expect(reject).not.toHaveBeenCalled();
  }
 });
});
