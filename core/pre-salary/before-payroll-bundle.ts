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

/** What person-items.ts asks of the owners for one own employment: each window as it computes it, and which groups it
 * reads (a module that is off or could not be resolved reads nothing, exactly as the checklist decides). */
export type BeforePayrollBundleRead=Readonly<{
 employmentId:string;today:string;locale:string;
 /** null: the Attendance module is not on for the person's company. `range`: null when the window has no past day. */
 attendance:Readonly<{range:Readonly<{from:string;to:string}>|null;corrections:Readonly<{status:'pending';limit:number}>;
  overtime:Readonly<{status:'pending';from:string;limit:number}>;capDate:string}>|null;
 leave:boolean;claims:boolean;toil:boolean;
 /** Payroll on: TP3 and the previous-employer answer; with a person, also TP1, the profile and the Family register. */
 payroll:boolean;assessmentYear:number;letterLimit:number;performance:boolean;lifecycle:boolean;
}>;

export type BeforePayrollBundle=Readonly<{
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
  corrections:attendance?ownAttendanceRequestChecklistBundleSql(employmentId,attendance.corrections):null,
  overtimePlans:attendance?overtimePlanChecklistBundleSql(employmentId,attendance.overtime):null,
  otCap:attendance?otMonthToDateBundleSql(employmentId,attendance.capDate):null,
  loopCards:attendance?readLoopCardsBundleSql(ctx):null,
  range:attendance?.range?attendanceRangeChecklistBundleSql(employmentId,attendance.range.from,attendance.range.to):null,
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
   // The Attendance range's two date-local facts are read now, in this transaction, through the seam.
   let days:BundleAnswer<AttendanceRangeRow[]>=null;
   if(attendance?.range&&has('range')){
    try{days=Object.freeze({value:await attendanceRangeChecklistFromBundle(tx,raw.range,employmentId,attendance.range.from,attendance.range.to,facts)});}
    catch{days=null;}
   }
   return Object.freeze({
    corrections:answer('corrections',ownAttendanceRequestChecklistFromBundle),
    overtimePlans:answer('overtimePlans',value=>overtimePlanChecklistFromBundle(value,attendance?.overtime.limit)),
    otCap:answer('otCap',otMonthToDateFromBundle),
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
