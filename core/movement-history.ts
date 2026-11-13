/**
 * Backward history (board 154511c4, ADR "Backward history entry"): HR imports an employee's latest details
 * first and then records the history backwards. A movement whose After values are ALREADY the record on its
 * effective date D, and whose Before values differ from the record the day before D, cannot mean "change from
 * D" (that is a no-change, refused today). It means "before D the employee was different": it rewrites the
 * period BEFORE D and never touches D or anything after it.
 *
 * WHAT IT WRITES. Only the dated placement on `assignment` (company, department, position, business unit,
 * work location). Every live version in [start, D) is SUPERSEDED and re-inserted with the Before values over
 * the same dates; the version spanning D is split into [from, D) and [D, to). Nothing is updated in place and
 * nothing is deleted, exactly as Correct hire details does (core/hire-correction.ts). Today's company
 * (`employment.company_id`) never changes: D is never in the future and the record from D stays as it was.
 *
 * WHEN IT REFUSES (each with a row code the import names):
 *   - a field outside the five above, or a Before missing for a field the row sets;
 *   - D in the future, or no recorded period before D;
 *   - the field already changes somewhere before D (an earlier change owns that period; correct it instead);
 *   - the version spanning D was created by a recorded movement (splitting it would break that movement's
 *     Roll Back, which splices one version into its neighbour);
 *   - a closed payroll in the period was paid under a different company than the Before company;
 *   - a carried department / position / business unit / cost centre / location is not usable by the Before company.
 *
 * THE CHAIN. The event records `assignment: [{supersededId, replacementId}]` in the shape `originMapOf`
 * (core/hire-correction.ts) reads, so Roll Back of an older movement still finds the live incarnation of the
 * row it created. A split version maps to its later piece; its earlier piece is listed under `inserted`.
 * Deleting a history movement is allowed only while every row it inserted is still live; it supersedes them
 * and re-inserts copies of the originals, recording `replacement -> copy` in the same shape.
 */
import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {assignment,compensation,domainEvent,location,payrollBatch,payslip,reportingLine} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {labelUsableByCompany} from './system-labels';
import {assertWorkforceCompanyTx,assertWorkforceEmploymentTx} from './workforce-access';
import {lockEmploymentStatutoryOwnerTx} from './org';

export const MOVEMENT_HISTORY_EVENT='employment.history.recorded';
export const MOVEMENT_HISTORY_REVERTED_EVENT='employment.history.reverted';
/** The dated placement fields a history movement may set, in display order. */
export const HISTORY_FIELDS=['companyId','departmentId','positionId','businessUnitId','locationId'] as const;
export type HistoryField=(typeof HISTORY_FIELDS)[number];
export type HistoryValues=Partial<Record<HistoryField,string|null>>;
const isHistoryField=(field:string):field is HistoryField=>(HISTORY_FIELDS as readonly string[]).includes(field);

/** An error that already IS a finite import row code (with an optional `:detail`). */
export class MovementHistoryError extends Error{constructor(code:string){super(code);this.name='MovementHistoryError';}}

type Version={id:string;validFrom:string;validTo:string|null}&Record<HistoryField,string|null>;
const covers=(v:{validFrom:string;validTo:string|null},day:string)=>v.validFrom<=day&&(v.validTo===null||v.validTo>day);
export function dayBefore(day:string){const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);}
const valueAt=(versions:readonly Version[],day:string,field:HistoryField)=>{const v=versions.find(x=>covers(x,day));return v?v[field]??null:undefined;};

export type HistoryCandidate={key:number;effectiveDate:string;after:HistoryValues;before:HistoryValues};
/**
 * Which of an employee's new rows are history, decided together and newest first against a simulated
 * timeline, so a set of history rows works in any file order: each is judged against the record the newer
 * ones leave. A row is history when every field it sets is a history field with a Before, every After equals
 * the record on its date, and at least one Before differs from the record the day before. Everything else is
 * an ordinary movement and keeps today's behaviour.
 */
