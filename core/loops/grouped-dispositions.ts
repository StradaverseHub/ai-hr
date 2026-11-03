/** AI v2 Phase 2 hardening (4 November 2026) — grouped dispositions and pre-filled resolves on the Salary payroll page.
 *
 * GROUPED. Payroll HR disposes of every open net-swing flag of one company, month and pattern (what moved the pay most:
 * a pay item, or a cause such as a pay rise or overtime) in one tap, having seen the evidence: each person, their swing
 * as a ratio, its direction and its causes (`swingFlagGroups`, pure). The tap is still a person's decision, recorded per
 * flag through the owner of dispositions (core/loops/salary-swing-service.ts recordSwingDisposition: attributed to them,
 * audited, refused to anyone who may not dispose of that flag); nothing is decided for them.
 * ONE ITEM, NOT TWO. The payroll anomaly layer's own `net-swing` detector looks at the same change as the loop's flag. When
 * a group is disposed of as expected, each person's anomaly verdict whose only open findings are `net-swing` is resolved
 * as accepted in the same tap, through the anomaly owner (core/payroll-anomaly.ts resolveAnomalyVerdict), so HR decides
 * the swing once. A verdict with any other finding is left for its own review. "A real problem" resolves nothing: the
 * exception stays open until it is fixed upstream.
 * PRE-FILLED. A blocking exception covered by a standing acknowledgement (core/loops/acknowledgements.ts) is never
 * suppressed: the page lists it with a one-tap resolve already filled in with the acknowledgement's reason, and a person
 * presses it (`resolveAcknowledgedBlock`, re-checked against the acknowledgements in force when pressed).
 * No figure is computed; no model is called. */
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {payrollAnomalyFinding,payrollAnomalyVerdict,payrollBatch} from '../../db/schema';
import {terasLoopCase} from '../../db/teras-schema';
import {canManagePayroll} from '../../lib/authz-model';
import {resolveAnomalyVerdict} from '../payroll-anomaly';
import {acknowledgementFor,acknowledgementsTx,currentDepartmentsTx,isBlockCheck} from './acknowledgements';
import {isSwingPattern} from './net-swing';
import {PayrollLoopRefused} from './payroll-loop-settings';
import {recordSwingDisposition} from './salary-swing-service';
import type {PayCauseKind} from '../pay-difference';

export type SwingFlagGroupMember=Readonly<{caseId:string;personName:string|null;swingBp:number;direction:'up'|'down'|null;causes:readonly PayCauseKind[]}>;
export type SwingFlagGroup=Readonly<{companyId:string;companyName:string|null;payPeriod:string;pattern:string;members:readonly SwingFlagGroupMember[]}>;

/** PURE. The open, undisposed flags grouped by company, month and pattern, largest group first, the biggest swing first
 * within it. A group of one is still a group (the same one-tap). */
export function swingFlagGroups(flags:readonly Readonly<{caseId:string;companyId:string;companyName:string|null;personName:string|null;payPeriod:string;
 pattern:string;swingBp:number;direction:'up'|'down'|null;causes:readonly PayCauseKind[];state:'open'|'closed';disposition:unknown}>[]):readonly SwingFlagGroup[]{
 const groups=new Map<string,{companyId:string;companyName:string|null;payPeriod:string;pattern:string;members:SwingFlagGroupMember[]}>();
 for(const flag of flags){
  if(flag.state!=='open'||flag.disposition)continue;
  const key=`${flag.companyId}|${flag.payPeriod}|${flag.pattern}`;
  const group=groups.get(key)??{companyId:flag.companyId,companyName:flag.companyName,payPeriod:flag.payPeriod,pattern:flag.pattern,members:[]};
  group.members.push(Object.freeze({caseId:flag.caseId,personName:flag.personName,swingBp:flag.swingBp,direction:flag.direction,causes:flag.causes}));
  groups.set(key,group);
 }
 return Object.freeze([...groups.values()].map(group=>Object.freeze({...group,members:Object.freeze([...group.members].sort((a,b)=>b.swingBp-a.swingBp))}))
  .sort((a,b)=>b.members.length-a.members.length||a.pattern.localeCompare(b.pattern)));
}

export type GroupDispositionResult=Readonly<{disposed:number;skipped:number;verdictsResolved:number}>;

/** Disposes of every open flag of one company, month and pattern, as the caller, flag by flag through the dispositions'
 * owner; for "expected", also resolves each person's net-swing-only anomaly verdict of that month as accepted. */
