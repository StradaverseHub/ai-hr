/** One employment's own leave inputs, read in ONE statement, for the current-cycle leave calculators.
 *
 * The leave calculators (leaveBalancesTx, the My Leave dashboard, leaveEntitlementBreakdowns and
 * leaveTypeApplySummaries) read their inputs in stages: the catalogue, then the ledger and request aggregates,
 * then the per-cycle windows that depend on dates computed in between. This statement reads every row those stages
 * would aggregate, under the same transaction, snapshot and row-level security, so each staged statement can be
 * answered from it. Each answer below names the statement it replaces and computes exactly its result:
 *   · the same rows (the same predicates and inner/left joins over rows this login may read),
 *   · the same `numeric` text (lib/pg-numeric.ts: exact sums at the widest input scale, `coalesce(..., 0)` as `0`),
 *   · the same order: every statement whose row order reaches a result orders deterministically (by id where it
 *     had no ORDER BY), and its answer here sorts the same way.
 * The calculators keep every line of their arithmetic. They use these answers only for the employment and the
 * transaction this was read for (`answers`); any other request, and any branch not answered here, reads live.
 *
 * Nothing here decides authority. The caller has already proved the own subject and principal; RLS still applies
 * to every row, so this can never return a row the staged statements could not. */
import {sql,type Column,type Table} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {company,employment,entitlementTemplate,leaveLedger,leaveRequest,leaveSharedGroup,leaveSharedGroupMember,leaveType,person} from '../db/schema';
import {columnRefSql,decodeJsonColumns,decodeJsonRow,jsonColumnsSql,jsonRowSql,projectFields} from '../db/json-row';
import {coalescedNegatedSumText,coalescedSumText,compareNumeric,NUMERIC_ZERO,numericText,parseNumeric,sqlLike,subtractNumeric,
 sumNumeric,type PgNumeric} from '../lib/pg-numeric';
import {A2C_RECALC_REASON_PREFIX,AGED_FORFEIT_REASON,POLICY_RECALC_REASON_PREFIX,PROFILE_RECALC_REASON_PREFIX,
 nextApprovedLeavePresenceSql} from '../packs/leave/service';

/** The employment, person and company columns the calculators' own employment selects read. */
const EMPLOYMENT_COLUMNS=[employment.hiredOn,employment.terminatedOn,employment.gradeId,employment.companyId,employment.confirmationDate,
 employment.finalConfirmationDate,employment.orgDivision,employment.orgBranch,employment.orgRegion,employment.orgLine,employment.orgSection,
 employment.orgTeam,employment.orgBase,employment.employmentCategory];
const PERSON_COLUMNS=[person.gender,person.maritalStatus];
const COMPANY_COLUMNS=[company.leaveCycle];
const LEDGER_COLUMNS=[leaveLedger.id,leaveLedger.employmentId,leaveLedger.leaveTypeId,leaveLedger.entryType,leaveLedger.days,
 leaveLedger.sourceRequestId,leaveLedger.effectiveOn,leaveLedger.reason];
const REQUEST_COLUMNS=[leaveRequest.id,leaveRequest.employmentId,leaveRequest.leaveTypeId,leaveRequest.status,leaveRequest.startDate,
 leaveRequest.endDate,leaveRequest.days,leaveRequest.unpaidDays,leaveRequest.durationType];

export type OwnLeaveLedgerRow={id:string;employmentId:string;leaveTypeId:string;entryType:(typeof leaveLedger.$inferSelect)['entryType'];
 days:string;sourceRequestId:string|null;effectiveOn:string;reason:string|null};
export type OwnLeaveRequestRow={id:string;employmentId:string;leaveTypeId:string;status:(typeof leaveRequest.$inferSelect)['status'];
 startDate:string;endDate:string;days:string;unpaidDays:string|null;durationType:string};
type LeaveTypeRow=typeof leaveType.$inferSelect;
type Raw={types:Record<string,unknown>[];employment:Record<string,unknown>|null;person:Record<string,unknown>|null;
 company:Record<string,unknown>|null;ledger:Record<string,unknown>[];requests:Record<string,unknown>[];
 groupMembers:{leaveTypeId:string;placement:string}[];templates:{leaveTypeId:string;validFrom:string;validTo:string|null}[];
 nextApproved:{requestId:string;date:string;duration:'full_day'|'part_day'}|null};

const a=(alias:string,column:Column)=>columnRefSql(alias,column);
const dec=(text:string)=>parseNumeric(text);
/** PostgreSQL's uuid order: unsigned bytes, which is the order of their lowercase hex text. */
const byText=(x:string,y:string)=>x<y?-1:x>y?1:0;
const sumText=(rows:readonly {days:string}[])=>coalescedSumText(rows.map(row=>dec(row.days)));
const negatedSumText=(rows:readonly {days:string}[])=>coalescedNegatedSumText(rows.map(row=>dec(row.days)));
/** Insertion-ordered grouping; callers order the groups the way their statement orders them. */
function groupBy<T>(rows:readonly T[],key:(row:T)=>string){
 const groups=new Map<string,T[]>();
 for(const row of rows){const k=key(row),group=groups.get(k);if(group)group.push(row);else groups.set(k,[row]);}
 return groups;
}

