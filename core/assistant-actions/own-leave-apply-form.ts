/** Read-only owner reads for a `leave.apply` card prepared from chat when the Assistant's own review contract
 * (one full day of annual leave, ./own-leave-candidate.ts) cannot take it: a range, a half day, or another leave
 * type. The confirm path for these is the existing Request Leave form on /leave, prefilled, where the person
 * submits and requestLeave owns eligibility, durations, balance, overlap, calendar and approval routing.
 *
 * Nothing here writes, saves a review or decides anything: the actor and AI controls are read fresh as the caller,
 * the leave types are the caller's own apply menu (core/read.ts listEligibleLeaveTypesFor) and the days and balance
 * are the leave service's own advisory preview (previewLeaveDeduction), exactly as the /leave form previews them.
 * A balance the company hides from the person (ess view) is never returned. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {leaveType} from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {assertAgentActionUnpausedTx} from '../agent-action-pause';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {isModuleEnabled} from '../entitlements';
import {isEmploymentEnded} from '../employment-status';
import {resolveEssView} from '../ess-view';
import {listEligibleLeaveTypesFor,myOwnEmploymentSubjectsTx} from '../read';
import {previewLeaveDeduction} from '../../packs/leave/service';
import {readOwnLeaveActorTx} from './own-leave-actor';

/** The day-based durations a chat card may carry; hourly needs a time window only the form collects. */
export const CHAT_LEAVE_DURATIONS=['full_day','half_day_am','half_day_pm'] as const;
export type ChatLeaveDuration=typeof CHAT_LEAVE_DURATIONS[number];
export const isChatLeaveDuration=(value:unknown):value is ChatLeaveDuration=>typeof value==='string'&&(CHAT_LEAVE_DURATIONS as readonly string[]).includes(value);

export type OwnLeaveApplyType=Readonly<{id:string;name:string;code:string;durations:readonly string[]}>;
export type OwnLeaveApplyMenu=Readonly<{kind:'menu';employmentId:string;types:readonly OwnLeaveApplyType[]}>|Readonly<{kind:'unavailable'}>;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});

/** The caller's one current own employment and the leave types its apply menu offers, in a fixed order (name, id).
 * Unavailable when the Assistant or the leave module is not the caller's, an AI control is paused, or the person
 * holds no current employment or more than one (the form chooses then). Throws a pause as the owners do. */
export async function readOwnLeaveApplyMenu(supplied:SessionContext,locale?:string,now:Date=new Date()):Promise<OwnLeaveApplyMenu>{
 const ctx=capture(supplied),today=todayInKualaLumpur(now);
 return withTenant(ctx,async tx=>{
  const actor=await readOwnLeaveActorTx(tx,ctx);
  if(!actor||!isModuleEnabled(actor,'leave'))return Object.freeze({kind:'unavailable' as const});
  await assertAiActionUnpausedTx(tx,actor,'hr_assistant');await assertAgentActionUnpausedTx(tx,'leave.apply');
  const current=(await myOwnEmploymentSubjectsTx(tx,actor)).filter(row=>row.hiredOn<=today&&!isEmploymentEnded(row,today));
  if(current.length!==1)return Object.freeze({kind:'unavailable' as const});
  const employmentId=current[0].employmentId;
  const types=(await listEligibleLeaveTypesFor(actor,employmentId,locale,tx)).map(row=>Object.freeze({id:row.id,name:String(row.name),code:String(row.code),
   durations:Object.freeze(Array.isArray(row.durations)?row.durations.filter((value):value is string=>typeof value==='string'):[])}))
   .sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  return Object.freeze({kind:'menu' as const,employmentId,types:Object.freeze(types)});
 });
}

export type OwnLeaveApplyFormInput=Readonly<{leaveTypeId:string;startDate:string;endDate:string;durationType:ChatLeaveDuration}>;
export type OwnLeaveApplyFormCandidate=Readonly<{kind:'candidate';employmentId:string;leaveTypeName:string;
 /** Days the request covers, as the leave service counted them. */days:number;
 /** The service's estimate after this request, or null when the company hides the available balance from the person. */availableAfter:number|null;
 /** The service's own figures say the balance covers every day, nothing goes unpaid and no rule would change it. */covered:boolean}>|Readonly<{kind:'unavailable'}>;

/** The service's own preview of one own application, for the card. Unavailable when the type is not on the caller's
 * own menu, the duration is not one the type allows, a half day spans more than one date, or the preview refuses.
 * Advisory only: the Request Leave form re-runs every check when the person submits. */
export async function readOwnLeaveApplyFormCandidate(supplied:SessionContext,input:OwnLeaveApplyFormInput,locale?:string,now:Date=new Date()):Promise<OwnLeaveApplyFormCandidate>{
 const ctx=capture(supplied),unavailable=Object.freeze({kind:'unavailable' as const});
 const {leaveTypeId,startDate,endDate,durationType}=input;
 if(!isChatLeaveDuration(durationType)||endDate<startDate||(durationType!=='full_day'&&endDate!==startDate))return unavailable;
 const menu=await readOwnLeaveApplyMenu(ctx,locale,now);
 if(menu.kind!=='menu')return unavailable;
 const type=menu.types.find(row=>row.id===leaveTypeId);
 if(!type||(durationType!=='full_day'&&!type.durations.includes(durationType)))return unavailable;
 const [identity]=await withTenant(ctx,tx=>tx.select({essViewConfig:leaveType.essViewConfig}).from(leaveType)
  .where(and(eq(leaveType.tenantId,ctx.tenantId),eq(leaveType.id,type.id))).limit(1));
 if(!identity)return unavailable;
 let preview:Awaited<ReturnType<typeof previewLeaveDeduction>>;
 try{preview=await previewLeaveDeduction(ctx,{employmentId:menu.employmentId,leaveTypeId:type.id,startDate,endDate,durationType,includeAvailableBalance:true,today:todayInKualaLumpur(now)});}
 catch{return unavailable;}
 if(!Number.isFinite(preview.days)||preview.days<=0)return unavailable;
 const available=preview.availableBalance,after=preview.availableAfter;
 const covered=typeof available==='number'&&Number.isFinite(available)&&available>=preview.days&&(preview.unpaidDays??0)===0
  &&(preview.overrides?.length??0)===0&&!preview.isEmergencySplit;
 const showAvailable=resolveEssView(identity.essViewConfig as Record<string,boolean>|null).available;
 return Object.freeze({kind:'candidate' as const,employmentId:menu.employmentId,leaveTypeName:type.name,days:preview.days,
  availableAfter:showAvailable&&typeof after==='number'&&Number.isFinite(after)?after:null,covered});
}
