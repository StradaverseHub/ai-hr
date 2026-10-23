import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '@/db/client';
import { actorOf, appendEvent } from '@/db/events';
import { organisationChoiceLabel as label, organisationChoiceLabels } from '@/lib/organisation-choice-label';
import { lockAccessConfigurationTx } from '@/core/access-configuration-lock';
import { businessUnit, company, department, jobGrade, location, position, profileOption } from '@/db/schema';
import { labelCompanyIdsSql, labelUsableByCompany, lockLabelCriteriaTx, visibleLabelIdsCondition } from '@/core/system-labels';
import { DEFAULT_FORM, JobDocumentError, normalizedJobCode, projectJobAnswers, validDate, validateDefinition, validateInput, type FormDefinition, type JobInput, type OrgAssignment } from './model';
export type MasterOption = {
    value: string;
    label: string;
    companyIds?: string[];
    isGlobal?: boolean;
    businessUnitId?: string | null;
    family?: string | null;
};
export type Masters = {
    companies: MasterOption[];
    businessUnit: MasterOption[];
    department: MasterOption[];
    position: MasterOption[];
    grade: MasterOption[];
    location: MasterOption[];
    section: MasterOption[];
    team: MasterOption[];
    family: MasterOption[];
    employmentType: MasterOption[];
    people: MasterOption[];
};
export type JobRevision = {
    id: string;
    tenant_id: string;
    job_id: string;
    version: number;
    status: 'draft' | 'submitted' | 'approved';
    lock_version: number;
    title: string;
    document_owner: string;
    org: OrgAssignment;
    org_labels: Record<string, string>;
    answers: JobInput['answers'];
    definition: FormDefinition;
    effective_on: string | null;
    review_on: string | null;
    reason: string;
    approver_id: string | null;
    prepared_by: string;
    last_edited_by: string;
    contributor_ids: string[];
    submitted_by: string | null;
    submitted_at: string | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
    updated_at: string;
};
export type Job = {
    id: string;
    company_id: string;
    job_code: string;
    inactive: boolean;
    created_by: string;
    updated_at: string;
    company_name: string;
};
export type Review = {
    id: string;
    reviewer_id: string;
    decision: string;
    comments: string;
    decided_at: string | null;
    name: string;
};
export type Audit = {
    id: string;
    action: string;
    actor_id: string;
    created_at: string;
    before_value: unknown;
    after_value: unknown;
};
export type Attachment = {
    id: string;
    filename: string;
    mime_type: string;
    size: number;
    created_at: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(x: string): string { if (!UUID.test(x))
    throw new JobDocumentError('Choose a valid record'); return x; }
function actor(ctx: SessionContext) { if (!ctx.userId || !UUID.test(ctx.userId) || !(ctx.grants ?? ctx.roles?.map(role => ({ role, companyId: null })) ?? []).some(g => ['hr_admin', 'super_admin'].includes(g.role)))
    throw new JobDocumentError('Job documentation requires an authorized HR user'); return ctx.userId; }
/** Access decisions are read under the same configuration lock used by revocation writers. */
async function jobTenant<T>(ctx:SessionContext, fn:(tx:Tx)=>Promise<T>):Promise<T>{
 return withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,ctx.tenantId);return fn(tx);});
}
async function rows<T>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> { return await tx.execute(q) as unknown as T[]; }
async function scope(tx: Tx, ctx: SessionContext, companyId: string, operation: 'view'|'maintain'='maintain'): Promise<void> { uuid(companyId); const [r] = await rows<{
    ok: boolean;
}>(tx, sql `select exists(select 1 from company where id=${companyId}::uuid and tenant_id=${ctx.tenantId}::uuid and app.access_workforce_company(id,${'workforce.'+operation})) as ok`); if (!r?.ok)
    throw new JobDocumentError('Job record not available'); }