export class OwnLeaveInputs{
 readonly types:LeaveTypeRow[];
 readonly ledger:OwnLeaveLedgerRow[];
 readonly requests:OwnLeaveRequestRow[];
 readonly nextApproved:Raw['nextApproved'];
 private readonly typeById:Map<string,LeaveTypeRow>;
 private readonly requestById:Map<string,OwnLeaveRequestRow>;
 private readonly sources:Map<Table,Record<string,unknown>|null>;
 constructor(private readonly tx:Tx,readonly employmentId:string,private readonly raw:Raw){
  this.types=raw.types.map(row=>decodeJsonRow(leaveType,row));
  this.ledger=raw.ledger.map(row=>decodeJsonColumns(LEDGER_COLUMNS,row) as OwnLeaveLedgerRow);
  this.requests=raw.requests.map(row=>decodeJsonColumns(REQUEST_COLUMNS,row) as OwnLeaveRequestRow);
  // jsonb orders object keys by length; the statement's own row is (requestId, date, duration).
  const next=raw.nextApproved;
  this.nextApproved=next?{requestId:next.requestId,date:next.date,duration:next.duration}:null;
  this.typeById=new Map(this.types.map(type=>[type.id,type]));
  this.requestById=new Map(this.requests.map(request=>[request.id,request]));
  const decoded=(columns:Column[],row:Record<string,unknown>|null)=>row?decodeJsonColumns(columns,row):null;
  this.sources=new Map<Table,Record<string,unknown>|null>([[employment,decoded(EMPLOYMENT_COLUMNS,raw.employment)],
   [person,decoded(PERSON_COLUMNS,raw.person)],[company,decoded(COMPANY_COLUMNS,raw.company)]]);
 }
 /** Only the transaction and employment these inputs were read for. */
 answers(tx:Tx,employmentId:string):boolean{return tx===this.tx&&employmentId===this.employmentId;}
 private ownLedger(asOf?:string){return this.ledger.filter(row=>row.employmentId===this.employmentId&&(asOf===undefined||row.effectiveOn<=asOf));}
 private ownRequests(status:OwnLeaveRequestRow['status'],startOnOrBefore?:string){
  return this.requests.filter(row=>row.employmentId===this.employmentId&&row.status===status&&(startOnOrBefore===undefined||row.startDate<=startOnOrBefore));
 }

 /** `select <fields> from employment [inner join person] [inner join company] where employment.id = $1 limit 1`. */
 employmentRows<R>(fields:Record<string,Column>):R[]{
  const row=projectFields(fields,this.sources);
  return (row?[row]:[]) as R[];
 }
 /** `select <fields> from leave_type [where …] [order by id]`: heap order unless the statement orders by id. */
 typeRows<R>(fields:Record<string,Column>,where:(type:LeaveTypeRow)=>boolean=()=>true,orderById=false):R[]{
  const types=this.types.filter(where);
  if(orderById)types.sort((x,y)=>byText(x.id,y.id));
  return types.map(type=>projectFields(fields,new Map([[leaveType,type]]))) as R[];
 }
 /** leaveBalancesTx: `select member.leave_type_id, group.ess_placement from leave_shared_group_member join leave_shared_group`. */
 sharedGroupMembers(){return this.raw.groupMembers.map(row=>({leaveTypeId:row.leaveTypeId,placement:row.placement}));}

