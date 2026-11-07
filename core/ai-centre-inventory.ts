import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {isGroupAdmin} from '../lib/authz-model';
import {AI_FEATURES} from '../lib/ai/features';
import {aiInventoryComponents} from '../lib/ai/ai-inventory';
import {registeredWorkers} from './agent-registry/workers';
import {SEMANTIC_READS} from './semantic-model/entities';
import {TERAS_READS} from './semantic-model/generate';
import {ASSISTANT_TOOL_CATALOGUE} from '../lib/ai/assistant-tool-catalogue';
import {WORK_JOB_TYPES} from './mandates/job-types';
import {MODULE_JOBS} from '../lib/ai/module-jobs';

export type AiCentreFunction=Readonly<{key:string;name:string;kind:string;control:'existing'|'read'|'required'|'platform';href:string}>;
/** Additional restrictions only for reads/tools that previously shared one parent switch. */
export function aiCentreReadKeys():readonly string[]{
 return Object.freeze([...new Set([
  ...[...SEMANTIC_READS,...TERAS_READS].map(row=>'read:'+row.name),
  ...ASSISTANT_TOOL_CATALOGUE.map(row=>'read:'+row.name),
  ...MODULE_JOBS.map(([module])=>'module:'+module),
  'read:suggest_action','read:prepare_import','read:product_guidance','read:product_capabilities',
 ])].sort());
}
export function aiCentreFunctions():readonly AiCentreFunction[]{
 const workers=registeredWorkers(),components=aiInventoryComponents();
 const rows:AiCentreFunction[]=[
  ...AI_FEATURES.map(f=>({key:'feature:'+f.id,name:f.id,kind:'feature',control:f.kind==='platform'?'platform' as const:'existing' as const,href:'/control-tower/agents/features#ai-feature-'+f.id})),
  ...workers.map(w=>({key:'worker:'+w.id,name:w.label,kind:w.family,control:'existing' as const,href:w.switch.kind==='job_type'?'/control-tower/agents/features#ai-centre-jobs':'/control-tower/agents/features#worker-'+w.id})),
  ...components.filter(row=>row.kind==='action').map(row=>({key:row.key,name:row.id,kind:row.kind,control:'existing' as const,href:'/control-tower/agents/features#ai-component-action-'+row.id.replace(/[^a-z0-9_-]/gi,'-')})),
  ...aiCentreReadKeys().map(key=>({key,name:key.slice(key.indexOf(':')+1),kind:key.startsWith('module:')?'module reads':'AI read or preparation',control:'read' as const,href:'#ai-centre-functions'})),
  {key:'learning:payroll',name:'Payroll history learning',kind:'learning',control:'existing',href:'/control-tower/loops/payroll-cycle/settings'},
  ...components.filter(row=>row.kind==='scheduled_job').map(row=>({key:row.key,name:row.id,kind:'scheduler',control:'required' as const,href:'/admin/scheduled-actions'})),
  ...['policies','capacity','quality','privacy','audit','validation'].map(id=>({key:'system:'+id,name:id,kind:'required service',control:'required' as const,href:id==='policies'?'/policies':id==='privacy'?'/assistant?view=privacy':'/assistant?view=insights'})),
 ];
 if(new Set(rows.map(row=>row.key)).size!==rows.length)throw Error('Duplicate AI centre function.');
 return Object.freeze(rows.map(row=>Object.freeze(row)));
}
export const aiCentreJobTypes=()=>Object.keys(WORK_JOB_TYPES);
export async function aiCentreReadControls(ctx:SessionContext):Promise<ReadonlyMap<string,boolean>>{
 return withTenant(ctx,async tx=>{
  const rows=await tx.execute<{function_key:string;enabled:boolean}>(sql`select function_key,enabled from app.ai_centre_read_controls()`);
  return new Map(rows.map(row=>[row.function_key,row.enabled]));
 });
}
export async function setAiCentreReadControl(ctx:SessionContext,key:unknown,enabled:unknown){
 if(!ctx.userId||ctx.agent||!isGroupAdmin(ctx))throw Error('Only a group administrator may change AI functions.');
 if(typeof key!=='string'||!aiCentreReadKeys().includes(key)||typeof enabled!=='boolean')throw Error('Unknown AI function.');
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.ai_centre_read_set(${key},${enabled})`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-centre-function',aggregateId:ctx.tenantId,
   eventType:'ai-centre.function-changed',actor:actorOf(ctx),payload:{key,enabled}});
 });
}