export async function getJobMasters(ctx: SessionContext): Promise<Masters> {
    actor(ctx);
    return jobTenant(ctx, async (tx) => {
        const companies = await tx.select({ value: company.id, label: company.legalName }).from(company).where(and(eq(company.tenantId, ctx.tenantId), isNull(company.archivedAt), sql `app.access_workforce_company(${company.id},'workforce.view')`)).orderBy(asc(company.legalName), asc(company.id));
        if(!companies.length)return{companies:[],businessUnit:[],department:[],position:[],grade:[],location:[],section:[],team:[],family:[],employmentType:[],people:[]};
        const ids = companies.map(v => v.value);
        const bus = await tx.select({ id: businessUnit.id, name: businessUnit.name, label: businessUnit.label, code: businessUnit.code, companyIds: labelCompanyIdsSql(businessUnit, 'business_unit'), isGlobal: businessUnit.isGlobal }).from(businessUnit).where(and(eq(businessUnit.tenantId, ctx.tenantId), isNull(businessUnit.archivedAt), visibleLabelIdsCondition(businessUnit, 'business_unit', ids))).orderBy(asc(businessUnit.name), asc(businessUnit.id));
        const departments = await tx.select({ id: department.id, name: department.name, label: department.label, businessUnitId: department.businessUnitId, companyIds: labelCompanyIdsSql(department, 'department'), isGlobal: department.isGlobal }).from(department).where(and(eq(department.tenantId, ctx.tenantId), isNull(department.archivedAt), visibleLabelIdsCondition(department, 'department', ids))).orderBy(asc(department.name), asc(department.id));
        const positions = await tx.select({ id: position.id, title: position.title, label: position.label, family: position.jobFamily, companyIds: labelCompanyIdsSql(position, 'position'), isGlobal: position.isGlobal }).from(position).where(and(eq(position.tenantId, ctx.tenantId), isNull(position.archivedAt), visibleLabelIdsCondition(position, 'position', ids))).orderBy(asc(position.title), asc(position.id));
        const grades = await tx.select({ id: jobGrade.id, name: jobGrade.name, code: jobGrade.code }).from(jobGrade).where(and(eq(jobGrade.tenantId, ctx.tenantId), isNull(jobGrade.archivedAt))).orderBy(asc(jobGrade.rank), asc(jobGrade.id));
        const locations = await tx.select({ id: location.id, name: location.name, companyId: location.companyId }).from(location).where(and(eq(location.tenantId, ctx.tenantId), isNull(location.archivedAt), sql `app.access_workforce_company(${location.companyId},'workforce.view')`)).orderBy(asc(location.name), asc(location.id));
        const profiles = await tx.select().from(profileOption).where(and(eq(profileOption.tenantId, ctx.tenantId), eq(profileOption.isActive, true))).orderBy(asc(profileOption.sortOrder), asc(profileOption.id));
        const people = await rows<{value:string;label:string;companyIds:string[];isGlobal:boolean}>(tx,sql`
          select u.id::text as value,coalesce(p.full_name,u.id::text) as label,false as "isGlobal",
           array(select c.id::text from company c where c.tenant_id=u.tenant_id and app.access_workforce_company(c.id,'workforce.view') and app.job_document_reviewer_eligible(c.id,u.id) order by c.id) as "companyIds"
          from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id
          where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)
           and exists(select 1 from company c where c.tenant_id=u.tenant_id and app.access_workforce_company(c.id,'workforce.view') and app.job_document_reviewer_eligible(c.id,u.id))
          order by label,u.id`);

        const map = (rs: readonly ((typeof bus)[number] | (typeof departments)[number] | (typeof positions)[number])[]) => organisationChoiceLabels(rs).map(v => ({ ...v, value: v.id, label: v.displayLabel }));
        return { companies, businessUnit: map(bus), department: map(departments), position: map(positions), grade: organisationChoiceLabels(grades).map(v => ({ value: v.id, label: v.displayLabel })), location: locations.map(v => ({ value: v.id, label: v.name, companyIds: [v.companyId] })), section: profiles.filter(v => v.category === 'section').map(v => ({ value: v.value, label: v.label })), team: profiles.filter(v => v.category === 'team').map(v => ({ value: v.value, label: v.label })), family: [...new Set(positions.map(v => v.family).filter((v): v is string => !!v))].sort().map(v => ({ value: v, label: v })), employmentType: ['full_time', 'part_time', 'contract', 'intern'].map(v => ({ value: v, label: v.replaceAll('_', ' ') })), people: people.map(v => ({ ...v, companyIds: v.companyIds ?? [] })) };
    });
}
async function definitionTx(tx: Tx, ctx: SessionContext, companyId: string): Promise<FormDefinition> { const [r] = await rows<{
    definition: FormDefinition;
}>(tx, sql `select definition from job_document_form where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid order by version desc limit 1`); return r?.definition ?? structuredClone(DEFAULT_FORM); }
export async function getJobForm(ctx: SessionContext, companyId: string) { actor(ctx); return jobTenant(ctx, async (tx) => { await scope(tx, ctx, companyId,'view'); return definitionTx(tx, ctx, companyId); }); }
export async function configureJobForm(ctx: SessionContext, companyId: string, expectedVersion: number, definition: FormDefinition) { const by = actor(ctx); const def = validateDefinition(definition); return jobTenant(ctx, async (tx) => { await scope(tx, ctx, companyId); const [config] = await rows<{ok:boolean}>(tx,sql`select app.access_configuration_not_denied() as ok`);if(!config?.ok)throw new JobDocumentError('Form configuration permission is unavailable'); await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:job-form:${companyId}`},0))`); const current = await definitionTx(tx, ctx, companyId); if (current.version !== expectedVersion || def.version !== expectedVersion + 1)
    throw new JobDocumentError('The form changed. Reopen configuration before saving'); await tx.execute(sql `insert into job_document_form(tenant_id,company_id,version,definition,created_by) values(${ctx.tenantId}::uuid,${companyId}::uuid,${def.version},${JSON.stringify(def)}::jsonb,${by}::uuid)`); await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'job-document-form', aggregateId: companyId, eventType: 'job-document.form.configured', actor: actorOf(ctx), payload: { companyId, fromVersion: expectedVersion, toVersion: def.version } }); return def; }); }
