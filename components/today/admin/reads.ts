/** HR administrator and manager Today (owner decision, 11 Nov 2026; AdminToday.dc.html, ManagerToday.dc.html): every
 * fact the two pages show, read from its existing owner as the viewer.
 *
 * Nothing here writes, decides or computes a business figure. Each owner runs under the viewer's session and row-level
 * security; the set-based administrator reads (core/today-admin-reads.ts) also refuse anyone but an administrator and
 * take the shared Access lock first. A source that fails is left out and its panel says one sentence about it.
 *
 * ONE READ PER FACT PER RENDER. Each reader is memoised for the render (React cache), so a fact two panels show (Needs
 * you's ranked list in the heading and in its panel; the payroll cut-off in Needs you and in Payroll readiness; the
 * exceptions count in Needs you and in Watching) is read once. The composed reads fan out to several owners and so run
 * under withBackgroundReadWork (docs/architecture/FUTURE-BUILD-CONTRACT.md); each joins the render's shared read-only
 * snapshot (lib/request-read-scope.ts). The company scope is passed as one key string so the memo can match it. */
import {cache} from 'react';
import {withBackgroundReadWork,withSharedReadSnapshot,type SessionContext} from '@/db/client';
import {requestReadScope} from '@/lib/request-read-scope';
import {EntitlementsResolutionFailedError,isModuleEnabled} from '@/core/entitlements';
import {pendingTaskSummary} from '@/core/approvals-inbox';
import {summariseOutcomeRecords,type OutcomeSummary} from '@/core/outcome-record/summary';
import {readAdminExceptionCounts,readAdminLoopHandled,readAdminPayrollReadiness,readAdminStatutoryDeadlines,type LoopHandled,type PayrollReadiness,type StatutoryDeadlines} from '@/core/today-admin-reads';
import {todayAudience,windowStart} from '@/lib/today/audience';
import {managerQueue,rankedNeeds,type ManagerQueue,type RankedNeeds} from '@/lib/today/admin';
import {readNeedsYou,type NeedsYouData} from '../reads';

const shared=<T,>(s:SessionContext,read:()=>Promise<T>)=>withSharedReadSnapshot(s,read,undefined,requestReadScope());
type Settled<T>={ok:true;value:T}|{ok:false};
const settle=async<T,>(read:()=>Promise<T>):Promise<Settled<T>>=>{try{return {ok:true,value:await read()};}catch{return {ok:false};}};
/** The company scope as the memo key the readers share (the switcher's selection, in its own order). */
export const scopeKey=(scopeIds:readonly string[])=>scopeIds.join(',');
const scopeOf=(key:string)=>key?key.split(','):[];

/** Payroll in use: for the tenant (a module check with no company), or for one company. An entitlement snapshot that
 * cannot be resolved is `failed`, never "not in use" (test/module-catalog-drift.test.ts). */
export type ModuleState='on'|'off'|'failed';
export function payrollState(s:SessionContext,companyId?:string):ModuleState{
 try{return isModuleEnabled(s,'payroll',companyId)?'on':'off';}catch(error){if(error instanceof EntitlementsResolutionFailedError)return 'failed';throw error;}
}

/** Needs you's own sources (the approvals queue, prepared reviews, findings and the loops' cards), as the earlier Today
 * read them, for the viewer's audience. */
export const readNeeds=cache((s:SessionContext,key:string,today:string,locale:string):Promise<NeedsYouData>=>
 readNeedsYou(s,{scopeIds:scopeOf(key),audience:todayAudience(s),today,locale}));

/** Payroll readiness for the companies in view (core/today-admin-reads.ts). */
export const readReadiness=cache((s:SessionContext,key:string,today:string):Promise<PayrollReadiness>=>
 shared(s,()=>readAdminPayrollReadiness(s,{scopeIds:scopeOf(key),today,payrollOn:companyId=>payrollState(s,companyId)==='on'})));

/** Open payroll exceptions on the runs of the companies in view, and how many block a run: Operations › Exceptions'
 * own filters, counted in one statement (core/today-admin-reads.ts readAdminExceptionCounts). */
