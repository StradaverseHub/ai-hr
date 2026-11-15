import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {assertModuleEnabled,isModuleEnabled} from './entitlements';
import {validateProbationOfflinePdf} from '../lib/probation-offline-pdf';
import {ProbationError,type ProbationPersonnel} from './probation';
import {employmentStatusSql} from './employment-status-sql';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {ProbationIntakeDisposition,ProbationIntakeStageOption,ProbationRequiredIntakePart,ProbationOfflineFinalDecision} from '../lib/probation-intake-model';
export type ProbationIntakeCandidate={source:ProbationPersonnel;classification:'excluded'|'held'|'ready'|'already_admitted';issues:string[];canReview:boolean;canValidate:boolean;requiredParts:ProbationRequiredIntakePart[];stageOptions:ProbationIntakeStageOption[];offlineDecisionReady:boolean;offlineDecision:ProbationOfflineFinalDecision|null;holders:{role:string;name:string;userId:string}[];sourceDigest:string;disposition:ProbationIntakeDisposition|null;evidence:{id:string;name:string;reason:string;createdAt:string}[]};
export type ProbationIntakeWorkspace={candidates:ProbationIntakeCandidate[];truncated:boolean;excludedCount:number};
const id=z.uuid();
export function probationIntakeWorkspace(ctx:SessionContext,companyId:string):Promise<ProbationIntakeWorkspace>{return withScopedLifecycleTenant(ctx,async tx=>{assertModuleEnabled(ctx,'lifecycle',id.parse(companyId));const[row]=await tx.execute<{data:ProbationIntakeWorkspace}>(sql`select app.probation_intake_workspace(${companyId}::uuid) as data`);return row.data;});}
export function saveProbationIntakeDisposition(ctx:SessionContext,input:{employmentId:string;revision:number;sourceDigest:string;kind:'exclude'|'unfinished';reason:string;validatedUnknown:boolean;exclusionFlags:ProbationIntakeDisposition['exclusionFlags'];parts:ProbationIntakeDisposition['parts'];extensionCount?:number;extensionEventIds?:string[];validatedHistory?:boolean}){return withScopedLifecycleTenant(ctx,async tx=>{
 const{employmentId,revision,sourceDigest,...data}=input;id.parse(employmentId);z.number().int().nonnegative().parse(revision);z.string().regex(/^[a-f0-9]{64}$/).parse(sourceDigest);
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_intake_save(${employmentId}::uuid,${revision},${sourceDigest},${JSON.stringify(data)}::jsonb) as id`);return row.id;
});}
export function uploadProbationCutoverEvidence(ctx:SessionContext,input:{employmentId:string;name:string;content:Buffer;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{
 id.parse(input.employmentId);await validateProbationOfflinePdf(input.content);
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_intake_upload(${input.employmentId}::uuid,${input.name},${input.content},${input.reason}) as id`);return row.id;
});}
export function readProbationCutoverEvidence(ctx:SessionContext,input:{employmentId:string;evidenceId:string}):Promise<{name:string;content:Buffer}>{return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{name:string;content:Buffer}>(sql`select * from app.probation_intake_evidence_read(${id.parse(input.employmentId)}::uuid,${id.parse(input.evidenceId)}::uuid)`);if(!row)throw new ProbationError('forbidden','The original scoped offline PDF is unavailable.');return row;});}

export function probationIntakeCompanies(ctx:SessionContext):Promise<{id:string;name:string;canPrepare:boolean}[]>{if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle')&&!ctx.entitlements?.scopedModules.lifecycle?.some(company=>isModuleEnabled(ctx,'lifecycle',company)))return Promise.resolve([]);return withScopedLifecycleTenant(ctx,async tx=>{const rows=await tx.execute<{id:string;name:string;canPrepare:boolean}>(sql`select * from app.probation_intake_companies()`);return rows.filter(row=>ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle',row.id));});}
export function proposeProbationOfflineFinalDecision(ctx:SessionContext,input:{employmentId:string;entryId:string;revision:number;evidenceId:string;outcome:ProbationOfflineFinalDecision['outcome'];extensionMonths:3|6|null;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_propose_offline_final(${id.parse(input.employmentId)}::uuid,${id.parse(input.entryId)}::uuid,${input.revision},${id.parse(input.evidenceId)}::uuid,${input.outcome},${input.extensionMonths},${input.reason}) as id`);return row.id;});}
export function adjudicateProbationOfflineFinalDecision(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;outcome:Exclude<ProbationOfflineFinalDecision['outcome'],'other'>;extensionMonths?:3|6|null;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_adjudicate_offline_final(${id.parse(input.caseId)}::uuid,${id.parse(input.partId)}::uuid,${input.revision},${input.outcome},${input.extensionMonths??null}::integer,${input.reason}) as id`);return row.id;});}

export type ProbationActivationCount={companyId:string;personnelProbation:number;openCases:number;live:boolean;activationOn:string|null};
/**
 * Intake and activation (mockup screen 11): per company, full-time employments Personnel derives as Probation today
 * against the open probation cases, both as the reader's row security shows them. One set-based statement for the
 * companies the reader may open in intake (bounded by that list), never a per-company loop.
 */
export function probationActivationCounts(ctx:SessionContext,companyIds:string[]):Promise<ProbationActivationCount[]>{
 const ids=[...new Set(companyIds.map(value=>id.parse(value)))].filter(company=>ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle',company)).slice(0,2000);
 if(!ids.length)return Promise.resolve([]);
 const today=todayInKualaLumpur();
 return withScopedLifecycleTenant(ctx,async tx=>{
  const rows=await tx.execute<ProbationActivationCount>(sql`
   with scope as (select unnest(array[${sql.join(ids.map(value=>sql`${value}::uuid`),sql`, `)}]::uuid[]) as company_id),
   personnel as (
    select employment.company_id,count(*)::integer as n from employment
    where employment.tenant_id=${ctx.tenantId}::uuid and employment.company_id in(select company_id from scope) and employment.voided_at is null and employment.import_pending_attempt_id is null
     and ${employmentStatusSql(today)}='probation'
     and exists(select 1 from assignment a where a.employment_id=employment.id and a.tenant_id=employment.tenant_id and a.valid_to is null and a.superseded_at is null and a.employment_type='full_time')
    group by employment.company_id),
   cases as (
    select c.company_id,count(*)::integer as n from probation_case c
    where c.tenant_id=${ctx.tenantId}::uuid and c.company_id in(select company_id from scope) and c.data->>'state' not in('withdrawn','confirmed','not_confirmed')
    group by c.company_id)
   select s.company_id as "companyId",coalesce(p.n,0) as "personnelProbation",coalesce(c.n,0) as "openCases",coalesce(act.enabled,false) as live,act.activation_on::text as "activationOn"
   from scope s left join personnel p on p.company_id=s.company_id left join cases c on c.company_id=s.company_id
   left join probation_activation act on act.tenant_id=${ctx.tenantId}::uuid and act.company_id=s.company_id
   order by s.company_id`);
  return [...rows];
 });
}
