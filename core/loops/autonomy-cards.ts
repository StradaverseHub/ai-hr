/** AI v2 Phase 2 P2-1 — what the autonomy ladder puts on Today, read as the viewer in the caller's transaction.
 *  - autoFixed (the employee): a missed clock-out the loop set on their own day, while its undo window is open, with
 *    the Undo that core/loops/undo.ts carries out. Shown whether or not the loop still runs: an undo window never
 *    closes early.
 *  - movedDown (administrators): a loop that moved itself back to Prepare in a company in the viewer's current scope in
 *    the last 7 days, with the corrections that moved it, each named through the owners' row-level security.
 * Row-level security decides what each viewer reads (migration 0963): an employee their own actions, an administrator
 * the level history of companies they administer and the actions of employments they administer. Only dates, clock
 * times and the employee's own name: no figure, no reason text. */
import {and,desc,eq,gt,gte,inArray,isNull} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {company,employment,person} from '../../db/schema';
import {terasLoopAction,terasLoopActionUndo,terasLoopLevelChange} from '../../db/teras-autonomy-schema';
import type {LoopId} from './types';
import type {UndoneBy} from './autonomy-types';

const DAY_MS=86_400_000,MOVED_DOWN_DAYS=7,CORRECTIONS_SHOWN=5;
export type MovedDownCorrection=Readonly<{personName:string|null;date:string|null;kind:'undone'|'changed';by:UndoneBy|null}>;
export type AutonomyCard=
 |Readonly<{kind:'autoFixed';actionId:string;date:string;checkOut:string;undoUntil:string}>
 |Readonly<{kind:'movedDown';changeId:string;workerId:LoopId;companyName:string|null;at:string;applied:number;corrected:number;
  corrections:readonly MovedDownCorrection[];more:number;href:string}>;
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
 }
 return Object.freeze(cards);
}
