/**
 * Recruitment slice 10 — agencies and headhunters (docs/recruitment-reconstruction/specification.md "Slice 10"). Reached
 * from outside the pack ONLY through ./service.
 *
 * HR side only (D-036): agencies, tags, contracts and consultants (contact records) are managed by the company's
 * recruitment administrators; contracts are released to jobs by administrators and the job's recruiter; submissions are
 * RECORDED BY HR on the agency's behalf by the job's recruiter and assistants (and administrators). Nobody at the agency
 * signs in and nothing is sent to anybody.
 *
 * Every entry point runs inside `withRecruitmentTenant` as the caller, under the caller's own row security (4410). The
 * ONE cross-candidate read is app.recruitment_agency_submission_check (a definer that answers an outcome, and match ids
 * to administrators only); the database's submission guard computes that outcome again, so the service's answer is
 * never trusted. The fee rate and the contract file are read from recruitment_agency_contract_terms, whose only policy
 * admits administrators. Audit events carry ids, outcomes and sizes — never a name, contact, ID number, salary, comment
 * or file name. Nothing here calls a model or calculates a fee (D-037).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { resolveDocumentUpload } from '../../core/employee-documents';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, appliedEvent, firstStage, isUuid, type RecruitmentErrorCode } from './model';
import { CANDIDATE_FILE_MAX_BYTES, CANDIDATE_FILE_MIME, normEmail, normIdNumber, normMobile, type IdType } from './privacy-model';
import {
  CONTRACT_FILE_MAX_BYTES, contractUsableOn, isTicked, submissionFor, validateAgencyName, validateConsultantInput, validateContractInput,
  validateRequirements, validateReviewReason, validateSubmissionInput, validateTagName,
  type CheckOutcome, type ConsultantStatus, type ContractAccess, type ContractPositionCounts, type ContractStatus, type ContractType, type MatchKind,
  type SubmissionOutcome, type ValidSubmission,
} from './agency-model';
import {
  recruitmentAgency, recruitmentAgencyConsultant, recruitmentAgencyContract, recruitmentAgencyContractTerms, recruitmentAgencyContractUser,
  recruitmentAgencySubmission, recruitmentAgencyTag, recruitmentAgencyTagLink, recruitmentApplicationEvent, recruitmentCandidate,
  recruitmentCandidateFile, recruitmentCandidateRestricted, recruitmentJobAgencyContract,
} from './schema';
import { actorId, assertCompanyTx, assertNotRepeatedTx, duplicateCheckTx, insertApplicationTx, jobTx, processStagesTx, userLabelsTx, type DuplicateMatch } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const day = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const event = (tx: Tx, s: SessionContext, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType, aggregateId, eventType, actor: actorOf(s), payload });
/** A lock wait that gave up (55P03) or a deadlock broken by the database (40P01): another session is changing the same
 *  candidate or submission. The caller is told to try again — never a generic error page. */
async function busyRetryable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    const state = pgSqlState(e);
    if (state === '40P01' || state === '55P03') throw new RecruitmentError('candidate_busy');
    throw e;
  }
}
/** A database refusal as a stable code (SQLSTATE only; the message carries bound values and is never shown or logged). */
const asError = (e: unknown, map: Record<string, RecruitmentErrorCode>): never => {
  const code = pgSqlState(e);
  if (code && map[code]) throw new RecruitmentError(map[code]);
  throw e;
};

// ── Setup: agencies and tags (administrators) ────────────────────────────────────────────────────────────────

export type AgencyTagRow = { id: string; name: string; enabled: boolean; used: number };
export type AgencyRow = { id: string; name: string; tagIds: string[]; contracts: number };
export type AgencyContact = { id: string; name: string };
export type AgencySetup = { agencies: AgencyRow[]; tags: AgencyTagRow[]; contacts: AgencyContact[] };

async function contactsTx(tx: Tx, companyId: string): Promise<AgencyContact[]> {
  const rows = await tx.execute<{ app_user_id: string; full_name: string }>(sql`select * from app.recruitment_admin_contacts(${companyId}::uuid)`);
  return rows.map((r) => ({ id: r.app_user_id, name: r.full_name }));
}

/** Settings › Agencies: the company's agencies with their tags and contract counts, the tag list and the HR contact choices. */
export async function agencySetup(s: SessionContext, companyId: string): Promise<AgencySetup> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const [agencies, tags, contacts] = await Promise.all([
      tx.execute<{ id: string; name: string; tag_ids: string[] | null; contracts: number }>(sql`
        select a.id, a.name, (select array_agg(l.tag_id order by l.tag_id) from recruitment_agency_tag_link l where l.agency_id = a.id) as tag_ids,
          (select count(*)::int from recruitment_agency_contract c where c.agency_id = a.id) as contracts
        from recruitment_agency a where a.tenant_id = ${s.tenantId}::uuid and a.company_id = ${companyId}::uuid order by lower(a.name), a.id`),
      tx.execute<{ id: string; name: string; enabled: boolean; used: number }>(sql`
        select t.id, t.name, t.enabled, (select count(*)::int from recruitment_agency_tag_link l where l.tag_id = t.id) as used
        from recruitment_agency_tag t where t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${companyId}::uuid order by lower(t.name), t.id`),
      contactsTx(tx, companyId),
    ]);
    return {
      agencies: agencies.map((a) => ({ id: a.id, name: a.name, tagIds: a.tag_ids ?? [], contracts: a.contracts })),
      tags: tags.map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, used: t.used })),
      contacts,
    };
  });
}

/** Create or rename an agency and set its tags (an enabled tag of the same company may be added; a disabled one is kept). */
export async function saveAgency(s: SessionContext, input: { id?: unknown; companyId?: unknown; name?: unknown; tagIds?: unknown }): Promise<{ id: string }> {
  const name = validateAgencyName(input.name);
  if (!name.ok) throw new RecruitmentError(name.code, name.fields);
  const tagIds = Array.isArray(input.tagIds) ? [...new Set(input.tagIds.map(String).filter((x) => x !== ''))] : [];
  if (!tagIds.every(isUuid)) throw new RecruitmentError('invalid_input', ['tags']);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    let id: string;
    let companyId: string;
    try {
      if (input.id != null && input.id !== '') {
        if (!isUuid(input.id)) throw new RecruitmentError('not_found');
        const [a] = await tx.select({ id: recruitmentAgency.id, companyId: recruitmentAgency.companyId }).from(recruitmentAgency)
          .where(and(eq(recruitmentAgency.id, input.id), eq(recruitmentAgency.tenantId, s.tenantId)));
        if (!a) throw new RecruitmentError('not_found');
        await assertCompanyTx(tx, a.companyId);
        ({ id, companyId } = a);
        await tx.update(recruitmentAgency).set({ name: name.value, updatedByUserId: user }).where(eq(recruitmentAgency.id, id));
      } else {
        if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
        companyId = input.companyId;
        await assertCompanyTx(tx, companyId);
        [{ id }] = await tx.insert(recruitmentAgency).values({ tenantId: s.tenantId, companyId, name: name.value, createdByUserId: user, updatedByUserId: user })
          .returning({ id: recruitmentAgency.id });
      }
    } catch (e) {
      if (e instanceof RecruitmentError) throw e;
      return asError(e, { '23505': 'name_taken' });
    }
    const current = (await tx.select({ tagId: recruitmentAgencyTagLink.tagId }).from(recruitmentAgencyTagLink).where(eq(recruitmentAgencyTagLink.agencyId, id))).map((r) => r.tagId);
    const added = tagIds.filter((t) => !current.includes(t));
    const removed = current.filter((t) => !tagIds.includes(t));
    if (added.length) {
      const usable = await tx.select({ id: recruitmentAgencyTag.id }).from(recruitmentAgencyTag)
        .where(and(eq(recruitmentAgencyTag.companyId, companyId), eq(recruitmentAgencyTag.enabled, true)));
      if (!added.every((t) => usable.some((u) => u.id === t))) throw new RecruitmentError('invalid_input', ['tags']);
      await tx.insert(recruitmentAgencyTagLink).values(added.map((tagId) => ({ agencyId: id, tagId, tenantId: s.tenantId, companyId, createdByUserId: user })));
    }
    for (const tagId of removed) {
      await tx.delete(recruitmentAgencyTagLink).where(and(eq(recruitmentAgencyTagLink.agencyId, id), eq(recruitmentAgencyTagLink.tagId, tagId)));
    }
    await event(tx, s, 'recruitment-agency', id, input.id ? 'recruitment-agency.updated' : 'recruitment-agency.created', { companyId, tagsAdded: added.length, tagsRemoved: removed.length });
    return { id };
  });
}