 /** leaveBalancesTx `rows`: per visible leave type, accrual + in-lieu, negated debits and the signed balance. */
 ledgerTotalsByType(asOf?:string){
  const rows=this.ownLedger(asOf).filter(row=>this.typeById.has(row.leaveTypeId));
  return [...groupBy(rows,row=>row.leaveTypeId)].sort(([x],[y])=>byText(x,y)).map(([id,group])=>({leaveTypeId:id,leaveType:this.typeById.get(id)!.name,
   accrued:sumText(group.filter(row=>row.entryType==='accrual'||row.entryType==='in_lieu_accrual')),
   taken:negatedSumText(group.filter(row=>row.entryType==='debit')),balance:sumText(group)}));
 }
 /** leaveBalancesTx `pend`: pending request days per visible leave type, starting on or before `asOf` when given. */
 pendingDaysByType(asOf?:string){
  const rows=this.ownRequests('pending',asOf).filter(row=>this.typeById.has(row.leaveTypeId));
  return [...groupBy(rows,row=>row.leaveTypeId)].sort(([x],[y])=>byText(x,y)).map(([id,group])=>({leaveTypeId:id,leaveType:this.typeById.get(id)!.name,pending:sumText(group)}));
 }
 /** leaveBalancesTx `takenFiled`: negated debits per coalesce(filed request's type, ledger type). */
 debitsByFiledType(asOf?:string){
  const groups=groupBy(this.ownLedger(asOf),row=>(row.sourceRequestId?this.requestById.get(row.sourceRequestId)?.leaveTypeId:undefined)??row.leaveTypeId);
  return [...groups].map(([filedTypeId,group])=>({filedTypeId,taken:negatedSumText(group.filter(row=>row.entryType==='debit'))}));
 }
 /** leaveBalancesTx `unpaidFiled`: `coalesce(sum(unpaid_days), 0)` of approved requests per filed type. */
 unpaidDaysByType(asOf?:string){
  return [...groupBy(this.ownRequests('approved',asOf),row=>row.leaveTypeId)].map(([leaveTypeId,group])=>({leaveTypeId,
   unpaid:coalescedSumText(group.flatMap(row=>row.unpaidDays==null?[]:[dec(row.unpaidDays)]))}));
 }
 /** earnedRecalcDaysBy: policy, profile and Anniversary-to-Calendar recalculation rows. */
 recalculationRows(asOf?:string){
  return this.ownLedger(asOf).filter(row=>sqlLike(row.reason,`${POLICY_RECALC_REASON_PREFIX}:%`)||sqlLike(row.reason,`${PROFILE_RECALC_REASON_PREFIX}:%`)
   ||sqlLike(row.reason,`${A2C_RECALC_REASON_PREFIX}:%`)).map(({employmentId,leaveTypeId,entryType,days,effectiveOn,reason})=>
   ({employmentId,leaveTypeId,entryType,days,effectiveOn,reason}));
 }

 /** buildTemplateEntitlementResolver's first read: is any entitlement table version in force on `asOf`? */
 templatesInForce(asOf:string,leaveTypeIds:readonly string[]){
  const ids=new Set(leaveTypeIds);
  return this.raw.templates.some(row=>ids.has(row.leaveTypeId)&&row.validFrom<=asOf&&(row.validTo===null||row.validTo>asOf));
 }
 /** leaveEntitlementBreakdownTx `agg`: one type's ledger to `asOf`, split at the cycle start. */
 breakdownTotals(leaveTypeId:string,asOf:string,cycleStart:string){
  const rows=this.ownLedger(asOf).filter(row=>row.leaveTypeId===leaveTypeId),inCycle=rows.filter(row=>row.effectiveOn>=cycleStart);
  return {
   otherAdjustments:sumText(inCycle.filter(row=>row.entryType==='adjustment'&&(compareNumeric(dec(row.days),NUMERIC_ZERO)>0
    ||sqlLike(row.reason,`${POLICY_RECALC_REASON_PREFIX}:%`)))),
   agedForfeited:negatedSumText(inCycle.filter(row=>row.entryType==='adjustment'&&row.reason===AGED_FORFEIT_REASON)),
   balance:sumText(rows),priorBalance:sumText(rows.filter(row=>row.effectiveOn<cycleStart)),
  };
 }
 /** leaveEntitlementBreakdownTx `debitAgg`: negated debits of one type in [from, to]. */
 breakdownDebits(leaveTypeId:string,from:string,to:string){
  return {taken:negatedSumText(this.ownLedger().filter(row=>row.leaveTypeId===leaveTypeId&&row.entryType==='debit'&&row.effectiveOn>=from&&row.effectiveOn<=to))};
 }
 /** leaveEntitlementBreakdownTx `pendingRows`: `order by start_date, id`. */
 breakdownPending(leaveTypeId:string,asOf:string){
  return this.ownRequests('pending',asOf).filter(row=>row.leaveTypeId===leaveTypeId)
   .sort((x,y)=>x.startDate<y.startDate?-1:x.startDate>y.startDate?1:x.id<y.id?-1:x.id>y.id?1:0)
   .map(({startDate,endDate,days})=>({startDate,endDate,days}));
 }
 /** leaveEntitlementBreakdownTx `rows`: one type's ledger in [from, to], `order by effective_on, id`. */
 breakdownLedger(leaveTypeId:string,from:string,to:string){
  return this.ownLedger().filter(row=>row.leaveTypeId===leaveTypeId&&row.effectiveOn>=from&&row.effectiveOn<=to)
   .sort((x,y)=>byText(x.effectiveOn,y.effectiveOn)||byText(x.id,y.id))
   .map(({id,effectiveOn,entryType,days,sourceRequestId,reason})=>({id,effectiveOn,entryType,days,sourceRequestId,reason}));
 }

