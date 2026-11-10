/** The Today page's "Before payroll" checklist inputs in ONE statement (docs/adr/2026-11-10-home-request-read-scope.md,
 * decision 11).
 *
 * core/pre-salary/person-items.ts reads about fifteen owners for the person's own employment: about sixty statements in
 * one shared snapshot. Here every owner contributes a section to a single statement, built beside the owner it
 * reproduces (the owner and the section share their select, predicate and order) and evaluated in the caller's own
 * session, so row-level security is the owner's own; each owner's own proof (the TP1 owner check, the letters'
 * presentation proof, the profile's own-person check) is read in the same statement as a value. The checklist then runs
 * each owner's TypeScript projection on the section: the Attendance Records day loop with its schedule, rotation,
 * Schedule Group, absence-deduction and exception ladders (day adjustments through scheduleFor on the range-shaped twin
 * of the Today clock day's schedule inputs, draft 9873), the loop cards' gate and card rules, the readiness gaps and
 * their correction actions, the TP1 month collapse, the TP3 history mapping and the onboarding projection. Where the
 * checklist reads only some fields of an owner, the section carries those fields of the same rows (decision 8's rule for
 * the claim types): no amount, limit, balance, rating or bank fact is read.
 *
 * Module gates stay the caller's decision and the owner's: a section is built only where the owner's own gate
 * (assertModuleGate, and the AI Centre check for Performance) would admit it; otherwise that owner reads itself and
 * refuses exactly as before. Two date-local facts of the Attendance range, approved leave presence and the holiday
 * calendar, are read through core/attendance.ts AttendanceRangeDatedFacts after the statement, in the same
 * transaction: another reader owns their one-statement form. A section whose projection refuses its rows, an owner
 * check that fails, an order the owner leaves to the plan, or a failed statement leaves that owner (or every owner) to
 * read exactly as before in the same snapshot. Read only; never cached beyond one response. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {aiCentreActivity} from '../../lib/ai/centre-activity';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {assertModuleGate} from '../module-gate';
import {attendanceRangeChecklistBundleSql,attendanceRangeChecklistFromBundle,otMonthToDateBundleSql,otMonthToDateFromBundle,
 overtimePlanChecklistBundleSql,overtimePlanChecklistFromBundle,ownAttendanceRequestChecklistBundleSql,ownAttendanceRequestChecklistFromBundle,
 LIVE_ATTENDANCE_RANGE_DATED_FACTS,type AttendanceRangeDatedFacts,type AttendanceRangeRow,type OvertimeCapView,type OvertimePlanChecklistRow,
 type OwnAttendanceRequestChecklistRow} from '../../packs/attendance/service';
import {readLoopCardsBundleSql,readLoopCardsFromBundle,type LoopCard} from '../loops/cards';
import {eligibleLeaveTypesBundleSql,eligibleLeaveTypesFromBundle,leaveRequestsChecklistBundleSql,leaveRequestsChecklistFromBundle} from '../read';
import {claimTypeReceiptRulesBundleSql,claimTypeReceiptRulesFromBundle,openClaimsChecklistBundleSql,openClaimsChecklistFromBundle,
 type OpenClaimChecklistRow} from '../../packs/claims/service';
import {ownReplacementChecklistBundleSql,ownReplacementChecklistFromBundle,type OwnReplacementChecklistRow} from '../../packs/leave/service';
import {myReadinessActionsBundleSql,myReadinessActionsFromBundle} from '../readiness-actions';
import {listMyTp1DeclarationsSnapshotBundleSql,listMyTp1DeclarationsSnapshotFromBundle,myTp3SnapshotBundleSql,myTp3SnapshotFromBundle,
 type MyTp3Draft,type MyTp3Employment,type Tp1MonthDeclaration,type Tp3Record} from '../../packs/payroll/service';
import {myTp3PreviousEmployerAnswerBundleSql,myTp3PreviousEmployerAnswerFromBundle,type Tp3PreviousEmployerAnswer} from './tp3-answer';
import {myProfileChildCountBundleSql,myProfileChildCountFromBundle} from '../profile';
import {listDependentsBundleSql,listDependentsFromBundle,type DependentRow} from '../dependents';
import {listMyLettersBundleSql,listMyLettersFromBundle} from '../letters';
import {pendingNoticeAcknowledgementTaskBundleSql,pendingNoticeAcknowledgementTasksFromBundle} from '../notice';
import {myReviewsChecklistBundleSql,myReviewsChecklistFromBundle,type MyReviewChecklistRow} from '../../packs/performance/service';
import {onboardingMyAcknowledgementsBundleSql,onboardingMyAcknowledgementsFromBundle} from '../../packs/lifecycle/service';

const ownerReads=new AsyncLocalStorage<true>();
/** Every Before payroll owner inside `work` reads on its own, as before this statement existed. Equivalence proofs only. */
export function withOwnerBeforePayrollReads<T>(work:()=>Promise<T>):Promise<T>{return ownerReads.run(true,work);}