/** Create, rename, enable or disable an agency tag. */
export async function saveAgencyTag(s: SessionContext, input: { id?: unknown; companyId?: unknown; name?: unknown; enabled?: unknown }): Promise<{ id: string }> {
  const name = validateTagName(input.name);
  if (!name.ok) throw new RecruitmentError(name.code, name.fields);
  const enabled = input.enabled === undefined ? true : isTicked(input.enabled);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    try {
      if (input.id != null && input.id !== '') {
        if (!isUuid(input.id)) throw new RecruitmentError('not_found');
        const [t] = await tx.select({ id: recruitmentAgencyTag.id, companyId: recruitmentAgencyTag.companyId }).from(recruitmentAgencyTag)
          .where(and(eq(recruitmentAgencyTag.id, input.id), eq(recruitmentAgencyTag.tenantId, s.tenantId)));
        if (!t) throw new RecruitmentError('not_found');
        await assertCompanyTx(tx, t.companyId);
        await tx.update(recruitmentAgencyTag).set({ name: name.value, enabled, updatedByUserId: user }).where(eq(recruitmentAgencyTag.id, t.id));
        await event(tx, s, 'recruitment-agency-tag', t.id, 'recruitment-agency-tag.updated', { companyId: t.companyId, enabled });
        return { id: t.id };
      }
      if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
      await assertCompanyTx(tx, input.companyId);
      const [row] = await tx.insert(recruitmentAgencyTag).values({ tenantId: s.tenantId, companyId: input.companyId, name: name.value, enabled, createdByUserId: user, updatedByUserId: user })
        .returning({ id: recruitmentAgencyTag.id });
      await event(tx, s, 'recruitment-agency-tag', row.id, 'recruitment-agency-tag.created', { companyId: input.companyId });
      return row;
    } catch (e) {
      if (e instanceof RecruitmentError) throw e;
      return asError(e, { '23505': 'name_taken' });
    }
  });
}

/** Delete an unused agency tag. A tag on an agency is refused (tag_in_use): disable it instead. */
export async function deleteAgencyTag(s: SessionContext, tagId: unknown): Promise<void> {
  if (!isUuid(tagId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [t] = await tx.select({ id: recruitmentAgencyTag.id, companyId: recruitmentAgencyTag.companyId }).from(recruitmentAgencyTag)
      .where(and(eq(recruitmentAgencyTag.id, tagId), eq(recruitmentAgencyTag.tenantId, s.tenantId)));
    if (!t) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, t.companyId);
    try {
      await tx.delete(recruitmentAgencyTag).where(eq(recruitmentAgencyTag.id, t.id));
    } catch (e) {
      return asError(e, { '23503': 'tag_in_use' });
    }
    await event(tx, s, 'recruitment-agency-tag', t.id, 'recruitment-agency-tag.deleted', { companyId: t.companyId });
  });
}

// ── Contracts (administrators) ───────────────────────────────────────────────────────────────────────────────

export type ContractFilters = { agency?: string; tagId?: string; contractType?: string; status?: string };
export type ContractRow = {
  id: string; name: string; agencyId: string; agencyName: string; tags: string[]; activeConsultants: number; feeRate: string;
  status: ContractStatus; contractType: ContractType; startsOn: string; endsOn: string; usableToday: boolean;
};

/** The contract list (administrators): filters by agency name, tag, type and status. */
export async function agencyContracts(s: SessionContext, companyId: string, filters: ContractFilters = {}): Promise<ContractRow[]> {
  const today = todayInKualaLumpur();
  const agency = typeof filters.agency === 'string' && filters.agency.trim() ? filters.agency.trim().slice(0, 120) : null;
  const tagId = isUuid(filters.tagId) ? filters.tagId : null;
  const type = filters.contractType === 'headhunter' || filters.contractType === 'rpo' ? filters.contractType : null;
  const status = filters.status === 'enabled' || filters.status === 'disabled' ? filters.status : null;
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<{
      id: string; name: string; agency_id: string; agency_name: string; tags: string[] | null; active: number; fee_rate: string;
      status: ContractStatus; contract_type: ContractType; starts_on: string | Date; ends_on: string | Date;
    }>(sql`
      select c.id, c.name, c.agency_id, a.name as agency_name,
        (select array_agg(t.name order by lower(t.name)) from recruitment_agency_tag_link l join recruitment_agency_tag t on t.id = l.tag_id where l.agency_id = a.id) as tags,
        (select count(*)::int from recruitment_agency_consultant k where k.contract_id = c.id and k.status = 'active') as active,
        tr.fee_rate::text as fee_rate, c.status, c.contract_type, c.starts_on, c.ends_on
      from recruitment_agency_contract c
      join recruitment_agency a on a.id = c.agency_id
      join recruitment_agency_contract_terms tr on tr.contract_id = c.id
      where c.tenant_id = ${s.tenantId}::uuid and c.company_id = ${companyId}::uuid
        ${agency ? sql`and strpos(lower(a.name), lower(${agency})) > 0` : sql``}
        ${tagId ? sql`and exists (select 1 from recruitment_agency_tag_link l where l.agency_id = a.id and l.tag_id = ${tagId}::uuid)` : sql``}
        ${type ? sql`and c.contract_type = ${type}` : sql``}
        ${status ? sql`and c.status = ${status}` : sql``}
      order by lower(a.name), lower(c.name), c.id limit 500`);
    return rows.map((r) => {
      const startsOn = day(r.starts_on); const endsOn = day(r.ends_on);
      return {
        id: r.id, name: r.name, agencyId: r.agency_id, agencyName: r.agency_name, tags: r.tags ?? [], activeConsultants: r.active, feeRate: r.fee_rate,
        status: r.status, contractType: r.contract_type, startsOn, endsOn, usableToday: contractUsableOn({ status: r.status, startsOn, endsOn }, today),
      };
    });
  });
}

export type ConsultantRow = { id: string; name: string; email: string | null; mobile: string | null; status: ConsultantStatus };
export type ContractPositionRow = ContractPositionCounts & { jobId: string; title: string; jobNumber: string; assigned: boolean };
export type ContractDetail = {
  id: string; companyId: string; agencyId: string; agencyName: string; name: string; contractType: ContractType; status: ContractStatus;
  startsOn: string; endsOn: string; usableToday: boolean; access: ContractAccess; protectionDays: number | null; feeRate: string;
  file: { name: string; size: number } | null; hrContactUserId: string; hrContactName: string | null; users: AgencyContact[];
  consultants: ConsultantRow[]; positions: ContractPositionRow[]; contacts: AgencyContact[]; userOptions: AgencyContact[];
};

/** Contract positions: every job the contract was assigned to or submitted to, with live counts (slice 6 rules). */
async function contractPositionsTx(tx: Tx, contractId: string, now: Date): Promise<ContractPositionRow[]> {
  const rows = await tx.execute<{ job_id: string; title: string; job_number: string; assigned: boolean } & ContractPositionCounts>(sql`
    with jobs as (select x.job_id from recruitment_job_agency_contract x where x.contract_id = ${contractId}::uuid
      union select s.job_id from recruitment_agency_submission s where s.contract_id = ${contractId}::uuid)
    select j.id as job_id, j.title, j.job_number,
      exists (select 1 from recruitment_job_agency_contract x where x.contract_id = ${contractId}::uuid and x.job_id = j.id) as assigned,
      count(s.id)::int as submitted, count(s.id) filter (where s.outcome = 'accepted')::int as accepted,
      count(a.id) filter (where exists (select 1 from recruitment_interview i where i.application_id = a.id and i.cancelled_at is null
        and i.starts_at + make_interval(mins => i.duration_minutes) <= ${now.toISOString()}::timestamptz))::int as interviewed,
      count(a.id) filter (where exists (select 1 from recruitment_offer o where o.application_id = a.id))::int as offered,
      count(a.id) filter (where a.state = 'hired')::int as hired
    from jobs join recruitment_job_opening j on j.id = jobs.job_id
    left join recruitment_agency_submission s on s.contract_id = ${contractId}::uuid and s.job_id = j.id
    left join recruitment_application a on a.id = s.application_id and s.outcome = 'accepted'
    group by j.id, j.title, j.job_number, j.created_at
    order by j.created_at desc, j.id`);
  return rows.map((r) => ({
    jobId: r.job_id, title: r.title, jobNumber: r.job_number, assigned: r.assigned, submitted: r.submitted, accepted: r.accepted,
    interviewed: r.interviewed, offered: r.offered, hired: r.hired,
  }));
}