 /** leaveTypeApplySummaries `balanceRows`: `coalesce(sum(days), 0)` per source type. */
 ledgerBalanceBySourceType(sources:readonly string[]){
  const wanted=new Set(sources);
  return [...groupBy(this.ownLedger().filter(row=>wanted.has(row.leaveTypeId)),row=>row.leaveTypeId)].map(([typeId,group])=>({typeId,bal:sumText(group)}));
 }
 /** leaveTypeApplySummaries `takenRows`: negated debits per source type. */
 ledgerTakenBySourceType(sources:readonly string[]){
  const wanted=new Set(sources);
  return [...groupBy(this.ownLedger().filter(row=>wanted.has(row.leaveTypeId)),row=>row.leaveTypeId)]
   .map(([typeId,group])=>({typeId,taken:negatedSumText(group.filter(row=>row.entryType==='debit'))}));
 }
 /** leaveTypeApplySummaries `pendingRows`: pending `days - coalesce(unpaid_days, 0)` over each source's spender pairs. */
 pendingBySource(pairSource:readonly string[],pairType:readonly string[]){
  const pending=this.ownRequests('pending'),out=new Map<string,PgNumeric[]>();
  pairSource.forEach((source,index)=>{
   for(const row of pending)if(row.leaveTypeId===pairType[index]){
    const value=subtractNumeric(dec(row.days),row.unpaidDays==null?NUMERIC_ZERO:dec(row.unpaidDays));
    const values=out.get(source);if(values)values.push(value);else out.set(source,[value]);
   }
  });
  return [...out].map(([src,values])=>({src,pending:numericText(sumNumeric(values)!)}));
 }
}

/** The single statement. Every subselect is the owner's own predicate; RLS applies to each table it reads. */
export async function readOwnLeaveInputsTx(tx:Tx,employmentId:string,today:string):Promise<OwnLeaveInputs>{
 const id=sql`${employmentId}::uuid`;
 const [row]=await tx.execute<{inputs:Raw}>(sql`select jsonb_build_object(
  'types',(select coalesce(jsonb_agg(${jsonRowSql(leaveType,'t')} order by t.ctid),'[]'::jsonb) from ${leaveType} t),
  'employment',(select ${jsonColumnsSql('e',EMPLOYMENT_COLUMNS)} from ${employment} e where ${a('e',employment.id)}=${id}),
  'person',(select ${jsonColumnsSql('p',PERSON_COLUMNS)} from ${employment} e join ${person} p on ${a('p',person.id)}=${a('e',employment.personId)}
   where ${a('e',employment.id)}=${id}),
  'company',(select ${jsonColumnsSql('c',COMPANY_COLUMNS)} from ${employment} e join ${company} c on ${a('c',company.id)}=${a('e',employment.companyId)}
   where ${a('e',employment.id)}=${id}),
  'ledger',(select coalesce(jsonb_agg(${jsonColumnsSql('l',LEDGER_COLUMNS)} order by ${a('l',leaveLedger.effectiveOn)},l.ctid),'[]'::jsonb)
   from ${leaveLedger} l where ${a('l',leaveLedger.employmentId)}=${id}),
  'requests',(select coalesce(jsonb_agg(${jsonColumnsSql('r',REQUEST_COLUMNS)} order by r.ctid),'[]'::jsonb) from ${leaveRequest} r
   where ${a('r',leaveRequest.employmentId)}=${id} or ${a('r',leaveRequest.id)} in (select ${a('s',leaveLedger.sourceRequestId)} from ${leaveLedger} s
    where ${a('s',leaveLedger.employmentId)}=${id} and ${a('s',leaveLedger.sourceRequestId)} is not null)),
  'groupMembers',(select coalesce(jsonb_agg(jsonb_build_object('leaveTypeId',${a('m',leaveSharedGroupMember.leaveTypeId)},
   'placement',${a('g',leaveSharedGroup.essPlacement)}) order by m.ctid),'[]'::jsonb)
   from ${leaveSharedGroupMember} m join ${leaveSharedGroup} g on ${a('g',leaveSharedGroup.id)}=${a('m',leaveSharedGroupMember.groupId)}),
  'templates',(select coalesce(jsonb_agg(jsonb_build_object('leaveTypeId',${a('x',entitlementTemplate.leaveTypeId)},
   'validFrom',${a('x',entitlementTemplate.validFrom)},'validTo',${a('x',entitlementTemplate.validTo)})),'[]'::jsonb) from ${entitlementTemplate} x),
  'nextApproved',(select jsonb_build_object('requestId',q."requestId",'date',q.date,'duration',q.duration)
   from (${nextApprovedLeavePresenceSql(employmentId,today)}) q)
 ) as inputs`);
 if(!row?.inputs)throw new Error('Own leave inputs are unavailable.');
 return new OwnLeaveInputs(tx,employmentId,row.inputs);
}