async function assignedUser(tx:Tx,ctx:SessionContext,userId:string,companyId:string){
 uuid(userId);const [r]=await rows<{ok:boolean}>(tx,sql`select app.job_document_reviewer_eligible(${companyId}::uuid,${userId}::uuid) as ok`);
 if(!r?.ok)throw new JobDocumentError('Choose a currently authorized reviewer / approver for this company');
}
async function orgLabels(tx: Tx, ctx: SessionContext, x: JobInput, previous?: JobRevision): Promise<Record<string, string>> {
    const [co] = await tx.select({ name: company.legalName }).from(company).where(eq(company.id, x.companyId));
    const labels: Record<string, string> = { company: previous?.org_labels.company ?? co?.name ?? '' };
    await lockLabelCriteriaTx(tx, ctx.tenantId);
    for (const key of Object.keys(x.org) as (keyof OrgAssignment)[]) {
        const id = x.org[key];
        if (!id)
            continue;
        if (previous?.org[key] === id) {
            labels[key] = previous.org_labels[key] ?? id;
            continue;
        }
        if (['businessUnit', 'department', 'position', 'reportsTo'].includes(key)) {
            uuid(id);
            const kind = key === 'businessUnit' ? 'business_unit' : key === 'reportsTo' ? 'position' : key as 'department' | 'position';
            if (!await labelUsableByCompany(tx, ctx.tenantId, kind, id, x.companyId))
                throw new JobDocumentError('Organization selection is outside the company Criteria');
            const table = key === 'businessUnit' ? businessUnit : key === 'department' ? department : position;
            const [row] = await tx.select().from(table).where(and(eq(table.id, id), eq(table.tenantId, ctx.tenantId), isNull(table.archivedAt))).for('share');
            if (!row)
                throw new JobDocumentError('Choose active organization master data');
            labels[key] = label(row as unknown as {
                label?: string;
                name?: string;
                title?: string;
                code?: string;
            });
        }
        else if (key === 'grade') {
            uuid(id);
            const [r] = await tx.select().from(jobGrade).where(and(eq(jobGrade.id, id), eq(jobGrade.tenantId, ctx.tenantId), isNull(jobGrade.archivedAt))).for('share');
            if (!r)
                throw new JobDocumentError('Choose an active job grade');
            labels[key] = label(r);
        }
        else if (key === 'location') {
            uuid(id);
            const [r] = await tx.select().from(location).where(and(eq(location.id, id), eq(location.tenantId, ctx.tenantId), eq(location.companyId, x.companyId), isNull(location.archivedAt))).for('share');
            if (!r)
                throw new JobDocumentError('Choose an active location in this company');
            labels[key] = r.name;
        }
        else if (key === 'section' || key === 'team') {
            const [r] = await tx.select().from(profileOption).where(and(eq(profileOption.tenantId, ctx.tenantId), eq(profileOption.category, key), eq(profileOption.value, id), eq(profileOption.isActive, true))).for('share');
            if (!r)
                throw new JobDocumentError('Choose an active section / team');
            labels[key] = r.label;
        }
        else if (key === 'employmentType') {
            if (!['full_time', 'part_time', 'contract', 'intern'].includes(id))
                throw new JobDocumentError('Choose an existing employment type');
            labels[key] = id.replaceAll('_', ' ');
        }
        else if (key === 'family') {
            const [r] = await tx.select({ id: position.id }).from(position).where(and(eq(position.tenantId, ctx.tenantId), eq(position.jobFamily, id), isNull(position.archivedAt), visibleLabelIdsCondition(position, 'position', [x.companyId]))).limit(1);
            if (!r)
                throw new JobDocumentError('Choose a job family from existing positions');
            labels[key] = id;
        }
    }
    if (x.org.department && x.org.businessUnit) {
        const [d] = await tx.select({ businessUnitId: department.businessUnitId }).from(department).where(eq(department.id, x.org.department));
        if (d?.businessUnitId && d.businessUnitId !== x.org.businessUnit && !(previous?.org.department === x.org.department && previous?.org.businessUnit === x.org.businessUnit))
            throw new JobDocumentError('Department belongs to a different business unit');
    }
    if (x.org.position && x.org.family) {
        const [p] = await tx.select({ family: position.jobFamily }).from(position).where(eq(position.id, x.org.position));
        if (p?.family && p.family !== x.org.family && !(previous?.org.position === x.org.position && previous?.org.family === x.org.family))
            throw new JobDocumentError('Position belongs to a different job family');
    }
    return labels;
}
async function getTx(tx: Tx, ctx: SessionContext, id: string, revisionId?: string, lock = false) { uuid(id); if (revisionId)
    uuid(revisionId); const [job] = await rows<Job>(tx, sql `select j.*, c.legal_name as company_name from job_document j join company c on c.id=j.company_id and c.tenant_id=j.tenant_id where j.id=${id}::uuid and j.tenant_id=${ctx.tenantId}::uuid ${lock ? sql `for update of j` : sql ``}`); if (!job)
    throw new JobDocumentError('Job record not available'); const [revision] = await rows<JobRevision>(tx, sql `select * from job_document_revision where job_id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid ${revisionId ? sql `and id=${revisionId}::uuid` : sql ``} order by version desc limit 1 ${lock ? sql `for update` : sql ``}`); if (!revision)
    throw new JobDocumentError('Job revision not available'); return { job, revision }; }
