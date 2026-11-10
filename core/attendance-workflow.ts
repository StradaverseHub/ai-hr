import { AttendanceWorkflowSubmissionError } from '../lib/attendance-workflow-submission';
import { nextAttendanceWorkflowPriority } from '@/lib/attendance-workflow';
import { createHash, randomUUID } from 'node:crypto';
import {getTableColumns as templateColumnsOf, and, asc, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
import { withAttendanceTenant as withTenant,assertModuleGate } from './module-gate';
import { actorOf, appendEvent, type AppendEventArgs } from '../db/events';
import { attendanceWorkflowPreview as previewSnapshot, company, attendanceWorkflowTemplate as template, attendanceWorkflowSetting as setting, attendanceWorkflowRequest as request, attendanceWorkflowDecision as decision, attendanceWorkflowReassignment as reassignment, attendanceWorkflowParticipantDecision as participantDecision, attendanceWorkflowParticipantReassignment as participantReassignment, domainEvent, employment, person, department, businessUnit, jobGrade, profileOption, position } from '../db/schema';
import { approversOf } from '../lib/leave-approval-kinds';
import { todayInKualaLumpur } from '../lib/hr-date';
import { resolveOrgCriteriaTargets } from './org-criteria';
import { assertCanDecide } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { CATEGORY_EMPLOYMENT_COLUMN, EMPLOYMENT_PROFILE_CATEGORIES } from './profile-options';
import { labelUsableByCompany } from './system-labels';
import { AttendanceWorkflowError, attendanceScopesOverlap, attendanceCriteriaGroups, attendanceStageLevelNumber, validateAttendanceWorkflow, type AttendanceWorkflowInput, type AttendanceApplicationType, type AttendanceResolvedStage, type AttendanceResolvedApprover, type AttendanceSkippedLevel, type AttendanceCriteriaGroup } from '../lib/attendance-workflow';
import { ATTENDANCE_PREVIEW_ROW_LIMIT, ATTENDANCE_PREVIEW_HISTORY_LIMIT, ATTENDANCE_SUPERIOR_PROBLEMS, type AttendanceSuperiorProblem, type AttendanceWorkflowPreviewEmployee, type AttendanceWorkflowPreviewWarning } from '../lib/attendance-workflow-preview';
import { AttendanceLevelError, type AttendanceLevelProblem, type AttendanceV3FrozenLevel } from '../lib/attendance-workflow-v3';
import {validateAnyAttendanceWorkflow,attendanceWorkflowConfiguration,type AnyAttendanceWorkflowInput} from '../lib/attendance-workflow-config';
import {AttendanceCcError,type AttendanceCcSource,type AttendanceCcRecipient} from '../lib/attendance-workflow-v4';
export type { AnyAttendanceWorkflowInput } from '../lib/attendance-workflow-config';
export { AttendanceWorkflowError } from '../lib/attendance-workflow';
export type { AttendanceWorkflowInput, AttendanceApplicationType } from '../lib/attendance-workflow';
async function adminFor(tx: Tx, companyId: string) {
    const rows = await tx.execute(sql `select app.is_admin_for(c.id) as ok from company c where c.id=${companyId}::uuid and c.tenant_id=app.current_tenant_id()`);
    if (!(rows as unknown as {
        ok: boolean;
    }[])[0]?.ok)
        throw new AttendanceWorkflowError('scope', 'Only an administrator for this company may configure attendance workflows.');
}
const companyLock = (tx: Tx, tenantId: string, companyId: string, type: string) => tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${tenantId + ':attendance-workflow:' + companyId + ':' + type},0))`);
/** All-company scope includes future companies; a complete list of today's grants is insufficient. */
async function allCompanyAuthority(tx:Tx){const [row]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_admin_for(NULL::uuid) as ok`);return row?.ok===true;}
async function configurationCompanies(tx:Tx,input:AnyAttendanceWorkflowInput){
 if(!input.allCompanies)return input.companyIds??[input.companyId];
 if(!await allCompanyAuthority(tx))throw new AttendanceWorkflowError('scope','All Company requires organisation-wide administration.');
 return (await tx.select({id:company.id}).from(company).where(eq(company.tenantId,sql`app.current_tenant_id()`)).orderBy(asc(company.id))).map(c=>c.id);
}
/** Shared by every submission and configuration mutation; acquire before company/lineage locks. */
const configurationLock=(tx:Tx,tenantId:string,type:string)=>tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId+':attendance-workflow-scope:'+type},0))`);
const templateColumns=()=>templateColumnsOf(template);
const applies=(companyId:string)=>sql`app.attendance_workflow_applies(${template.id},${companyId}::uuid)`;
const used=sql<boolean>`exists(select 1 from attendance_workflow_request w join attendance_workflow_template historical on historical.id=w.template_id and historical.tenant_id=w.tenant_id where historical.lineage_id=${template.lineageId} and historical.tenant_id=app.current_tenant_id())`.as('used');
const assignments=sql<string[]>`app.attendance_workflow_companies(${template.id})`.as('companyIds');
async function assignedCompanies(tx:Tx,id:string){const [row]=await tx.execute<{ids:string[]}>(sql`select app.attendance_workflow_companies(${id}::uuid) as ids`);return row?.ids??[];}
async function requireAllCompanies(tx:Tx,ids:string[]){if(!ids.length)throw new AttendanceWorkflowError('scope','This shared workflow requires permission for every assigned company.');for(const id of ids)await adminFor(tx,id);}
async function validateScope(tx: Tx, ctx: SessionContext, input: AnyAttendanceWorkflowInput) {
    if (input.routingVersion === 3 || input.routingVersion === 4) {
        const selected=input.stages.flatMap(stage=>'sources' in stage?stage.sources:[stage.source]).flatMap(source=>source.kind==='specific_employee'?source.employmentIds:[]);
        if(selected.length){
         const visible=await tx.select({id:employment.id}).from(employment).where(and(inArray(employment.id,selected),sql`app.is_admin_for(${employment.companyId}) and app.access_workforce_employment(${employment.id},'workforce.view')`));
         const allowed=new Set(visible.map(row=>row.id));
         for(const [levelIndex,stage] of input.stages.entries())for(const source of 'sources' in stage?stage.sources:[stage.source])if(source.kind==='specific_employee')for(const [participantIndex,id] of source.employmentIds.entries())if(!allowed.has(id))throw new AttendanceLevelError({code:'employee_unavailable',levelIndex,participantIndex});
        }
    }

    // Every OR group is validated by the same per-field rules. A company-scoped label needs only to be
    // usable by one workflow company: in another company that group simply matches nobody.
    const groups = attendanceCriteriaGroups(input.criteria);
    const union = (key: keyof AttendanceCriteriaGroup) => [...new Set(groups.flatMap(group => group[key] ?? []))];
    const companies = await configurationCompanies(tx, input);
    for (const [key, table] of [['departmentIds', department], ['businessUnitIds', businessUnit], ['gradeIds', jobGrade], ['positionIds', position]] as const) {
        const ids = union(key);
        if (ids.length) {
            const found = await tx.select({ id: table.id }).from(table).where(and(inArray(table.id, ids), isNull(table.archivedAt)));
            if (found.length !== ids.length)
                throw new AttendanceWorkflowError('invalid', 'An organisational assignment is missing, inactive or outside your access.');
            if (key !== 'gradeIds')
                for (const id of ids) {
                    let usable = false;
                    for (const companyId of companies) if (await labelUsableByCompany(tx, ctx.tenantId, key === 'departmentIds' ? 'department' : key === 'positionIds' ? 'position' : 'business_unit', id, companyId)) { usable = true; break; }
                    if (!usable) throw new AttendanceWorkflowError('invalid', 'An organisational assignment is not available to this company.');
                }
        }
    }
    for (const category of EMPLOYMENT_PROFILE_CATEGORIES) {
        const key = CATEGORY_EMPLOYMENT_COLUMN[category]?.[0] as keyof AttendanceCriteriaGroup;
        const selected = union(key);
        if (!selected.length) continue;
        const rows = await tx.select({ value: profileOption.value }).from(profileOption).where(and(eq(profileOption.category, category), inArray(profileOption.value, selected), eq(profileOption.isActive, true)));
        if (new Set(rows.map(r => r.value)).size !== selected.length) throw new AttendanceWorkflowError('invalid', `An assignment in ${category} is missing or inactive.`);
    }
    const selectedEmployees = union('employeeIds');
    if (selectedEmployees.length) {
        const rows = await resolveOrgCriteriaTargets(tx, { criteria: { companyIds: companies }, asOf: todayInKualaLumpur(), employmentIds: selectedEmployees });
        if (rows.length !== selectedEmployees.length) throw new AttendanceWorkflowError('invalid', 'An employee is missing, inactive or outside the selected company.');
    }

}
/** Employee IDs are an additional intersected restriction within their own group, not a new org-criteria interpretation. */
async function groupTargets(tx: Tx, group: AttendanceCriteriaGroup, companyId: string, employmentIds?: string[]) {
    const { employeeIds = [], ...orgCriteria } = group;
    const restricted = employeeIds.length ? employmentIds?.length ? employmentIds.filter(id => employeeIds.includes(id)) : employeeIds : employmentIds;
    if (employmentIds?.length && employeeIds.length && !restricted?.length) return [];
    return resolveOrgCriteriaTargets(tx, { criteria: { ...orgCriteria, companyIds: [companyId] }, asOf: todayInKualaLumpur(), employmentIds: restricted });
}
/**
 * The one assignment matcher used by preview, save and submission: an employee is assigned when they
 * match every chosen field of ANY group. A legacy flat assignment is exactly one group.
 */
async function workflowTargets(tx: Tx, criteria: AnyAttendanceWorkflowInput['criteria'], companyId: string, employmentIds?: string[]) {
    const groups = attendanceCriteriaGroups(criteria);
    if (groups.length === 1) return groupTargets(tx, groups[0], companyId, employmentIds);
    const found = new Set<string>();
    for (const group of groups) {
        const remaining = employmentIds?.filter(id => !found.has(id));
        if (employmentIds?.length && !remaining?.length) break;
        for (const id of await groupTargets(tx, group, companyId, remaining)) found.add(id);
    }
    return [...found];
}
async function resolveV4(tx:Tx,employmentId:string,stages:AnyAttendanceWorkflowInput['stages'],cc:AttendanceCcSource[]) {
 const [row]=await tx.execute(sql`select app.attendance_workflow_resolve_v4(${employmentId}::uuid,${JSON.stringify(stages)}::jsonb,${JSON.stringify(cc)}::jsonb) as result`) as unknown as {result:{ok:true;stages:AttendanceResolvedStage[];cc:AttendanceCcRecipient[];skipped?:AttendanceSkippedLevel[]}|{ok:false;problem:AttendanceLevelProblem}}[];
 if(!row?.result)throw new AttendanceLevelError({code:'employee_unavailable',levelIndex:null});
 if(!row.result.ok){if(row.result.problem.code==='invalid_route'&&row.result.problem.levelIndex===null)throw new AttendanceCcError('unavailableCc');throw new AttendanceLevelError(row.result.problem);}
 return {...row.result,skipped:row.result.skipped??[]};
}
async function resolveStages(tx: Tx, employmentId: string, configured: AnyAttendanceWorkflowInput['stages'], routingVersion: 1 | 2 | 3 | 4 = 1, cc: AttendanceCcSource[] = []): Promise<AttendanceResolvedStage[]> {
    if (routingVersion === 4) return (await resolveV4(tx,employmentId,configured,cc)).stages;
    if (routingVersion === 3) {
        try {
            const [result] = await tx.execute(sql`select app.attendance_workflow_resolve_v3(${employmentId}::uuid,${JSON.stringify(configured)}::jsonb) as result`) as unknown as { result: { ok: true; stages: AttendanceV3FrozenLevel[] } | { ok: false; problem: AttendanceLevelProblem } }[];
            if (!result?.result) throw new AttendanceLevelError({ code: 'employee_unavailable', levelIndex: null });
            if (!result.result.ok) throw new AttendanceLevelError(result.result.problem);
            return result.result.stages;
        } catch (error) {
            if (error instanceof AttendanceLevelError) throw error;
            throw new AttendanceLevelError({ code: 'employee_unavailable', levelIndex: null });
        }
    }
    // V3 has its own exact parser; legacy stages retain the unchanged Leave-compatible vocabulary.
    const stages = configured as AttendanceWorkflowInput['stages'];
    if (routingVersion === 2) {
        try {
            const [row] = await tx.execute(sql`select app.attendance_workflow_resolve_v2(${employmentId}::uuid,${JSON.stringify(stages)}::jsonb) as stages`) as unknown as { stages: AttendanceResolvedStage[] }[];
            if (!row?.stages?.length) throw new AttendanceWorkflowError('unresolved', 'No valid hierarchy approvers could be resolved. Contact HR to correct the reporting relationship.');
            return row.stages;
        } catch (error) {
            if (error instanceof AttendanceWorkflowError) throw error;
            throw new AttendanceWorkflowError('unresolved', 'A required Direct Superior is missing, inactive, repeated or outside the permitted hierarchy. Contact HR to correct the relationship or explicitly configure an HR alternative.');
        }
    }
    const needsManager = stages.some(stage => approversOf(stage.level).some(actor => actor.kind === 'direct_manager'));
    const managers = needsManager
        ? await tx.execute(sql `select * from app.attendance_workflow_manager(${employmentId}::uuid)`) as unknown as {
            employment_id: string;
            full_name: string;
        }[]
        : [];
    const needsHr = stages.some(stage => approversOf(stage.level).some(actor => actor.kind === 'hr_admin'));
    const hr = needsHr
        ? await tx.execute(sql `select app.attendance_workflow_has_hr(${employmentId}::uuid) as ok`) as unknown as {
            ok: boolean;
        }[]
        : [];
    for (const stage of stages) {
        const usable = approversOf(stage.level).some(actor => actor.kind === 'direct_manager' ? managers.length === 1 : hr[0]?.ok === true);
        if (!usable) {
            throw new AttendanceWorkflowError('unresolved', 'This approval stage has no active non-self approver with authority for the employee. Assign another authorised HR administrator or change the stage before activating or submitting.');
        }
    }
    return stages.map(stage => ({
        name: stage.name,
        approvers: approversOf(stage.level).flatMap<AttendanceResolvedApprover>(actor => actor.kind === 'direct_manager'
            ? managers.length === 1 ? [{ kind: 'direct_manager' as const, employmentId: managers[0].employment_id, name: managers[0].full_name }] : []
            : hr[0]?.ok === true ? [{ kind: 'hr_admin' as const, employmentId: null, name: 'HR administrators' }] : []),
    }));
}
export type AttendanceWorkflowWarning={employmentId:string;employeeCode:string|null;name:string;companyId:string;levelIndex:number|null;problem:AttendanceLevelProblem|null;legacy:boolean};
async function validateActivation(tx: Tx, ctx: SessionContext, input: AnyAttendanceWorkflowInput, lineageId?: string,checkOverlap=true,strict=true,resolveEmployees=true) {
    const warnings:AttendanceWorkflowWarning[]=[];
    const others = await tx.select().from(template).where(and(applies(input.companyId), eq(template.applicationType, input.applicationType), eq(template.active, true), isNull(template.supersededAt)));
    if (checkOverlap&&others.some(t => t.lineageId !== lineageId && t.priority === input.priority && attendanceScopesOverlap(t.criteria, input.criteria)))
        throw new AttendanceWorkflowError('overlap', 'An active workflow at this priority overlaps this assignment. Use a different priority or disjoint scope. Lower priority numbers apply first.');
    const targets=await workflowTargets(tx,input.criteria,input.companyId);
    const warning=async(id:string,problem:AttendanceLevelProblem|null)=>{const [who]=await tx.select({name:person.fullName,employeeCode:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.id,id));warnings.push({employmentId:id,employeeCode:who?.employeeCode??null,name:who?.name??id,companyId:input.companyId,levelIndex:problem?.levelIndex??null,problem,legacy:!problem});};
    const sources=input.routingVersion===3?input.stages.map(stage=>stage.source):input.routingVersion===4?input.stages.flatMap(stage=>stage.sources):[];
    const selected=sources.flatMap(source=>source.kind==='specific_employee'?source.employmentIds:[]);
    if(selected.length){
     const [conflict]=await tx.execute<{bad:boolean}>(sql`select exists(select 1 from employment candidate where candidate.id in (${sql.join(selected.map(id=>sql`${id}::uuid`),sql`, `)}) and (exists(select 1 from employment subject where subject.id=any(ARRAY[${sql.join(targets.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) and subject.person_id=candidate.person_id) or exists(select 1 from employment other where other.id in (${sql.join(selected.map(id=>sql`${id}::uuid`),sql`, `)}) and other.id<>candidate.id and other.person_id=candidate.person_id))) as bad`);
     if(conflict?.bad)throw new AttendanceLevelError({code:'self_approval',levelIndex:null});
    }
    // Save checks the configuration only; per-employee routes are Preview Assignment warnings and are
    // always resolved again, and refused if unresolved, at submission.
    for(const id of resolveEmployees?targets:[]){
     try{await tx.transaction(nested=>resolveStages(nested,id,input.stages,input.routingVersion,input.routingVersion===4?input.cc:[]));}
     catch(error){
      if(error instanceof AttendanceLevelError&&error.problem.levelIndex!==null){
       const stage=input.stages[error.problem.levelIndex];
       const sources=stage&&('sources' in stage?stage.sources:'source' in stage?[stage.source]:[])||[];
       const dynamic=sources.some(source=>source.kind==='direct_manager');
       if(sources.some(source=>source.kind==='specific_employee')&&['employee_unavailable','missing_or_ambiguous_login'].includes(error.problem.code)){await warning(id,error.problem);continue;}
       if(dynamic&&['missing_superior','ambiguous_superior','cycle','inactive_superior','outside_company_scope','missing_or_ambiguous_login','missing_person'].includes(error.problem.code)){await warning(id,error.problem);continue;}
      }
      if(error instanceof AttendanceLevelError&&error.problem.code==='hr_unavailable'){await warning(id,error.problem);continue;}
      if(error instanceof AttendanceWorkflowError&&error.code==='unresolved'){await warning(id,null);continue;}
      if(!strict&&(error instanceof AttendanceLevelError||error instanceof AttendanceWorkflowError&&error.code==='unresolved')){await warning(id,error instanceof AttendanceLevelError?error.problem:null);continue;}
      throw error;
     }
    }
    // Submission still resolves every required level and never treats an unresolved route as approved.
    return warnings;
}
export type AttendanceWorkflowCopySource = { lineageId: string; version: number };
export async function saveAttendanceWorkflow(ctx: SessionContext, raw: unknown, lineageId?: string, restoreVersion?:number, autoPriority = false, saveRequestId?:string, copiedFrom?: AttendanceWorkflowCopySource) {
    if (copiedFrom !== undefined && (lineageId !== undefined || !copiedFrom || typeof copiedFrom !== 'object' || typeof copiedFrom.lineageId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(copiedFrom.lineageId) || !Number.isInteger(copiedFrom.version) || copiedFrom.version < 1))
        throw new AttendanceWorkflowError('invalid', 'Reopen the copied workflow before saving.');
    const input = validateAnyAttendanceWorkflow(raw);
    if(saveRequestId!==undefined&&(!ctx.userId||typeof saveRequestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saveRequestId)))
        throw new AttendanceWorkflowError('invalid','Reload the workflow form before saving.');
    const intent = saveRequestId ? createHash('sha256').update(JSON.stringify({version:1,input,lineageId,restoreVersion,autoPriority})).digest('hex') : undefined;
    return withTenant(ctx, async (tx) => {
        if(saveRequestId&&ctx.userId)await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':attendance-workflow-save:'+ctx.userId+':'+saveRequestId.toLowerCase()},0))`);
        await configurationLock(tx,ctx.tenantId,input.applicationType);
        // Serialize the lineage before discovering its complete prior assignment set.
        if(lineageId)await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':attendance-workflow-lineage:'+lineageId},0))`);
        const existing=lineageId?(await tx.select().from(template).where(eq(template.lineageId,lineageId)).orderBy(desc(template.version)).limit(1))[0]:undefined;
        const previousCompanies=existing?await assignedCompanies(tx,existing.id):[];
        if(existing)await requireAllCompanies(tx,previousCompanies);
        if(existing?.allCompanies&&!await allCompanyAuthority(tx))throw new AttendanceWorkflowError('scope','All Company requires organisation-wide administration.');
        const companies=await configurationCompanies(tx,input);
        for(const companyId of [...new Set([...previousCompanies,...companies])].sort()){await adminFor(tx,companyId);await companyLock(tx,ctx.tenantId,companyId,input.applicationType);}
        if(saveRequestId&&ctx.userId){
            const [receipt]=await tx.select({payload:domainEvent.payload}).from(domainEvent).where(and(
                eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.aggregateType,'attendance-workflow-save'),
                eq(domainEvent.aggregateId,saveRequestId),eq(domainEvent.eventType,'attendance-workflow-save.completed'),eq(domainEvent.actorId,ctx.userId),
            )).limit(1);
            if(receipt){
                const payload=receipt.payload as {intent:string;templateId:string} | null;
                if(!payload||payload.intent!==intent)throw new AttendanceWorkflowError('stale','This save attempt belongs to an earlier edit. Reopen the workflow before saving.');
                const [saved]=await tx.select().from(template).where(and(eq(template.id,payload.templateId),isNull(template.supersededAt),isNull(template.retiredAt))).limit(1);
                if(!saved)throw new AttendanceWorkflowError('stale','The workflow changed after this save. Reopen it before saving again.');
                return {...saved,companyIds:companies};
            }
        }
        let [old] = lineageId ? await tx.select().from(template).where(and(eq(template.lineageId, lineageId), isNull(template.supersededAt))).for('update') : [];
        if(old && restoreVersion!==undefined)throw new AttendanceWorkflowError('stale','This workflow already has a current version. Reload before restoring.');
        if (!old && lineageId && restoreVersion!==undefined) {
            [old]=await tx.select().from(template).where(and(eq(template.lineageId,lineageId),isNotNull(template.retiredAt))).orderBy(desc(template.version)).limit(1).for('update');
            if(!old||old.version!==restoreVersion)throw new AttendanceWorkflowError('stale','The retained configuration changed. Reload before restoring.');
        }
        if (lineageId && (!old || old.applicationType !== input.applicationType))
            throw new AttendanceWorkflowError('scope', 'The workflow was changed or is outside this company.');
        if(old&&input.expectedVersion!==undefined&&old.version!==input.expectedVersion)throw new AttendanceWorkflowError('stale','The workflow changed. Reopen it before saving.');
        if (!lineageId && autoPriority) {
            const current = await tx.select({ priority: template.priority }).from(template).where(and(
                sql`app.attendance_workflow_companies(${template.id}) && ARRAY[${sql.join(companies.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`, eq(template.applicationType, input.applicationType),
                isNull(template.supersededAt),
            ));
            const priority = nextAttendanceWorkflowPriority(current.map(row => row.priority));
            if (priority > 9999) throw new AttendanceWorkflowError('overlap', 'All automatic workflow priorities are in use.');
            input.priority = priority;
        }
        // Provenance only: the source must be a workflow this administrator may manage. Nothing is written to it.
        if(copiedFrom){const [source]=await tx.select({id:template.id}).from(template).where(and(eq(template.lineageId,copiedFrom.lineageId),eq(template.version,copiedFrom.version),sql`app.attendance_workflow_all_companies_admin(${template.id})`)).limit(1);if(!source)throw new AttendanceWorkflowError('scope','The copied workflow is not available.');}
        await validateScope(tx,ctx,input);
        for(const companyId of companies){const scoped={...input,companyId};await validateActivation(tx,ctx,scoped,lineageId,input.active,true,false);
         const duplicate=await tx.select({lineageId:template.lineageId}).from(template).where(and(applies(companyId),eq(template.code,input.code),isNull(template.supersededAt)));
         if(duplicate.some(row=>row.lineageId!==lineageId))throw new AttendanceWorkflowError('invalid','Workflow Code is already used in a selected company.');
        }
        if (old && !old.retiredAt)
            await tx.update(template).set({ supersededAt: new Date() }).where(eq(template.id, old.id));
        const lineage = lineageId ?? randomUUID();
        const {companyIds:_companies,expectedVersion:_expected,...configuration}=input;
        const [row] = await tx.insert(template).values({ tenantId: ctx.tenantId, ...configuration, lineageId: lineage, version: (old?.version ?? 0) + 1 }).returning();
        for(const companyId of companies.filter(id=>id!==input.companyId))await tx.execute(sql`insert into attendance_workflow_company(tenant_id,template_id,company_id) values(${ctx.tenantId}::uuid,${row.id}::uuid,${companyId}::uuid)`);
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-workflow-template', aggregateId: lineage, eventType: old?.retiredAt?'attendance-workflow-template.restored':old ? 'attendance-workflow-template.versioned' : 'attendance-workflow-template.created', actor: actorOf(ctx), payload: { companyId: input.companyId, templateId: row.id, version: row.version, before: old ?? null, after: input, ...(copiedFrom?{copiedFrom:{lineageId:copiedFrom.lineageId,version:copiedFrom.version}}:{}) } });
        if(saveRequestId)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-workflow-save',aggregateId:saveRequestId,eventType:'attendance-workflow-save.completed',actor:actorOf(ctx),payload:{intent,templateId:row.id}});
        return {...row,companyIds:companies};
    });
}
export async function attendanceWorkflowWarningPage(ctx:SessionContext,lineageId:string,companyIds:string[],offset=0){
 if(!Number.isInteger(offset)||offset<0||offset>100000)throw new AttendanceWorkflowError('invalid','Choose a valid warning page.');
 const row=await getAttendanceWorkflow(ctx,lineageId,companyIds);if(!row)throw new AttendanceWorkflowError('scope','The workflow is not available.');
 return withTenant(ctx,async tx=>{const input=attendanceWorkflowConfiguration(row),warnings:AttendanceWorkflowWarning[]=[];for(const companyId of await configurationCompanies(tx,input)){await adminFor(tx,companyId);warnings.push(...await validateActivation(tx,ctx,{...input,companyId},lineageId,false,false));}return{rows:warnings.slice(offset,offset+50),total:warnings.length,offset,hasMore:offset+50<warnings.length};});
}
function manageableInScope(companyIds:string[]){return sql`app.attendance_workflow_all_companies_admin(${template.id}) and app.attendance_workflow_companies(${template.id}) && ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;}
export function listAttendanceWorkflows(ctx:SessionContext,companyIds:string[]){
 return withTenant(ctx,tx=>companyIds.length?tx.select({...templateColumns(),companyIds:assignments,used}).from(template).where(and(manageableInScope(companyIds),isNull(template.supersededAt))).orderBy(asc(template.applicationType),asc(template.priority),asc(template.code)):Promise.resolve([]));
}
export function getAttendanceWorkflow(ctx:SessionContext,lineageId:string,companyIds:string[],includeRetired=false){
 return withTenant(ctx,async tx=>companyIds.length?(await tx.select({...templateColumns(),companyIds:assignments,used}).from(template).where(and(eq(template.lineageId,lineageId),manageableInScope(companyIds),includeRetired?undefined:isNull(template.supersededAt))).orderBy(desc(template.version)).limit(1))[0]??null:null);
}
export function listRetiredAttendanceWorkflows(ctx:SessionContext,companyIds:string[]){
 return withTenant(ctx,tx=>companyIds.length?tx.select({...templateColumns(),companyIds:assignments,used}).from(template).where(and(manageableInScope(companyIds),isNotNull(template.retiredAt),sql`not exists(select 1 from attendance_workflow_template later where later.tenant_id=${template.tenantId} and later.lineage_id=${template.lineageId} and later.version>${template.version})`)).orderBy(asc(template.code)):Promise.resolve([]));
}
export async function retireAttendanceWorkflow(ctx:SessionContext,lineageId:string,expectedVersion:number){return removeAttendanceWorkflow(ctx,lineageId,expectedVersion,false);}
export async function archiveAttendanceWorkflow(ctx:SessionContext,lineageId:string,expectedVersion:number){return removeAttendanceWorkflow(ctx,lineageId,expectedVersion,true);}
async function removeAttendanceWorkflow(ctx:SessionContext,lineageId:string,expectedVersion:number,archive:boolean){
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(lineageId)||!Number.isInteger(expectedVersion)||expectedVersion<1)throw new AttendanceWorkflowError('invalid','Reload the workflow before changing it.');
 return withTenant(ctx,async tx=>{
  const [old]=await tx.select().from(template).where(and(eq(template.lineageId,lineageId),isNull(template.supersededAt))).limit(1);
  if(!old)throw new AttendanceWorkflowError('stale','The workflow changed. Reload before changing it.');
  await configurationLock(tx,ctx.tenantId,old.applicationType);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':attendance-workflow-lineage:'+lineageId},0))`);
  const companies=await assignedCompanies(tx,old.id);await requireAllCompanies(tx,companies);
  if(old.allCompanies&&!await allCompanyAuthority(tx))throw new AttendanceWorkflowError('scope','All Company requires organisation-wide administration.');
  for(const id of companies.sort())await companyLock(tx,ctx.tenantId,id,old.applicationType);
  try{await tx.execute(sql`select app.attendance_workflow_remove(${lineageId}::uuid,${expectedVersion},${archive})`);}
  catch(error){const top=error as {code?:string;cause?:{code?:string}};const code=top.cause?.code??top.code;if(code==='P5101')throw new AttendanceWorkflowError('inUse','This workflow has already been used by approval transactions and cannot be deleted. Please archive it instead.');if(code==='P5102')throw new AttendanceWorkflowError('stale','The workflow changed. Reload before changing it.');throw error;}

  return{companyId:old.companyId,applicationType:old.applicationType};
 });
}
export async function restoreAttendanceWorkflow(ctx:SessionContext,lineageId:string,expectedVersion:number,companyIds:string[]) {
 const retained=await getAttendanceWorkflow(ctx,lineageId,companyIds,true);
 if(!retained?.retiredAt||retained.version!==expectedVersion)throw new AttendanceWorkflowError('stale','The retained workflow changed. Reload before restoring.');
 return saveAttendanceWorkflow(ctx,attendanceWorkflowConfiguration(retained),lineageId,expectedVersion);
}
/** Retained for compatibility with the pre-publication settings model. Submission uses active templates directly. */
export function listAttendanceWorkflowSettings(ctx: SessionContext, companyIds: string[]) {
    return withTenant(ctx, tx => companyIds.length ? tx.select().from(setting).where(inArray(setting.companyId, companyIds)).orderBy(asc(setting.companyId), asc(setting.applicationType)) : Promise.resolve([]));
}
export async function setAttendanceWorkflowEnabled(ctx: SessionContext, companyId: string, applicationType: AttendanceApplicationType, enabled: boolean) {
    if (!['irregularity', 'self_overtime'].includes(applicationType))
        throw new AttendanceWorkflowError('invalid', 'Choose a supported attendance application type.');
    return withTenant(ctx, async (tx) => {
        await adminFor(tx, companyId);
        await companyLock(tx, ctx.tenantId, companyId, applicationType);
        if (enabled) {
            const active = await tx.select().from(template).where(and(applies(companyId), eq(template.applicationType, applicationType), eq(template.active, true), isNull(template.supersededAt)));
            if (!active.length)
                throw new AttendanceWorkflowError('invalid', 'Create and activate valid templates before enabling routing.');
            for (const row of active) {
                const input = attendanceWorkflowConfiguration({...row,companyId,companyIds:await assignedCompanies(tx,row.id),active:true});
                await validateScope(tx, ctx, input);
                await validateActivation(tx, ctx, input, row.lineageId);
            }
        }
        const [previous] = await tx.select().from(setting).where(and(eq(setting.companyId, companyId), eq(setting.applicationType, applicationType)));
        await tx.insert(setting).values({ tenantId: ctx.tenantId, companyId, applicationType, enabled }).onConflictDoUpdate({ target: [setting.tenantId, setting.companyId, setting.applicationType], set: { enabled, updatedAt: new Date() } });
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-workflow-setting', aggregateId: companyId, eventType: 'attendance-workflow.routing.changed', actor: actorOf(ctx), payload: { companyId, applicationType, before: previous?.enabled ?? false, after: enabled } });
    });
}
/** New requests require a configured route. Existing rows retain their immutable snapshot/legacy decisions. */
export async function prepareAttendanceWorkflowSnapshotTx(tx:Tx,ctx:SessionContext,employmentId:string,applicationType:AttendanceApplicationType){
    assertModuleGate(ctx,'attendance');
    const [subject] = await tx.select({ companyId: employment.companyId }).from(employment).where(eq(employment.id, employmentId)).limit(1);
    if (!subject)
        throw new AttendanceWorkflowError('scope', 'The employee is not visible.');
    // Match the lifecycle owner's exclusive lock before any company lock.
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${ctx.tenantId + ':attendance-workflow-scope:' + applicationType},0))`);
    await companyLock(tx, ctx.tenantId, subject.companyId, applicationType);
    const candidates = await tx.select().from(template).where(and(applies(subject.companyId), eq(template.applicationType, applicationType), eq(template.active, true), isNull(template.supersededAt), isNull(template.retiredAt))).orderBy(asc(template.priority), asc(template.id));
    const matches: typeof candidates = [];
    for (const row of candidates)
        if ((await workflowTargets(tx, row.criteria, subject.companyId, [employmentId])).includes(employmentId))
            matches.push(row);
    if (!matches.length)
        throw new AttendanceWorkflowSubmissionError('noMatch');
    if (matches.filter(row => row.priority === matches[0].priority).length !== 1)
        throw new AttendanceWorkflowSubmissionError('tie');
    const selected = matches[0];
    try {
    const validated = attendanceWorkflowConfiguration(selected);
    const resolved=validated.routingVersion===4?await resolveV4(tx,employmentId,validated.stages,validated.cc):{stages:await resolveStages(tx,employmentId,validated.stages,validated.routingVersion),cc:[],skipped:[] as AttendanceSkippedLevel[]};
    const {stages,cc,skipped}=resolved;
    // Unchanged digest when nothing is skipped; a skipped level is part of the route the employee confirms.
    const fingerprint=createHash('sha256').update(JSON.stringify(skipped.length?{version:2,tenantId:ctx.tenantId,employmentId,templateId:selected.id,stages,cc,skipped}:{version:1,tenantId:ctx.tenantId,employmentId,templateId:selected.id,stages,cc})).digest('hex');
    return {subject,selected,validated,stages,cc,skipped,fingerprint};
    } catch (error) {
      if (error instanceof AttendanceLevelError || error instanceof AttendanceWorkflowError || error instanceof AttendanceCcError)
        throw new AttendanceWorkflowSubmissionError('unresolved', error instanceof AttendanceLevelError ? error.problem : undefined);
      throw error;
    }
}
export async function ownAttendanceSubmissionRoute(ctx:SessionContext, employmentId:string, applicationType:AttendanceApplicationType) {
  return withTenant(ctx,async tx=>{
    const [subject]=await tx.select({personId:employment.personId}).from(employment).where(eq(employment.id,employmentId)).limit(1);
    if(!ctx.personId || subject?.personId!==ctx.personId) throw new AttendanceWorkflowError('scope','The employee is not visible.');
    try {
      const route=await prepareAttendanceWorkflowSnapshotTx(tx,ctx,employmentId,applicationType);
      const first=route.stages[0];
      const firstApprovers=(first.mode==='sequential'?first.approvers.slice(0,1):first.approvers).map(({kind,name})=>({kind,name}));
      if(first.hrAlternative&&!firstApprovers.some(actor=>actor.kind==='hr_admin'))firstApprovers.push({kind:'hr_admin',name:'HR administrators'});
      return {available:true as const,name:route.selected.name,stages:route.stages,skippedLevels:route.skipped,firstApprovers,fingerprint:route.fingerprint};
    } catch(error) {
      if(error instanceof AttendanceWorkflowSubmissionError) return {available:false as const,reason:error.reason};
      throw error;
    }
  });
}
export async function snapshotAttendanceWorkflowTx(tx: Tx, ctx: SessionContext, correctionId: string, employmentId: string, applicationType: AttendanceApplicationType, expectedFingerprint?:string) {
    const prepared=await prepareAttendanceWorkflowSnapshotTx(tx,ctx,employmentId,applicationType);
    if(expectedFingerprint!==undefined&&expectedFingerprint!==prepared.fingerprint)throw new AttendanceWorkflowSubmissionError('routeChanged');
    const {subject,selected,validated,stages,cc,skipped}=prepared;
    const [snapshot] = await tx.insert(request).values({ tenantId: ctx.tenantId, correctionId, employmentId, companyId: subject.companyId, templateId: selected.id, templateCode: selected.code, templateName: selected.name, templateVersion: selected.version, applicationType, routingVersion: validated.routingVersion, stages, cc, skippedLevels: skipped }).returning();
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: correctionId, eventType: 'attendance-workflow.resolved', actor: actorOf(ctx), subjectEmploymentId: employmentId, payload: { workflowRequestId: snapshot.id, templateId: selected.id, templateVersion: selected.version, stages, ...(skipped.length?{skippedLevels:skipped}:{}) } });
    return snapshot;
}
/** A workflow assignment grants authority only for its request, never generic Personnel correction access. */
export async function assertCanDecideAttendanceApplicationTx(tx: Tx, ctx: SessionContext, correctionId: string, employmentId: string) {
    const [flow] = await tx.select({ routingVersion: request.routingVersion, employmentId: request.employmentId }).from(request).where(eq(request.correctionId, correctionId)).limit(1);
    if ((flow?.routingVersion === 3 || flow?.routingVersion === 4)) {
        if (flow.employmentId !== employmentId) throw new AttendanceWorkflowError('scope', 'The application subject does not match its frozen workflow.');
        const [allowed] = await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid) as slot`) as unknown as { slot: unknown }[];
        if (!allowed?.slot) throw new AttendanceWorkflowError('notApprover', 'Only the next distinct authorized participant may decide this frozen attendance request.');
        return;
    }
    if (flow?.routingVersion === 2) {
        if (flow.employmentId !== employmentId) throw new AttendanceWorkflowError('scope', 'The application subject does not match its frozen workflow.');
        const [allowed] = await tx.execute(sql`select app.attendance_workflow_v2_decide(${correctionId}::uuid) as ok`) as unknown as { ok: boolean }[];
        if (!allowed?.ok) throw new AttendanceWorkflowError('notApprover', 'Only the current frozen approver, their valid delegate or scoped HR may decide this level. Each level requires a different authorized person.');
        return;
    }
    await assertCanDecide(tx, ctx, employmentId, 'attendance application', scopeOf('attendance.correction'));
}
async function effectiveStageTx(tx: Tx, flow: typeof request.$inferSelect, index: number) {
    const stage = flow.stages[index];
    if (!stage) return stage;
    if ((flow.routingVersion === 3 || flow.routingVersion === 4)) {
        const changes = await tx.select().from(participantReassignment).where(and(eq(participantReassignment.requestId, flow.id), eq(participantReassignment.stageIndex, index))).orderBy(asc(participantReassignment.occurredAt), asc(participantReassignment.id));
        return { ...stage, approvers: stage.approvers.map(actor => changes.filter(change => change.participantSlot === actor.slot).at(-1)?.assigned ?? actor) };
    }
    if (flow.routingVersion !== 2) return stage;
    const [latest] = await tx.select().from(reassignment).where(and(eq(reassignment.requestId, flow.id), eq(reassignment.stageIndex, index))).orderBy(sql`${reassignment.occurredAt} desc`, sql`${reassignment.id} desc`).limit(1);
    return latest ? { ...stage, approvers: latest.approvers } : stage;
}
export type AttendanceStageResult = {
    routed: boolean;
    final: boolean;
    currentStage?: number;
    delegatedFinalStageIndex?: number;
    /** V2/v3 final effects retain the real actor and install only a verified request-ID capability. */
    versionedFinalEffect?: boolean;
    actualDeciderEmploymentId?: string | null;
    /** Fixed audit data only. The final caller emits it after effect/payroll locks and identity restoration. */
    finalApprovalEvent?: AppendEventArgs;
};
/** V3 records each required person before considering the existing stage-completion grain. */
async function decideAttendanceParticipantTx(tx: Tx, ctx: SessionContext, flow: typeof request.$inferSelect, p: {
    correctionId: string; employmentId: string; decision: 'approved' | 'rejected'; remarks?: string; expectedParticipantSlot?: string;
}): Promise<AttendanceStageResult> {
    const [authority] = await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${p.correctionId}::uuid) as actor`) as unknown as { actor: { slot: string; assigned: AttendanceResolvedApprover; actingMode: 'assigned' | 'delegate' } | null }[];
    if (!authority?.actor || authority.actor.slot !== p.expectedParticipantSlot) throw new AttendanceWorkflowError('stale', 'The pending participant changed. Reload before deciding this application.');
    if (!ctx.userId || !ctx.personId) throw new AttendanceWorkflowError('notApprover', 'A linked live participant identity is required.');
    const assigned = authority.actor.assigned;
    const actualEmploymentId = authority.actor.actingMode === 'assigned' ? assigned.employmentId : null;
    const [recorded] = await tx.insert(participantDecision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: flow.employmentId, stageIndex: flow.currentStage,
        participantSlot: authority.actor.slot, decision: p.decision, assigned, actualUserId: ctx.userId, actualPersonId: ctx.personId,
        actualEmploymentId, actualActorName: '', actingMode: authority.actor.actingMode, remarks: p.remarks?.trim() || null }).returning();
    const [fulfillment] = await tx.execute(sql`select app.attendance_workflow_v3_completed(${flow.id}::uuid,${flow.currentStage}) as decision`) as unknown as { decision: 'approved' | 'rejected' | null }[];
    const participantPayload = { workflowRequestId: flow.id, participantDecisionId: recorded.id, stageIndex: flow.currentStage, participantSlot: recorded.participantSlot,
        decision: recorded.decision, assignedApprover: recorded.assigned, actualPersonId: recorded.actualPersonId, actualEmploymentId, actingMode: recorded.actingMode,
        remarks: recorded.remarks, decidedAt: recorded.decidedAt.toISOString() };
    if (!fulfillment?.decision) {
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.participant.decided', actor: actorOf(ctx), subjectEmploymentId: flow.employmentId, payload: participantPayload });
        return { routed: true, final: false, currentStage: flow.currentStage, actualDeciderEmploymentId: actualEmploymentId };
    }
    const final = fulfillment.decision === 'rejected' || flow.currentStage === flow.stages.length - 1;
    if (final) {
        // Rejecting an OT-bearing correction changes its canonical approval digest too. Preserve
        // ordinary non-OT rejection, but require the existing scoped calculation owner for that
        // terminal OT mutation rather than failing later in the cash-source guard with generic42501.
        const [visibility] = await tx.execute(sql`select app.can_see_employment(${flow.employmentId}::uuid) as ok,
            (select c.requested_ot_minutes is not null from public.attendance_correction c
             where c.id=${flow.correctionId}::uuid and c.tenant_id=app.current_tenant_id() and c.employment_id=${flow.employmentId}::uuid) as "otBearing"`) as unknown as { ok: boolean; otBearing: boolean | null }[];
        if (!visibility?.ok && (fulfillment.decision === 'approved' || visibility?.otBearing !== false))
            throw new AttendanceLevelError({ code: 'hr_handoff_required', levelIndex: flow.currentStage });
    }

    await tx.insert(decision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: flow.employmentId, stageIndex: flow.currentStage,
        decision: fulfillment.decision, assignedKind: assigned.kind, assignedEmploymentId: assigned.employmentId,
        actualUserId: ctx.userId, actualPersonId: ctx.personId, actualEmploymentId, actualActorName: recorded.actualActorName,
        actingMode: recorded.actingMode, remarks: recorded.remarks, previousStatus: 'pending', resultingStatus: final ? fulfillment.decision : 'pending' });
    await tx.update(request).set({ currentStage: final ? flow.stages.length : flow.currentStage + 1 }).where(eq(request.id, flow.id));
    const stageEvent: AppendEventArgs = { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId,
        eventType: 'attendance-workflow.stage.decided', actor: actorOf(ctx), subjectEmploymentId: flow.employmentId,
        payload: { ...participantPayload, stageName: flow.stages[flow.currentStage].name, previousStatus: 'pending', resultingStatus: final ? fulfillment.decision : 'pending' } };
    // The final caller emits this only after canonical effect/payroll locks; do not invert the audit lock.
    if (!final || fulfillment.decision !== 'approved') await appendEvent(tx, stageEvent);
    return { routed: true, final, currentStage: final ? flow.stages.length : flow.currentStage + 1, actualDeciderEmploymentId: actualEmploymentId,
        ...(final && fulfillment.decision === 'approved' ? { versionedFinalEffect: true, finalApprovalEvent: stageEvent } : {}) };
}
/** Called by EVERY decide path before touching attendance. Request row is already locked by the caller. */
export async function decideAttendanceWorkflowStageTx(tx: Tx, ctx: SessionContext, p: {
    correctionId: string;
    employmentId: string;
    decision: 'approved' | 'rejected';
    remarks?: string;
    expectedStageIndex?: number;
    expectedParticipantSlot?: string;
}): Promise<AttendanceStageResult> {
    const [flow] = await tx.select().from(request).where(eq(request.correctionId, p.correctionId)).limit(1).for('update');
    if (!flow)
        return { routed: false, final: true };
    if (p.expectedStageIndex !== flow.currentStage)
        throw new AttendanceWorkflowError('stale', 'The pending approval stage changed. Reload the application before deciding it.');
    await assertCanDecideAttendanceApplicationTx(tx, ctx, p.correctionId, p.employmentId);
    if ((flow.routingVersion === 3 || flow.routingVersion === 4)) return decideAttendanceParticipantTx(tx, ctx, flow, p);
    const stage = await effectiveStageTx(tx, flow, flow.currentStage);
    if (!stage)
        throw new AttendanceWorkflowError('stale', 'This workflow has already completed.');
    const [subject] = await tx.select({ personId: employment.personId, companyId: employment.companyId }).from(employment).where(eq(employment.id, p.employmentId));
    if (ctx.personId && subject?.personId === ctx.personId)
        throw new AttendanceWorkflowError('notApprover', 'You cannot decide your own attendance application.');
    const adminRows = await tx.execute(sql `select app.can_admin_employment(${p.employmentId}::uuid) as ok`);
    const isAdmin = (adminRows as unknown as {
        ok: boolean;
    }[])[0]?.ok === true;
    let assigned: AttendanceResolvedApprover | undefined, mode: 'assigned' | 'delegate' | 'administrator' = 'assigned';
    if (flow.routingVersion === 2) {
        const previous = await tx.select({ userId: decision.actualUserId, personId: decision.actualPersonId }).from(decision).where(eq(decision.requestId, flow.id));
        if (previous.some(d => d.userId === ctx.userId || (ctx.personId != null && d.personId === ctx.personId))) throw new AttendanceWorkflowError('notApprover', 'A different authorized person must complete each approval level. Ask HR to arrange another approver.');
        for (const candidate of stage.approvers) {
            const [authority] = await tx.execute(sql`select app.attendance_workflow_v2_assigned_allowed(${p.correctionId}::uuid,${flow.currentStage},${candidate.kind},${candidate.employmentId}::uuid,'assigned') as assigned, app.attendance_workflow_v2_assigned_allowed(${p.correctionId}::uuid,${flow.currentStage},${candidate.kind},${candidate.employmentId}::uuid,'delegate') as delegated`) as unknown as { assigned: boolean; delegated: boolean }[];
            if (authority?.assigned || authority?.delegated) { assigned = candidate; mode = authority.assigned ? 'assigned' : 'delegate'; break; }
        }
        if (!assigned && stage.approvers[0]) {
            const candidate = stage.approvers[0];
            const [authority] = await tx.execute(sql`select app.attendance_workflow_v2_assigned_allowed(${p.correctionId}::uuid,${flow.currentStage},${candidate.kind},${candidate.employmentId}::uuid,'administrator') as ok`) as unknown as { ok: boolean }[];
            if (authority?.ok) {
                if (!p.remarks?.trim()) throw new AttendanceWorkflowError('invalid', 'A reason is required when HR completes a level on behalf of its assigned approver.');
                assigned = candidate; mode = 'administrator';
            }
        }
    } else {
    for (const a of stage.approvers) {
        if (a.kind === 'hr_admin' && isAdmin) {
            assigned = a;
            break;
        }
        if (a.employmentId && ctx.personId) {
            const [owner] = await tx.select({ personId: employment.personId, terminatedOn: employment.terminatedOn }).from(employment).where(eq(employment.id, a.employmentId));
            if (owner?.personId === ctx.personId && (!owner.terminatedOn || owner.terminatedOn > todayInKualaLumpur())) {
                assigned = a;
                break;
            }
            const rows = await tx.execute(sql `select app.can_decide_via_delegation_from(${a.employmentId}::uuid,${p.employmentId}::uuid,'attendance','attendance.correction') as ok`);
            if ((rows as unknown as {
                ok: boolean;
            }[])[0]?.ok) {
                assigned = a;
                mode = 'delegate';
                break;
            }
        }
    }
    if (!assigned && isAdmin) {
        assigned = stage.approvers[0];
        mode = 'administrator';
    }
    }
    if (!assigned)
        throw new AttendanceWorkflowError('notApprover', 'Only the pending assigned approver, their valid delegate or an authorised HR administrator may decide this stage.');
    const final = p.decision === 'rejected' || flow.currentStage === flow.stages.length - 1;
    const [actual] = flow.routingVersion === 2 && mode === 'assigned' && assigned.employmentId ? [{ id: assigned.employmentId }] : flow.routingVersion === 2 ? [] : ctx.personId ? await tx.select({ id: employment.id }).from(employment).where(and(eq(employment.personId, ctx.personId), eq(employment.companyId, subject?.companyId ?? flow.companyId))).orderBy(asc(employment.id)).limit(1) : [];
    const [actualPerson] = ctx.personId ? await tx.select({ name: person.fullName }).from(person).where(eq(person.id, ctx.personId)).limit(1) : [];
    const [recorded] = await tx.insert(decision).values({ tenantId: ctx.tenantId, requestId: flow.id, employmentId: p.employmentId, stageIndex: flow.currentStage, decision: p.decision, assignedKind: assigned.kind, assignedEmploymentId: assigned.employmentId, actualUserId: actorOf(ctx).id ?? 'system', actualActorName: actualPerson?.name ?? actorOf(ctx).id ?? 'System', actualPersonId: ctx.personId ?? null, actualEmploymentId: actual?.id ?? null, actingMode: mode, remarks: p.remarks?.trim() || null, previousStatus: 'pending', resultingStatus: final ? p.decision : 'pending' }).returning({ decidedAt: decision.decidedAt });
    await tx.update(request).set({ currentStage: final ? flow.stages.length : flow.currentStage + 1 }).where(eq(request.id, flow.id));
    const stageEvent: AppendEventArgs = { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.stage.decided', actor: actorOf(ctx), subjectEmploymentId: p.employmentId, payload: { workflowRequestId: flow.id, stageIndex: flow.currentStage, stageName: stage.name, decision: p.decision, assignedApprover: assigned, actingMode: mode, actualPersonId: ctx.personId ?? null, actualEmploymentId: actual?.id ?? null, remarks: p.remarks?.trim() || null, previousStatus: 'pending', resultingStatus: final ? p.decision : 'pending', decidedAt: recorded.decidedAt.toISOString() } };
    // Final approval still needs payroll locks. Taking the tenant audit lock here would invert payroll
    // generation's batch -> audit order; carry immutable data to the fixed final-effect caller instead.
    if (!final || p.decision !== 'approved') await appendEvent(tx, stageEvent);
    return { routed: true, final, currentStage: flow.currentStage,
        ...(flow.routingVersion === 2 ? { actualDeciderEmploymentId: actual?.id ?? null } : {}),
        ...(final && p.decision === 'approved' ? { finalApprovalEvent: stageEvent } : {}),
        ...(final && p.decision === 'approved' && flow.routingVersion === 2 ? { versionedFinalEffect: true } : {}),
        ...(final && p.decision === 'approved' && flow.routingVersion !== 2 && mode === 'delegate' ? { delegatedFinalStageIndex: flow.currentStage } : {}) };
}
export async function reassignAttendanceWorkflowStageToHr(ctx: SessionContext, p: { correctionId: string; expectedStageIndex: number; expectedParticipantSlot?: string; reason: string }) {
    if (!ctx.userId) throw new AttendanceWorkflowError('scope', 'A live authenticated HR administrator is required.');
    if (!p.reason?.trim() || p.reason.trim().length > 500) throw new AttendanceWorkflowError('invalid', 'Enter a reassignment reason of 1–500 characters.');
    return withTenant(ctx, async tx => {
        const [flow] = await tx.select().from(request).where(eq(request.correctionId, p.correctionId)).limit(1);
        if (!flow || (flow.routingVersion !== 2 && flow.routingVersion !== 3 && flow.routingVersion !== 4)) throw new AttendanceWorkflowError('scope', 'Only a versioned pending application can be reassigned.');
        await adminFor(tx, flow.companyId);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + flow.employmentId},0))`);
        const correction = await tx.execute(sql`select c.status from public.attendance_correction c where c.id=${p.correctionId}::uuid and c.tenant_id=${ctx.tenantId}::uuid for update`) as unknown as { status: string }[];
        const [locked] = await tx.select().from(request).where(eq(request.id, flow.id)).for('update');
        if (correction[0]?.status !== 'pending' || !locked || locked.currentStage !== p.expectedStageIndex || locked.currentStage >= locked.stages.length) throw new AttendanceWorkflowError('stale', 'The pending level changed. Reload before reassigning.');
        const current = await effectiveStageTx(tx, locked, locked.currentStage);
        if (!current) throw new AttendanceWorkflowError('stale', 'The pending level changed. Reload before reassigning.');
        if ((locked.routingVersion === 3 || locked.routingVersion === 4)) {
            if (!ctx.personId || !p.expectedParticipantSlot) throw new AttendanceWorkflowError('invalid', 'Select the outstanding participant to reassign.');
            const previous = current.approvers.find(actor => actor.slot === p.expectedParticipantSlot);
            if (!previous) throw new AttendanceWorkflowError('stale', 'The outstanding participant changed. Reload before reassigning.');
            const assigned: AttendanceResolvedApprover = { kind: 'hr_admin', employmentId: null, name: 'HR administrators', slot: p.expectedParticipantSlot };
            const [recorded] = await tx.insert(participantReassignment).values({ tenantId: ctx.tenantId, requestId: locked.id, stageIndex: locked.currentStage, participantSlot: p.expectedParticipantSlot,
                previousAssigned: previous, assigned, reason: p.reason.trim(), actualUserId: ctx.userId!, actualPersonId: ctx.personId, actualActorName: '' }).returning();
            await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.participant.reassigned', actor: actorOf(ctx), subjectEmploymentId: locked.employmentId,
                payload: { workflowRequestId: locked.id, reassignmentId: recorded.id, stageIndex: locked.currentStage, participantSlot: recorded.participantSlot, before: recorded.previousAssigned, after: recorded.assigned, reason: recorded.reason, actualPersonId: recorded.actualPersonId, occurredAt: recorded.occurredAt.toISOString() } });
            return recorded;
        }
        const approvers: AttendanceResolvedApprover[] = [{ kind: 'hr_admin', employmentId: null, name: 'HR administrators' }];
        const [recorded] = await tx.insert(reassignment).values({ tenantId: ctx.tenantId, requestId: locked.id, stageIndex: locked.currentStage, previousApprovers: current.approvers, approvers, reason: p.reason.trim(), actualUserId: ctx.userId!, actualPersonId: ctx.personId ?? null }).returning();
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-correction', aggregateId: p.correctionId, eventType: 'attendance-workflow.stage.reassigned', actor: actorOf(ctx), subjectEmploymentId: locked.employmentId, payload: { workflowRequestId: locked.id, reassignmentId: recorded.id, stageIndex: locked.currentStage, before: current.approvers, after: approvers, reason: recorded.reason, actualPersonId: recorded.actualPersonId, occurredAt: recorded.occurredAt.toISOString() } });
        return recorded;
    });
}
export async function attendanceWorkflowForTx(tx: Tx, correctionId: string) {
    const [flow] = await tx.select().from(request).where(eq(request.correctionId, correctionId));
    if (!flow)
        return null;
    const decisions = await tx.select().from(decision).where(eq(decision.requestId, flow.id)).orderBy(asc(decision.stageIndex), asc(decision.id));
    const reassignments = await tx.select().from(reassignment).where(eq(reassignment.requestId, flow.id)).orderBy(asc(reassignment.occurredAt), asc(reassignment.id));
    const effectiveStages = flow.stages.map((stage, index) => { const latest = reassignments.filter(r => r.stageIndex === index).at(-1); return latest ? { ...stage, approvers: latest.approvers } : stage; });
    const participantDecisions = (flow.routingVersion === 3 || flow.routingVersion === 4) ? await tx.select().from(participantDecision).where(eq(participantDecision.requestId, flow.id)).orderBy(asc(participantDecision.stageIndex), asc(participantDecision.decidedAt), asc(participantDecision.id)) : [];
    const participantReassignments = (flow.routingVersion === 3 || flow.routingVersion === 4) ? await tx.select().from(participantReassignment).where(eq(participantReassignment.requestId, flow.id)).orderBy(asc(participantReassignment.occurredAt), asc(participantReassignment.id)) : [];
    const currentParticipantSlot = (flow.routingVersion === 3 || flow.routingVersion === 4) ? (await tx.execute(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid)->>'slot' as slot`) as unknown as { slot: string | null }[])[0]?.slot ?? null : null;
    const projected = (flow.routingVersion === 3 || flow.routingVersion === 4) ? flow.stages.map((stage, index) => ({ ...stage, approvers: stage.approvers.map(actor => participantReassignments.filter(change => change.stageIndex === index && change.participantSlot === actor.slot).at(-1)?.assigned ?? actor) })) : effectiveStages;
    return { ...flow, decisions, effectiveStages: projected, reassignments, participantDecisions, participantReassignments, currentParticipantSlot };
}
/** Read-only preview uses the SAME shared org resolver and selection priority as submission. */
async function previewAttendanceWorkflowCompany(ctx: SessionContext, raw: unknown, lineageId?: string) {
    const input = validateAnyAttendanceWorkflow(raw);
    return withTenant(ctx, async (tx) => {
        await adminFor(tx, input.companyId);
        await validateScope(tx, ctx, input);
        const targets = await workflowTargets(tx, input.criteria, input.companyId);
        const other = await tx.select().from(template).where(and(applies(input.companyId), eq(template.applicationType, input.applicationType), eq(template.active, true), isNull(template.supersededAt))).orderBy(asc(template.priority), asc(template.code));
        const result: {
            employmentId: string;
            name: string;employeeCode:string|null;companyId:string;
            selectedCode: string;
            problem: string | null;
            routingVersion: 1 | 2 | 3 | 4;
            resolvedStages: AttendanceResolvedStage[];
            levelProblem: AttendanceLevelProblem | null;
        }[] = [];
        for (const id of targets.slice(0, 100)) {
            const [who] = await tx.execute(sql `select p.full_name,e.employee_code from employment e join person p on p.id=e.person_id where e.id=${id}::uuid`) as unknown as {
                full_name: string;employee_code:string|null;
            }[];
            const matches = [{ code: input.code, priority: input.priority, stages: input.stages, routingVersion: input.routingVersion ?? 1,cc:input.routingVersion===4?input.cc:[] }, ...await (async () => {
                    const found: {
                        code: string;
                        priority: number;
                        stages: AnyAttendanceWorkflowInput['stages'];
                        cc: AttendanceCcSource[];
                        routingVersion: 1 | 2 | 3 | 4;
                    }[] = [];
                    for (const t of other.filter(t => t.lineageId !== lineageId))
                        if ((await workflowTargets(tx, t.criteria, input.companyId, [id])).includes(id))
                            found.push(t);
                    return found;
                })()];
            matches.sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
            let problem: string | null = matches.filter(m => m.priority === matches[0].priority).length > 1 ? 'Conflicting templates at the same priority.' : null;
            let resolvedStages: AttendanceResolvedStage[] = [];
            let levelProblem: AttendanceLevelProblem | null = null;
            // Preview the actual priority winner through the same resolver used by submission.
            if (!problem)
                try {
                    resolvedStages = await tx.transaction(nested=>resolveStages(nested,id,matches[0].stages,matches[0].routingVersion,matches[0].cc));
                }
                catch (e) {
                    if (e instanceof AttendanceLevelError) levelProblem = e.problem;
                    else problem = e instanceof AttendanceWorkflowError ? e.message : 'Unable to resolve the approval stages.';
                }
            result.push({ employmentId: id, name: who?.full_name ?? id,employeeCode:who?.employee_code??null,companyId:input.companyId, selectedCode: matches[0].code, problem, routingVersion: matches[0].routingVersion, resolvedStages, levelProblem });
        }
        return { total: targets.length, rows: result, truncated: targets.length > result.length };
    });
}
export async function previewAttendanceWorkflow(ctx:SessionContext,raw:unknown,lineageId?:string){
 const input=validateAnyAttendanceWorkflow(raw),results=[];
 const companies=await withTenant(ctx,tx=>configurationCompanies(tx,input));
 for(const companyId of companies)results.push(await previewAttendanceWorkflowCompany(ctx,{...input,companyId},lineageId));
 return {total:results.reduce((n,r)=>n+r.total,0),rows:results.flatMap(r=>r.rows),truncated:results.some(r=>r.truncated)};
}
export async function attendanceWorkflowsForTx(tx: Tx, ids: string[]) {
    if (!ids.length)
        return new Map<string, Awaited<ReturnType<typeof attendanceWorkflowForTx>>>();
    const flows = await tx.select().from(request).where(inArray(request.correctionId, ids));
    const decisions = flows.length ? await tx.select().from(decision).where(inArray(decision.requestId, flows.map(f => f.id))).orderBy(asc(decision.stageIndex), asc(decision.id)) : [];
    const reassignments = flows.length ? await tx.select().from(reassignment).where(inArray(reassignment.requestId, flows.map(f => f.id))).orderBy(asc(reassignment.occurredAt), asc(reassignment.id)) : [];
    const v3 = flows.filter(flow => (flow.routingVersion === 3 || flow.routingVersion === 4));
    const participantDecisions = v3.length ? await tx.select().from(participantDecision).where(inArray(participantDecision.requestId, v3.map(flow => flow.id))).orderBy(asc(participantDecision.stageIndex), asc(participantDecision.decidedAt), asc(participantDecision.id)) : [];
    const participantReassignments = v3.length ? await tx.select().from(participantReassignment).where(inArray(participantReassignment.requestId, v3.map(flow => flow.id))).orderBy(asc(participantReassignment.occurredAt), asc(participantReassignment.id)) : [];
    const actorSlots = v3.length ? await tx.execute(sql`select w.id,app.attendance_workflow_v3_decision_slot(w.correction_id)->>'slot' as slot from public.attendance_workflow_request w where w.id in (${sql.join(v3.map(flow => sql`${flow.id}::uuid`), sql`,`)})`) as unknown as { id: string; slot: string | null }[] : [];
    return new Map(flows.map(f => {
        const overrides = reassignments.filter(r => r.requestId === f.id);
        const effectiveStages = f.stages.map((stage, index) => { const latest = overrides.filter(r => r.stageIndex === index).at(-1); return latest ? { ...stage, approvers: latest.approvers } : stage; });
        const participantChanges = participantReassignments.filter(change => change.requestId === f.id);
        const projected = (f.routingVersion === 3 || f.routingVersion === 4) ? f.stages.map((stage, index) => ({ ...stage, approvers: stage.approvers.map(actor => participantChanges.filter(change => change.stageIndex === index && change.participantSlot === actor.slot).at(-1)?.assigned ?? actor) })) : effectiveStages;
        return [f.correctionId, { ...f, decisions: decisions.filter(d => d.requestId === f.id), effectiveStages: projected, reassignments: overrides,
            participantDecisions: participantDecisions.filter(d => d.requestId === f.id), participantReassignments: participantChanges, currentParticipantSlot: actorSlots.find(actor => actor.id === f.id)?.slot ?? null }];
    }));
}

