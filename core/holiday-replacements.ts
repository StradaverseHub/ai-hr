/** ADR-0120. One repeat-safe write owner; effective calendar reads never call this allocator. */
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {attendance,company,employment,holiday,replacementHoliday,replacementHolidayPolicy,replacementHolidayRevision,replacementHolidayQueue} from '../db/schema';
import {isAdmin} from '../lib/authz';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addHolidayDays,allocateReplacementHolidays,policyOn,type ReplacementPolicy,type ReplacementDecision,type OriginalHoliday} from '../lib/holiday-replacement';
import {rawScheduleDaysTx,rawScheduleDayFactsTx} from '../packs/attendance/service';
import {effectiveHolidayState,originalHolidayCalendarFor} from './holidays';
import {lockPayrollForAttendanceChange} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {provenCompanyDatesTx} from './employment-company';
import {replacementHolidayDatesByEmployment} from './holiday-replacement-read';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isoDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
async function authority(tx:Tx,employmentId:string){const [row]=await tx.execute(sql`select app.can_admin_employment(${employmentId}::uuid) as allowed`) as unknown as {allowed:boolean}[];if(!row?.allowed)throw new Error('You cannot administer this employee.');}
export function listReplacementHolidayPolicies(ctx:SessionContext,companyIds:readonly string[]){return withTenant(ctx,tx=>tx.select().from(replacementHolidayPolicy).where(inArray(replacementHolidayPolicy.companyId,[...companyIds])).orderBy(asc(replacementHolidayPolicy.companyId),asc(replacementHolidayPolicy.effectiveFrom)));}
export function saveReplacementHolidayPolicy(ctx:SessionContext,p:{companyId:string;effectiveFrom:string;regime:ReplacementPolicy['regime'];confirmed:boolean;restMode:ReplacementPolicy['restMode'];halfEligible:boolean;searchDays:number;reason:string}){
 if(!isAdmin(ctx))throw new Error('Only an HR administrator can set replacement holiday policy.');
 if(!isoDate(p.effectiveFrom)||p.effectiveFrom<todayInKualaLumpur())throw new Error('Choose today or a future policy effective date. Historical cases require review.');
 if(!['MY_EA_60D','MY_SABAH_103','company_confirmed'].includes(p.regime)||!['scheduled_rest','last_weekly_rest'].includes(p.restMode))throw new Error('Choose a supported, confirmed policy definition.');
 if(!Number.isInteger(p.searchDays)||p.searchDays<1||p.searchDays>366)throw new Error('Search limit must be between 1 and 366 days.');
 if(p.reason.trim().length<3||p.reason.trim().length>2000)throw new Error('Record the policy basis in 3 to 2000 characters.');
 if(p.regime==='MY_EA_60D'&&(p.restMode!=='last_weekly_rest'||!p.halfEligible))throw new Error('The Employment Act policy uses the designated last weekly rest day and includes half working days. Use an explicitly confirmed company rule for a different policy.');
 return withTenant(ctx,async tx=>{
  const [permission]=await tx.execute(sql`select app.is_admin_for(${p.companyId}::uuid) as allowed`) as unknown as {allowed:boolean}[];
  if(!permission?.allowed)throw new Error('You cannot administer this company.');
  const [c]=await tx.select().from(company).where(eq(company.id,p.companyId)).for('update');if(!c)throw new Error('Company unavailable.');
  const versions=await tx.select().from(replacementHolidayPolicy).where(eq(replacementHolidayPolicy.companyId,p.companyId)).orderBy(asc(replacementHolidayPolicy.effectiveFrom));
  if(versions.some(v=>v.effectiveFrom>=p.effectiveFrom))throw new Error('Choose a date later than every saved policy version. Published policy history is retained.');
  const [row]=await tx.insert(replacementHolidayPolicy).values({...p,tenantId:ctx.tenantId,reason:p.reason.trim(),createdBy:ctx.userId??'system'}).returning({id:replacementHolidayPolicy.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'company',aggregateId:p.companyId,eventType:'holiday.replacement-policy.published',actor:actorOf(ctx),payload:{policyId:row.id,...p,reason:p.reason.trim()}});return row;
 });
}
async function saveRevision(tx:Tx,ctx:SessionContext,row:typeof replacementHoliday.$inferSelect,before:typeof replacementHoliday.$inferSelect|null,basis?:Record<string,unknown>){
 await tx.insert(replacementHolidayRevision).values({tenantId:ctx.tenantId,allocationId:row.id,employmentId:row.employmentId,companyId:row.companyId,snapshot:{before,after:row,basis},createdBy:ctx.userId??'system'});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'holiday-replacement',aggregateId:row.id,eventType:row.manual?'holiday.replacement.manually-adjusted':'holiday.replacement.reconciled',subjectEmploymentId:row.employmentId,actor:actorOf(ctx),payload:{sourceHolidayId:row.sourceHolidayId,sourceDate:row.sourceDate,policyId:row.policyId,before:before?{date:before.replacementDate,status:before.status,reason:before.reason}:null,after:{date:row.replacementDate,proposedDate:row.proposedDate,status:row.status,reason:row.reason},manualReason:row.manualReason}});
}
export async function reconcileReplacementHolidaysTx(tx:Tx,ctx:SessionContext,employmentId:string){
 await authority(tx,employmentId);
 const [emp]=await tx.select().from(employment).where(eq(employment.id,employmentId)).for('update');if(!emp)throw new Error('Employee unavailable.');
 const [c]=await tx.select().from(company).where(eq(company.id,emp.companyId));if(!c)throw new Error('Company unavailable.');
 const existing=await tx.select().from(replacementHoliday).where(eq(replacementHoliday.employmentId,employmentId)).orderBy(asc(replacementHoliday.sourceDate),asc(replacementHoliday.sourceHolidayId));
 const recorded=await tx.select({date:attendance.attendanceDate,dayType:attendance.dayType}).from(attendance).where(eq(attendance.employmentId,employmentId));
 const today=todayInKualaLumpur(),tenureFrom=emp.hiredOn;
 const firstYear=`${today.slice(0,4)}-01-01`,prior=existing.reduce((date,row)=>row.sourceDate<date?row.sourceDate:date,firstYear);
 const recordedFrom=recorded.reduce((date,row)=>row.date<date?row.date:date,prior);
 const from=recordedFrom<tenureFrom?tenureFrom:recordedFrom;
 const requestedEnd=`${Number(today.slice(0,4))+1}-12-31`,to=emp.terminatedOn&&emp.terminatedOn<requestedEnd?emp.terminatedOn:requestedEnd;
 if(to<from)return {changed:0,review:0,calendarConflicts:[] as {date:string;recorded:string;holiday:boolean}[]};
 const horizon=addHolidayDays(to,366),rawFrom=addHolidayDays(from,-7);
 const sources=await originalHolidayCalendarFor(tx,{employmentId,startDate:from,endDate:horizon});
 const scheduleFacts=await rawScheduleDayFactsTx(tx,employmentId,rawFrom,horizon);
 const days=new Map([...scheduleFacts].map(([date,fact])=>[date,fact.kind]));
 const scheduleUnknownReasons=new Map([...scheduleFacts].filter(([,fact])=>fact.reason).map(([date,fact])=>[date,fact.reason!]));
 const companyIds=[...new Set([emp.companyId,...sources.map(source=>source.companyId??emp.companyId),...existing.map(row=>row.companyId)])];
 const companies=await tx.select().from(company).where(inArray(company.id,companyIds));
 const policies=await tx.select().from(replacementHolidayPolicy).where(inArray(replacementHolidayPolicy.companyId,companyIds)).orderBy(asc(replacementHolidayPolicy.companyId),asc(replacementHolidayPolicy.effectiveFrom));
 const companyContexts=new Map<string,{country:string;state:string|null;knownState:boolean}>();
 for(const context of companies){
  const jurisdiction=await effectiveHolidayState(tx,employmentId,context.id),states=jurisdiction?.states??[];
  let knownStates:readonly string[]=[];try{knownStates=requirePackFor(context.country).states??[];}catch{/* Unknown jurisdiction stays review-only. */}
  const knownState=states.length>0&&states.every(state=>knownStates.includes(state));
  const regions=new Set(states.map(state=>state==='Sabah'?'Sabah':state==='Sarawak'?'Sarawak':'Peninsular'));
  companyContexts.set(context.id,{country:context.country,state:regions.size===1?jurisdiction?.state??null:null,knownState});
 }
 const companyProof=await provenCompanyDatesTx(tx,[...days.keys()].map(date=>({employmentId,date})));
 const companyCoverage=new Map([...days.keys()].map(date=>[date,companyProof.get(`${employmentId}|${date}`)!]));
 const oldBySource=new Map(existing.map(row=>[row.sourceHolidayId,row]));
 const recordedByDate=new Map(recorded.map(row=>[row.date,row.dayType]));
 const payroll=new Map<string,boolean>();
 const protectedDate=async(date:string)=>{if(!payroll.has(date))payroll.set(date,(await lockPayrollForAttendanceChange(tx,employmentId,date)).length>0);return payroll.get(date)!;};
 const reserved=new Set<string>(),retained=new Map<string,string|null>(),oldDates=new Map<string,string>();
 for(const old of existing){
  if(old.manual)retained.set(old.sourceHolidayId,old.replacementDate);
  if(old.replacementDate){oldDates.set(old.sourceHolidayId,old.replacementDate);if(old.manual||recordedByDate.has(old.replacementDate)||await protectedDate(old.replacementDate))reserved.add(old.replacementDate);}
 }
 const decisions=allocateReplacementHolidays({sources,policies,days,reserved,retained,existingDates:oldDates,companyCountry:c.country,state:null,knownState:false,companyContexts,companyCoverage,scheduleUnknownReasons,employmentFrom:tenureFrom,employmentTo:emp.terminatedOn});
 const selected=new Map(decisions.filter(d=>d.source.date<=to).map(d=>[d.source.id,d]));
 for(const old of existing)if(!selected.has(old.sourceHolidayId))selected.set(old.sourceHolidayId,{source:{id:old.sourceHolidayId,date:old.sourceDate,name:old.sourceName,companyId:old.companyId,holidayType:'public',tentative:false,active:true},policyId:old.policyId,status:'not_required',date:null,reason:'source_no_longer_applicable'});
 let changed=0,review=0;
 const writes:{before:typeof replacementHoliday.$inferSelect|null;values:typeof replacementHoliday.$inferInsert;basis:Record<string,unknown>}[]=[];
 for(const decision of [...selected.values()].sort((a,b)=>a.source.date.localeCompare(b.source.date)||a.source.id.localeCompare(b.source.id))){
  const sourceCompanyId=decision.source.companyId??emp.companyId;
  const old=oldBySource.get(decision.source.id);if(old?.manual){if(old.status==='review')review++;continue;}
  if(!old&&decision.status==='not_required')continue;
  let status=decision.status,date=decision.date,reason=decision.reason,proposedDate:string|null=null;
  if(status==='review'&&old?.replacementDate){proposedDate=date;date=old.replacementDate;}
  const datesChanged=(old?.replacementDate??null)!==date;
  if(old&&old.sourceDate!==decision.source.date){status='review';reason='source_date_changed';proposedDate=date;date=old.replacementDate;}
  else if(old&&old.companyId!==sourceCompanyId){status='review';reason='employment_company_changed';proposedDate=date;date=old.replacementDate;}
  else if(datesChanged){
   const involved=[...new Set([decision.source.date,old?.replacementDate,date].filter((d):d is string=>!!d))];
   let locked=false;for(const day of involved)if(await protectedDate(day))locked=true;
   const recordedChange=!!old?.replacementDate&&recordedByDate.has(old.replacementDate)||!!date&&recordedByDate.has(date)&&recordedByDate.get(date)!=='holiday';
   if(locked||recordedChange){status='review';reason=locked?'payroll_protected':'recorded_attendance';proposedDate=date;date=old?.replacementDate??null;}
  }
  if(status==='review')review++;
  const policy=policyOn(policies,decision.source.date,sourceCompanyId),end=addHolidayDays(decision.source.date,policy?.searchDays??366);
  const inputDigest=digest({source:decision.source,policy,days:[...days].filter(([day])=>day>=addHolidayDays(decision.source.date,-7)&&day<=end),originals:sources.filter(h=>h.date>=decision.source.date&&h.date<=end),companyId:sourceCompanyId,tenureFrom,terminatedOn:emp.terminatedOn,context:companyContexts.get(sourceCompanyId),status,date,reason,proposedDate});
  if(old?.inputDigest===inputDigest)continue;
  const values={tenantId:ctx.tenantId,employmentId,companyId:old?.companyId??sourceCompanyId,sourceHolidayId:decision.source.id,sourceDate:reason==='source_date_changed'?old!.sourceDate:decision.source.date,sourceName:reason==='source_date_changed'?old!.sourceName:decision.source.name,policyId:old&&(old.companyId!==sourceCompanyId||reason==='source_date_changed')?old.policyId:decision.policyId,inputDigest,status,replacementDate:date,proposedDate,reason,manual:false,manualReason:null,updatedAt:new Date()};
  writes.push({before:old??null,values,basis:{source:decision.source,policyId:decision.policyId,inputDigest}});
 }
 // Several sources can move forward together: A's new date may still be held by B's old projection.
 // Vacate only dates that this same transaction will change, after every payroll/attendance guard has
 // decided the final result. Intermediate review rows are invisible outside this transaction; revisions
 // retain the original before snapshot, and rollback restores the whole allocation if any write fails.
 for(const write of writes)if(write.before?.replacementDate&&write.before.replacementDate!==write.values.replacementDate)
  await tx.update(replacementHoliday).set({replacementDate:null,status:'review'}).where(eq(replacementHoliday.id,write.before.id));
 for(const write of writes){
  const [row]=write.before?await tx.update(replacementHoliday).set(write.values).where(eq(replacementHoliday.id,write.before.id)).returning():await tx.insert(replacementHoliday).values(write.values).returning();
  await saveRevision(tx,ctx,row,write.before,write.basis);changed++;
 }
 const effectiveDates=new Set(sources.map(h=>h.date));
 for(const date of (await replacementHolidayDatesByEmployment(tx,{employmentIds:[employmentId],startDate:from,endDate:to})).get(employmentId)??[])effectiveDates.add(date);
 const calendarConflicts=recorded.filter(row=>row.date>=from&&row.date<=to&&(row.dayType==='holiday')!==effectiveDates.has(row.date)).map(row=>({date:row.date,recorded:row.dayType,holiday:effectiveDates.has(row.date)}));
 return {changed,review,calendarConflicts};
}
export function reconcileReplacementHolidays(ctx:SessionContext,employmentId:string){if(!isAdmin(ctx))throw new Error('Only an HR administrator can reconcile replacement holidays.');return withTenant(ctx,tx=>reconcileReplacementHolidaysTx(tx,ctx,employmentId));}
export function adjustReplacementHoliday(ctx:SessionContext,p:{allocationId:string;date:string|null;reason:string;policyId?:string|null;releaseToAutomatic?:boolean}){
 if(!isAdmin(ctx))throw new Error('Only an HR administrator can adjust replacement holidays.');
 if(p.reason.trim().length<3||p.reason.trim().length>2000)throw new Error('Record an adjustment reason in 3 to 2000 characters.');
 if(p.date&&!isoDate(p.date))throw new Error('Choose a valid replacement date.');
 return withTenant(ctx,async tx=>{
  const [found]=await tx.select().from(replacementHoliday).where(eq(replacementHoliday.id,p.allocationId));if(!found)throw new Error('Replacement unavailable.');
  await authority(tx,found.employmentId);
  const [emp]=await tx.select().from(employment).where(eq(employment.id,found.employmentId)).for('update');if(!emp)throw new Error('Employee unavailable.');
  const [old]=await tx.select().from(replacementHoliday).where(eq(replacementHoliday.id,p.allocationId)).for('update');
  const adjustmentDate=p.releaseToAutomatic?old.replacementDate:p.date;
  const [original]=await tx.select().from(holiday).where(eq(holiday.id,old.sourceHolidayId));if(!original)throw new Error('Original holiday unavailable.');
  if(adjustmentDate&&!p.releaseToAutomatic){const proof=await provenCompanyDatesTx(tx,[{employmentId:emp.id,date:original.holidayDate},{employmentId:emp.id,date:adjustmentDate}]);for(const date of [original.holidayDate,adjustmentDate]){const coverage=proof.get(`${emp.id}|${date}`);if(!coverage||coverage.reason||coverage.companyId!==old.companyId)throw new Error('The original and replacement dates must have proven assignment coverage in their recorded company and employment tenure.');}}
  if(adjustmentDate&&!p.releaseToAutomatic){
   if(adjustmentDate<=original.holidayDate||adjustmentDate<emp.hiredOn||emp.terminatedOn&&adjustmentDate>emp.terminatedOn)throw new Error('The replacement must follow its source within this employment’s tenure.');
   const selectedPolicyId=p.policyId??old.policyId;
   const [policy]=selectedPolicyId?await tx.select().from(replacementHolidayPolicy).where(and(eq(replacementHolidayPolicy.id,selectedPolicyId),eq(replacementHolidayPolicy.companyId,old.companyId))):[];
   if(!policy?.confirmed||policy.effectiveFrom>todayInKualaLumpur())throw new Error('Choose a confirmed policy in effect for this company before assigning a manual replacement.');
   const raw=await rawScheduleDaysTx(tx,emp.id,adjustmentDate,adjustmentDate),kind=raw.get(adjustmentDate);
   if(kind!=='full'&&!(kind==='half'&&policy.halfEligible))throw new Error('Choose an eligible scheduled working day.');
   const originals=await originalHolidayCalendarFor(tx,{employmentId:emp.id,startDate:adjustmentDate,endDate:adjustmentDate});if(originals.length)throw new Error('That date is already an original holiday.');
   const [occupied]=await tx.select({id:replacementHoliday.id}).from(replacementHoliday).where(and(eq(replacementHoliday.employmentId,emp.id),eq(replacementHoliday.replacementDate,adjustmentDate)));
   if(occupied&&occupied.id!==old.id)throw new Error('That date already replaces another public holiday.');
  }
  for(const date of new Set([old.sourceDate,old.replacementDate,adjustmentDate].filter((d):d is string=>!!d)))if((await lockPayrollForAttendanceChange(tx,emp.id,date)).length)throw new Error('This adjustment affects processed or closed payroll. Use the protected-period review and correction process.');
  if(old.replacementDate!==adjustmentDate){
   const involved=[old.replacementDate,adjustmentDate].filter((d):d is string=>!!d),rows=involved.length?await tx.select().from(attendance).where(and(eq(attendance.employmentId,emp.id),inArray(attendance.attendanceDate,involved))):[];
   if(rows.some(row=>row.attendanceDate===adjustmentDate?row.dayType!=='holiday':row.dayType==='holiday'))throw new Error('Complete the attendance day-type correction first. This operation does not rewrite recorded clocking or pay.');
  }
  if(old.replacementDate===adjustmentDate&&old.manual===!p.releaseToAutomatic&&old.manualReason===p.reason.trim()&&(!p.policyId||p.policyId===old.policyId))return {id:old.id};
  const [row]=await tx.update(replacementHoliday).set({sourceDate:p.releaseToAutomatic?old.sourceDate:original.holidayDate,sourceName:p.releaseToAutomatic?old.sourceName:original.name,policyId:p.releaseToAutomatic?null:p.policyId??old.policyId,replacementDate:adjustmentDate,proposedDate:null,status:p.releaseToAutomatic?'review':adjustmentDate?'allocated':'not_required',manual:!p.releaseToAutomatic,manualReason:p.reason.trim(),reason:p.releaseToAutomatic?'automatic_released':'manual_adjustment',inputDigest:digest({previous:old.inputDigest,date:adjustmentDate,reason:p.reason.trim(),release:!!p.releaseToAutomatic}),updatedAt:new Date()}).where(eq(replacementHoliday.id,old.id)).returning();
  await saveRevision(tx,ctx,row,old);
  if(p.releaseToAutomatic)await tx.insert(replacementHolidayQueue).values({tenantId:ctx.tenantId,employmentId:emp.id}).onConflictDoUpdate({target:[replacementHolidayQueue.tenantId,replacementHolidayQueue.employmentId],set:{requestedAt:new Date(),generation:sql`${replacementHolidayQueue.generation}+1`,claimedAt:null,claimedGeneration:null}});
  return {id:row.id};
 });
}
