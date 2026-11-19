/** One private email retry, then a handoff back to the genuine original sealed workflow owner. */
import {sql} from 'drizzle-orm';
import type {SqlExecutor} from '../db/sql-executor';
import {automationRunFromRow,sqlAutomationRunStore,advanceAutomationRun,resumeAutomationRun,MAX_RUN_LOG,type AutomationExecutors,type AutomationRun,type AutomationRunDeps} from '../packs/automation/service';
type NativeRun=Parameters<typeof automationRunFromRow>[0];
export type ContractEmailRecoveryStart={ready:boolean;completed:boolean;run?:NativeRun;pinId?:string;disposition?:'current'|'authority_changed'|'legacy_cursor_unknown'|'stopped'};
export async function beginContractEmailRecovery(tx:SqlExecutor,eventId:string):Promise<ContractEmailRecoveryStart>{
 const [row]=await tx.execute<{recovery:ContractEmailRecoveryStart}>(sql`select app.contract_shared_email_prerequisite_begin(${eventId}::uuid) as recovery`);
 return row.recovery;
}
export async function retryContractEmailRecovery(tx:SqlExecutor,eventId:string,start:ContractEmailRecoveryStart,sendEmail:AutomationExecutors['sendEmail'],read:AutomationRunDeps['read']){
 if(start.ready){
  if(!start.run||!sendEmail)throw Error('The native email retry is unavailable.');
  const original=automationRunFromRow(start.run),pending=original.remaining[0];
  if(pending?.step.type!=='sendEmail')throw Error('A recovery can retry only its pending Send email step.');
  const next:AutomationRun={...original,status:'running',waitingFor:null,cursor:pending.index+1,remaining:original.remaining.slice(1)};
  const outcome=await sendEmail({run:next,step:pending.step,index:pending.index,read});
  if(outcome.status==='done'){
   const at=new Date().toISOString();
   next.log=[...original.log,{at,kind:'stepDone' as const,step:pending.index+1,stepId:pending.step.id,type:'sendEmail',message:outcome.message??'Email delivery intent recorded.',...(outcome.recipients?{recipients:outcome.recipients}:{}),...(outcome.unresolved?.length?{unresolved:outcome.unresolved}:{})}].slice(-MAX_RUN_LOG);
   if(!next.remaining.length){next.status='done';next.log=[...next.log,{at,kind:'done' as const,step:null,stepId:null,type:null,message:'Finished.'}].slice(-MAX_RUN_LOG);}
   else if(start.disposition==='authority_changed'||start.disposition==='legacy_cursor_unknown'){
    next.status='failed';next.failure=start.disposition==='legacy_cursor_unknown'?'Original workflow progress needs reconciliation; remaining steps stopped.':'Original workflow authority changed; remaining steps stopped.';
    next.log=[...next.log,{at,kind:'failed' as const,step:null,stepId:null,type:null,message:next.failure}].slice(-MAX_RUN_LOG);
   }
   // A native trigger verifies the actual queued OneHR intent and permits exactly this one-step suffix.
   await sqlAutomationRunStore(tx).save(next,'waiting');
  }else if(outcome.status==='hold')throw Error(outcome.message);
  else if(outcome.status!=='wait')throw Error(outcome.reason);
 }
 await tx.execute(sql`select app.contract_shared_email_prerequisite_finish(${eventId}::uuid)`);
}
export async function continueContractEmailRecovery(tx:SqlExecutor,eventId:string,depsForRun:(run:AutomationRun)=>Promise<AutomationRunDeps>):Promise<'none'|'more'|'waiting'>{
 const [row]=await tx.execute<{continuation:{waiting:boolean;observed?:boolean;receiptId?:string;run?:NativeRun}}>(sql`select app.contract_shared_email_prerequisite_continuation(${eventId}::uuid) as continuation`);
 if(row.continuation.observed)return 'more';
 if(row.continuation.run&&row.continuation.receiptId){
  const original=automationRunFromRow(row.continuation.run);
  const next=await advanceAutomationRun(original,await depsForRun(original));
  await sqlAutomationRunStore(tx).save(next,'running');
  await tx.execute(sql`select app.contract_shared_email_prerequisite_continued(${row.continuation.receiptId}::uuid)`);
  return 'more';
 }
 return row.continuation.waiting?'waiting':'none';
}
/** No fabricated completion actor: only the original still-authorized owner may observe its own PM/account hold. */
export async function recheckOriginalContractEmail(tx:SqlExecutor,eventId:string,after:string|null,depsForRun:(run:AutomationRun)=>Promise<AutomationRunDeps>):Promise<{progressed:boolean;after:string|null}>{
 const [row]=await tx.execute<{value:{selected:boolean;ready:boolean;pinId?:string;run?:NativeRun}}>(sql`select app.contract_shared_email_original_recheck(${eventId}::uuid,${after}::uuid) as value`);
 if(!row.value.selected)return {progressed:false,after:null};
 if(!row.value.pinId)throw Error('The original email prerequisite selection is unavailable.');
 if(!row.value.ready)return {progressed:false,after:row.value.pinId};
 if(!row.value.run)throw Error('The original pending email run is unavailable.');
 const original=automationRunFromRow(row.value.run);
 const next=await resumeAutomationRun(original,row.value.pinId,await depsForRun(original));
 await sqlAutomationRunStore(tx).save(next,'waiting');
 return {progressed:true,after:row.value.pinId};
}

/** Technical hold/closure only. It never supplies business executors after original authority changes. */
export async function observeHistoricalContractEmail(tx:SqlExecutor,eventId:string):Promise<{handled:boolean;waiting?:boolean;reconciliationNeeded?:boolean;reason?:'authority_changed'|'legacy_cursor_unknown'}>{
 const [row]=await tx.execute<{value:{handled:boolean;waiting?:boolean;reconciliationNeeded?:boolean;reason?:'authority_changed'|'legacy_cursor_unknown'}}>(sql`select app.contract_shared_email_recovery_original(${eventId}::uuid) as value`);
 return row.value;
}