export function classifyHistoryRows(versions:readonly Version[],rows:readonly HistoryCandidate[]):Set<number>{
 let timeline:Version[]=versions.map(v=>({...v}));const history=new Set<number>();
 for(const row of [...rows].sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||b.key-a.key)){
  const fields=Object.keys(row.after);
  if(!fields.length||!fields.every(isHistoryField)||!fields.every(f=>f in row.before))continue;
  const d=row.effectiveDate,prior=dayBefore(d);
  if(!fields.every(f=>valueAt(timeline,d,f as HistoryField)===row.after[f as HistoryField]))continue;
  if(!fields.some(f=>{const was=valueAt(timeline,prior,f as HistoryField);return was!==undefined&&was!==row.before[f as HistoryField];}))continue;
  history.add(row.key);
  // Simulate the write: every version before D takes the Before values (the span check at write time refuses
  // a field that changes before D, so a uniform prefix is the only case that will actually be written).
  const next:Version[]=[];
  for(const v of timeline){
   if(v.validFrom>=d){next.push(v);continue;}
   const set=Object.fromEntries(fields.map(f=>[f,row.before[f as HistoryField]??null]));
   if(v.validTo===null||v.validTo>d){next.push({...v,...set,validTo:d},{...v,validFrom:d});}
   else next.push({...v,...set});
  }
  timeline=next;
 }
 return history;
}

/** The employee's live versions, oldest first, with the five history fields. */
export async function historyVersionsTx(tx:Tx,employmentId:string):Promise<Version[]>{
 return tx.select({id:assignment.id,validFrom:assignment.validFrom,validTo:assignment.validTo,companyId:assignment.companyId,departmentId:assignment.departmentId,positionId:assignment.positionId,businessUnitId:assignment.businessUnitId,locationId:assignment.locationId})
  .from(assignment).where(and(eq(assignment.employmentId,employmentId),isNull(assignment.supersededAt))).orderBy(asc(assignment.validFrom));
}

/** Closed payroll months that overlap [from, to) for this employment, with the company each was paid under. */
async function closedPayrollInSpanTx(tx:Tx,employmentId:string,from:string,toExclusive:string){
 const rows=await tx.selectDistinct({period:payrollBatch.payPeriod,companyId:payrollBatch.companyId}).from(payslip)
  .innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId))
  .where(and(eq(payslip.employmentId,employmentId),eq(payrollBatch.status,'closed')));
 const first=from.slice(0,7),last=dayBefore(toExclusive).slice(0,7);
 return rows.filter(r=>r.period>=first&&r.period<=last).sort((a,b)=>a.period.localeCompare(b.period));
}

export type RecordHistoryInput={employmentId:string;kind:string;typeCode?:string|null;effectiveDate:string;after:HistoryValues;before:HistoryValues;remarks?:string|null};
export type RecordHistoryResult={eventId:string;spanFrom:string;spanTo:string;fields:HistoryField[];closedPayrollPeriods:string[]};

