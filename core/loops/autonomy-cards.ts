/** AI v2 Phase 2 P2-1 — what the autonomy ladder puts on Today, read as the viewer in the caller's transaction.
 *  - autoFixed (the employee): a missed clock-out the loop set on their own day, while its undo window is open, with
 *    the Undo that core/loops/undo.ts carries out. Shown whether or not the loop still runs: an undo window never
 *    closes early.
 *  - movedDown (administrators): a loop that moved itself back to Prepare in a company in the viewer's current scope in
 *    the last 7 days, with the corrections that moved it, each named through the owners' row-level security.
 *  - acted (administrators, Level 2): every action of the last day in a company at Act within limits, so HR sees each one.
 *  - sample (administrators, Level 3): this week's sample to review in a company at Act and audit, until it is reviewed;
 *    at Level 3 the individual actions no longer fill HR's feed.
 *  - leftAlone (administrators): days or requests the loop left for the person in the last 7 days because a condition did
 *    not hold, still waiting; the employee keeps their own card for each.
 * Row-level security decides what each viewer reads (migration 0963): an employee their own actions, an administrator
 * the level history of companies they administer and the actions of employments they administer. Only dates, clock
 * times and the employee's own name: no figure, no reason text. */
import {and,desc,eq,gt,gte,inArray,isNull} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {company,employment,person} from '../../db/schema';
import {terasLoopCase} from '../../db/teras-schema';
import {terasLoopAction,terasLoopActionUndo,terasLoopLevel,terasLoopLevelChange,terasLoopSampleReview} from '../../db/teras-autonomy-schema';
import type {LoopId} from './types';
import type {LoopActionReason,UndoneBy} from './autonomy-types';
import {currentWeekStart,weeklySampleTx} from './samples';

const DAY_MS=86_400_000,MOVED_DOWN_DAYS=7,CORRECTIONS_SHOWN=5,LEFT_ALONE_DAYS=7;
export type MovedDownCorrection=Readonly<{personName:string|null;date:string|null;kind:'undone'|'changed';by:UndoneBy|null}>;
export type AutonomyCardItem=Readonly<{personName:string|null;date:string|null;reason:LoopActionReason|null}>;
export type AutonomyCard=
 |Readonly<{kind:'autoFixed';actionId:string;date:string;checkOut:string;undoUntil:string}>
 |Readonly<{kind:'movedDown';changeId:string;workerId:LoopId;companyName:string|null;at:string;applied:number;corrected:number;
  corrections:readonly MovedDownCorrection[];more:number;href:string}>
 |Readonly<{kind:'acted';workerId:LoopId;companyId:string;companyName:string|null;count:number;items:readonly AutonomyCardItem[];more:number;href:string}>
 |Readonly<{kind:'sample';workerId:LoopId;companyId:string;companyName:string|null;weekStart:string;size:number;total:number;href:string}>
 |Readonly<{kind:'leftAlone';workerId:LoopId;companyId:string;companyName:string|null;count:number;items:readonly AutonomyCardItem[];more:number;href:string}>;
export const AUTONOMY_CARD_HREF=Object.freeze({movedDown:(workerId:LoopId)=>`/control-tower/loops/${encodeURIComponent(workerId)}`});