async function audit(tx: Tx, ctx: SessionContext, jobId: string, revisionId: string | null, action: string, before: unknown, after: unknown) { await tx.execute(sql `insert into job_document_audit(tenant_id,job_id,revision_id,action,actor_id,before_value,after_value) values(${ctx.tenantId}::uuid,${jobId}::uuid,${revisionId}::uuid,${action},${ctx.userId}::uuid,${JSON.stringify(before ?? null)}::jsonb,${JSON.stringify(after ?? null)}::jsonb)`); await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'job-document', aggregateId: jobId, eventType: `job-document.${action}`, actor: actorOf(ctx), payload: { revisionId } }); }
async function assignments(tx: Tx, ctx: SessionContext, x: JobInput, revisionId: string) { if (x.approverId)
    await assignedUser(tx, ctx, x.approverId, x.companyId); for (const id of x.reviewerIds)
    await assignedUser(tx, ctx, id, x.companyId); await tx.execute(sql `delete from job_document_review where revision_id=${revisionId}::uuid`); for (const id of x.reviewerIds)
    await tx.execute(sql `insert into job_document_review(tenant_id,revision_id,reviewer_id) values(${ctx.tenantId}::uuid,${revisionId}::uuid,${id}::uuid)`); }
export async function saveJobDraft(ctx: SessionContext, input: JobInput, existing?: {
    jobId: string;
    revisionId: string;
    lockVersion: number;
}) {
    const by = actor(ctx);
    return jobTenant(ctx, async (tx) => {
        await scope(tx, ctx, input.companyId);
        let old: JobRevision | undefined;
        let jobId = existing?.jobId;
        if (existing) {
            const found = await getTx(tx, ctx, existing.jobId, existing.revisionId, true);
            old = found.revision;
            if (found.job.inactive || old.status !== 'draft' || old.lock_version !== existing.lockVersion)
                throw new JobDocumentError('This draft changed or is read-only. Reopen it before saving');
            if (found.job.company_id !== input.companyId || found.job.job_code !== input.jobCode)
                throw new JobDocumentError('Company and common Job ID cannot change');
        }
        const definition = old?.definition ?? await definitionTx(tx, ctx, input.companyId);
        validateInput(input, definition);
        const labels = await orgLabels(tx, ctx, input, old);
        if (!jobId) {
            const [j] = await rows<{
                id: string;
            }>(tx, sql `insert into job_document(tenant_id,company_id,job_code,normalized_code,created_by) values(${ctx.tenantId}::uuid,${input.companyId}::uuid,${input.jobCode.trim()},${normalizedJobCode(input.jobCode)},${by}::uuid) on conflict(tenant_id,company_id,normalized_code) do nothing returning id`);
            if (!j)
                throw new JobDocumentError('This company already has that common Job ID');
            jobId = j.id;
        }
        let saved: JobRevision;
        if (old) {
            [saved] = await rows<JobRevision>(tx, sql `update job_document_revision set title=${input.title.trim()},document_owner=${input.owner},org=${JSON.stringify(input.org)}::jsonb,org_labels=${JSON.stringify(labels)}::jsonb,answers=${JSON.stringify(input.answers)}::jsonb,effective_on=${input.effectiveOn || null}::date,review_on=${input.reviewOn || null}::date,reason=${input.reason},approver_id=${input.approverId || null}::uuid,last_edited_by=${by}::uuid,lock_version=lock_version+1,updated_at=now() where id=${old.id}::uuid returning *`);
        }
        else {
            [saved] = await rows<JobRevision>(tx, sql `insert into job_document_revision(tenant_id,job_id,version,title,document_owner,org,org_labels,answers,definition,effective_on,review_on,reason,approver_id,prepared_by,last_edited_by) values(${ctx.tenantId}::uuid,${jobId}::uuid,1,${input.title.trim()},${input.owner},${JSON.stringify(input.org)}::jsonb,${JSON.stringify(labels)}::jsonb,${JSON.stringify(input.answers)}::jsonb,${JSON.stringify(definition)}::jsonb,${input.effectiveOn || null}::date,${input.reviewOn || null}::date,${input.reason},${input.approverId || null}::uuid,${by}::uuid,${by}::uuid) returning *`);
        }
        await assignments(tx, ctx, input, saved.id);
        await tx.execute(sql `update job_document set updated_at=now() where id=${jobId}::uuid`);
        await audit(tx, ctx, jobId, saved.id, old ? 'draft.updated' : 'created', old, { ...saved, reviewerIds: input.reviewerIds });
        return { jobId, revisionId: saved.id };
    });
}
export async function readJobDocument(ctx: SessionContext, id: string, revisionId?: string) { actor(ctx); return jobTenant(ctx, async (tx) => { const found = await getTx(tx, ctx, id, revisionId); const history = await rows<JobRevision>(tx, sql `select * from job_document_revision where job_id=${id}::uuid order by version desc,id`); const reviews = await rows<Review>(tx, sql `select r.*,coalesce(p.full_name,u.id::text) as name from job_document_review r join app_user u on u.id=r.reviewer_id left join person p on p.id=u.person_id where r.revision_id=${found.revision.id}::uuid order by r.id`); const attachments = await rows<Attachment>(tx, sql `select id,filename,mime_type,octet_length(content) as size,created_at from job_document_attachment where revision_id=${found.revision.id}::uuid order by created_at,id`); const events = await rows<Audit>(tx, sql `select id,action,actor_id,created_at,before_value,after_value from job_document_audit where job_id=${id}::uuid order by created_at desc,id desc limit 200`); const principals = await rows<{ id: string; name: string }>(tx, sql`select u.id::text as id, coalesce(p.full_name,u.id::text) as name from app_user u left join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and (u.id in (select prepared_by from job_document_revision where job_id=${id}::uuid union select last_edited_by from job_document_revision where job_id=${id}::uuid union select approver_id from job_document_revision where job_id=${id}::uuid union select submitted_by from job_document_revision where job_id=${id}::uuid union select approved_by from job_document_revision where job_id=${id}::uuid) or u.id in (select reviewer_id from job_document_review where revision_id=${found.revision.id}::uuid)) order by u.id`);
        return { ...found, history, reviews, attachments, events, principals: Object.fromEntries(principals.map(p => [p.id,p.name])) }; }); }