/** One section's owner result, or null where that owner must read itself. */
export type BundleAnswer<T>=Readonly<{value:T}>|null;

/** The cut-off days row of app.own_payroll_cut_off_day, as the period owner reads it. */
export type OwnCutOffRow=Readonly<{cut_off_day:number|null;attendance_cut_off_day:number|null;overtime_cut_off_day:number|null;
 claim_cut_off_day:number|null;unpaid_leave_cut_off_day:number|null}>;
/** The Attendance windows the checklist reads once the period is known. */
export type AttendanceReadWindows=Readonly<{range:Readonly<{from:string;to:string}>|null;overtimeFrom:string;capDate:string}>;
/** What person-items.ts asks of the owners for one own employment, and which groups it reads (a module that is off or
 * could not be resolved reads nothing, exactly as the checklist decides).
 *
 * The cut-off day decides the Attendance windows, and is read in the same statement (`cutOff`: the period owner's own
 * statement, null where the checklist reads none). So the Attendance sections are read for windows that cover every
 * window the period owner can choose (`covering`): a pay period is this month or the next, and each input type's window
 * for it opens on or after the first day of the previous month and closes by its end; the checklist reads no day after
 * yesterday. `windowsFor` then gives the exact windows for the cut-off row the statement returned (null: none read),
 * and each section is narrowed to them exactly as its owner would have read them (or left to its owner where a window
 * falls outside what was covered). */
export type BeforePayrollBundleRead=Readonly<{
 employmentId:string;today:string;locale:string;cutOff:SQL|null;windowsFor:(cutOff:readonly OwnCutOffRow[]|null)=>AttendanceReadWindows;
 /** null: the Attendance module is not on for the person's company. */
 attendance:Readonly<{covering:Readonly<{from:string;to:string}>;corrections:Readonly<{status:'pending';limit:number}>;
  overtime:Readonly<{status:'pending';from:string;limit:number}>;capMonths:readonly string[]}>|null;
 leave:boolean;claims:boolean;toil:boolean;
 /** Payroll on: TP3 and the previous-employer answer; with a person, also TP1, the profile and the Family register. */
 payroll:boolean;assessmentYear:number;letterLimit:number;performance:boolean;lifecycle:boolean;
}>;

export type BeforePayrollBundle=Readonly<{
 cutOff:BundleAnswer<OwnCutOffRow[]>;
 corrections:BundleAnswer<OwnAttendanceRequestChecklistRow[]>;
 overtimePlans:BundleAnswer<OvertimePlanChecklistRow[]>;
 otCap:BundleAnswer<OvertimeCapView>;
 loopCards:BundleAnswer<readonly LoopCard[]>;
 days:BundleAnswer<AttendanceRangeRow[]>;
 leaveRequests:BundleAnswer<ReturnType<typeof leaveRequestsChecklistFromBundle>>;
 leaveTypes:BundleAnswer<ReturnType<typeof eligibleLeaveTypesFromBundle>>;
 claims:BundleAnswer<OpenClaimChecklistRow[]>;
 claimRules:BundleAnswer<ReturnType<typeof claimTypeReceiptRulesFromBundle>>;
 toil:BundleAnswer<OwnReplacementChecklistRow[]>;
 readiness:BundleAnswer<ReturnType<typeof myReadinessActionsFromBundle>>;
 tp3:BundleAnswer<{employments:MyTp3Employment[];history:{records:Tp3Record[];drafts:MyTp3Draft[]}}>;
 tp3Answer:BundleAnswer<Tp3PreviousEmployerAnswer|null>;
 tp1:BundleAnswer<Tp1MonthDeclaration[]>;
 profile:BundleAnswer<ReturnType<typeof myProfileChildCountFromBundle>>;
 dependents:BundleAnswer<DependentRow[]>;
 letters:BundleAnswer<NonNullable<ReturnType<typeof listMyLettersFromBundle>>>;
 notices:BundleAnswer<ReturnType<typeof pendingNoticeAcknowledgementTasksFromBundle>>;
 reviews:BundleAnswer<MyReviewChecklistRow[]>;
 onboarding:BundleAnswer<ReturnType<typeof onboardingMyAcknowledgementsFromBundle>>;
}>;
type SectionName=keyof BeforePayrollBundle;