const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readAutonomyCardsTx(tx:Tx,ctx:SessionContext,p:Readonly<{scopeIds:readonly string[];admin:boolean;now?:Date}>):Promise<readonly AutonomyCard[]>{
 if(!ctx.userId||ctx.agent)return [];
 const now=p.now??new Date(),cards:AutonomyCard[]=[];
 // The employee's own: open undo windows on their own days.
 if(ctx.personId){
  const own=await tx.select({id:terasLoopAction.id,facts:terasLoopAction.facts,undoUntil:terasLoopAction.undoUntil}).from(terasLoopAction)
   .innerJoin(employment,eq(employment.id,terasLoopAction.employmentId))
   .leftJoin(terasLoopActionUndo,eq(terasLoopActionUndo.actionId,terasLoopAction.id))
   .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.workerId,'loop_missed_clock_outs'),eq(terasLoopAction.state,'applied'),
    gt(terasLoopAction.undoUntil,now),isNull(terasLoopAction.peopleChangedAt),isNull(terasLoopActionUndo.actionId),eq(employment.personId,ctx.personId)))
   .orderBy(desc(terasLoopAction.createdAt)).limit(5);
  for(const row of own){
   const {date,checkOut}=row.facts;
   if(isDate(date)&&isClock(checkOut))cards.push(Object.freeze({kind:'autoFixed' as const,actionId:row.id,date,checkOut,undoUntil:row.undoUntil.toISOString()}));
  }
 }
 // Administrators: loops that moved themselves down in a company in scope.
 if(p.admin&&p.scopeIds.length){
  const changes=await tx.select({id:terasLoopLevelChange.id,workerId:terasLoopLevelChange.workerId,companyName:company.legalName,at:terasLoopLevelChange.changedAt,
   evidence:terasLoopLevelChange.evidence}).from(terasLoopLevelChange).leftJoin(company,eq(company.id,terasLoopLevelChange.companyId))
   .where(and(eq(terasLoopLevelChange.tenantId,ctx.tenantId),eq(terasLoopLevelChange.kind,'demoted_auto'),inArray(terasLoopLevelChange.companyId,[...p.scopeIds]),
    gte(terasLoopLevelChange.changedAt,new Date(now.getTime()-MOVED_DOWN_DAYS*DAY_MS)))).orderBy(desc(terasLoopLevelChange.changedAt)).limit(5);
  for(const change of changes){
   const evidence=change.evidence as Record<string,unknown>;
   const listed=(Array.isArray(evidence.corrections)?evidence.corrections:[]).flatMap(item=>{
    const value=item as Record<string,unknown>;
    return typeof value.actionId==='string'&&UUID.test(value.actionId)&&(value.kind==='undone'||value.kind==='changed')
     ?[{actionId:value.actionId,kind:value.kind as 'undone'|'changed',by:value.by==='employee'||value.by==='hr'?value.by as UndoneBy:null}]:[];
   });
   const shown=listed.slice(0,CORRECTIONS_SHOWN);
   const people=shown.length?await tx.select({id:terasLoopAction.id,facts:terasLoopAction.facts,name:person.fullName}).from(terasLoopAction)
    .leftJoin(employment,eq(employment.id,terasLoopAction.employmentId)).leftJoin(person,eq(person.id,employment.personId))
    .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),inArray(terasLoopAction.id,shown.map(item=>item.actionId)))):[];
   const corrections=shown.map(item=>{const row=people.find(found=>found.id===item.actionId);
    return Object.freeze({personName:row?.name??null,date:isDate(row?.facts.date)?row!.facts.date as string:null,kind:item.kind,by:item.by});});
   cards.push(Object.freeze({kind:'movedDown' as const,changeId:change.id,workerId:change.workerId,companyName:change.companyName??null,at:change.at.toISOString(),
    applied:typeof evidence.applied==='number'?evidence.applied:0,corrected:typeof evidence.corrected==='number'?evidence.corrected:listed.length,
    corrections:Object.freeze(corrections),more:Math.max(0,listed.length-shown.length),href:AUTONOMY_CARD_HREF.movedDown(change.workerId)}));
  }
  cards.push(...await feedCardsTx(tx,ctx,p.scopeIds,now));
 }
 return Object.freeze(cards);
}