export type JobFilters={q?:string;company?:string;businessUnit?:string;department?:string;grade?:string;family?:string;status?:string;page?:string};
export type JobSummary=Job&{revision:Pick<JobRevision,'id'|'title'|'version'|'status'|'org'|'org_labels'|'updated_at'>};
function filtersSql(ctx:SessionContext,f:JobFilters){
 const q=(f.q??'').trim().slice(0,200).replace(/[\\%_]/g,'\\$&');
 return sql`j.tenant_id=${ctx.tenantId}::uuid
 ${q?sql`and (j.job_code ilike ${'%'+q+'%'} or r.title ilike ${'%'+q+'%'})`:sql``}
 ${f.company?sql`and j.company_id::text=${f.company}`:sql``}
 ${f.status?sql`and (case when j.inactive then 'inactive' else r.status end)=${f.status}`:sql``}
 ${sql.join((['businessUnit','department','grade','family'] as const).filter(k=>f[k]).map(k=>sql`and r.org->>${k}=${f[k]}`),sql` `)}`;
}
export async function getJobDocumentPage(ctx:SessionContext,filters:JobFilters={}){
 actor(ctx);const page=Math.max(1,Math.min(20000,Number.parseInt(filters.page??'1',10)||1));const pageSize=50;
 return jobTenant(ctx,async tx=>{
 const match=filtersSql(ctx,filters);const from=sql`from job_document j join company c on c.id=j.company_id and c.tenant_id=j.tenant_id join lateral(select id,title,version,status,org,org_labels,updated_at from job_document_revision where job_id=j.id order by version desc limit 1) r on true where ${match}`;
 const rowsFound=await rows<JobSummary>(tx,sql`select j.*,c.legal_name as company_name,to_jsonb(r) as revision ${from} order by j.updated_at desc,j.id limit ${pageSize} offset ${(page-1)*pageSize}`);
 const [count]=await rows<{total:number}>(tx,sql`select count(*)::int as total ${from}`);
 return{rows:rowsFound,total:count.total,page,pageSize};
 });
}
/** Compatibility read returns one explicit page of bounded summary rows, never answers or bytes. */
export async function listJobDocuments(ctx:SessionContext,filters:JobFilters={}){return(await getJobDocumentPage(ctx,filters)).rows;}

