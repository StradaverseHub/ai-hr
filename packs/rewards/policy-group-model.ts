/** A shared policy targets explicit legal-company/business-unit pairs, never a Cartesian product. */
import {z} from 'zod';
import {policySchema,type RewardPolicy} from './model';
export const rewardPgUuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform(value=>value.toLowerCase());
export type RewardPolicyTarget={companyId:string;businessUnitId:string};
export const rewardTargetKey=(p:RewardPolicyTarget)=>`${p.companyId}:${p.businessUnitId}`;
export const rewardPolicyTargetsSchema=z.array(z.object({companyId:rewardPgUuid,businessUnitId:rewardPgUuid}).strict()).max(500)
 .refine(rows=>new Set(rows.map(rewardTargetKey)).size===rows.length,'Select each company and business unit pair once.');
export const rewardPolicyGroupEditSchema=z.object({
 groupId:rewardPgUuid.nullable(),expectedRevision:z.number().int().min(0),name:z.string().trim().min(1).max(100),
 policy:policySchema,targets:rewardPolicyTargetsSchema,
}).strict().refine(p=>p.groupId===null?p.expectedRevision===0&&p.targets.length>0:p.expectedRevision>0,'Reload the current shared configuration.')
 .refine(p=>p.policy.seniorMembershipMode==='named-members'&&p.policy.seniorGrades.length===0&&p.policy.lumpUnitCents===null,'Future reviews use named senior membership in each review.');
export type RewardPolicyGroupEdit=z.infer<typeof rewardPolicyGroupEditSchema>;
export type RewardPolicyGroupVersion={groupId:string;versionId:string;revision:number;name:string;policy:RewardPolicy;targets:RewardPolicyTarget[]};
const versionSchema=z.object({groupId:rewardPgUuid,versionId:rewardPgUuid,revision:z.number().int().positive(),name:z.string().min(1).max(100),policy:policySchema,targets:rewardPolicyTargetsSchema}).strict();
export function parseRewardPolicyGroupVersion(raw:unknown):RewardPolicyGroupVersion{return versionSchema.parse(raw);}
export function normalizedRewardTargets(rows:readonly RewardPolicyTarget[]):RewardPolicyTarget[]{
 return rewardPolicyTargetsSchema.parse(rows).map(row=>({...row})).sort((a,b)=>rewardTargetKey(a).localeCompare(rewardTargetKey(b)));
}
/** Removing a company removes only its explicitly selected pairs. No other company is added. */
export function removeRewardTargetCompany(rows:readonly RewardPolicyTarget[],companyId:string){return rows.filter(row=>row.companyId!==companyId);}