/** HR's feed: each action of the last day at Level 2, the weekly sample at Level 3, and what the loop left alone. */
async function feedCardsTx(tx:Tx,ctx:SessionContext,scopeIds:readonly string[],now:Date):Promise<AutonomyCard[]>{
 const out:AutonomyCard[]=[];
 const levels=await tx.select({workerId:terasLoopLevel.workerId,companyId:terasLoopLevel.companyId,level:terasLoopLevel.level,companyName:company.legalName})
  .from(terasLoopLevel).leftJoin(company,eq(company.id,terasLoopLevel.companyId))
  .where(and(eq(terasLoopLevel.tenantId,ctx.tenantId),inArray(terasLoopLevel.companyId,[...scopeIds]),gte(terasLoopLevel.level,2)));
 const named=(rows:readonly {name:string|null;facts:Readonly<Record<string,unknown>>;reason:LoopActionReason|null}[]):AutonomyCardItem[]=>rows.slice(0,CORRECTIONS_SHOWN)
  .map(row=>Object.freeze({personName:row.name??null,date:isDate(row.facts.date)?row.facts.date:null,reason:row.reason}));
 const actionRows=(workerId:LoopId,companyId:string,extra:ReturnType<typeof and>)=>tx.select({id:terasLoopAction.id,facts:terasLoopAction.facts,reason:terasLoopAction.reason,name:person.fullName})
  .from(terasLoopAction).leftJoin(employment,eq(employment.id,terasLoopAction.employmentId)).leftJoin(person,eq(person.id,employment.personId))
  .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.workerId,workerId),eq(terasLoopAction.companyId,companyId),extra))
  .orderBy(desc(terasLoopAction.createdAt),desc(terasLoopAction.id));
 for(const row of levels){
  const base={workerId:row.workerId,companyId:row.companyId,companyName:row.companyName??null,href:AUTONOMY_CARD_HREF.movedDown(row.workerId)};
  if(row.level===2){
   const acted=await actionRows(row.workerId,row.companyId,and(eq(terasLoopAction.state,'applied'),gte(terasLoopAction.appliedAt,new Date(now.getTime()-DAY_MS))));
   if(acted.length)out.push(Object.freeze({kind:'acted' as const,...base,count:acted.length,items:Object.freeze(named(acted)),more:Math.max(0,acted.length-CORRECTIONS_SHOWN)}));
  }else if(row.level===3){
   const weekStart=currentWeekStart(now),sample=await weeklySampleTx(tx,ctx.tenantId,row.workerId,row.companyId,weekStart);
   const [reviewed]=await tx.select({id:terasLoopSampleReview.id}).from(terasLoopSampleReview).where(and(eq(terasLoopSampleReview.tenantId,ctx.tenantId),
    eq(terasLoopSampleReview.workerId,row.workerId),eq(terasLoopSampleReview.companyId,row.companyId),eq(terasLoopSampleReview.weekStart,weekStart))).limit(1);
   if(sample.actionIds.length&&!reviewed)out.push(Object.freeze({kind:'sample' as const,...base,weekStart,size:sample.actionIds.length,total:sample.total}));
  }
 }
 // What the loop left for people in the last 7 days, still waiting, in every company in scope.
 const left=await tx.select({workerId:terasLoopAction.workerId,companyId:terasLoopAction.companyId,companyName:company.legalName,facts:terasLoopAction.facts,
  reason:terasLoopAction.reason,name:person.fullName}).from(terasLoopAction)
  .innerJoin(terasLoopCase,and(eq(terasLoopCase.id,terasLoopAction.caseId),eq(terasLoopCase.state,'open')))
  .leftJoin(employment,eq(employment.id,terasLoopAction.employmentId)).leftJoin(person,eq(person.id,employment.personId))
  .leftJoin(company,eq(company.id,terasLoopAction.companyId))
  .where(and(eq(terasLoopAction.tenantId,ctx.tenantId),eq(terasLoopAction.state,'not_applied'),inArray(terasLoopAction.companyId,[...scopeIds]),
   gte(terasLoopAction.createdAt,new Date(now.getTime()-LEFT_ALONE_DAYS*DAY_MS)))).orderBy(desc(terasLoopAction.createdAt),desc(terasLoopAction.id));
 const groups=new Map<string,typeof left>();
 for(const row of left){const key=`${row.workerId}:${row.companyId}`;groups.set(key,[...(groups.get(key)??[]),row]);}
 for(const rows of groups.values()){
  const first=rows[0];
  out.push(Object.freeze({kind:'leftAlone' as const,workerId:first.workerId,companyId:first.companyId,companyName:first.companyName??null,count:rows.length,
   items:Object.freeze(named(rows)),more:Math.max(0,rows.length-CORRECTIONS_SHOWN),href:AUTONOMY_CARD_HREF.movedDown(first.workerId)}));
 }
 return out;
}