function revisionInput(job: Job, r: JobRevision, reviews: Review[]): JobInput { return { companyId: job.company_id, jobCode: job.job_code, title: r.title, owner: r.document_owner, org: r.org, answers: r.answers, effectiveOn: r.effective_on ?? '', reviewOn: r.review_on ?? '', reason: r.reason, approverId: r.approver_id ?? '', reviewerIds: reviews.map(v => v.reviewer_id) }; }
export async function transitionJob(ctx: SessionContext, p: {
    jobId: string;
    revisionId: string;
    lockVersion: number;
    action: 'submit' | 'review' | 'return' | 'approve' | 'revise' | 'inactivate' | 'reactivate' | 'delete' | 'acknowledge';
    comments?: string;
    receiptOn?: string;
}) {
    const by = actor(ctx);
    return jobTenant(ctx, async (tx) => {
        const { job, revision: r } = await getTx(tx, ctx, p.jobId, p.revisionId, true);
        await scope(tx,ctx,job.company_id);
        if (r.lock_version !== p.lockVersion)
            throw new JobDocumentError('This document changed. Reopen it before continuing');
        const reviews = await rows<Review>(tx, sql `select * from job_document_review where revision_id=${r.id}::uuid order by id`);
        if(p.action==='acknowledge'){
            if(r.status!=='approved'||!p.comments?.trim()||p.comments.length>2000||!p.receiptOn||!validDate(p.receiptOn))throw new JobDocumentError('Record the recipient, receipt date and acknowledgement details for an approved revision');
            await audit(tx,ctx,job.id,r.id,'holder.acknowledged',null,{recipientDetails:p.comments,receiptOn:p.receiptOn,recordedBy:by,meaning:'receipt-only; reported by HR; not a verified holder signature'});return;
        }
        if (p.action === 'delete') {
            if (r.status !== 'draft' || r.version !== 1 || r.submitted_at)
                throw new JobDocumentError('Only an unused initial draft can be deleted');
            await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'job-document', aggregateId: job.id, eventType: 'job-document.deleted', actor: actorOf(ctx), payload: { revisionId: r.id, jobCode: job.job_code } });
            await tx.execute(sql `delete from job_document where id=${job.id}::uuid`);
            return;
        }
        if (p.action === 'inactivate' || p.action === 'reactivate') {
            if (!p.comments?.trim())
                throw new JobDocumentError('Enter the reason for changing active status');
            if (p.action === 'reactivate' && !job.inactive)
                throw new JobDocumentError('Job is already active');
            await tx.execute(sql `update job_document set inactive=${p.action === 'inactivate'},updated_at=now() where id=${job.id}::uuid`);
            await audit(tx, ctx, job.id, r.id, p.action, { inactive: job.inactive }, { inactive: p.action === 'inactivate', reason: p.comments });
            return;
        }
        if (job.inactive)
            throw new JobDocumentError('Reactivate the job before continuing');
        if (p.action === 'revise') {
            if (r.status !== 'approved' || !p.comments?.trim() || p.comments.length > 2000)
                throw new JobDocumentError('Choose an approved revision and enter a revision reason');
            const [latest] = await rows<{
                version: number;
            }>(tx, sql `select version from job_document_revision where job_id=${job.id}::uuid order by version desc limit 1`);
            if (latest.version !== r.version)
                throw new JobDocumentError('Revise the latest version');
            const def = await definitionTx(tx, ctx, job.company_id);
            const [next] = await rows<JobRevision>(tx, sql `insert into job_document_revision(tenant_id,job_id,version,title,document_owner,org,org_labels,answers,definition,reason,approver_id,prepared_by,last_edited_by) values(${ctx.tenantId}::uuid,${job.id}::uuid,${r.version + 1},${r.title},${r.document_owner},${JSON.stringify(r.org)}::jsonb,${JSON.stringify(r.org_labels)}::jsonb,${JSON.stringify(projectJobAnswers(r.definition,def,r.answers))}::jsonb,${JSON.stringify(def)}::jsonb,${p.comments},${r.approver_id}::uuid,${by}::uuid,${by}::uuid) returning *`);
            for (const review of reviews)
                await tx.execute(sql `insert into job_document_review(tenant_id,revision_id,reviewer_id) values(${ctx.tenantId}::uuid,${next.id}::uuid,${review.reviewer_id}::uuid)`);
            await tx.execute(sql `insert into job_document_attachment(tenant_id,revision_id,filename,mime_type,content,created_by) select tenant_id,${next.id}::uuid,filename,mime_type,content,${by}::uuid from job_document_attachment where revision_id=${r.id}::uuid`);
            await audit(tx, ctx, job.id, next.id, 'revised', { revisionId: r.id }, { revisionId: next.id, reason: p.comments });
            return;
        }
        if (p.action === 'submit') {
            if (r.status !== 'draft')
                throw new JobDocumentError('Only drafts can be submitted');
            validateInput(revisionInput(job, r, reviews), r.definition, true);
            if (r.version > 1 && !r.reason.trim())
                throw new JobDocumentError('Enter a revision reason');
            if (r.contributor_ids.includes(r.approver_id ?? '') || r.approver_id === by || reviews.some(v => [...r.contributor_ids, by].includes(v.reviewer_id)))
                throw new JobDocumentError('Choose independent reviewers and an approver who did not prepare, edit or submit this revision');
            await assignedUser(tx, ctx, r.approver_id!, job.company_id);
            for (const review of reviews)
                await assignedUser(tx, ctx, review.reviewer_id, job.company_id);
            await tx.execute(sql `update job_document_revision set status='submitted',submitted_by=${by}::uuid,submitted_at=now(),updated_at=now(),lock_version=lock_version+1 where id=${r.id}::uuid`);
        }
        else if (p.action === 'review' || p.action === 'return') {
            if (r.status !== 'submitted' || !reviews.some(v => v.reviewer_id === by) || [...r.contributor_ids, r.submitted_by].includes(by))
                throw new JobDocumentError('Only an assigned independent reviewer may review / return this revision');
            if (!p.comments?.trim() || p.comments.length > 4000)
                throw new JobDocumentError('Enter review feedback');
            await assignedUser(tx, ctx, by, job.company_id);
            await tx.execute(sql `update job_document_review set decision=${p.action === 'review' ? 'reviewed' : 'returned'},comments=${p.comments},decided_at=now() where revision_id=${r.id}::uuid and reviewer_id=${by}::uuid`);
            await tx.execute(sql `update job_document_revision set status=${p.action === 'return' ? 'draft' : 'submitted'},updated_at=now(),lock_version=lock_version+1 where id=${r.id}::uuid`);
        }
        else if (p.action === 'approve') {
            if (r.status !== 'submitted' || r.approver_id !== by || [...r.contributor_ids, r.submitted_by].includes(by) || !reviews.length || reviews.some(v => v.decision !== 'reviewed'))
                throw new JobDocumentError('The named independent approver may approve after all reviews are complete');
            await assignedUser(tx, ctx, by, job.company_id);
            validateInput(revisionInput(job, r, reviews), r.definition, true);
            await tx.execute(sql `update job_document_revision set status='approved',approved_by=${by}::uuid,approved_at=now(),updated_at=now(),lock_version=lock_version+1 where id=${r.id}::uuid`);
        }
        const [after] = await rows<JobRevision>(tx, sql `select * from job_document_revision where id=${r.id}::uuid`);
        await tx.execute(sql `update job_document set updated_at=now() where id=${job.id}::uuid`);
        await audit(tx, ctx, job.id, r.id, p.action, r, { ...after, feedback: p.comments ?? null });
    });
}
const TYPES = new Set(['application/pdf', 'text/plain', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
export function validateJobAttachment(file: {
    name: string;
    type: string;
    size: number;
}, bytes: Uint8Array) { if (!TYPES.has(file.type) || file.size < 1 || file.size > 2097152 || bytes.length !== file.size || !file.name.trim() || file.name.length > 180 || /[\x00-\x1f/\\]/.test(file.name))
    throw new JobDocumentError('Use a PDF, DOCX, plain text, PNG or JPEG file up to 2 MB'); const hex = Buffer.from(bytes.subarray(0, 8)).toString('hex'); if ((file.type === 'application/pdf' && !hex.startsWith('255044462d')) || (file.type === 'image/png' && hex !== '89504e470d0a1a0a') || (file.type === 'image/jpeg' && !hex.startsWith('ffd8ff')) || (file.type.includes('wordprocessingml') && !hex.startsWith('504b0304')) || (file.type === 'text/plain' && bytes.includes(0)))
    throw new JobDocumentError('File content does not match its type'); }
export async function attachJobDocument(ctx: SessionContext, p: {
    jobId: string;
    revisionId: string;
    lockVersion: number;
    name: string;
    type: string;
    bytes: Uint8Array;
}) { const by = actor(ctx); validateJobAttachment({ name: p.name, type: p.type, size: p.bytes.length }, p.bytes); return jobTenant(ctx, async (tx) => { const { job, revision: r } = await getTx(tx, ctx, p.jobId, p.revisionId, true); if (job.inactive || r.status !== 'draft' || r.lock_version !== p.lockVersion)
    throw new JobDocumentError('Reopen the current draft before uploading'); const [count] = await rows<{
    n: number;
}>(tx, sql `select count(*)::int as n from job_document_attachment where revision_id=${r.id}::uuid`); if (count.n >= 20)
    throw new JobDocumentError('Maximum 20 supporting documents per revision'); const [a] = await rows<{
    id: string;
}>(tx, sql `insert into job_document_attachment(tenant_id,revision_id,filename,mime_type,content,created_by) values(${ctx.tenantId}::uuid,${r.id}::uuid,${p.name},${p.type},decode(${Buffer.from(p.bytes).toString('hex')},'hex'),${by}::uuid) returning id`); await tx.execute(sql `update job_document_revision set lock_version=lock_version+1,last_edited_by=${by}::uuid,updated_at=now() where id=${r.id}::uuid`); await audit(tx, ctx, job.id, r.id, 'attachment.added', null, { id: a.id, name: p.name }); return a; }); }
export async function removeJobAttachment(ctx: SessionContext, p: {
    jobId: string;
    revisionId: string;
    lockVersion: number;
    attachmentId: string;
}) { actor(ctx); uuid(p.attachmentId); return jobTenant(ctx, async (tx) => { const { job, revision: r } = await getTx(tx, ctx, p.jobId, p.revisionId, true); if (job.inactive || r.status !== 'draft' || r.lock_version !== p.lockVersion)
    throw new JobDocumentError('Reopen the current draft'); const [a] = await rows<{
    id: string;
    filename: string;
}>(tx, sql `delete from job_document_attachment where id=${p.attachmentId}::uuid and revision_id=${r.id}::uuid returning id,filename`); if (!a)
    throw new JobDocumentError('Attachment not available'); await tx.execute(sql `update job_document_revision set lock_version=lock_version+1,last_edited_by=${ctx.userId}::uuid,updated_at=now() where id=${r.id}::uuid`); await audit(tx, ctx, job.id, r.id, 'attachment.removed', a, null); }); }
export async function downloadJobAttachment(ctx: SessionContext, id: string) { actor(ctx); uuid(id); return jobTenant(ctx, async (tx) => { const [a] = await rows<{
    filename: string;
    mime_type: string;
    hex: string;
}>(tx, sql `select filename,mime_type,encode(content,'hex') as hex from job_document_attachment where id=${id}::uuid and tenant_id=${ctx.tenantId}::uuid`); if (!a)
    throw new JobDocumentError('Attachment not available'); return { filename: a.filename, mimeType: a.mime_type, bytes: Buffer.from(a.hex, 'hex') }; }); }