async function contractTx(tx: Tx, s: SessionContext, contractId: unknown) {
  if (!isUuid(contractId)) throw new RecruitmentError('not_found');
  const [c] = await tx.select().from(recruitmentAgencyContract).where(and(eq(recruitmentAgencyContract.id, contractId), eq(recruitmentAgencyContract.tenantId, s.tenantId)));
  if (!c) throw new RecruitmentError('not_found');
  await assertCompanyTx(tx, c.companyId);
  return c;
}

/** The contract page (administrators): details, terms, access list, consultants and Positions. */
export async function agencyContract(s: SessionContext, contractId: unknown, opts: { now?: Date } = {}): Promise<ContractDetail> {
  const now = opts.now ?? new Date();
  return withRecruitmentTenant(s, async (tx) => {
    const c = await contractTx(tx, s, contractId);
    const [[agency], [terms], users, consultants, positions, contacts, labels] = await Promise.all([
      tx.select({ name: recruitmentAgency.name }).from(recruitmentAgency).where(eq(recruitmentAgency.id, c.agencyId)),
      tx.select({ feeRate: recruitmentAgencyContractTerms.feeRate, fileName: recruitmentAgencyContractTerms.fileName, fileSize: recruitmentAgencyContractTerms.fileSize })
        .from(recruitmentAgencyContractTerms).where(eq(recruitmentAgencyContractTerms.contractId, c.id)),
      tx.select({ userId: recruitmentAgencyContractUser.appUserId }).from(recruitmentAgencyContractUser).where(eq(recruitmentAgencyContractUser.contractId, c.id)),
      tx.select({ id: recruitmentAgencyConsultant.id, name: recruitmentAgencyConsultant.name, email: recruitmentAgencyConsultant.email,
        mobile: recruitmentAgencyConsultant.mobile, status: recruitmentAgencyConsultant.status })
        .from(recruitmentAgencyConsultant).where(eq(recruitmentAgencyConsultant.contractId, c.id)).orderBy(asc(recruitmentAgencyConsultant.name), asc(recruitmentAgencyConsultant.id)),
      contractPositionsTx(tx, c.id, now),
      contactsTx(tx, c.companyId),
      userLabelsTx(tx, c.companyId),
    ]);
    const label = (id: string) => labels.get(id)?.name ?? contacts.find((x) => x.id === id)?.name ?? null;
    const startsOn = day(c.startsOn); const endsOn = day(c.endsOn);
    return {
      id: c.id, companyId: c.companyId, agencyId: c.agencyId, agencyName: agency?.name ?? '', name: c.name, contractType: c.contractType, status: c.status,
      startsOn, endsOn, usableToday: contractUsableOn({ status: c.status, startsOn, endsOn }, todayInKualaLumpur(now)), access: c.access,
      protectionDays: c.protectionDays, feeRate: terms?.feeRate ?? '0.00',
      file: terms?.fileName && terms.fileSize ? { name: terms.fileName, size: terms.fileSize } : null,
      hrContactUserId: c.hrContactUserId, hrContactName: label(c.hrContactUserId),
      users: users.map((u) => ({ id: u.userId, name: label(u.userId) ?? '' })),
      consultants, positions, contacts,
      userOptions: [...labels.values()].filter((l) => l.active).map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/** Create a contract for an agency (with its fee rate) or change one. The HR contact must administer recruitment there. */
export async function saveAgencyContract(s: SessionContext, input: Record<string, unknown> & { id?: unknown; agencyId?: unknown }): Promise<{ id: string }> {
  const v = validateContractInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  const { feeRate, ...fields } = v.value;
  return withRecruitmentTenant(s, async (tx) => {
    const contactOk = async (companyId: string) => {
      const [row] = await tx.execute<{ ok: boolean }>(sql`select app.recruitment_user_administers(${companyId}::uuid, ${fields.hrContactUserId}::uuid) as ok`);
      if (row?.ok !== true) throw new RecruitmentError('contact_invalid');
    };
    try {
      if (input.id != null && input.id !== '') {
        const c = await contractTx(tx, s, input.id);
        if (c.hrContactUserId !== fields.hrContactUserId) await contactOk(c.companyId);
        await tx.update(recruitmentAgencyContract).set({ ...fields, updatedByUserId: user }).where(eq(recruitmentAgencyContract.id, c.id));
        await tx.update(recruitmentAgencyContractTerms).set({ feeRate, updatedByUserId: user }).where(eq(recruitmentAgencyContractTerms.contractId, c.id));
        await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-contract.updated', {
          companyId: c.companyId, agencyId: c.agencyId, status: fields.status, statusChanged: c.status !== fields.status,
          periodChanged: day(c.startsOn) !== fields.startsOn || day(c.endsOn) !== fields.endsOn, accessChanged: c.access !== fields.access,
        });
        return { id: c.id };
      }
      if (!isUuid(input.agencyId)) throw new RecruitmentError('not_found');
      const [a] = await tx.select({ id: recruitmentAgency.id, companyId: recruitmentAgency.companyId }).from(recruitmentAgency)
        .where(and(eq(recruitmentAgency.id, input.agencyId), eq(recruitmentAgency.tenantId, s.tenantId)));
      if (!a) throw new RecruitmentError('not_found');
      await assertCompanyTx(tx, a.companyId);
      await contactOk(a.companyId);
      const [row] = await tx.insert(recruitmentAgencyContract).values({
        tenantId: s.tenantId, companyId: a.companyId, agencyId: a.id, ...fields, createdByUserId: user, updatedByUserId: user,
      }).returning({ id: recruitmentAgencyContract.id });
      await tx.insert(recruitmentAgencyContractTerms).values({ contractId: row.id, tenantId: s.tenantId, companyId: a.companyId, feeRate, updatedByUserId: user });
      await event(tx, s, 'recruitment-agency-contract', row.id, 'recruitment-agency-contract.created', { companyId: a.companyId, agencyId: a.id, contractType: fields.contractType });
      return row;
    } catch (e) {
      if (e instanceof RecruitmentError) throw e;
      return asError(e, { '23505': 'name_taken', '23514': 'invalid_input' });
    }
  });
}

/** Attach or replace the contract file: a PDF (type read from the bytes), at most 10 MB. Administrators only. */
export async function uploadAgencyContractFile(s: SessionContext, contractId: unknown, input: { fileName?: unknown; content?: unknown }): Promise<void> {
  const content = Buffer.isBuffer(input.content) ? input.content : null;
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim().slice(-200) : '';
  if (!content || content.byteLength === 0 || !fileName) throw new RecruitmentError('missing_fields', ['file']);
  if (content.byteLength > CONTRACT_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
  let mimeType: string;
  try {
    ({ mimeType } = resolveDocumentUpload(fileName, content));
  } catch {
    throw new RecruitmentError('file_type');
  }
  if (mimeType !== 'application/pdf') throw new RecruitmentError('file_type');
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await contractTx(tx, s, contractId);
    await tx.update(recruitmentAgencyContractTerms).set({ fileName, fileMime: mimeType, fileSize: content.byteLength, fileContent: content, updatedByUserId: user })
      .where(eq(recruitmentAgencyContractTerms.contractId, c.id));
    await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-contract.file-attached', { companyId: c.companyId, sizeBytes: content.byteLength });
  });
}

export async function removeAgencyContractFile(s: SessionContext, contractId: unknown): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await contractTx(tx, s, contractId);
    await tx.update(recruitmentAgencyContractTerms).set({ fileName: null, fileMime: null, fileSize: null, fileContent: null, updatedByUserId: user })
      .where(eq(recruitmentAgencyContractTerms.contractId, c.id));
    await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-contract.file-removed', { companyId: c.companyId });
  });
}