/** Writes one history movement. The caller has already classified it (classifyHistoryRows); every rule is checked again here. */
export async function recordHistoryMovementTx(tx:Tx,ctx:SessionContext,p:RecordHistoryInput):Promise<RecordHistoryResult>{
 const roles=ctx.roles??[];if(!(roles.includes('super_admin')||roles.includes('hr_admin')))throw new Error('Only an admin can record a movement.');
 const fields=Object.keys(p.after);
 if(!fields.length||!fields.every(isHistoryField))throw new MovementHistoryError('movement_history_fields');
 if(!fields.every(f=>f in p.before))throw new MovementHistoryError('movement_history_before_required');
 const d=p.effectiveDate,prior=dayBefore(d);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||d>todayInKualaLumpur())throw new MovementHistoryError('movement_history_future');
 await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
 await lockEmploymentStatutoryOwnerTx(tx,p.employmentId);
 // Lock the live versions (no other writer may close or split them under this rewrite).
 await tx.execute(sql`select id from assignment where employment_id=${p.employmentId}::uuid and superseded_at is null for update`);
 const versions=await historyVersionsTx(tx,p.employmentId);
 const span=versions.filter(v=>v.validFrom<d);
 if(!span.length)throw new MovementHistoryError('movement_history_no_period');
 const spanFrom=span[0].validFrom;
 for(const f of fields as HistoryField[]){
  if(valueAt(versions,d,f)!==p.after[f])throw new MovementHistoryError('movement_history_after_mismatch:'+f);
  // A change already recorded ON D owns that boundary: rewriting before it would leave its Before stale.
  if(span[span.length-1][f]!==p.after[f])throw new MovementHistoryError('movement_history_change_on_date');
  // The field must be uniform over [start, D): a change inside it belongs to an earlier record.
  for(let i=1;i<span.length;i++)if(span[i][f]!==span[i-1][f])throw new MovementHistoryError('movement_history_earlier_change:'+span[i].validFrom);
 }
 if(!(fields as HistoryField[]).some(f=>valueAt(versions,prior,f)!==p.before[f]))throw new MovementHistoryError('movement_history_no_change');
 const spanning=span.find(v=>covers(v,d));
 if(spanning){
  const [created]=await tx.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,p.employmentId),eq(domainEvent.aggregateId,spanning.id),inArray(domainEvent.eventType,['employment.assignment.changed','assignment.transferred']),sql`${domainEvent.payload}->'movement' is not null`)).limit(1);
  if(created)throw new MovementHistoryError('movement_history_splits_movement:'+spanning.validFrom);
 }
 // Payroll already paid stays true: a closed month paid under another company contradicts the Before company.
 const closed=await closedPayrollInSpanTx(tx,p.employmentId,spanFrom,d);
 const beforeCompany=p.before.companyId;
 if(beforeCompany!==undefined){
  const contradicted=closed.filter(r=>r.companyId!==null&&r.companyId!==beforeCompany).map(r=>r.period);
  if(contradicted.length)throw new MovementHistoryError('movement_history_payroll_company:'+[...new Set(contradicted)].join(', '));
 }
 // Full rows of the span, for the copies.
 const full=await tx.select().from(assignment).where(inArray(assignment.id,span.map(v=>v.id)));
 const byId=new Map(full.map(r=>[r.id,r]));
 const companies=new Set<string>();
 for(const v of span){
  const row=byId.get(v.id)!;const company=(p.before.companyId!==undefined?p.before.companyId:row.companyId)??null;
  if(company)companies.add(company);
  if(row.companyId)companies.add(row.companyId);
  if(!company)continue;
  const department=p.before.departmentId!==undefined?p.before.departmentId:row.departmentId;
  const position=p.before.positionId!==undefined?p.before.positionId:row.positionId;
  const unit=p.before.businessUnitId!==undefined?p.before.businessUnitId:row.businessUnitId;
  const site=p.before.locationId!==undefined?p.before.locationId:row.locationId;
  for(const [kind,id,field] of [['department',department,'departmentId'],['position',position,'positionId'],['business_unit',unit,'businessUnitId'],['cost_center',row.costCenterId,'costCenterId']] as const)
   if(id&&!await labelUsableByCompany(tx,ctx.tenantId,kind,id,company))throw new MovementHistoryError('movement_label_other_company'+(field==='costCenterId'?'':':'+field));
  if(site){const [loc]=await tx.select({companyId:location.companyId}).from(location).where(eq(location.id,site)).limit(1);if(!loc||loc.companyId!==company)throw new MovementHistoryError('movement_label_other_company:locationId');}
 }
 for(const company of companies)await assertWorkforceCompanyTx(tx,ctx,company,'maintain');
 const now=new Date(),replaced:{supersededId:string;replacementId:string}[]=[],inserted:string[]=[];
 await tx.update(assignment).set({supersededAt:now}).where(inArray(assignment.id,span.map(v=>v.id)));
 for(const v of span){
  const {id:_id,createdAt:_c,recordedAt:_r,supersededAt:_s,...prior}=byId.get(v.id)!;
  const set=Object.fromEntries((fields as HistoryField[]).map(f=>[f,p.before[f]??null]));
  if(v.validTo===null||v.validTo>d){
   const [early]=await tx.insert(assignment).values({...prior,...set,validFrom:v.validFrom,validTo:d}).returning({id:assignment.id});
   const [late]=await tx.insert(assignment).values({...prior,validFrom:d,validTo:v.validTo}).returning({id:assignment.id});
   inserted.push(early.id);replaced.push({supersededId:v.id,replacementId:late.id});
  }else{
   const [whole]=await tx.insert(assignment).values({...prior,...set}).returning({id:assignment.id});
   replaced.push({supersededId:v.id,replacementId:whole.id});
  }
 }
 const before=Object.fromEntries((fields as HistoryField[]).map(f=>[f,p.before[f]??null])),after=Object.fromEntries((fields as HistoryField[]).map(f=>[f,p.after[f]??null]));
 const event=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:p.employmentId,eventType:MOVEMENT_HISTORY_EVENT,actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
  payload:{employmentId:p.employmentId,type:p.typeCode??p.kind,kind:p.kind,effectiveDate:d,spanFrom,fields,before,after,remarks:p.remarks?.trim()||null,
   assignment:replaced,inserted,closedPayrollPeriods:[...new Set(closed.map(r=>r.period))]}},{returnId:true});
 return{eventId:typeof event==='string'?event:'',spanFrom,spanTo:prior,fields:fields as HistoryField[],closedPayrollPeriods:[...new Set(closed.map(r=>r.period))]};
}

