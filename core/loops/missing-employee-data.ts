/** AI v2 W8 loop 3 — missing employee data.
 *
 * Detect: the record readiness owner's gaps (core/record-readiness.ts readinessSnapshot, the one definition of what is
 * missing) for active employments the sponsor administers, in the companies in scope.
 * Diagnose: which gaps the employee may fill in through the existing profile-change request flow, and which already
 * wait for HR's approval (core/readiness-actions.ts loadReadinessActions, the same catalogue as the readiness queue).
 * Prepare: a self-service request card for the employee listing what to fill in, opening their own profile request
 * section. HR approves the request as usual; gaps only HR can fill stay in the HR readiness queue.
 * Verify: waiting while the employee's request waits for HR; done when no gap the employee could fill remains on a
 * positively observed active record; inactive when the employment ended. A gap that comes back reopens the case. */
import {inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {employment} from '../../db/schema';
import {readinessSnapshot,type ReadinessGapId} from '../record-readiness';
import {loadReadinessActions} from '../readiness-actions';
import {read,unique,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';

export const MISSING_DATA_LOOP_VERSION='loop_missing_employee_data@v1';
export const recordKey=(employmentId:string)=>`record:${employmentId}`;

export async function detectMissingEmployeeData(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const scope=new Set(input.companyIds),tracked=new Map(input.tracked.map(item=>[item.subjectKey,item]));
 return withTenant(sponsor,async tx=>{
  const {view,activeEmploymentIds}=await readinessSnapshot(tx,Number.POSITIVE_INFINITY,true);
  const trackedIds=input.tracked.flatMap(item=>item.employmentId?[item.employmentId]:[]);
  const ids=unique([...activeEmploymentIds,...trackedIds]);
  const rows:{id:string;companyId:string;terminatedOn:string|null}[]=[];
  for(let offset=0;offset<ids.length;offset+=500)
   rows.push(...await tx.select({id:employment.id,companyId:employment.companyId,terminatedOn:employment.terminatedOn}).from(employment).where(inArray(employment.id,ids.slice(offset,offset+500))));
  const companyOf=new Map(rows.map(row=>[row.id,row.companyId])),ended=new Set(rows.filter(row=>row.terminatedOn!=null).map(row=>row.id));
  const active=new Set(activeEmploymentIds);
  const inScope=[...active].filter(id=>scope.has(companyOf.get(id)??'')),inScopeSet=new Set(inScope);
  const actions=await loadReadinessActions(tx,sponsor,unique([...inScope,...trackedIds.filter(id=>active.has(id))]));
  const gapsOf=new Map<string,ReadinessGapId[]>();
  for(const gap of view.gaps)for(const person of gap.people){const list=gapsOf.get(person.employmentId)??[];list.push(gap.id);gapsOf.set(person.employmentId,list);}
  const observations:LoopObservation[]=[];
  const observe=(employmentId:string)=>{
   const key=recordKey(employmentId),known=tracked.get(key),companyId=known?.companyId??companyOf.get(employmentId);
   if(!companyId)return;
   const base={subjectKey:key,companyId,employmentId,recipient:'employee' as const};
   if(!active.has(employmentId)){
    if(known&&ended.has(employmentId))observations.push({...base,state:'closed',closeReason:'inactive',facts:known.facts});
    return;
   }
   const gaps=gapsOf.get(employmentId)??[];
   const fill=gaps.filter(gap=>actions.get(`${employmentId}:${gap}`)?.type==='submit_correction');
   const pending=gaps.filter(gap=>actions.get(`${employmentId}:${gap}`)?.type==='review_submission');
   if(fill.length){
    const tabs=unique(fill.map(gap=>actions.get(`${employmentId}:${gap}`)!.tab));
    observations.push({...base,state:'open',facts:{gaps:fill,tabs,pending:pending.length}});
   }else if(pending.length){
    if(known)observations.push({...base,state:'waiting',facts:{gaps:pending,tabs:[],pending:pending.length}});
   }else if(known){
    observations.push({...base,state:'closed',closeReason:'done',resolution:'completed',facts:{gaps:[],tabs:[],pending:0}});
   }
  };
  for(const id of inScope)observe(id);
  for(const id of trackedIds)if(!inScopeSet.has(id))observe(id);
  return {observations,reads:[read('record_readiness.snapshot','core/record-readiness.ts#readinessSnapshot'),
   read('record_readiness.actions','core/readiness-actions.ts#loadReadinessActions')]};
 });
}
