import {createHash} from 'node:crypto';
import { z } from 'zod';
import type { RewardEntry, RewardPolicy, RewardRole } from './model';

const money = z.number().int().min(0).max(100_000_000_000);
const bp = z.number().int().min(0).max(100_000);
const identity = z.uuid();
export const unitInputSchema = z.object({
  forecastCents: money.nullable(), actualCents: money.nullable(), targetCents: money.nullable(),
  targetMonthsBp: bp, multiplierBp: bp.nullable(),
  branchRatings: z.record(z.string().trim().min(1).max(100), z.enum(['UA','BE','ME','AE','OU'])),
}).strict();
export type RewardUnitInputs = z.infer<typeof unitInputSchema>;
export type RewardPublicGovernance={status:RewardPoolStatus;pools:{standard:number;h:number};targetMonthsBp:number;multiplierBp:number|null;branchRatings:RewardUnitInputs['branchRatings'];selectionConfirmed:boolean;previousPools:{standard:number;h:number}|null;basis:string};
export type RewardPoolStatus = 'not-set' | 'provisional' | 'final' | 'legacy';
export type RewardCheck = { proposedBy: string; confirmedBy: string | null; confirmedAt: string | null };
export type SeniorAward = { newBasicCents: number; bonusCents: number; approvalReference: string; approvalDate: string; reason: string; sourceFingerprint:string; evidence: {id:string;name:string;mime:string;size:number}[] } & RewardCheck;
export type RewardGovernance = {
  version: 1; inputs: RewardUnitInputs | null; selection: (RewardCheck & {employmentIds:string[]}) | null;
  exemption: ({reason:string} & RewardCheck) | null;
  awards: Record<string, SeniorAward>;
  previousPools: {standard:number;h:number} | null;
};
export const emptyGovernance = ():RewardGovernance => ({version:1,inputs:null,selection:null,exemption:null,awards:{},previousPools:null});
export const seniorGrade = (grade:string) => /^(?:JG\s*)?(21|22|23)$/i.test(grade.trim());
export const maySeeSeniorAmounts = (roles:readonly RewardRole[]) => roles.some(role=>role==='gr'||role==='ctro'||role==='ec');
export const poolStatus = (state:RewardGovernance|null):RewardPoolStatus => {
  if(!state?.inputs)return 'legacy';
  const input=state.inputs;
  if(input.targetCents===null||input.targetCents<=0)return 'not-set';
  if(input.actualCents!==null)return input.actualCents>0?'final':'not-set';
  return input.forecastCents!==null&&input.forecastCents>0?'provisional':'not-set';
};
export function effectiveRewardPolicy(policy:RewardPolicy,state:RewardGovernance|null):RewardPolicy {
  if(!state?.inputs)return policy;
  const status=poolStatus(state),input=state.inputs;
  return {...policy,patActual:status==='not-set'?0:input.actualCents??input.forecastCents??0,patTarget:status==='not-set'?100:input.targetCents!,targetMonthsBp:input.targetMonthsBp,
    multiplierBp:policy.bonusStructure==='branch'?10000:input.multiplierBp,branchRatings:input.branchRatings,
    exemptReason:state.exemption?.confirmedBy?state.exemption.reason:''};
}
export function confirmedSeniorAwards(state:RewardGovernance|null,entries:RewardEntry[]) {
  return Object.fromEntries(entries.flatMap(entry=>{
    const award=state?.awards[entry.id];
    return award?.confirmedBy&&award.sourceFingerprint===seniorSourceFingerprint(entry)&&award.newBasicCents>=entry.source.basicCents?[[entry.id,{newBasicCents:award.newBasicCents,bonusCents:award.bonusCents}]]:[];
  }));
}
export const seniorAwardSchema=z.object({
 entryId:identity,newBasicCents:money.nullable(),incrementBp:bp.nullable(),bonusCents:money,approvalReference:z.string().trim().min(1).max(300),approvalDate:z.iso.date(),reason:z.string().trim().min(10).max(2000),
 evidence:z.array(z.object({name:z.string().trim().min(1).max(240),mime:z.enum(['application/pdf','image/png','image/jpeg']),content:z.string().max(14_000_000)}).strict()).max(5),
}).strict().refine(value=>(value.newBasicCents===null)!==(value.incrementBp===null),'Enter an increment percentage or a new salary, not both.');
/** Frozen policy facts remain the budget owner until Group Rewards explicitly adopts unit inputs. */
export function redactPatPolicy(policy:RewardPolicy,roles:readonly RewardRole[]):RewardPolicy {
 return roles.includes('gr')?policy:{...policy,patActual:0,patTarget:100};
}

export function seniorSourceFingerprint(entry:RewardEntry){return JSON.stringify({employmentId:entry.source.employmentId,compensationId:entry.source.compensationId,basicCents:entry.source.basicCents,gradeId:entry.source.gradeId,grade:entry.source.grade});}
export function governanceBasis(policy:RewardPolicy,entries:RewardEntry[]){
 const group={year:policy.year,activeAsOf:policy.activeAsOf,minimumBonusRating:policy.minimumBonusRating,excludeNotice:policy.excludeNotice,excludeErCase:policy.excludeErCase,confirmedBy:policy.confirmedBy,blockedFrom:policy.blockedFrom,blockedTo:policy.blockedTo,payWindowKeep:policy.payWindowKeep,seniorMembershipMode:policy.seniorMembershipMode,seniorGrades:policy.seniorGrades};
 return createHash('sha256').update(JSON.stringify({group,entries:entries.map(entry=>({id:entry.id,source:entry.source,facts:{performance:entry.facts.performance,seniorPlan:entry.facts.seniorPlan,erCase:entry.facts.erCase,confidentiality:entry.facts.confidentiality}})).sort((a,b)=>a.id.localeCompare(b.id))})).digest('hex');
}

export function governanceHistoryProjection(value:unknown,visibleEntries:RewardEntry[]):RewardGovernance|null{
 if(!value||typeof value!=='object')return null;
 const state=value as RewardGovernance,ids=new Set(visibleEntries.map(entry=>entry.id)),employmentIds=new Set(visibleEntries.map(entry=>entry.source.employmentId));
 return {...state,selection:state.selection?{...state.selection,employmentIds:state.selection.employmentIds.filter(id=>employmentIds.has(id))}:null,awards:Object.fromEntries(Object.entries(state.awards??{}).filter(([id])=>ids.has(id)))};
}
