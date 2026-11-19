/** Bounded, original-employer history readers. Current Personnel is never exposed as a directory. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertModuleGate} from './module-gate';
import {withAccessDisplayRead,lockAccessConfigurationReadTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {personnelFormulaPermissionsTx} from './pay-formula-personnel-permissions';
import {historyMaintenanceStatesTx} from './payroll-history-maintenance-state';
import {resolveImportActors,actorOn} from './import-actor-label';
import {effectiveHistoryItems} from '../lib/payroll-history-maintenance-lineage';
import type {HistoryContributionState} from '../lib/payroll-history-maintenance-lineage';
import {PayrollHistoryRevisionError,type ImportedPayrollValues} from '../lib/payroll-history-revisions';
import type {ImportActor} from '../lib/import-reference';
import type {PayrollHistoryMaintenanceQuery,PayrollHistoryMaintenancePage,PayrollHistoryMaintenanceRecord,PayrollHistoryMaintenanceDetail,PayrollHistoryMaintenanceAudit,PayrollHistoryMaintenanceImpact} from '../lib/payroll-history-maintenance';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function fail(message:string):never{throw new PayrollHistoryRevisionError(message);}
type RawRecord=Omit<PayrollHistoryMaintenanceRecord,'itemCount'|'values'|'items'|'impact'>&{impactCounts:Record<PayrollHistoryMaintenanceImpact['kind'],number>};
type RawPage={items:RawRecord[];total:number;offset:number;limit:number};
type State={state:HistoryContributionState;values:ImportedPayrollValues|null;unavailableReason?:string};
type RawAudit=Omit<PayrollHistoryMaintenanceAudit,'actor'>&{actorId:string|null};
function validate(query:PayrollHistoryMaintenanceQuery){
 if(!query||query.companyId!==undefined&&!uuid.test(query.companyId)||query.period!==undefined&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(query.period)||query.search!==undefined&&(typeof query.search!=='string'||query.search.length>200)||query.offset!==undefined&&(!Number.isSafeInteger(query.offset)||query.offset<0)||query.limit!==undefined&&(!Number.isInteger(query.limit)||query.limit<1||query.limit>100)||query.includeWithdrawn!==undefined&&typeof query.includeWithdrawn!=='boolean')fail('Choose a valid imported history scope and a page of at most 100 records.');
}
async function read<T>(ctx:SessionContext,fn:(tx:Tx)=>Promise<T>){
 assertModuleGate(ctx,'payroll');if(!ctx.userId)fail('Sign in to read payroll history.');
 return withAccessDisplayRead(()=>withTenant(ctx,async tx=>{
  // Same History -> Access order as the writer; both locks are shared for these readers.
  await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  // The public history view always reads released revisions, even if a caller forges a stage GUC.
  await tx.execute(sql`select set_config('app.payroll_history_stage','',true)`);
  const [actor]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!actor.ok)fail('Your payroll authority changed. Sign in again.');return fn(tx);
 },{readOnlySnapshot:true}));
}
async function pageTx(tx:Tx,q:PayrollHistoryMaintenanceQuery,recordId:string|null=null){const [row]=await tx.execute<{result:RawPage}>(sql`select app.payroll_history_maintenance_page(${q.companyId??null}::uuid,${q.period??null}::text,${q.search??null}::text,${q.offset??0},${q.limit??25},${q.includeWithdrawn??false},${recordId}::uuid) result`);return row.result;}
const impactMessages:Record<PayrollHistoryMaintenanceImpact['kind'],string>={
 payroll:'Existing payroll runs in this assessment year remain unchanged. Review their history inputs separately.',
 report:'Recorded statutory reports remain unchanged. Review any affected report separately.',
 payment:'Recorded payment-summary exports remain unchanged. This is not evidence of bank settlement.',
 issued:'Released payroll results remain unchanged. Issued copies are not regenerated or resent.',
 review:'Eligible payroll work already marked for source review must be reviewed before further processing.',
};
function impacts(row:RawRecord,unavailableReason?:string):PayrollHistoryMaintenanceImpact[]{return [...Object.entries(row.impactCounts).filter(([,count])=>count>0).map(([kind,count])=>({kind:kind as PayrollHistoryMaintenanceImpact['kind'],count,message:impactMessages[kind as PayrollHistoryMaintenanceImpact['kind']]})),...(unavailableReason?[{kind:'review' as const,message:unavailableReason}]:[])];}
function imported(state:HistoryContributionState){return Object.values(state.chains).some(chain=>!!chain[0]?.item&&chain[0].attemptId!==null);}
async function projectTx(tx:Tx,ctx:SessionContext,rows:RawRecord[],detail=false):Promise<PayrollHistoryMaintenanceRecord[]>{
 if(!rows.length)return[];
 const permissions=await personnelFormulaPermissionsTx(tx,ctx,[...new Set(rows.map(r=>r.companyId))],['payroll.history.import','payroll.history.revert']);
 const states:Map<string,State>=await historyMaintenanceStatesTx(tx,ctx,rows.map(row=>row.id));
 const sourceIds=detail?[...new Set([...states.values()].flatMap(({state,unavailableReason})=>unavailableReason?[]:Object.values(state.chains).flatMap(chain=>chain[0]?.item&&chain[0].attemptId?[chain[0].attemptId]:[])))]:[];
 if(sourceIds.some(id=>!uuid.test(id)))fail('The retained history source identity is unavailable.');
 // Attempt RLS still requires its complete company scope. A selected record never grants its source file.
 const sourceNames=sourceIds.length?await tx.execute<{id:string;name:string}>(sql`select id,source_name as name from payroll_history_import_attempt where id=any(ARRAY[${sql.join(sourceIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`):[];
 const names=new Map(sourceNames.map(row=>[row.id,row.name]));
 return rows.map(row=>{
  const state=states.get(row.id);if(!state)fail('The selected history changed. Refresh the history list.');
  const held=state.unavailableReason,items=held?[]:effectiveHistoryItems(state.state),withdrawn=held?state.values===null:!imported(state.state);
  const {impactCounts:_,...metadata}=row;
  return{...metadata,withdrawn,unavailableReason:held??null,itemCount:items.length,canEdit:row.canEdit&&permissions.get('payroll.history.import')!.has(row.companyId)&&!held&&!withdrawn,canRemove:row.canRemove&&permissions.get('payroll.history.revert')!.has(row.companyId)&&!held&&!withdrawn,values:state.values,items:detail?items.map(item=>{
   const chain=state.state.chains[item.key],source=chain[0]?.attemptId??null;
   return{key:item.key,code:item.code,label:item.label,originalCodes:item.originalCodes,amount:item.amount,direction:item.direction,sourceAttemptId:source,sourceName:source?names.get(source)??null:null,sourceRows:item.sourceRows,laterCorrection:chain.length>1&&source!==null};
  }):[],impact:impacts(row,held)};
 });
}
/** SQL applies authorization, filters, stable ordering, count and page before state reconstruction. */
export async function payrollHistoryMaintenanceRecords(ctx:SessionContext,query:PayrollHistoryMaintenanceQuery={}):Promise<PayrollHistoryMaintenancePage>{
 validate(query);return read(ctx,async tx=>{const page=await pageTx(tx,query);return{...page,items:await projectTx(tx,ctx,page.items)};});
}
function actorLabel(actor:ImportActor){return actor.kind==='person'?actor.employeeCode?`${actor.name} (${actor.employeeCode})`:actor.name:actor.kind==='unlinked'?`Account …${actor.loginSuffix}`:'Unavailable user';}
export async function payrollHistoryMaintenanceRecord(ctx:SessionContext,id:string):Promise<PayrollHistoryMaintenanceDetail|null>{
 if(!uuid.test(id))return null;
 return read(ctx,async tx=>{
  const page=await pageTx(tx,{limit:1,includeWithdrawn:true},id);if(!page.items.length)return null;
  const [record]=await projectTx(tx,ctx,page.items,true);
  const [row]=await tx.execute<{result:{items:RawAudit[];total:number}}>(sql`select app.payroll_history_maintenance_audit(${id}::uuid,100) result`);
  const actors=await resolveImportActors(tx,'payroll_history',[...new Set(row.result.items.map(r=>r.attemptId))]);
  return{...record,auditTotal:row.result.total,audit:row.result.items.map(({actorId,...revision})=>({...revision,actor:actorLabel(actorOn(actors,revision.attemptId,actorId))}))};
 });
}