/** The contract file for an administrator (row security returns nothing to anybody else). Each download is audited. */
export async function getAgencyContractFile(s: SessionContext, contractId: unknown): Promise<{ fileName: string; mimeType: string; content: Buffer } | null> {
  if (!isUuid(contractId)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [t] = await tx.select({ companyId: recruitmentAgencyContractTerms.companyId, fileName: recruitmentAgencyContractTerms.fileName,
      fileMime: recruitmentAgencyContractTerms.fileMime, fileContent: recruitmentAgencyContractTerms.fileContent })
      .from(recruitmentAgencyContractTerms).where(and(eq(recruitmentAgencyContractTerms.contractId, contractId), eq(recruitmentAgencyContractTerms.tenantId, s.tenantId)));
    if (!t?.fileContent || !t.fileName || !t.fileMime) return null;
    await event(tx, s, 'recruitment-agency-contract', contractId, 'recruitment-agency-contract.file-downloaded', { companyId: t.companyId, sizeBytes: t.fileContent.byteLength });
    return { fileName: t.fileName, mimeType: t.fileMime, content: t.fileContent };
  });
}

/** A Restricted contract's access list: add a user of the company (people labels). */
export async function addAgencyContractUser(s: SessionContext, contractId: unknown, userId: unknown): Promise<void> {
  if (!isUuid(userId)) throw new RecruitmentError('invalid_input', ['user']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await contractTx(tx, s, contractId);
    const labels = await userLabelsTx(tx, c.companyId);
    if (!labels.get(userId)?.active) throw new RecruitmentError('invalid_input', ['user']);
    await tx.insert(recruitmentAgencyContractUser).values({ contractId: c.id, appUserId: userId, tenantId: s.tenantId, companyId: c.companyId, createdByUserId: user })
      .onConflictDoNothing();
    await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-contract.user-added', { companyId: c.companyId, userId });
  });
}
export async function removeAgencyContractUser(s: SessionContext, contractId: unknown, userId: unknown): Promise<void> {
  if (!isUuid(userId)) throw new RecruitmentError('invalid_input', ['user']);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await contractTx(tx, s, contractId);
    await tx.delete(recruitmentAgencyContractUser).where(and(eq(recruitmentAgencyContractUser.contractId, c.id), eq(recruitmentAgencyContractUser.appUserId, userId)));
    await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-contract.user-removed', { companyId: c.companyId, userId });
  });
}

/** Add or change a consultant of a contract (a contact record; nothing is sent to them). */
export async function saveAgencyConsultant(s: SessionContext, input: Record<string, unknown> & { id?: unknown; contractId?: unknown }): Promise<{ id: string }> {
  const v = validateConsultantInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    if (input.id != null && input.id !== '') {
      if (!isUuid(input.id)) throw new RecruitmentError('not_found');
      const [k] = await tx.select({ id: recruitmentAgencyConsultant.id, contractId: recruitmentAgencyConsultant.contractId }).from(recruitmentAgencyConsultant)
        .where(and(eq(recruitmentAgencyConsultant.id, input.id), eq(recruitmentAgencyConsultant.tenantId, s.tenantId)));
      if (!k) throw new RecruitmentError('not_found');
      const c = await contractTx(tx, s, k.contractId);
      await tx.update(recruitmentAgencyConsultant).set({ ...v.value, updatedByUserId: user }).where(eq(recruitmentAgencyConsultant.id, k.id));
      await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-consultant.updated', { companyId: c.companyId, consultantId: k.id, status: v.value.status });
      return { id: k.id };
    }
    const c = await contractTx(tx, s, input.contractId);
    const [row] = await tx.insert(recruitmentAgencyConsultant).values({ tenantId: s.tenantId, companyId: c.companyId, contractId: c.id, ...v.value, createdByUserId: user, updatedByUserId: user })
      .returning({ id: recruitmentAgencyConsultant.id });
    await event(tx, s, 'recruitment-agency-contract', c.id, 'recruitment-agency-consultant.created', { companyId: c.companyId, consultantId: row.id });
    return row;
  });
}

// ── Jobs released to agencies ────────────────────────────────────────────────────────────────────────────────

export type JobAgencyAssignment = {
  id: string; contractId: string; contractName: string; agencyName: string; contractType: ContractType; usableToday: boolean; requirements: string | null;
};
export type JobAgencyContracts = { canAssign: boolean; assigned: JobAgencyAssignment[]; available: { contractId: string; label: string }[] };

async function jobAssignAccessTx(tx: Tx, companyId: string, jobId: string): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean }>(sql`select (app.can_admin_recruitment_for(${companyId}::uuid)
    or app.recruitment_has_job_role(${jobId}::uuid, array['recruiter'])) as ok`);
  return row?.ok === true;
}

/** The job's sourcing settings: its assigned contracts (the job's operators read them; administrators and the job's
 *  recruiter change them) and, for those who may assign, the contracts usable today by them that are not yet assigned. */
export async function jobAgencyContracts(s: SessionContext, jobId: string): Promise<JobAgencyContracts> {
  return withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId, 'operate');
    const canAssign = await jobAssignAccessTx(tx, job.companyId, job.id);
    const assigned = await tx.execute<{ id: string; contract_id: string; contract_name: string | null; agency_name: string | null; contract_type: ContractType | null;
      usable: boolean; requirements: string | null }>(sql`
      select x.id, x.contract_id, c.name as contract_name, a.name as agency_name, c.contract_type, app.recruitment_contract_usable(x.contract_id) as usable, x.requirements
      from recruitment_job_agency_contract x
      left join recruitment_agency_contract c on c.id = x.contract_id
      left join recruitment_agency a on a.id = c.agency_id
      where x.job_id = ${job.id}::uuid order by x.created_at, x.id`);
    const available = canAssign && job.status !== 'closed' ? await tx.execute<{ id: string; label: string }>(sql`
      select c.id, a.name || ' · ' || c.name as label from recruitment_agency_contract c join recruitment_agency a on a.id = c.agency_id
      where c.tenant_id = ${s.tenantId}::uuid and c.company_id = ${job.companyId}::uuid and app.recruitment_contract_usable(c.id)
        and not exists (select 1 from recruitment_job_agency_contract x where x.job_id = ${job.id}::uuid and x.contract_id = c.id)
      order by lower(a.name), lower(c.name)`) : [];
    return {
      canAssign,
      assigned: assigned.map((r) => ({
        id: r.id, contractId: r.contract_id, contractName: r.contract_name ?? '', agencyName: r.agency_name ?? '', contractType: r.contract_type ?? 'headhunter',
        usableToday: r.usable === true, requirements: r.requirements,
      })),
      available: available.map((r) => ({ contractId: r.id, label: r.label })),
    };
  });
}

/** Release a job to a contract usable today by the actor (administrators and the job's recruiter; 4410 refuses again). */
export async function assignAgencyContract(s: SessionContext, jobId: string, contractId: unknown, requirements?: unknown): Promise<{ id: string }> {
  if (!isUuid(contractId)) throw new RecruitmentError('contract_unavailable');
  const req = validateRequirements(requirements);
  if (!req.ok) throw new RecruitmentError(req.code, req.fields);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId, 'operate');
    if (!(await jobAssignAccessTx(tx, job.companyId, job.id))) throw new RecruitmentError('forbidden');
    if (job.status === 'closed') throw new RecruitmentError('job_closed');
    const [ok] = await tx.execute<{ ok: boolean }>(sql`select app.recruitment_contract_usable(${contractId}::uuid)
      and exists (select 1 from recruitment_agency_contract c where c.id = ${contractId}::uuid and c.company_id = ${job.companyId}::uuid) as ok`);
    if (ok?.ok !== true) throw new RecruitmentError('contract_unavailable');
    try {
      const [row] = await tx.insert(recruitmentJobAgencyContract).values({
        tenantId: s.tenantId, companyId: job.companyId, jobId: job.id, contractId, requirements: req.value, createdByUserId: user, updatedByUserId: user,
      }).returning({ id: recruitmentJobAgencyContract.id });
      await event(tx, s, 'recruitment-job', job.id, 'recruitment-job.agency-contract-assigned', { companyId: job.companyId, jobId: job.id, contractId });
      return row;
    } catch (e) {
      return asError(e, { '23505': 'name_taken', '23514': 'contract_unavailable' });
    }
  });
}