export async function disposeSwingGroup(supplied:SessionContext,input:Readonly<{companyId:unknown;payPeriod:unknown;pattern:unknown;disposition:unknown}>):Promise<GroupDispositionResult>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx))throw new PayrollLoopRefused('not_administrator');
 const {companyId,payPeriod,pattern,disposition}=input;
 if(typeof companyId!=='string'||!/^[0-9a-f-]{36}$/i.test(companyId)||typeof payPeriod!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(payPeriod)
  ||!isSwingPattern(pattern)||(disposition!=='expected'&&disposition!=='problem'))throw new PayrollLoopRefused('invalid');
 // The open flags of the group, as the caller may read them.
 const cases=await withTenant(ctx,tx=>tx.select({id:terasLoopCase.id,employmentId:terasLoopCase.employmentId}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.tenantId,ctx.tenantId),eq(terasLoopCase.workerId,'loop_salary_payroll'),eq(terasLoopCase.companyId,companyId),
   eq(terasLoopCase.state,'open'),sql`${terasLoopCase.subjectKey} like 'swing:%'`,sql`${terasLoopCase.facts}->>'payPeriod'=${payPeriod}`,
   sql`${terasLoopCase.facts}->>'pattern'=${pattern}`)));
 if(!cases.length)throw new PayrollLoopRefused('changed');
 let disposed=0,skipped=0,verdictsResolved=0;
 const done:string[]=[];
 for(const item of cases){
  try{await recordSwingDisposition(ctx,{caseId:item.id,disposition});disposed++;if(item.employmentId)done.push(item.employmentId);}
  catch(error){if(error instanceof PayrollLoopRefused&&(error.reason==='already'||error.reason==='not_found'))skipped++;else throw error;}
 }
 if(disposition==='expected'&&done.length){
  // The anomaly layer's own net-swing finding for the same people and month: one decision, not two.
  const verdicts=await withTenant(ctx,tx=>tx.select({id:payrollAnomalyVerdict.id,detectors:sql<string[]>`array_agg(distinct ${payrollAnomalyFinding.detectorId})`})
   .from(payrollAnomalyVerdict).innerJoin(payrollBatch,eq(payrollBatch.id,payrollAnomalyVerdict.batchId))
   .innerJoin(payrollAnomalyFinding,eq(payrollAnomalyFinding.verdictId,payrollAnomalyVerdict.id))
   .where(and(eq(payrollBatch.companyId,companyId),eq(payrollBatch.payPeriod,payPeriod),inArray(payrollAnomalyVerdict.employmentId,done),
    isNull(payrollAnomalyVerdict.supersededAt),isNull(payrollAnomalyVerdict.resolvedAt)))
   .groupBy(payrollAnomalyVerdict.id));
  for(const verdict of verdicts){
   if(!(verdict.detectors??[]).every(id=>id==='net-swing'))continue;
   await resolveAnomalyVerdict(ctx,{verdictId:verdict.id,resolution:'accepted',note:'Expected: the net-swing flag was disposed of as expected on the Salary payroll loop.'});
   verdictsResolved++;
  }
 }
 return Object.freeze({disposed,skipped,verdictsResolved});
}

export type AcknowledgedBlock=Readonly<{verdictId:string;batchId:string;companyId:string;employmentId:string;personName:string|null;detectors:readonly string[];
 acknowledgementId:string;reason:string}>;

/** The open blocking exceptions of some companies' runs of one month that standing acknowledgements cover (every open
 * finding of the verdict acknowledged for that person), each with the reason its one-tap resolve is pre-filled with. */
export async function acknowledgedBlocks(supplied:SessionContext,input:Readonly<{companyIds:readonly string[];payPeriod:string}>):Promise<readonly AcknowledgedBlock[]>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 if(!ctx.userId||ctx.agent||!canManagePayroll(ctx)||!input.companyIds.length)return [];
 return withTenant(ctx,async tx=>{
  const list=await acknowledgementsTx(tx,ctx.tenantId,input.companyIds);
  if(!list.some(item=>isBlockCheck(item.checkId)))return [];
  const rows=Array.from(await tx.execute(sql`select v.id,v.batch_id,b.company_id,v.employment_id,p.full_name,array_agg(distinct f.detector_id) as detectors,
    bool_or(f.severity='block') as blocks from public.payroll_anomaly_verdict v join public.payroll_batch b on b.id=v.batch_id
    join public.payroll_anomaly_finding f on f.verdict_id=v.id left join public.employment e on e.id=v.employment_id left join public.person p on p.id=e.person_id
    where b.company_id in (${sql.join(input.companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) and b.pay_period=${input.payPeriod}
     and v.superseded_at is null and v.resolved_at is null and v.disposition='block'
    group by v.id,v.batch_id,b.company_id,v.employment_id,p.full_name order by p.full_name nulls last,v.id`) as unknown as
   {id:string;batch_id:string;company_id:string;employment_id:string;full_name:string|null;detectors:string[];blocks:boolean}[]);
  const departments=await currentDepartmentsTx(tx,rows.map(row=>row.employment_id));
  const out:AcknowledgedBlock[]=[];
  for(const row of rows){
   const acks=row.detectors.map(id=>acknowledgementFor(list,{companyId:row.company_id,checkId:`anomaly:${id}`,employmentId:row.employment_id,
    departmentId:departments.get(row.employment_id)??null}));
   if(!acks.every(Boolean))continue;
   const first=acks[0]!;
   out.push(Object.freeze({verdictId:row.id,batchId:row.batch_id,companyId:row.company_id,employmentId:row.employment_id,personName:row.full_name,
    detectors:Object.freeze([...row.detectors].sort()),acknowledgementId:first.id,reason:first.reason}));
  }
  return Object.freeze(out);
 });
}

/** A person presses the pre-filled resolve of one acknowledged blocking exception: re-checked against the acknowledgements
 * in force now, then resolved as accepted through the anomaly owner with the acknowledgement's reason. */
export async function resolveAcknowledgedBlock(supplied:SessionContext,input:Readonly<{verdictId:unknown;companyId:unknown;payPeriod:unknown}>){
 const {verdictId,companyId,payPeriod}=input;
 if(typeof verdictId!=='string'||typeof companyId!=='string'||typeof payPeriod!=='string')throw new PayrollLoopRefused('invalid');
 const block=(await acknowledgedBlocks(supplied,{companyIds:[companyId],payPeriod})).find(item=>item.verdictId===verdictId);
 if(!block)throw new PayrollLoopRefused('changed');
 await resolveAnomalyVerdict(supplied,{verdictId,resolution:'accepted',note:`Expected (standing acknowledgement): ${block.reason}`.slice(0,500)});
 return block;
}