const gateOpen=(ctx:SessionContext,code:string)=>{try{assertModuleGate(ctx,code);return true;}catch{return false;}};
const CUT_OFF_KEYS=['cut_off_day','attendance_cut_off_day','overtime_cut_off_day','claim_cut_off_day','unpaid_leave_cut_off_day'] as const;
/** The cut-off rows as the driver returns them: integers or null, in the statement's column order. */
function cutOffRowsFromBundle(value:unknown):OwnCutOffRow[]{
 if(!Array.isArray(value))throw new Error('The bundled cut-off days are unavailable.');
 return value.map(row=>{
  const record=row as Record<string,unknown>;
  for(const key of CUT_OFF_KEYS)if(record[key]!==null&&!Number.isInteger(record[key]))throw new Error('A bundled cut-off day is not an integer.');
  return Object.fromEntries(CUT_OFF_KEYS.map(key=>[key,record[key] as number|null])) as OwnCutOffRow;
 });
}

/** One Before payroll response's statement. Resolves null when every owner must read on its own. `facts`: the reader of
 * approved leave presence and the holiday calendar for the Attendance range (the seam a one-statement reader of those
 * date-local facts plugs into). */
export async function readBeforePayrollBundle(ctx:SessionContext,read:BeforePayrollBundleRead,
 facts:AttendanceRangeDatedFacts=LIVE_ATTENDANCE_RANGE_DATED_FACTS):Promise<BeforePayrollBundle|null>{
 if(ownerReads.getStore()||!ctx.userId||ctx.agent)return null;
 const {employmentId,locale}=read,personId=ctx.personId??null;
 // An owner whose own gate would refuse, or whose section needs a person it does not have, reads itself.
 const attendance=read.attendance&&gateOpen(ctx,'attendance')?read.attendance:null;
 const claims=read.claims&&gateOpen(ctx,'claims'),payroll=read.payroll&&gateOpen(ctx,'payroll');
 const performance=read.performance&&gateOpen(ctx,'performance')&&!aiCentreActivity(ctx.tenantId),lifecycle=read.lifecycle&&gateOpen(ctx,'lifecycle');
 const sections:Partial<Record<SectionName|'range',SQL|null>>={
  cutOff:read.cutOff?sql`(select coalesce(jsonb_agg(to_jsonb(cut_off_row)),'[]'::jsonb) from (${read.cutOff}) cut_off_row)`:null,
  corrections:attendance?ownAttendanceRequestChecklistBundleSql(employmentId,attendance.corrections):null,
  overtimePlans:attendance?overtimePlanChecklistBundleSql(employmentId,attendance.overtime):null,
  // Each month a cap date can fall in: the two sums for that month.
  otCap:attendance?sql`jsonb_build_object(${sql.join(attendance.capMonths.map(month=>sql`${month}::text,${otMonthToDateBundleSql(employmentId,month+'-01')}`),sql`,`)})`:null,
  loopCards:attendance?readLoopCardsBundleSql(ctx):null,
  range:attendance?attendanceRangeChecklistBundleSql(employmentId,attendance.covering.from,attendance.covering.to):null,
  leaveRequests:read.leave?leaveRequestsChecklistBundleSql(employmentId):null,
  leaveTypes:read.leave?eligibleLeaveTypesBundleSql(employmentId):null,
  claims:claims?openClaimsChecklistBundleSql(employmentId):null,
  claimRules:claims?claimTypeReceiptRulesBundleSql():null,
  toil:read.toil?ownReplacementChecklistBundleSql(employmentId):null,
  readiness:myReadinessActionsBundleSql(ctx,employmentId),
  tp3:payroll?myTp3SnapshotBundleSql(ctx):null,
  tp3Answer:read.payroll?myTp3PreviousEmployerAnswerBundleSql(ctx,read.assessmentYear):null,
  tp1:payroll&&personId?listMyTp1DeclarationsSnapshotBundleSql(ctx,{assessmentYear:read.assessmentYear}):null,
  profile:read.payroll&&personId?myProfileChildCountBundleSql(ctx):null,
  dependents:read.payroll&&personId?listDependentsBundleSql({personId}):null,
  letters:gateOpen(ctx,'employees')?listMyLettersBundleSql(ctx,read.letterLimit):null,
  // The owner takes its own HR day, not the checklist's.
  notices:pendingNoticeAcknowledgementTaskBundleSql(ctx,todayInKualaLumpur()),
  reviews:performance?myReviewsChecklistBundleSql(ctx):null,
  onboarding:lifecycle?onboardingMyAcknowledgementsBundleSql(ctx):null,
 };
 const built=Object.entries(sections).filter((entry):entry is [string,SQL]=>entry[1]!=null);
 if(!built.length)return null;
 // jsonb_build_object takes at most fifty pairs per call.
 const chunks:SQL[]=[];
 for(let index=0;index<built.length;index+=40)chunks.push(sql`jsonb_build_object(${sql.join(built.slice(index,index+40).map(([name,section])=>sql`${sql.raw(`'${name}'`)},${section}`),sql`,\n`)})`);
 const decide=<T,>(project:()=>T):BundleAnswer<T>=>{try{return Object.freeze({value:project()});}catch{return null;}};
 try{
  return await withTenant(ctx,async tx=>{
   const [row]=await tx.execute<{bundle:Record<string,unknown>|null}>(sql`select ${sql.join(chunks,sql` || `)} as bundle`);
   const raw=row?.bundle;
   if(!raw)throw new Error('The Before payroll statement returned no row.');
   const has=(name:string)=>name in sections&&sections[name as SectionName|'range']!=null;
   const answer=<T,>(name:SectionName,project:(value:unknown)=>T|null):BundleAnswer<T>=>{
    if(!has(name))return null;
    const value=decide(()=>project(raw[name]));
    return value&&value.value!==null?value as BundleAnswer<T>:null;
   };
   const cutOff=answer('cutOff',cutOffRowsFromBundle);
   // The exact Attendance windows for the cut-off row read here (none read: the checklist's own calendar fallback).
   let windows:AttendanceReadWindows|null=null;
   if(attendance&&(!has('cutOff')||cutOff)){try{windows=read.windowsFor(cutOff?cutOff.value:null);}catch{windows=null;}}
   const covered=(from:string,to:string)=>!!attendance&&from>=attendance.covering.from&&to<=attendance.covering.to;
   // The Attendance range's two date-local facts are read now, in this transaction, through the seam, for the exact range.
   let days:BundleAnswer<AttendanceRangeRow[]>=null;
   const range=windows?.range;
   if(range&&has('range')&&covered(range.from,range.to)){
    try{days=Object.freeze({value:await attendanceRangeChecklistFromBundle(tx,raw.range,employmentId,range.from,range.to,facts)});}
    catch{days=null;}
   }
   return Object.freeze({
    cutOff,
    corrections:answer('corrections',ownAttendanceRequestChecklistFromBundle),
    overtimePlans:windows&&attendance&&windows.overtimeFrom>=attendance.overtime.from
     ?answer('overtimePlans',value=>overtimePlanChecklistFromBundle(value,attendance.overtime.limit,windows!.overtimeFrom)):null,
    otCap:windows?answer('otCap',value=>{const month=(value as Record<string,unknown>)[windows!.capDate.slice(0,7)];return month===undefined?null:otMonthToDateFromBundle(month);}):null,
    loopCards:answer('loopCards',value=>readLoopCardsFromBundle(ctx,value)),
    days,
    leaveRequests:answer('leaveRequests',value=>leaveRequestsChecklistFromBundle(value,locale)),
    leaveTypes:answer('leaveTypes',value=>eligibleLeaveTypesFromBundle(value,locale)),
    claims:answer('claims',openClaimsChecklistFromBundle),
    claimRules:answer('claimRules',claimTypeReceiptRulesFromBundle),
    toil:answer('toil',ownReplacementChecklistFromBundle),
    readiness:answer('readiness',value=>myReadinessActionsFromBundle(ctx,employmentId,value)),
    tp3:answer('tp3',myTp3SnapshotFromBundle),
    // The answer itself may be null (not answered yet): it is wrapped so that null stays a value.
    // The answer itself may be null (not answered yet), and the profile null (not the caller's own): both are values.
    tp3Answer:has('tp3Answer')?decide(()=>myTp3PreviousEmployerAnswerFromBundle(raw.tp3Answer)):null,
    tp1:answer('tp1',listMyTp1DeclarationsSnapshotFromBundle),
    profile:has('profile')?decide(()=>myProfileChildCountFromBundle(raw.profile)):null,
    dependents:answer('dependents',listDependentsFromBundle),
    letters:answer('letters',value=>listMyLettersFromBundle(ctx,value,read.letterLimit)),
    notices:answer('notices',pendingNoticeAcknowledgementTasksFromBundle),
    reviews:answer('reviews',myReviewsChecklistFromBundle),
    onboarding:answer('onboarding',value=>onboardingMyAcknowledgementsFromBundle(ctx,value)),
   });
  },{readOnlySnapshot:true});
 }catch{
  // The owners report their own failures (or succeed) exactly as before.
  return null;
 }
}