async function assignmentTx(tx: Tx, s: SessionContext, assignmentId: unknown) {
  if (!isUuid(assignmentId)) throw new RecruitmentError('not_found');
  const [x] = await tx.select().from(recruitmentJobAgencyContract).where(and(eq(recruitmentJobAgencyContract.id, assignmentId), eq(recruitmentJobAgencyContract.tenantId, s.tenantId)));
  if (!x) throw new RecruitmentError('not_found');
  if (!(await jobAssignAccessTx(tx, x.companyId, x.jobId))) throw new RecruitmentError('forbidden');
  return x;
}
export async function updateAgencyAssignment(s: SessionContext, assignmentId: unknown, requirements: unknown): Promise<void> {
  const req = validateRequirements(requirements);
  if (!req.ok) throw new RecruitmentError(req.code, req.fields);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const x = await assignmentTx(tx, s, assignmentId);
    await tx.update(recruitmentJobAgencyContract).set({ requirements: req.value, updatedByUserId: user }).where(eq(recruitmentJobAgencyContract.id, x.id));
    await event(tx, s, 'recruitment-job', x.jobId, 'recruitment-job.agency-requirements-updated', { companyId: x.companyId, jobId: x.jobId, contractId: x.contractId });
  });
}
/** Remove a job's assignment: no new submissions from that contract; the submissions already recorded stay. */
export async function removeAgencyAssignment(s: SessionContext, assignmentId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const x = await assignmentTx(tx, s, assignmentId);
    await tx.delete(recruitmentJobAgencyContract).where(eq(recruitmentJobAgencyContract.id, x.id));
    await event(tx, s, 'recruitment-job', x.jobId, 'recruitment-job.agency-contract-removed', { companyId: x.companyId, jobId: x.jobId, contractId: x.contractId });
  });
}

// ── Recording a submission (the job's recruiter and assistants, administrators) ──────────────────────────────

export type SubmissionContractOption = { contractId: string; label: string; startsOn: string; requirements: string | null; consultants: { id: string; name: string }[] };
/** The contracts a submission may come from on this job: assigned to it and usable today by the viewer, each with its
 *  Active consultants. */
export async function agencySubmissionOptions(s: SessionContext, jobId: string): Promise<SubmissionContractOption[]> {
  return withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId, 'operate');
    if (job.status === 'closed') return [];
    const rows = await tx.execute<{ contract_id: string; label: string; starts_on: string | Date; requirements: string | null; consultants: { id: string; name: string }[] | null }>(sql`
      select x.contract_id, a.name || ' · ' || c.name as label, c.starts_on, x.requirements,
        (select json_agg(json_build_object('id', k.id, 'name', k.name) order by lower(k.name), k.id) from recruitment_agency_consultant k
          where k.contract_id = c.id and k.status = 'active') as consultants
      from recruitment_job_agency_contract x
      join recruitment_agency_contract c on c.id = x.contract_id
      join recruitment_agency a on a.id = c.agency_id
      where x.job_id = ${job.id}::uuid and app.recruitment_contract_usable(c.id)
      order by lower(a.name), lower(c.name)`);
    return rows.map((r) => ({ contractId: r.contract_id, label: r.label, startsOn: day(r.starts_on), requirements: r.requirements, consultants: r.consultants ?? [] }));
  });
}

/** The cross-candidate check (4410): the outcome, and match ids for an administrator only. Takes the identity locks and
 *  always counts as one of the caller's daily attempts. */
async function checkTx(tx: Tx, jobId: string, contractId: string, v: Pick<ValidSubmission, 'fullName' | 'email' | 'mobile' | 'idNumber'>) {
  const [row] = await tx.execute<{ outcome: CheckOutcome; match_ids: string[] | null }>(sql`
    select outcome, match_ids from app.recruitment_agency_submission_check(${jobId}::uuid, ${contractId}::uuid, ${v.fullName}, ${v.email}, ${v.mobile},
      ${v.idNumber})`);
  return { outcome: row.outcome, matchIds: row.match_ids };
}

/** The same company + identity keys as the check (4407/4408/4410), for a write that does not run the check. */
async function lockIdentityTx(tx: Tx, s: SessionContext, companyId: string, v: { email: string | null; mobile: string | null; idNumber: string | null }) {
  const email = normEmail(v.email); const mobile = normMobile(v.mobile); const id = normIdNumber(v.idNumber);
  const prefix = `recruitment-referral:${s.tenantId}:${companyId}:`;
  const keys = await tx.execute<{ k: string }>(sql`select k::text from unnest(array[
      case when ${email}::text is not null then hashtextextended(${`${prefix}email:${email}`}, 0) end,
      case when ${mobile}::text is not null then hashtextextended(${`${prefix}mobile:${mobile}`}, 0) end,
      case when ${id}::text is not null then hashtextextended(${`${prefix}id:${id}`}, 0) end]::bigint[]) k where k is not null order by k`);
  for (const { k } of keys) await tx.execute(sql`select pg_advisory_xact_lock(${k}::bigint)`);
}