export const readExceptions=cache((s:SessionContext,key:string)=>shared(s,()=>readAdminExceptionCounts(s,{scopeIds:scopeOf(key)})));

/** The optional modules the approvals queue reads, with the throwing check: an unresolved snapshot reads a module as
 * off and reports the read as failed, never as "not in use". */
function queueModules(s:SessionContext){
 let failed=false;
 const on=(code:string)=>{try{return isModuleEnabled(s,code);}catch(error){if(error instanceof EntitlementsResolutionFailedError){failed=true;return false;}throw error;}};
 return {modules:{attendance:on('attendance'),claims:on('claims'),performance:on('performance'),rewards:on('rewards')},failed:()=>failed};
}
/** The manager's decisions: the approvals queue for the companies in view, WITHOUT notice acknowledgements (those are
 * the person's own, not decisions), split into what /approvals lists (counted, linked there) and the other work each
 * owner lists on its own page (lib/today/admin.ts managerQueue). */
export const readManagerQueue=cache((s:SessionContext,key:string):Promise<ManagerQueue&Readonly<{failed:boolean}>>=>shared(s,async()=>{
 const {modules,failed}=queueModules(s);
 const summary=await pendingTaskSummary(s,scopeOf(key),modules,{noticeAcknowledgements:false});
 return Object.freeze({...managerQueue(summary),failed:failed()});
}));

export type AdminNeeds=Readonly<{ranked:RankedNeeds;failed:boolean}>;
/** The administrator's one ranked Needs you list. Every source is read once for the render; one that fails is left out
 * and the list says so. Its total is the list's own length (lib/today/admin.ts rankedNeeds). */
export const readAdminNeeds=cache((s:SessionContext,key:string,today:string,locale:string):Promise<AdminNeeds>=>
 withBackgroundReadWork(s.tenantId,async()=>{
  const payroll=payrollState(s);
  const [needs,readiness,statutory,exceptions]=await Promise.all([
   settle(()=>readNeeds(s,key,today,locale)),
   payroll==='on'?settle(()=>readReadiness(s,key,today)):null,
   payroll==='on'?settle(()=>shared(s,()=>readAdminStatutoryDeadlines(s,{scopeIds:scopeOf(key),today}))):null,
   payroll==='on'?settle(()=>readExceptions(s,key)):null,
  ]);
  const data=needs.ok?needs.value:null;
  const ranked=rankedNeeds({today,
   nextCutOff:readiness?.ok?readiness.value.nextCutOff:null,
   statutory:statutory?.ok?statutory.value:null,
   exceptions:exceptions?.ok?{blocking:exceptions.value.blocking}:null,
   tasks:data?.tasks??[],claimTotal:data?.claimTotal??null,
   prepared:data?.prepared??[],findings:data?.findings??[],
   loops:data?.loops??[],
  });
  const failed=payroll==='failed'||!needs.ok||(data?.failed??false)||[readiness,statutory,exceptions].some(result=>result!==null&&!result.ok);
  return Object.freeze({ranked,failed});
 }));

export type Handled=Readonly<{summary:OutcomeSummary|null;loops:readonly LoopHandled[]|null}>;
/** What AI Centre did over the last 7 HR days, from its own records only: the outcome records' counts (questions
 * answered, leave requests checked, delegated items prepared) and the loops' case ledger (cases found, cases resolved). */
export const readHandled=cache((s:SessionContext,key:string,today:string):Promise<Handled>=>
 withBackgroundReadWork(s.tenantId,async()=>{
  const since=windowStart(today),scopeIds=scopeOf(key);
  const [summary,loops]=await Promise.all([
   settle(()=>shared(s,()=>summariseOutcomeRecords(s,{since,companyIds:scopeIds}))),
   settle(()=>shared(s,()=>readAdminLoopHandled(s,{scopeIds,since}))),
  ]);
  return Object.freeze({summary:summary.ok?summary.value:null,loops:loops.ok?loops.value:null});
 }));

export type {PayrollReadiness,StatutoryDeadlines};