/** Navigation uses an existing frozen request capability; this never grants a Manager role. */
export function hasPendingAttendanceParticipantAssignment(ctx: SessionContext) {
    return withTenant(ctx, async tx => {
        const [row] = await tx.execute(sql`select exists(select 1 from public.attendance_workflow_request w join public.attendance_correction c on c.id=w.correction_id and c.tenant_id=w.tenant_id where w.tenant_id=app.current_tenant_id() and w.routing_version in (3,4) and c.status='pending' and app.attendance_workflow_v3_decision_slot(c.id) is not null) as ok`) as unknown as { ok: boolean }[];
        return row?.ok === true;
    });
}

/** Bounded actor-scoped lookup. Candidate visibility never substitutes for approval authority. */
export async function searchAttendanceApprovers(ctx:SessionContext,input:{companyIds:string[];query:string;page:number;selectedIds?:string[]}){
 const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 if(!input.companyIds.length||input.companyIds.length>100||input.companyIds.some(id=>!uuid.test(id))||typeof input.query!=='string'||input.query.length>100||!Number.isInteger(input.page)||input.page<0||input.page>200||(input.selectedIds??[]).length>100||(input.selectedIds??[]).some(id=>!uuid.test(id)))throw new AttendanceWorkflowError('invalid','Choose valid company and employee search criteria.');
 return withTenant(ctx,async tx=>{
  await requireAllCompanies(tx,input.companyIds);
  const companies=sql`ARRAY[${sql.join(input.companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const pattern='%'+input.query.trim().replace(/[\\%_]/g,'\\$&')+'%';
  const fields=sql`e.id,p.full_name as name,e.employee_code as "employeeCode",c.legal_name as company,
   not exists(select 1 from unnest(${companies}) target where not app.attendance_selected_approver_eligible(target,e.id)) as eligible`;
  const visible=sql`e.tenant_id=${ctx.tenantId}::uuid and app.is_admin_for(e.company_id) and app.access_workforce_employment(e.id,'workforce.view')`;
  const rows=await tx.execute<{id:string;name:string;employeeCode:string|null;company:string;eligible:boolean}>(sql`select ${fields} from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where ${visible} and (p.full_name ilike ${pattern} or e.employee_code ilike ${pattern}) order by e.employee_code nulls last,p.full_name,e.id limit 51 offset ${input.page*50}`);
  const selected=input.selectedIds?.length?await tx.execute<typeof rows[number]>(sql`select ${fields} from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where ${visible} and e.id in (${sql.join(input.selectedIds.map(id=>sql`${id}::uuid`),sql`, `)}) order by e.id`):[];
  return {rows:rows.slice(0,50),selected,more:rows.length>50};
 });
}

const HIERARCHY_PROBLEMS=['missing_superior','ambiguous_superior','cycle','inactive_superior','outside_company_scope','missing_or_ambiguous_login','missing_person','duplicate_person','duplicate_login'];
type ConfiguredSource={kind:'direct_manager';depth:number}|{kind:'specific_employee';employmentIds:string[]};
function configuredSources(stage:AnyAttendanceWorkflowInput['stages'][number]|undefined):ConfiguredSource[]{
 if(!stage)return[];
 if('sources' in stage)return stage.sources;
 if('source' in stage)return[stage.source];
 return approversOf(stage.level).flatMap(actor=>actor.kind==='direct_manager'?[{kind:'direct_manager' as const,depth:1}]:[]);
}
/** Read-only wording diagnosis for one Direct Superior source; the frozen resolver remains authoritative. */
async function superiorDiagnosis(tx:Tx,employmentId:string,depth:number){
 const rows=await tx.execute<{level_number:number;employment_id:string|null;employee_code:string|null;full_name:string|null;problem:string|null}>(sql`select level_number,employment_id,employee_code,full_name,problem from app.attendance_workflow_superior_diagnostic(${employmentId}::uuid,${depth}) order by level_number`);
 const failed=rows.find(row=>row.problem);
 if(!failed)return null;
 return {problem:(ATTENDANCE_SUPERIOR_PROBLEMS as readonly string[]).includes(failed.problem!)?failed.problem as AttendanceSuperiorProblem:null,depth:failed.level_number,name:failed.full_name,code:failed.employee_code};
}
async function previewWarningFor(tx:Tx,who:{employmentId:string;employeeCode:string|null;name:string;companyId:string},stages:AnyAttendanceWorkflowInput['stages'],error:unknown):Promise<AttendanceWorkflowPreviewWarning>{
 const base:AttendanceWorkflowPreviewWarning={...who,levelIndex:null,source:null,approverName:null,approverCode:null,problem:null,superiorProblem:null,superiorDepth:null,conflict:null};
 if(error instanceof AttendanceCcError)return{...base,source:{kind:'cc'}};
 if(!(error instanceof AttendanceLevelError))return base;
 const problem=error.problem,levelIndex=problem.levelIndex;
 if(problem.code==='hr_unavailable')return{...base,levelIndex,problem,source:{kind:'hr_admin'}};
 const sources=configuredSources(levelIndex===null?undefined:stages[levelIndex]);
 const managers=sources.filter((source):source is {kind:'direct_manager';depth:number}=>source.kind==='direct_manager');
 const selected=sources.filter((source):source is {kind:'specific_employee';employmentIds:string[]}=>source.kind==='specific_employee');
 if(managers.length&&HIERARCHY_PROBLEMS.includes(problem.code)){
  const deepest=Math.max(...managers.map(source=>source.depth)),diagnosis=await superiorDiagnosis(tx,who.employmentId,deepest);
  const depth=diagnosis?managers.map(source=>source.depth).sort((a,b)=>a-b).find(value=>value>=diagnosis.depth)??deepest:managers[0].depth;
  return{...base,levelIndex,problem,source:{kind:'direct_manager',depth},approverName:diagnosis?.name??null,approverCode:diagnosis?.code??null,superiorProblem:diagnosis?.problem??null,superiorDepth:diagnosis&&diagnosis.depth!==depth?diagnosis.depth:null};
 }
 if(selected.length){
  const id=selected.length===1?selected[0].employmentIds[problem.participantIndex??-1]:undefined;
  const [named]=id?await tx.select({name:person.fullName,code:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.id,id)).limit(1):[];
  return{...base,levelIndex,problem,source:{kind:'specific_employee'},approverName:named?.name??null,approverCode:named?.code??null};
 }
 return{...base,levelIndex,problem};
}
type PreviewApprover={name:string;kind:AttendanceResolvedApprover['kind'];employmentId:string|null};
const previewApprovers=(stage:AttendanceResolvedStage):PreviewApprover[]=>[...stage.approvers.map(actor=>({name:actor.kind==='hr_admin'?'':actor.name,kind:actor.kind,employmentId:actor.employmentId})),...(stage.hrAlternative&&!stage.approvers.some(actor=>actor.kind==='hr_admin')?[{name:'',kind:'hr_admin' as const,employmentId:null}]:[])];
/**
 * Preview Assignment of the saved version: one pass computes matching employees and per-employee route
 * warnings, using the same matcher and resolver as submission, and stores an immutable snapshot.
 */
export async function generateAttendanceWorkflowPreview(ctx:SessionContext,lineageId:string,expectedVersion:number,companyIds:string[]){
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(lineageId)||!Number.isInteger(expectedVersion)||expectedVersion<1)throw new AttendanceWorkflowError('invalid','Reload the workflow before generating a preview.');
 if(!ctx.userId)throw new AttendanceWorkflowError('scope','A signed-in administrator is required.');
 const row=await getAttendanceWorkflow(ctx,lineageId,companyIds);
 if(!row)throw new AttendanceWorkflowError('scope','The workflow is not available.');
 if(row.version!==expectedVersion)throw new AttendanceWorkflowError('stale','The workflow changed. Reload before generating a preview.');
 const input=attendanceWorkflowConfiguration(row);
 return withTenant(ctx,async tx=>{
  const companies=await configurationCompanies(tx,input);await requireAllCompanies(tx,companies);
  const employees:AttendanceWorkflowPreviewEmployee[]=[],warnings:AttendanceWorkflowPreviewWarning[]=[];let total=0,warningCount=0;
  const levelCount=input.stages.length;
  for(const companyId of companies){
   const targets=await workflowTargets(tx,input.criteria,companyId);
   if(!targets.length)continue;
   total+=targets.length;
   // Other active workflows are matched once per workflow, not once per employee.
   const others=await tx.select().from(template).where(and(applies(companyId),eq(template.applicationType,input.applicationType),eq(template.active,true),isNull(template.supersededAt),isNull(template.retiredAt)));
   const competing:{code:string;priority:number;ids:Set<string>}[]=[];
   for(const other of others.filter(other=>other.lineageId!==lineageId))competing.push({code:other.code,priority:other.priority,ids:new Set(await workflowTargets(tx,other.criteria,companyId,targets))});
   const people=new Map((await tx.select({id:employment.id,name:person.fullName,code:employment.employeeCode}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(inArray(employment.id,targets))).map(p=>[p.id,p]));
   for(const id of targets){
    const who={employmentId:id,employeeCode:people.get(id)?.code??null,name:people.get(id)?.name??id,companyId};
    const matches=[{code:input.code,priority:input.priority,own:true},...competing.filter(c=>c.ids.has(id)).map(c=>({code:c.code,priority:c.priority,own:false}))].sort((a,b)=>a.priority-b.priority||a.code.localeCompare(b.code));
    const record=(employee:AttendanceWorkflowPreviewEmployee)=>{if(employees.length<ATTENDANCE_PREVIEW_ROW_LIMIT)employees.push(employee);};
    const warn=(warning:AttendanceWorkflowPreviewWarning)=>{warningCount++;if(warnings.length<ATTENDANCE_PREVIEW_ROW_LIMIT)warnings.push(warning);};
    if(matches.filter(m=>m.priority===matches[0].priority).length>1){warn({...who,levelIndex:null,source:null,approverName:null,approverCode:null,problem:null,superiorProblem:null,superiorDepth:null,conflict:'tie'});record({...who,selectedCode:matches[0].code,outcome:'tie',levels:[]});continue;}
    if(!matches[0].own){record({...who,selectedCode:matches[0].code,outcome:'otherWorkflow',levels:[]});continue;}
    try{
     const resolved=await tx.transaction(async nested=>input.routingVersion===4?resolveV4(nested,id,input.stages,input.cc):{stages:await resolveStages(nested,id,input.stages,input.routingVersion),skipped:[] as AttendanceSkippedLevel[]});
     const levels:{level:number;state:'resolved'|'skipped';approvers:PreviewApprover[]}[]=Array.from({length:levelCount},(_,index)=>{
      const kept=resolved.stages.findIndex((stage,position)=>attendanceStageLevelNumber(stage,position)===index+1);
      return kept>=0?{level:index+1,state:'resolved',approvers:previewApprovers(resolved.stages[kept])}:{level:index+1,state:'skipped',approvers:[]};
     });
     const approverIds=levels.flatMap(level=>level.approvers.flatMap(actor=>actor.employmentId?[actor.employmentId]:[]));
     const codeRows=approverIds.length?await tx.select({id:employment.id,code:employment.employeeCode}).from(employment).where(inArray(employment.id,approverIds)):[];
     const codes=new Map(codeRows.map(row=>[row.id,row.code]));
     record({...who,selectedCode:input.code,outcome:'routed',levels:levels.map(level=>({level:level.level,state:level.state,approvers:level.approvers.map(actor=>({name:actor.name,kind:actor.kind,employeeCode:actor.employmentId?codes.get(actor.employmentId)??null:null}))}))});
    }catch(error){
     if(!(error instanceof AttendanceLevelError||error instanceof AttendanceCcError||error instanceof AttendanceWorkflowError&&error.code==='unresolved'))throw error;
     warn(await previewWarningFor(tx,who,input.stages,error));
     record({...who,selectedCode:input.code,outcome:'warning',levels:[]});
    }
   }
  }
  const [stored]=await tx.insert(previewSnapshot).values({tenantId:ctx.tenantId,lineageId,templateId:row.id,templateVersion:row.version,generatedByUserId:ctx.userId!,companyIds:companies,totalMatching:total,warningCount,truncated:total>employees.length||warningCount>warnings.length,employees,warnings}).returning({id:previewSnapshot.id,generatedAt:previewSnapshot.generatedAt});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-workflow-template',aggregateId:lineageId,eventType:'attendance-workflow-preview.generated',actor:actorOf(ctx),payload:{previewId:stored.id,templateId:row.id,version:row.version,totalMatching:total,warningCount}});
  return{id:stored.id,generatedAt:stored.generatedAt,totalMatching:total,warningCount};
 });
}
const previewHeader={id:previewSnapshot.id,lineageId:previewSnapshot.lineageId,templateVersion:previewSnapshot.templateVersion,generatedAt:previewSnapshot.generatedAt,totalMatching:previewSnapshot.totalMatching,warningCount:previewSnapshot.warningCount,truncated:previewSnapshot.truncated,generatedBy:sql<string|null>`(select p.full_name from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${previewSnapshot.generatedByUserId} and u.tenant_id=${previewSnapshot.tenantId})`.as('generatedBy')};
/** Latest stored previews of a workflow the caller manages (RLS: administrator of every workflow company). */
export async function listAttendanceWorkflowPreviews(ctx:SessionContext,lineageId:string,companyIds:string[]){
 if(!await getAttendanceWorkflow(ctx,lineageId,companyIds,true))return null;
 return withTenant(ctx,tx=>tx.select(previewHeader).from(previewSnapshot).where(eq(previewSnapshot.lineageId,lineageId)).orderBy(desc(previewSnapshot.generatedAt),desc(previewSnapshot.id)).limit(ATTENDANCE_PREVIEW_HISTORY_LIMIT));
}
/** One stored preview (the latest when no id is given). */
export async function getAttendanceWorkflowPreview(ctx:SessionContext,lineageId:string,companyIds:string[],previewId?:string){
 if(previewId!==undefined&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(previewId))return null;
 if(!await getAttendanceWorkflow(ctx,lineageId,companyIds,true))return null;
 return withTenant(ctx,async tx=>(await tx.select({...previewHeader,companyIds:previewSnapshot.companyIds,employees:previewSnapshot.employees,warnings:previewSnapshot.warnings}).from(previewSnapshot).where(and(eq(previewSnapshot.lineageId,lineageId),previewId?eq(previewSnapshot.id,previewId):undefined)).orderBy(desc(previewSnapshot.generatedAt),desc(previewSnapshot.id)).limit(1))[0]??null);
}