type Resume = { fileName: string; mimeType: string; content: Buffer };
function resumeOf(input: { resumeName?: unknown; resumeContent?: unknown; permissionConfirmed?: unknown }): Resume | null {
  const content = Buffer.isBuffer(input.resumeContent) && input.resumeContent.byteLength > 0 ? input.resumeContent : null;
  if (!content) return null;
  if (!isTicked(input.permissionConfirmed)) throw new RecruitmentError('permission_required');
  const fileName = typeof input.resumeName === 'string' ? input.resumeName.trim().slice(-200) : '';
  if (!fileName) throw new RecruitmentError('missing_fields', ['resume']);
  if (content.byteLength > CANDIDATE_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
  let mimeType: string;
  try {
    ({ mimeType } = resolveDocumentUpload(fileName, content));
  } catch {
    throw new RecruitmentError('file_type');
  }
  if (!(CANDIDATE_FILE_MIME as readonly string[]).includes(mimeType)) throw new RecruitmentError('file_type');
  return { fileName, mimeType, content };
}

/** A new candidate with the job's application at its first enabled stage, source "agency", its restricted values and résumé. */
async function createCandidateTx(tx: Tx, s: SessionContext, job: { id: string; companyId: string; processId: string },
  v: Pick<ValidSubmission, 'fullName' | 'email' | 'mobile' | 'idType' | 'idNumber' | 'currentSalaryAmount' | 'currentSalaryCurrency' | 'expectedSalaryAmount' | 'expectedSalaryCurrency'>,
  resume: Resume | null): Promise<{ candidateId: string; applicationId: string }> {
  const user = actorId(s);
  const start = firstStage(await processStagesTx(tx, job.processId));
  if (!start) throw new RecruitmentError('process_unavailable');
  const candidateId = randomUUID();
  await tx.insert(recruitmentCandidate).values({
    id: candidateId, tenantId: s.tenantId, companyId: job.companyId, fullName: v.fullName, email: v.email, phone: v.mobile, source: 'agency',
    ownerUserId: user, createdByUserId: user, updatedByUserId: user,
  });
  const applicationId = await applicationOnTx(tx, s, job, candidateId, start);
  if (v.idNumber || v.currentSalaryAmount || v.expectedSalaryAmount) {
    await tx.insert(recruitmentCandidateRestricted).values({
      tenantId: s.tenantId, companyId: job.companyId, candidateId, idType: v.idType, idNumber: v.idNumber, currentSalaryAmount: v.currentSalaryAmount,
      currentSalaryCurrency: v.currentSalaryCurrency, expectedSalaryAmount: v.expectedSalaryAmount, expectedSalaryCurrency: v.expectedSalaryCurrency, updatedByUserId: user,
    });
  }
  if (resume) {
    await tx.insert(recruitmentCandidateFile).values({
      tenantId: s.tenantId, companyId: job.companyId, candidateId, kind: 'resume', fileName: resume.fileName, mimeType: resume.mimeType,
      sizeBytes: resume.content.byteLength, content: resume.content, permissionConfirmed: true, uploadedByUserId: user,
    });
  }
  return { candidateId, applicationId };
}
async function applicationOnTx(tx: Tx, s: SessionContext, job: { id: string; companyId: string; processId: string }, candidateId: string, start?: string): Promise<string> {
  const user = actorId(s);
  const stage = start ?? firstStage(await processStagesTx(tx, job.processId));
  if (!stage) throw new RecruitmentError('process_unavailable');
  const applicationId = await insertApplicationTx(tx, {
    tenantId: s.tenantId, companyId: job.companyId, jobId: job.id, candidateId, currentStageId: stage, source: 'agency', createdByUserId: user, updatedByUserId: user,
  });
  await tx.insert(recruitmentApplicationEvent).values({ tenantId: s.tenantId, companyId: job.companyId, applicationId, actorUserId: user, ...appliedEvent(stage) });
  return applicationId;
}

export type AgencySubmissionInput = Record<string, unknown> & {
  jobId?: unknown; contractId?: unknown; consultantId?: unknown; resumeName?: unknown; resumeContent?: unknown; permissionConfirmed?: unknown;
};
export type AgencySubmissionResult = { submissionId: string; outcome: SubmissionOutcome; applicationId: string | null };

/**
 * Record an agency submission (case 68–71). The job's recruiter, assistants or an administrator; a contract assigned to the
 * job and usable today by them; an Active consultant of it. The cross-candidate check decides (D-038): New → a candidate,
 * the application at the first enabled stage with source "agency" and the accepted submission, in this one transaction;
 * Duplicate inside another channel's protection → stored as Refused ("protected by an earlier application"), nothing else;
 * Duplicate outside protection or Suspected → stored as Waiting for review. The same agency submitting the same person to
 * the same job again while waiting, active or within the repeated-application window is refused (repeat_submission) and
 * nothing is stored. The recorder learns the outcome only — never who matched. Every attempt that reaches the check counts
 * against the recorder's 50 per Kuala Lumpur day (agency_daily_limit); a repeat or a refusal over the limit still commits
 * its attempt log, so it is thrown only after the transaction.
 */
export async function recordAgencySubmission(s: SessionContext, input: AgencySubmissionInput): Promise<AgencySubmissionResult> {
  if (!isUuid(input.jobId)) throw new RecruitmentError('missing_fields', ['job']);
  if (!isUuid(input.contractId)) throw new RecruitmentError('missing_fields', ['contract']);
  if (!isUuid(input.consultantId)) throw new RecruitmentError('missing_fields', ['consultant']);
  const resume = resumeOf(input);
  const user = actorId(s);
  const today = todayInKualaLumpur();
  const result = await busyRetryable(() => withRecruitmentTenant(s, async (tx): Promise<AgencySubmissionResult | 'repeat' | 'limit'> => {
    const job = await jobTx(tx, s, input.jobId as string, 'operate');
    if (job.status === 'closed') throw new RecruitmentError('job_closed');
    const [contract] = await tx.execute<{ agency_id: string; starts_on: string | Date; usable: boolean }>(sql`
      select c.agency_id, c.starts_on, app.recruitment_contract_usable(c.id) as usable from recruitment_agency_contract c
      where c.id = ${input.contractId as string}::uuid and c.company_id = ${job.companyId}::uuid
        and exists (select 1 from recruitment_job_agency_contract x where x.job_id = ${job.id}::uuid and x.contract_id = c.id)`);
    if (!contract?.usable) throw new RecruitmentError('contract_unavailable');
    const [consultant] = await tx.select({ id: recruitmentAgencyConsultant.id }).from(recruitmentAgencyConsultant)
      .where(and(eq(recruitmentAgencyConsultant.id, input.consultantId as string), eq(recruitmentAgencyConsultant.contractId, input.contractId as string),
        eq(recruitmentAgencyConsultant.status, 'active')));
    if (!consultant) throw new RecruitmentError('consultant_unavailable');
    const v = validateSubmissionInput(input, today, day(contract.starts_on));
    if (!v.ok) throw new RecruitmentError(v.code, v.fields);
    const check = await checkTx(tx, job.id, input.contractId as string, v.value);
    if (check.outcome === 'repeat' || check.outcome === 'limit') return check.outcome;
    const stored = submissionFor(check.outcome);
    if (!stored) throw new RecruitmentError('repeat_submission');
    const created = stored.outcome === 'accepted' ? await createCandidateTx(tx, s, job, v.value, resume) : null;
    const keepResume = stored.outcome === 'waiting' && resume;
    const base = {
      tenantId: s.tenantId, companyId: job.companyId, jobId: job.id, contractId: input.contractId as string, agencyId: contract.agency_id,
      consultantId: consultant.id, ...v.value, matchKind: stored.matchKind as MatchKind, outcome: stored.outcome, refusalReason: stored.refusalReason,
      candidateId: created?.candidateId ?? null, applicationId: created?.applicationId ?? null, createdByUserId: user,
      ...(keepResume ? { resumeName: resume.fileName, resumeMime: resume.mimeType, resumeSize: resume.content.byteLength, resumeContent: resume.content } : {}),
    };
    let submissionId: string;
    try {
      [{ id: submissionId }] = await tx.insert(recruitmentAgencySubmission).values(base).returning({ id: recruitmentAgencySubmission.id });
    } catch (e) {
      // 23505: the guard's own re-check found the same agency's earlier submission (a race the lock serialised).
      return asError(e, { '23505': 'repeat_submission' });
    }
    await event(tx, s, 'recruitment-job', job.id, 'recruitment-agency.submission-recorded', {
      companyId: job.companyId, jobId: job.id, contractId: input.contractId, submissionId, outcome: stored.outcome, matchKind: stored.matchKind,
      applicationId: created?.applicationId ?? null, resume: !!resume,
    });
    return { submissionId, outcome: stored.outcome, applicationId: created?.applicationId ?? null };
  }));
  if (result === 'repeat') throw new RecruitmentError('repeat_submission');
  if (result === 'limit') throw new RecruitmentError('agency_daily_limit');
  return result;
}

export type JobAgencySubmissionRow = {
  id: string; fullName: string | null; removed: boolean; agencyName: string; consultantName: string; submittedOn: string; outcome: SubmissionOutcome;
  refusalReason: 'protected' | null; applicationId: string | null; createdAt: string;
};
/** The job's agency submissions for its operators (newest first, at most 50): what was recorded and what became of it. */
export async function jobAgencySubmissions(s: SessionContext, jobId: string): Promise<JobAgencySubmissionRow[]> {
  return withRecruitmentTenant(s, async (tx) => {
    const job = await jobTx(tx, s, jobId, 'operate');
    const rows = await tx.execute<{ id: string; full_name: string | null; removed: boolean; agency_name: string | null; consultant_name: string | null;
      submitted_on: string | Date; outcome: SubmissionOutcome; refusal_reason: 'protected' | null; application_id: string | null; created_at: string | Date }>(sql`
      select s.id, s.full_name, s.personal_data_removed_at is not null as removed, a.name as agency_name, k.name as consultant_name, s.submitted_on,
        s.outcome, s.refusal_reason, s.application_id, s.created_at
      from recruitment_agency_submission s
      left join recruitment_agency a on a.id = s.agency_id
      left join recruitment_agency_consultant k on k.id = s.consultant_id
      where s.job_id = ${job.id}::uuid order by s.created_at desc, s.id limit 50`);
    return rows.map((r) => ({
      id: r.id, fullName: r.full_name, removed: r.removed, agencyName: r.agency_name ?? '', consultantName: r.consultant_name ?? '', submittedOn: day(r.submitted_on),
      outcome: r.outcome, refusalReason: r.refusal_reason, applicationId: r.application_id, createdAt: iso(r.created_at),
    }));
  });
}

// ── Review (administrators) ───────────────────────────────────────────────────────────────────────────────────

export type AgencyReviewRow = {
  id: string; companyId: string; jobId: string; jobTitle: string; jobNumber: string; fullName: string; agencyName: string; consultantName: string;
  matchKind: MatchKind; submittedOn: string; createdAt: string;
};
/** Submissions waiting for review in the companies the viewer administers (oldest first, at most 100). */
export async function agencyReviewQueue(s: SessionContext, companyIds: readonly string[]): Promise<AgencyReviewRow[]> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ id: string; company_id: string; job_id: string; title: string; job_number: string; full_name: string; agency_name: string;
      consultant_name: string; match_kind: MatchKind; submitted_on: string | Date; created_at: string | Date }>(sql`
      select s.id, s.company_id, s.job_id, j.title, j.job_number, s.full_name, a.name as agency_name, k.name as consultant_name, s.match_kind, s.submitted_on, s.created_at
      from unnest(${`{${ids.join(',')}}`}::uuid[]) co(id)
      cross join lateral (select s.id, s.company_id, s.job_id, s.agency_id, s.consultant_id, s.full_name, s.match_kind, s.submitted_on, s.created_at
        from recruitment_agency_submission s where s.tenant_id = ${s.tenantId}::uuid and s.company_id = co.id and s.outcome = 'waiting'
        and app.can_admin_recruitment_for(co.id) order by s.created_at limit 100) s
      join recruitment_job_opening j on j.id = s.job_id
      join recruitment_agency a on a.id = s.agency_id
      join recruitment_agency_consultant k on k.id = s.consultant_id
      order by s.created_at, s.id limit 100`);
    return rows.map((r) => ({
      id: r.id, companyId: r.company_id, jobId: r.job_id, jobTitle: r.title, jobNumber: r.job_number, fullName: r.full_name, agencyName: r.agency_name,
      consultantName: r.consultant_name, matchKind: r.match_kind, submittedOn: day(r.submitted_on), createdAt: iso(r.created_at),
    }));
  });
}

