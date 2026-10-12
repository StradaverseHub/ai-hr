import { z } from 'zod';
import { pmBands, potentialBands, type KPI, type Policy } from './model';

export const draftKinds = ['results', 'moderation', 'competency_self', 'competency_manager', 'feedback'] as const;
export type DraftKind = typeof draftKinds[number];
const remark = z.string().trim().max(4000);
export const assessmentDraftSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('results'), lines:z.array(z.object({id:z.uuid(),actual:z.number().finite().nullable(),note:remark})).max(100),remark}),
  z.object({kind:z.literal('moderation'), lines:z.array(z.object({id:z.uuid(),actual:z.number().finite().nullable(),note:remark})).max(100),remark}),
  z.object({kind:z.literal('competency_self'), answers:z.record(z.string().max(100),z.object({answer:z.enum(['yes','no']).nullable(),remark})),remark}),
  z.object({kind:z.literal('competency_manager'), answers:z.record(z.string().max(100),z.object({answer:z.enum(['yes','no']).nullable(),remark})),remark}),
  z.object({kind:z.literal('feedback'), answers:z.record(z.string().max(100),z.enum(['yes','no'])),remark}),
]);
export type AssessmentDraft = z.infer<typeof assessmentDraftSchema>;

/** The October source assigns ONE moderator. HR owns the assignment; the employee cannot reroute it. */
export function settingModerator(existing:KPI|undefined, reviewer:string|null, active:string[], requested?:string[], supplied?:string|null):string|null {
  if(requested && requested.length>1)throw Error('Each KPI has one assigned moderator. Approval chains are not supported.');
  const assigned=existing?.moderatorEmploymentId && active.includes(existing.moderatorEmploymentId)
    ? existing.moderatorEmploymentId : reviewer && active.includes(reviewer) ? reviewer : null;
  if(requested?.some(id=>id!==assigned)||supplied&&supplied!==assigned)
    throw Error('HR assigns the KPI moderator. Employees cannot change this assignment.');
  return assigned;
}

/** Python round(), used for the source curve's integer target headcounts (ties to even). */
export function sourceRound(value:number):number {
  const floor=Math.floor(value),fraction=value-floor;
  return fraction===0.5 ? floor%2===0?floor:floor+1 : Math.round(value);
}
export function curveTolerance(policy:Policy,count:number):number {
  if(count<=0)return 0;
  return policy.curveToleranceMode==='people'
    ? Math.min(policy.curveTolerancePeople,count)
    : Math.max(1,Math.floor(count*policy.curveTolerancePct/100+0.5));
}
export function curveGaps<B extends string>(bands:readonly B[],counts:Record<B,number>,target:Record<B,number>):Record<B,number> {
  const count=bands.reduce((n,b)=>n+counts[b],0);
  return Object.fromEntries(bands.map(b=>[b,sourceRound(target[b]/100*count)-counts[b]])) as Record<B,number>;
}
export function assertCurveLock(policy:Policy,tier:string,rows:{performance:typeof pmBands[number]|null;potential:typeof potentialBands[number]|null}[],reference:Record<typeof pmBands[number],number>|null,axes:{pm:boolean;pot:boolean},reason:string):void {
  // Department reviews are person decisions. BG and Group aggregate/override; only BU has a curve gate.
  if(tier!=='bu')return;
  const tolerance=curveTolerance(policy,rows.length);
  const gaps:number[]=[];
  if(axes.pm&&reference)gaps.push(...Object.values(curveGaps(pmBands,Object.fromEntries(pmBands.map(b=>[b,rows.filter(r=>r.performance===b).length])) as Record<typeof pmBands[number],number>,reference)));
  if(axes.pot)gaps.push(...Object.values(curveGaps(potentialBands,Object.fromEntries(potentialBands.map(b=>[b,rows.filter(r=>r.potential===b).length])) as Record<typeof potentialBands[number],number>,{Low:15,Mid:70,High:15})));
  if(!gaps.some(g=>Math.abs(g)>tolerance))return;
  if(policy.curveStrict)throw Error('Adjust the bands toward the reference curve before locking. Strict calibration does not allow an override.');
  if(!reason.trim())throw Error('The reference distribution needs an override reason.');
}

export type JourneyState='open'|'waiting'|'done'|'later'|'off';
export type JourneyStage={key:string;module:'pm'|'tm'|'idp';state:JourneyState;group:'self'|'team'};
/** A presentation dependency from the source journey. The underlying year-round plan remains accessible. */
export function careerPlanLocked(stages:JourneyStage[]):boolean {
  return stages.some(s=>s.group==='self'&&['account','checkin','competency'].includes(s.key)&&['open','waiting'].includes(s.state));
}
export function careerPlanState(ahead:JourneyState|undefined,career:JourneyState|undefined,locked=false):JourneyState|null {
  const live=[ahead,career].filter((s):s is JourneyState=>!!s&&s!=='off');
  if(!live.length)return null;
  if(locked)return 'later';
  if(live.some(s=>s==='open'||s==='waiting'))return 'open';
  return live.every(s=>s==='done')?'done':'later';
}