/** Rolls a history movement back: refused once a later write replaced any row it inserted. */
export async function reverseHistoryMovementTx(tx:Tx,ctx:SessionContext,e:{id:string;payload:unknown;subjectEmploymentId:string}){
 const p=(e.payload??{}) as {assignment?:{supersededId:string;replacementId:string}[];inserted?:string[]};
 const replaced=Array.isArray(p.assignment)?p.assignment:[],inserted=Array.isArray(p.inserted)?p.inserted:[];
 const mine=[...replaced.map(r=>r.replacementId),...inserted];
 if(!mine.length)return;
 await lockEmploymentStatutoryOwnerTx(tx,e.subjectEmploymentId);
 const live=await tx.select({id:assignment.id}).from(assignment).where(and(inArray(assignment.id,mine),isNull(assignment.supersededAt))).for('update');
 if(live.length!==mine.length)throw new MovementHistoryError('movement_history_overtaken');
 const originals=await tx.select().from(assignment).where(inArray(assignment.id,replaced.map(r=>r.supersededId)));
 const byId=new Map(originals.map(r=>[r.id,r]));
 await tx.update(assignment).set({supersededAt:new Date()}).where(inArray(assignment.id,mine));
 const restored:{supersededId:string;replacementId:string}[]=[];
 for(const r of replaced){
  const original=byId.get(r.supersededId);if(!original)throw new MovementHistoryError('movement_history_overtaken');
  const {id:_id,createdAt:_c,recordedAt:_r,supersededAt:_s,...copy}=original;
  const [row]=await tx.insert(assignment).values(copy).returning({id:assignment.id});
  restored.push({supersededId:r.replacementId,replacementId:row.id});
 }
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:e.subjectEmploymentId,eventType:MOVEMENT_HISTORY_REVERTED_EVENT,actor:actorOf(ctx),subjectEmploymentId:e.subjectEmploymentId,
  payload:{employmentId:e.subjectEmploymentId,reversalOf:e.id,assignment:restored,removed:inserted}});
}

/** Events whose `assignment` replacements Roll Back must follow (see originMapOf / liveIncarnationOf). */
// An information correction applied from the join date records its replacements in the same shape.
export const isAssignmentReplacementEvent=(eventType:string,hireCorrected:string)=>eventType===hireCorrected||eventType===MOVEMENT_HISTORY_EVENT||eventType===MOVEMENT_HISTORY_REVERTED_EVENT||eventType==='employment.information.corrected';

/**
 * Board 154511c4 — Correct information "in this company from the join date": the employee was ALWAYS in `to`,
 * so every live version's company becomes `to` (superseded and re-inserted over the same dates, no split). Only
 * when the company never changed in the dated history (`from` throughout); a closed payroll paid under another
 * company, or a carried label `to` cannot use, refuses. The caller writes employment.company_id and the event.
 */
export async function rewriteCompanyFromStartTx(tx:Tx,ctx:SessionContext,employmentId:string,from:string,to:string){
 await tx.execute(sql`select id from assignment where employment_id=${employmentId}::uuid and superseded_at is null for update`);
 const versions=await historyVersionsTx(tx,employmentId);
 if(!versions.length)throw new MovementHistoryError('movement_history_no_period');
 // Name the date the company changes, not the start of the history.
 const changeAt=versions.findIndex((v,i)=>i>0&&v.companyId!==versions[i-1].companyId);
 if(changeAt>0)throw new MovementHistoryError('movement_history_earlier_change:'+versions[changeAt].validFrom);
 if(versions.some(v=>v.companyId!==null&&v.companyId!==from))throw new MovementHistoryError('movement_history_earlier_change:'+versions[0].validFrom);
 const spanFrom=versions[0].validFrom;
 const closed=await closedPayrollInSpanTx(tx,employmentId,spanFrom,'9999-12-31');
 const contradicted=[...new Set(closed.filter(r=>r.companyId!==null&&r.companyId!==to).map(r=>r.period))];
 if(contradicted.length)throw new MovementHistoryError('movement_history_payroll_company:'+contradicted.join(', '));
 const full=await tx.select().from(assignment).where(inArray(assignment.id,versions.map(v=>v.id)));
 for(const row of full){
  for(const [kind,id,field] of [['department',row.departmentId,'departmentId'],['position',row.positionId,'positionId'],['business_unit',row.businessUnitId,'businessUnitId'],['cost_center',row.costCenterId,'costCenterId']] as const)
   if(id&&!await labelUsableByCompany(tx,ctx.tenantId,kind,id,to))throw new MovementHistoryError('movement_label_other_company'+(field==='costCenterId'?'':':'+field));
  if(row.locationId){const [loc]=await tx.select({companyId:location.companyId}).from(location).where(eq(location.id,row.locationId)).limit(1);if(!loc||loc.companyId!==to)throw new MovementHistoryError('movement_label_other_company:locationId');}
 }
 await tx.update(assignment).set({supersededAt:new Date()}).where(inArray(assignment.id,full.map(r=>r.id)));
 const replaced:{supersededId:string;replacementId:string}[]=[];
 for(const row of full.sort((a,b)=>a.validFrom.localeCompare(b.validFrom))){
  const {id,createdAt:_c,recordedAt:_r,supersededAt:_s,...copy}=row;
  const [inserted]=await tx.insert(assignment).values({...copy,companyId:to}).returning({id:assignment.id});
  replaced.push({supersededId:id,replacementId:inserted.id});
 }
 return{spanFrom,replaced,currentId:replaced[replaced.length-1]?.replacementId??null};
}