export type AgencySubmissionReview = {
  id: string; companyId: string; jobId: string; jobTitle: string; jobNumber: string; agencyName: string; contractName: string; consultantName: string;
  submittedOn: string; fullName: string | null; email: string | null; mobile: string | null; idType: IdType | null; idNumber: string | null;
  currentSalary: { amount: string; currency: string } | null; expectedSalary: { amount: string; currency: string } | null; comments: string | null;
  resume: { name: string; size: number } | null; matchKind: MatchKind; outcome: SubmissionOutcome; refusalReason: 'protected' | null; reviewReason: string | null;
  applicationId: string | null; removed: boolean; matches: DuplicateMatch[];
};
async function submissionTx(tx: Tx, s: SessionContext, submissionId: unknown, forUpdate = false) {
  if (!isUuid(submissionId)) throw new RecruitmentError('not_found');
  const q = tx.select({
    id: recruitmentAgencySubmission.id, companyId: recruitmentAgencySubmission.companyId, jobId: recruitmentAgencySubmission.jobId,
    contractId: recruitmentAgencySubmission.contractId, agencyId: recruitmentAgencySubmission.agencyId, consultantId: recruitmentAgencySubmission.consultantId,
    submittedOn: recruitmentAgencySubmission.submittedOn, fullName: recruitmentAgencySubmission.fullName, email: recruitmentAgencySubmission.email,
    mobile: recruitmentAgencySubmission.mobile, idType: recruitmentAgencySubmission.idType, idNumber: recruitmentAgencySubmission.idNumber,
    currentSalaryAmount: recruitmentAgencySubmission.currentSalaryAmount, currentSalaryCurrency: recruitmentAgencySubmission.currentSalaryCurrency,
    expectedSalaryAmount: recruitmentAgencySubmission.expectedSalaryAmount, expectedSalaryCurrency: recruitmentAgencySubmission.expectedSalaryCurrency,
    comments: recruitmentAgencySubmission.comments, resumeName: recruitmentAgencySubmission.resumeName, resumeSize: recruitmentAgencySubmission.resumeSize,
    matchKind: recruitmentAgencySubmission.matchKind, outcome: recruitmentAgencySubmission.outcome, refusalReason: recruitmentAgencySubmission.refusalReason,
    reviewReason: recruitmentAgencySubmission.reviewReason, applicationId: recruitmentAgencySubmission.applicationId,
    removedAt: recruitmentAgencySubmission.personalDataRemovedAt,
  }).from(recruitmentAgencySubmission)
    .where(and(eq(recruitmentAgencySubmission.id, submissionId), eq(recruitmentAgencySubmission.tenantId, s.tenantId)));
  const [seen] = await q;
  if (!seen) throw new RecruitmentError('not_found');
  await assertCompanyTx(tx, seen.companyId);
  if (!forUpdate) return seen;
  // Administrators only from here: lock the row and read it again, so a concurrent decision waits and is seen.
  const [row] = await q.for('update');
  if (!row) throw new RecruitmentError('not_found');
  return row;
}

/** One submission for an administrator's review, with the company's matching candidates (slice 5 rule) and their jobs. */
export async function agencySubmissionReview(s: SessionContext, submissionId: unknown): Promise<AgencySubmissionReview> {
  return withRecruitmentTenant(s, async (tx) => {
    const r = await submissionTx(tx, s, submissionId);
    const [names] = await tx.execute<{ title: string; job_number: string; agency: string; contract: string; consultant: string }>(sql`
      select j.title, j.job_number, a.name as agency, c.name as contract, k.name as consultant from recruitment_job_opening j, recruitment_agency a,
        recruitment_agency_contract c, recruitment_agency_consultant k
      where j.id = ${r.jobId}::uuid and a.id = ${r.agencyId}::uuid and c.id = ${r.contractId}::uuid and k.id = ${r.consultantId}::uuid`);
    const matches = r.outcome === 'waiting' && r.fullName
      ? (await duplicateCheckTx(tx, r.companyId, { fullName: r.fullName, email: r.email, phone: r.mobile, idNumber: r.idNumber })).matches ?? [] : [];
    return {
      id: r.id, companyId: r.companyId, jobId: r.jobId, jobTitle: names?.title ?? '', jobNumber: names?.job_number ?? '', agencyName: names?.agency ?? '',
      contractName: names?.contract ?? '', consultantName: names?.consultant ?? '', submittedOn: day(r.submittedOn), fullName: r.fullName, email: r.email,
      mobile: r.mobile, idType: r.idType, idNumber: r.idNumber,
      currentSalary: r.currentSalaryAmount && r.currentSalaryCurrency ? { amount: r.currentSalaryAmount, currency: r.currentSalaryCurrency } : null,
      expectedSalary: r.expectedSalaryAmount && r.expectedSalaryCurrency ? { amount: r.expectedSalaryAmount, currency: r.expectedSalaryCurrency } : null,
      comments: r.comments, resume: r.resumeName && r.resumeSize ? { name: r.resumeName, size: r.resumeSize } : null, matchKind: r.matchKind, outcome: r.outcome,
      refusalReason: r.refusalReason, reviewReason: r.reviewReason, applicationId: r.applicationId, removed: r.removedAt !== null, matches,
    };
  });
}

/**
 * Accept a waiting submission (administrators): onto an existing candidate of the company (`candidateId`, the application
 * is added to them; their record is not overwritten) or as a new candidate. Either way the application goes to the job's
 * first enabled stage with source "agency"; the waiting résumé moves to the candidate's files. The slice 5
 * repeated-application rule still applies to the existing candidate.
 */
