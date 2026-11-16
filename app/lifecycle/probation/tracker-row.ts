import type {ProbationSummaryRow} from '@/packs/probation/service';
import {probationLowBand} from '@/lib/probation-tracker';
/**
 * How one tracker row reads (lane M1; prototype Tracker, flagsOf, stageLabel, waitingOn). Pure: every fact comes from
 * the server-authorized summary row, and "today" is the HR calendar day the page passes in. The flag rules mirror the
 * tile counts in core/probation.ts probationSummaryRows so a row's pills agree with the tile it is counted in.
 */
type Row=ProbationSummaryRow;
type Part=Row['parts'][number];
export type TrackerTone='bad'|'warn'|'ok'|'info'|'vio'|'plain';
export type TrackerFlag={key:'end_passed'|'ending14'|'low_result'|'low_actioned'|'kpi_submit'|'kpi_ack'|'overridden'|'plan_review';tone:TrackerTone;band?:number};
const CLOSED=['confirmed','not_confirmed','withdrawn'];
const SETTLED=['locked','recorded','completed_offline','cancelled','not_issued'];
/** Calendar-day difference b − a for yyyy-mm-dd strings, without a timezone. */
const dayDiff=(a:string,b:string)=>{const day=(v:string)=>Date.UTC(+v.slice(0,4),+v.slice(5,7)-1,+v.slice(8,10));return Math.round((day(b)-day(a))/86400000);};
export const trackerRowClosed=(row:Pick<Row,'state'>)=>CLOSED.includes(row.state);
/** The review part the case is waiting on: the first part that is not settled (same rule as the tracker list today). */
export const trackerPendingPart=(row:Pick<Row,'parts'>):Part|undefined=>row.parts.find(part=>!SETTLED.includes(part.state));
/** The flags column (pills), in the prototype's order. Overdue shows in the Due column and extensions in Ext. */
export function trackerRowFlags(row:Row,today:string):TrackerFlag[]{
 const flags:TrackerFlag[]=[];
 if(trackerRowClosed(row))return flags;
 if(row.endOn<today)flags.push({key:'end_passed',tone:'bad'});
 else if(dayDiff(today,row.endOn)<=14)flags.push({key:'ending14',tone:'warn'});
 const low=row.parts.filter(part=>part.scoreBand!==null&&part.scoreBand<=probationLowBand(row)&&part.state!=='cancelled');
 const worst=low.reduce<Part|null>((best,part)=>!best||part.scoreBand!<best.scoreBand!?part:best,null);
 if(worst)flags.push({key:'low_result',tone:'bad',band:worst.scoreBand!});
 const kpi=row.parts.filter(part=>part.type===1&&!['completed_offline','cancelled'].includes(part.state));
 if(row.startOn<=today&&kpi.some(part=>!part.managerSubmittedAt))flags.push({key:'kpi_submit',tone:'warn'});
 if(kpi.some(part=>part.managerSubmittedAt&&!part.acknowledgedAt))flags.push({key:'kpi_ack',tone:'warn'});
 if(row.parts.some(part=>part.override&&part.state!=='cancelled'))flags.push({key:'overridden',tone:'vio'});
 if(row.planFlag)flags.push({key:'plan_review',tone:'warn'});
 if(low.length&&low.every(part=>part.lowResultActioned))flags.push({key:'low_actioned',tone:'ok'});
 return flags;
}
/** Rows the prototype tints: a step past its due date, or the probation end date passed with no outcome. */
export function trackerRowAttention(row:Row,today:string){
 if(trackerRowClosed(row)||row.startStatus==='waiting_for_start')return false;
 const pending=trackerPendingPart(row);
 return pending?.calendarDaysOverdue!==undefined||row.endOn<today;
}
/** Review plan second line: the review parts in this case's plan (Part 2 + Part 3, or Part 3 only), from its parts. */
export function trackerPlanParts(row:Pick<Row,'parts'>):(2|3)[]{
 return ([2,3] as const).filter(type=>row.parts.some(part=>part.type===type&&part.state!=='cancelled'));
}
/** What the person the row waits on has to do, from the same rule that names them (migration 5761 probation_tracker_page). */
export type TrackerWaitingStep='kpis'|'self'|'assessment'|'acknowledge'|'approval';
export function trackerWaitingStep(part:Part):TrackerWaitingStep{
 if(part.waitingRole==='employee')return part.type!==1&&!part.staffSubmittedAt?'self':'acknowledge';
 if(part.waitingRole==='lm'&&!part.managerSubmittedAt)return part.type===1?'kpis':'assessment';
 return 'approval';
}