/**
 * Board 154511c4 (production 13 Nov 2026, employee 101475) — the dated records start on the Group Join Date.
 * When Correct information moves the join date, the FIRST live company/position version, salary revision and
 * reporting lines start on it too: earlier, so the months from the join date are covered; later, only when no
 * recorded change or closed payroll lies in the dropped period. Rows are superseded and re-inserted (never
 * updated in place); the replacements are recorded in the shape Roll Back follows.
 */
export type StartAlignment={from:string;to:string};
export async function historyStartTx(tx:Tx,employmentId:string){
 const [first]=await tx.select({validFrom:assignment.validFrom}).from(assignment).where(and(eq(assignment.employmentId,employmentId),isNull(assignment.supersededAt))).orderBy(asc(assignment.validFrom)).limit(1);
 return first?.validFrom??null;
}
export async function alignHistoryStartTx(tx:Tx,employmentId:string,start:string){
 await tx.execute(sql`select id from assignment where employment_id=${employmentId}::uuid and superseded_at is null for update`);
 const replaced:{supersededId:string;replacementId:string}[]=[],aligned:{supersededId:string;replacementId:string}[]=[];
 const firstOf=<T extends {validFrom:string;validTo:string|null}>(rows:T[])=>[...rows].sort((a,b)=>a.validFrom.localeCompare(b.validFrom))[0];
 const check=async(row:{validFrom:string;validTo:string|null}|undefined)=>{
  if(!row||row.validFrom===start)return false;
  if(start>row.validFrom){
   if(row.validTo!==null&&row.validTo<=start)throw new MovementHistoryError('movement_history_earlier_change:'+row.validTo);
   const closed=await closedPayrollInSpanTx(tx,employmentId,row.validFrom,start);
   if(closed.length)throw new MovementHistoryError('movement_history_payroll_company:'+[...new Set(closed.map(r=>r.period))].join(', '));
  }
  return true;
 };
 const now=new Date();
 const asg=firstOf(await tx.select().from(assignment).where(and(eq(assignment.employmentId,employmentId),isNull(assignment.supersededAt))));
 if(await check(asg)){
  const {id,createdAt:_c,recordedAt:_r,supersededAt:_s,...copy}=asg;
  await tx.update(assignment).set({supersededAt:now}).where(eq(assignment.id,id));
  const [row]=await tx.insert(assignment).values({...copy,validFrom:start}).returning({id:assignment.id});
  replaced.push({supersededId:id,replacementId:row.id});
 }
 const pay=firstOf(await tx.select().from(compensation).where(and(eq(compensation.employmentId,employmentId),isNull(compensation.supersededAt))));
 if(await check(pay)){
  const {id,createdAt:_c,recordedAt:_r,supersededAt:_s,updatedAt:_u,...copy}=pay;
  await tx.update(compensation).set({supersededAt:now}).where(eq(compensation.id,id));
  const [row]=await tx.insert(compensation).values({...copy,validFrom:start}).returning({id:compensation.id});
  aligned.push({supersededId:id,replacementId:row.id});
 }
 const lines=await tx.select().from(reportingLine).where(and(eq(reportingLine.subordinateEmploymentId,employmentId),isNull(reportingLine.supersededAt)));
 for(const lineType of [...new Set(lines.map(l=>l.lineType))]){
  const line=firstOf(lines.filter(l=>l.lineType===lineType));
  if(!await check(line))continue;
  const {id,createdAt:_c,recordedAt:_r,supersededAt:_s,...copy}=line;
  await tx.update(reportingLine).set({supersededAt:now}).where(eq(reportingLine.id,id));
  const [row]=await tx.insert(reportingLine).values({...copy,validFrom:start}).returning({id:reportingLine.id});
  aligned.push({supersededId:id,replacementId:row.id});
 }
 return{replaced,aligned};
}