export async function acceptAgencySubmission(s: SessionContext, submissionId: unknown, input: { candidateId?: unknown } = {}): Promise<{ applicationId: string; candidateId: string }> {
  const existing = input.candidateId == null || input.candidateId === '' ? null : input.candidateId;
  if (existing !== null && !isUuid(existing)) throw new RecruitmentError('not_found');
  return busyRetryable(() => withRecruitmentTenant(s, async (tx) => {
    // Lock order, the same as every other writer of a candidate's record: the candidate (shared, so its removal cannot
    // interleave), then the submission row, then the identity keys.
    const seen = await submissionTx(tx, s, submissionId);
    if (existing) await tx.execute(sql`select pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(${s.tenantId}::uuid, ${existing}::uuid))`);
    const r = seen.outcome === 'waiting' ? await submissionTx(tx, s, submissionId, true) : seen;
    if (r.outcome !== 'waiting' || !r.fullName) throw new RecruitmentError('submission_decided');
    const job = await jobTx(tx, s, r.jobId);
    if (job.status === 'closed') throw new RecruitmentError('job_closed');
    await lockIdentityTx(tx, s, r.companyId, { email: r.email, mobile: r.mobile, idNumber: r.idNumber });
    const [resume] = await tx.select({ name: recruitmentAgencySubmission.resumeName, mime: recruitmentAgencySubmission.resumeMime,
      content: recruitmentAgencySubmission.resumeContent }).from(recruitmentAgencySubmission).where(eq(recruitmentAgencySubmission.id, r.id));
    const file = resume?.content && resume.name && resume.mime ? { fileName: resume.name, mimeType: resume.mime, content: resume.content } : null;
    let created: { candidateId: string; applicationId: string };
    if (existing) {
      const [c] = await tx.select({ id: recruitmentCandidate.id, destroyedAt: recruitmentCandidate.destroyedAt }).from(recruitmentCandidate)
        .where(and(eq(recruitmentCandidate.id, existing), eq(recruitmentCandidate.tenantId, s.tenantId), eq(recruitmentCandidate.companyId, r.companyId)));
      if (!c) throw new RecruitmentError('not_found');
      if (c.destroyedAt) throw new RecruitmentError('candidate_removed');
      await assertNotRepeatedTx(tx, r.companyId, c.id, job.id);
      const applicationId = await applicationOnTx(tx, s, job, c.id);
      if (file) {
        await tx.insert(recruitmentCandidateFile).values({
          tenantId: s.tenantId, companyId: r.companyId, candidateId: c.id, kind: 'resume', fileName: file.fileName, mimeType: file.mimeType,
          sizeBytes: file.content.byteLength, content: file.content, permissionConfirmed: true, uploadedByUserId: actorId(s),
        });
      }
      created = { candidateId: c.id, applicationId };
    } else {
      created = await createCandidateTx(tx, s, job, {
        fullName: r.fullName, email: r.email, mobile: r.mobile, idType: r.idType, idNumber: r.idNumber, currentSalaryAmount: r.currentSalaryAmount,
        currentSalaryCurrency: r.currentSalaryCurrency, expectedSalaryAmount: r.expectedSalaryAmount, expectedSalaryCurrency: r.expectedSalaryCurrency,
      }, file);
    }
    await tx.update(recruitmentAgencySubmission).set({
      outcome: 'accepted', candidateId: created.candidateId, applicationId: created.applicationId, resumeName: null, resumeMime: null, resumeSize: null, resumeContent: null,
    }).where(eq(recruitmentAgencySubmission.id, r.id));
    await event(tx, s, 'recruitment-job', job.id, 'recruitment-agency.submission-accepted', {
      companyId: r.companyId, jobId: job.id, submissionId: r.id, applicationId: created.applicationId, candidateId: created.candidateId, onto: existing ? 'existing' : 'new',
    });
    return created;
  }));
}

/** Reject a waiting submission with a reason (administrators). The waiting résumé is discarded; the row stays as Rejected. */
export async function rejectAgencySubmission(s: SessionContext, submissionId: unknown, reason: unknown): Promise<void> {
  const v = validateReviewReason(reason);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  await busyRetryable(() => withRecruitmentTenant(s, async (tx) => {
    const r = await submissionTx(tx, s, submissionId, true);
    if (r.outcome !== 'waiting') throw new RecruitmentError('submission_decided');
    await tx.update(recruitmentAgencySubmission).set({ outcome: 'rejected', reviewReason: v.value, resumeName: null, resumeMime: null, resumeSize: null, resumeContent: null })
      .where(eq(recruitmentAgencySubmission.id, r.id));
    await event(tx, s, 'recruitment-job', r.jobId, 'recruitment-agency.submission-rejected', { companyId: r.companyId, jobId: r.jobId, submissionId: r.id });
  }));
}

/**
 * Remove the personal data of a REFUSED or REJECTED submission (administrators; 4410 app.recruitment_clear_agency_submission):
 * name, contacts, ID number, salaries, comments, the review reason and any held résumé. Job, contract, consultant, dates and
 * outcome stay. Needs the explicit confirmation. An event records it without personal data.
 */
export async function removeAgencySubmissionData(s: SessionContext, submissionId: unknown, confirmed: unknown): Promise<void> {
  if (!isTicked(confirmed)) throw new RecruitmentError('confirm_required');
  await busyRetryable(() => withRecruitmentTenant(s, async (tx) => {
    const r = await submissionTx(tx, s, submissionId);
    if (r.outcome !== 'refused' && r.outcome !== 'rejected') throw new RecruitmentError('submission_decided');
    const [row] = await tx.execute<{ cleared: boolean }>(sql`select app.recruitment_clear_agency_submission(${r.id}::uuid) as cleared`);
    if (row?.cleared) {
      await event(tx, s, 'recruitment-job', r.jobId, 'recruitment-agency.submission-data-removed', { companyId: r.companyId, jobId: r.jobId, submissionId: r.id });
    }
  }));
}

export type AgencySubmissionDue = { id: string; jobTitle: string; jobNumber: string; agencyName: string; outcome: SubmissionOutcome; decidedOn: string };
/**
 * The Privacy due list's agency part (administrators): refused or rejected submissions still holding personal data whose
 * decision is older than the company's "months kept without consent" (slice 5 setting, Kuala Lumpur calendar months).
 * Nothing is removed automatically. Oldest first, at most 200.
 */
export async function agencySubmissionsDue(s: SessionContext, companyId: string, opts: { now?: Date } = {}): Promise<AgencySubmissionDue[]> {
  const today = todayInKualaLumpur(opts.now ?? new Date());
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<{ id: string; title: string; job_number: string; agency: string; outcome: SubmissionOutcome; decided_on: string }>(sql`
      with setting as (select coalesce((select st.retention_months_without_consent from recruitment_company_setting st
        where st.company_id = ${companyId}::uuid and st.tenant_id = ${s.tenantId}::uuid), 6) as months)
      select x.id, j.title, j.job_number, a.name as agency, x.outcome, to_char((x.decided_at at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD') as decided_on
      from recruitment_agency_submission x
      join recruitment_job_opening j on j.id = x.job_id
      join recruitment_agency a on a.id = x.agency_id
      cross join setting
      where x.tenant_id = ${s.tenantId}::uuid and x.company_id = ${companyId}::uuid and x.outcome in ('refused', 'rejected') and x.personal_data_removed_at is null
        and ((x.decided_at at time zone 'Asia/Kuala_Lumpur')::date + make_interval(months => setting.months))::date <= ${today}::date
      order by x.decided_at, x.id limit 200`);
    return rows.map((r) => ({ id: r.id, jobTitle: r.title, jobNumber: r.job_number, agencyName: r.agency, outcome: r.outcome, decidedOn: r.decided_on }));
  });
}

// ── The agency on an application ───────────────────────────────────────────────────────────────────────────────

export type ApplicationAgency = { agencyName: string; contractName: string | null; consultantName: string | null; submittedOn: string | null; comments: string | null };
/** The agency behind an application, for its readers: the agency name; contract, consultant, date and comments for the
 *  job's operators and administrators only (4410 app.recruitment_application_agency). Null when not from an agency. */
export async function applicationAgency(s: SessionContext, applicationId: unknown): Promise<ApplicationAgency | null> {
  if (!isUuid(applicationId)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.execute<{ agency_name: string; contract_name: string | null; consultant_name: string | null; submitted_on: string | Date | null; comments: string | null }>(sql`
      select agency_name, contract_name, consultant_name, submitted_on, comments from app.recruitment_application_agency(${applicationId}::uuid)`);
    return row ? {
      agencyName: row.agency_name, contractName: row.contract_name, consultantName: row.consultant_name,
      submittedOn: row.submitted_on ? day(row.submitted_on) : null, comments: row.comments,
    } : null;
  });
}

