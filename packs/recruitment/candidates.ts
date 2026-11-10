/**
 * Recruitment slice 5 — candidate records and privacy. Reached from outside the pack ONLY through ./service.
 *
 * Every entry point runs inside `withRecruitmentTenant` and re-asks the database (4405 predicates) who the caller is to
 * THIS candidate:
 *   read the profile and resume          — anyone who may read one of the candidate's applications;
 *   tags                                 — read by reviewers (administrators, recruiter, assistant, hiring manager),
 *                                          written by operators; interviewers never see them;
 *   edit, restricted values, attachments, consent — administrators and the operators (recruiter, assistant) of one of
 *                                          the candidate's jobs;
 *   retention, the due list, destruction, tag catalogue and privacy settings — recruitment administrators only.
 * Row security refuses the same independently. Domain event payloads carry ids, kinds, sizes and field NAMES — never a
 * value, a file name or file bytes. Dates come from lib/hr-date (Kuala Lumpur). Nothing here calls a model, parses a
 * resume or infers anything about a candidate; nothing is destroyed automatically.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { resolveDocumentUpload } from '../../core/employee-documents';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid } from './model';
import {
  CANDIDATE_FILE_MAX_BYTES, CANDIDATE_FILE_MIME, DEFAULT_REPEAT_WINDOW_MONTHS, DEFAULT_RETENTION_MONTHS_WITH_CONSENT, DEFAULT_RETENTION_MONTHS_WITHOUT_CONSENT,
  FILE_KINDS, currentConsent, retentionDueOn, retentionEnded, validateConsentInput, validateDestruction, validateEntryInput, validatePrivacySettings,
  validateProfileInput, validateRestrictedInput,
  type CandidateFileKind, type CandidateSource, type ConsentMethod, type ConsentState, type ConsentStatus, type EducationLevel, type EntryKind, type IdType,
  type ValidPrivacySettings,
} from './privacy-model';
import {
  recruitmentCandidate, recruitmentCandidateConsent, recruitmentCandidateEntry, recruitmentCandidateFile, recruitmentCandidateRestricted,
  recruitmentCandidateTag, recruitmentCompanySetting, recruitmentTag, recruitmentTagGroup,
} from './schema';
import { actorId, assertCompanyTx, assertJobLevelTx, userLabelsTx } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const candidateEvent = (tx: Tx, s: SessionContext, candidateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-candidate', aggregateId: candidateId, eventType, actor: actorOf(s), payload });

type CandidateAccess = { admin: boolean; operate: boolean; review: boolean };
const PROFILE_COLUMNS = {
  id: recruitmentCandidate.id, companyId: recruitmentCandidate.companyId, fullName: recruitmentCandidate.fullName, email: recruitmentCandidate.email,
  phone: recruitmentCandidate.phone, location: recruitmentCandidate.location, currentCompany: recruitmentCandidate.currentCompany,
  currentTitle: recruitmentCandidate.currentTitle, highestEducation: recruitmentCandidate.highestEducation, noticePeriod: recruitmentCandidate.noticePeriod,
  source: recruitmentCandidate.source, destroyedAt: recruitmentCandidate.destroyedAt,
};

/** The candidate, if the caller may see them (row security), and the caller's candidate-level access (4405 predicates). */
async function candidateTx(tx: Tx, s: SessionContext, candidateId: unknown) {
  if (!isUuid(candidateId)) throw new RecruitmentError('not_found');
  const [c] = await tx.select(PROFILE_COLUMNS).from(recruitmentCandidate)
    .where(and(eq(recruitmentCandidate.id, candidateId), eq(recruitmentCandidate.tenantId, s.tenantId)));
  if (!c) throw new RecruitmentError('not_found');
  const [a] = await tx.execute<CandidateAccess>(sql`select app.can_admin_recruitment_for(${c.companyId}::uuid) as admin,
    app.recruitment_operates_candidate(${c.companyId}::uuid, ${c.id}::uuid) as operate, app.recruitment_reviews_candidate(${c.companyId}::uuid, ${c.id}::uuid) as review`);
  return { c, access: { admin: a?.admin === true, operate: a?.operate === true, review: a?.review === true } };
}
/** A candidate the caller operates (administrator or a job operator), whose data has not been removed. */
async function operatedCandidateTx(tx: Tx, s: SessionContext, candidateId: unknown) {
  const found = await candidateTx(tx, s, candidateId);
  if (!found.access.operate) throw new RecruitmentError('forbidden');
  if (found.c.destroyedAt) throw new RecruitmentError('candidate_removed');
  return found.c;
}

// ── Retention ────────────────────────────────────────────────────────────────────────────────────────────────

export type PrivacySettings = ValidPrivacySettings;
async function privacySettingsTx(tx: Tx, companyId: string): Promise<PrivacySettings> {
  const [row] = await tx.select({
    w: recruitmentCompanySetting.retentionMonthsWithoutConsent, c: recruitmentCompanySetting.retentionMonthsWithConsent, r: recruitmentCompanySetting.repeatWindowMonths,
  }).from(recruitmentCompanySetting).where(eq(recruitmentCompanySetting.companyId, companyId));
  return {
    monthsWithoutConsent: row?.w ?? DEFAULT_RETENTION_MONTHS_WITHOUT_CONSENT, monthsWithConsent: row?.c ?? DEFAULT_RETENTION_MONTHS_WITH_CONSENT,
    repeatWindowMonths: row?.r ?? DEFAULT_REPEAT_WINDOW_MONTHS,
  };
}

type RetentionRow = { id: string; full_name: string; has_active: boolean; has_hired: boolean; archived_on: string | null; consent: { status: ConsentStatus; on: string } | null };
/**
 * The facts the retention rule needs, per live candidate of the company: active / hired applications, the latest
 * archival day (Kuala Lumpur) and the current consent (latest by date, then by recording time). With `dueOnly`, a cheap
 * SQL pre-filter keeps candidates whose earliest possible due day has passed; ./privacy-model decides exactly.
 */
async function retentionRowsTx(tx: Tx, s: SessionContext, companyId: string, opts: { candidateId?: string; dueOnly?: { minMonths: number; today: string } }): Promise<RetentionRow[]> {
  return [...await tx.execute<RetentionRow>(sql`
    select c.id, c.full_name, bool_or(a.state = 'active') as has_active, bool_or(a.state = 'hired') as has_hired,
      to_char(max((a.state_changed_at at time zone 'Asia/Kuala_Lumpur')::date) filter (where a.state = 'archived'), 'YYYY-MM-DD') as archived_on,
      (select json_build_object('status', k.status, 'on', to_char(k.effective_on, 'YYYY-MM-DD')) from recruitment_candidate_consent k
        where k.candidate_id = c.id order by k.effective_on desc, k.recorded_at desc, k.id desc limit 1) as consent
    from recruitment_candidate c join recruitment_application a on a.candidate_id = c.id and a.tenant_id = c.tenant_id
    where c.tenant_id = ${s.tenantId}::uuid and c.company_id = ${companyId}::uuid and c.destroyed_at is null
      ${opts.candidateId ? sql`and c.id = ${opts.candidateId}::uuid` : sql``}
    group by c.id
    ${opts.dueOnly ? sql`having not bool_or(a.state in ('active', 'hired'))
      and (max((a.state_changed_at at time zone 'Asia/Kuala_Lumpur')::date) filter (where a.state = 'archived')
        + make_interval(months => ${opts.dueOnly.minMonths}::int))::date <= ${opts.dueOnly.today}::date` : sql``}
    order by 5, c.id limit 1000`)];
}
const dueOf = (r: RetentionRow, settings: PrivacySettings) => retentionDueOn({
  hasActive: r.has_active, hasHired: r.has_hired, latestArchivedOn: r.archived_on, consent: r.consent as ConsentState,
  monthsWithoutConsent: settings.monthsWithoutConsent, monthsWithConsent: settings.monthsWithConsent,
});

export type DueCandidate = { candidateId: string; name: string; archivedOn: string; consent: ConsentState; dueOn: string };
/** Settings › Privacy: candidates whose retention period has ended, for recruitment administrators only. */
export async function dueForDestruction(s: SessionContext, companyId: string): Promise<{ today: string; settings: PrivacySettings; due: DueCandidate[] }> {
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const settings = await privacySettingsTx(tx, companyId);
    const rows = await retentionRowsTx(tx, s, companyId, { dueOnly: { minMonths: Math.min(settings.monthsWithoutConsent, settings.monthsWithConsent), today } });
    const due: DueCandidate[] = [];
    for (const r of rows) {
      const dueOn = dueOf(r, settings);
      if (dueOn && retentionEnded(dueOn, today)) due.push({ candidateId: r.id, name: r.full_name, archivedOn: r.archived_on!, consent: r.consent as ConsentState, dueOn });
    }
    // Longest overdue first; ties in a stable order.
    due.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.candidateId.localeCompare(b.candidateId));
    return { today, settings, due };
  });
}

export async function privacySettings(s: SessionContext, companyId: string): Promise<PrivacySettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    return privacySettingsTx(tx, companyId);
  });
}

export async function updatePrivacySettings(s: SessionContext, companyId: unknown, input: Record<string, unknown>): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const v = validatePrivacySettings(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const before = await privacySettingsTx(tx, companyId);
    await tx.insert(recruitmentCompanySetting).values({ tenantId: s.tenantId, companyId, createdByUserId: user, updatedByUserId: user }).onConflictDoNothing();
    await tx.update(recruitmentCompanySetting).set({
      retentionMonthsWithoutConsent: v.value.monthsWithoutConsent, retentionMonthsWithConsent: v.value.monthsWithConsent,
      repeatWindowMonths: v.value.repeatWindowMonths, updatedAt: sql`now()`, updatedByUserId: user,
    }).where(eq(recruitmentCompanySetting.companyId, companyId));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-setting.privacy-updated',
      actor: actorOf(s), payload: { companyId, before, after: v.value } });
  });
}

/**
 * Remove the personal data of due candidates (an administrator's explicit, confirmed choice). Each must belong to the
 * company and be past its retention period — so never one with an active or hired application. One transaction: all
 * or nothing. app.recruitment_destroy_candidate does the removal; one event per candidate records it with counts only.
 */
export async function destroyCandidates(s: SessionContext, companyId: unknown, candidateIds: unknown, confirmed: unknown): Promise<{ removed: number }> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  const v = validateDestruction(candidateIds, confirmed);
  if (!v.ok) throw new RecruitmentError(v.code);
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const settings = await privacySettingsTx(tx, companyId);
    // Take every candidate's lock (exclusive, in a fixed order so two removals never deadlock) BEFORE any retention
    // check: a consent or file written concurrently either commits first and is seen below, or waits and then finds the
    // record removed (the 4405 guards take the same lock shared). Never row FOR SHARE: that is filtered by update policies.
    const ids = [...v.ids].sort();
    for (const id of ids) await tx.execute(sql`select pg_advisory_xact_lock(app.recruitment_candidate_lock_key(${s.tenantId}::uuid, ${id}::uuid))`);
    for (const id of ids) {
      const [row] = await retentionRowsTx(tx, s, companyId, { candidateId: id });
      if (!row) throw new RecruitmentError('not_found');
      if (!retentionEnded(dueOf(row, settings), today)) throw new RecruitmentError('not_due');
      let counts: Record<string, number>;
      try {
        [{ counts }] = await tx.execute<{ counts: Record<string, number> }>(sql`select app.recruitment_destroy_candidate(${id}::uuid) as counts`);
      } catch (e) {
        if (pgSqlState(e) === '23514') throw new RecruitmentError('not_due');
        throw e;
      }
      await candidateEvent(tx, s, id, 'recruitment-candidate.personal-data-removed', { companyId, ...counts });
    }
    return { removed: v.ids.length };
  });
}

// ── The candidate profile ────────────────────────────────────────────────────────────────────────────────────

export type CandidateEntryView = { id: string; kind: EntryKind; organisation: string; title: string | null; fromMonth: string | null; toMonth: string | null; isCurrent: boolean };
export type CandidateFileView = { id: string; kind: CandidateFileKind; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string; uploadedBy: string | null };
export type CandidateRestrictedView = {
  currentSalaryAmount: string | null; currentSalaryCurrency: string | null; expectedSalaryAmount: string | null; expectedSalaryCurrency: string | null;
  idType: IdType | null; idNumber: string | null;
};
export type ConsentEntryView = { id: string; status: ConsentStatus; effectiveOn: string; method: ConsentMethod; noticeReference: string | null; recordedAt: string; recordedBy: string | null };
export type CandidateProfile = {
  candidateId: string; companyId: string; removed: boolean;
  fullName: string; email: string | null; phone: string | null; location: string | null; currentCompany: string | null; currentTitle: string | null;
  highestEducation: EducationLevel | null; noticePeriod: string | null; source: CandidateSource | null;
  entries: CandidateEntryView[];
  files: CandidateFileView[];
  /** Null unless the viewer may see restricted values (administrators and the candidate's job operators). */
  restricted: CandidateRestrictedView | null;
  /** Null for a viewer who may not see tags (interviewers). */
  tags: { id: string; name: string; groupName: string; enabled: boolean }[] | null;
  /** Enabled tags an operator may add. */
  tagOptions: { id: string; name: string; groupName: string }[];
  /** Null unless the viewer is an administrator or operator. */
  consent: { current: ConsentState; history: ConsentEntryView[] } | null;
  /** Administrators only: when the retention period ends (null = never: active or hired) and whether it has. */
  retention: { dueOn: string | null; ended: boolean } | null;
  can: { edit: boolean; admin: boolean; review: boolean };
};

/** The candidate behind an application, as the viewer may see them. */
export async function candidateProfile(s: SessionContext, applicationId: unknown): Promise<CandidateProfile> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  const today = todayInKualaLumpur();
  return withRecruitmentTenant(s, async (tx) => {
    const [app] = await tx.execute<{ candidate_id: string; company_id: string; job_id: string }>(sql`
      select candidate_id, company_id, job_id from recruitment_application where id = ${applicationId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!app) throw new RecruitmentError('not_found');
    await assertJobLevelTx(tx, app.company_id, app.job_id, 'read', applicationId);
    const { c, access } = await candidateTx(tx, s, app.candidate_id);
    const labels = await userLabelsTx(tx, c.companyId);
    const who = (id: string) => labels.get(id)?.name ?? null;
    const entries = await tx.select({
      id: recruitmentCandidateEntry.id, kind: recruitmentCandidateEntry.kind, organisation: recruitmentCandidateEntry.organisation, title: recruitmentCandidateEntry.title,
      fromMonth: recruitmentCandidateEntry.fromMonth, toMonth: recruitmentCandidateEntry.toMonth, isCurrent: recruitmentCandidateEntry.isCurrent,
    }).from(recruitmentCandidateEntry).where(eq(recruitmentCandidateEntry.candidateId, c.id))
      .orderBy(asc(recruitmentCandidateEntry.kind), sql`${recruitmentCandidateEntry.isCurrent} desc`, sql`${recruitmentCandidateEntry.fromMonth} desc nulls last`, asc(recruitmentCandidateEntry.createdAt));
    // The bytes are never selected here; row security narrows the list (interviewers and hiring managers: the resume only).
    const files = await tx.select({
      id: recruitmentCandidateFile.id, kind: recruitmentCandidateFile.kind, fileName: recruitmentCandidateFile.fileName, mimeType: recruitmentCandidateFile.mimeType,
      sizeBytes: recruitmentCandidateFile.sizeBytes, uploadedAt: recruitmentCandidateFile.uploadedAt, uploadedBy: recruitmentCandidateFile.uploadedByUserId,
    }).from(recruitmentCandidateFile).where(eq(recruitmentCandidateFile.candidateId, c.id)).orderBy(asc(recruitmentCandidateFile.kind), asc(recruitmentCandidateFile.uploadedAt));
    let restricted: CandidateRestrictedView | null = null;
    if (access.operate) {
      const [r] = await tx.select().from(recruitmentCandidateRestricted).where(eq(recruitmentCandidateRestricted.candidateId, c.id));
      restricted = {
        currentSalaryAmount: r?.currentSalaryAmount ?? null, currentSalaryCurrency: r?.currentSalaryCurrency ?? null, expectedSalaryAmount: r?.expectedSalaryAmount ?? null,
        expectedSalaryCurrency: r?.expectedSalaryCurrency ?? null, idType: r?.idType ?? null, idNumber: r?.idNumber ?? null,
      };
    }
    const tags = access.review ? await tx.execute<{ id: string; name: string; group_name: string; enabled: boolean }>(sql`
      select t.id, t.name, g.name as group_name, t.enabled and g.enabled as enabled from recruitment_candidate_tag ct
      join recruitment_tag t on t.id = ct.tag_id join recruitment_tag_group g on g.id = t.group_id
      where ct.candidate_id = ${c.id}::uuid order by g.name, t.name`) : null;
    const tagOptions = access.operate && !c.destroyedAt ? await tx.execute<{ id: string; name: string; group_name: string }>(sql`
      select t.id, t.name, g.name as group_name from recruitment_tag t join recruitment_tag_group g on g.id = t.group_id
      where t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${c.companyId}::uuid and t.enabled and g.enabled
        and not exists (select 1 from recruitment_candidate_tag ct where ct.candidate_id = ${c.id}::uuid and ct.tag_id = t.id)
      order by g.name, t.name`) : [];
    let consent: CandidateProfile['consent'] = null;
    if (access.operate) {
      const history = await tx.select().from(recruitmentCandidateConsent).where(eq(recruitmentCandidateConsent.candidateId, c.id));
      const views = history.map((h) => ({
        id: h.id, status: h.status, effectiveOn: h.effectiveOn, method: h.method, noticeReference: h.noticeReference, recordedAt: iso(h.recordedAt),
        recordedBy: who(h.recordedByUserId),
      })).sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.recordedAt.localeCompare(a.recordedAt));
      consent = { current: currentConsent(views), history: views };
    }
    let retention: CandidateProfile['retention'] = null;
    if (access.admin && !c.destroyedAt) {
      const [row] = await retentionRowsTx(tx, s, c.companyId, { candidateId: c.id });
      const dueOn = row ? dueOf(row, await privacySettingsTx(tx, c.companyId)) : null;
      retention = { dueOn, ended: retentionEnded(dueOn, today) };
    }
    return {
      candidateId: c.id, companyId: c.companyId, removed: !!c.destroyedAt, fullName: c.fullName, email: c.email, phone: c.phone, location: c.location,
      currentCompany: c.currentCompany, currentTitle: c.currentTitle, highestEducation: c.highestEducation ?? null, noticePeriod: c.noticePeriod,
      source: c.source ?? null, entries, restricted, consent, retention,
      files: files.map((f) => ({ ...f, uploadedAt: iso(f.uploadedAt), uploadedBy: who(f.uploadedBy) })),
      tags: tags ? tags.map((t) => ({ id: t.id, name: t.name, groupName: t.group_name, enabled: t.enabled })) : null,
      tagOptions: tagOptions.map((t) => ({ id: t.id, name: t.name, groupName: t.group_name })),
      can: { edit: access.operate && !c.destroyedAt, admin: access.admin, review: access.review },
    };
  });
}

/** Edit the candidate's profile (administrators and the candidate's job operators). */
export async function updateCandidateProfile(s: SessionContext, candidateId: unknown, input: Record<string, unknown>): Promise<void> {
  const v = validateProfileInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const changed = (Object.keys(v.value) as (keyof typeof v.value)[]).filter((k) => (c[k] ?? null) !== v.value[k]);
    if (!changed.length) return;
    await tx.update(recruitmentCandidate).set({ ...v.value, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentCandidate.id, c.id));
    // Field NAMES only: the values are personal data.
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.profile-updated', { companyId: c.companyId, fields: changed });
  });
}

/** Restricted values (salaries, ID number): administrators and the candidate's job operators only. */
export async function saveCandidateRestricted(s: SessionContext, candidateId: unknown, input: Record<string, unknown>): Promise<void> {
  const v = validateRestrictedInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const [before] = await tx.select().from(recruitmentCandidateRestricted).where(eq(recruitmentCandidateRestricted.candidateId, c.id));
    const changed = (Object.keys(v.value) as (keyof typeof v.value)[]).filter((k) => (before?.[k] ?? null) !== v.value[k]);
    if (!changed.length) return;
    await tx.insert(recruitmentCandidateRestricted).values({ tenantId: s.tenantId, companyId: c.companyId, candidateId: c.id, ...v.value, updatedByUserId: user })
      .onConflictDoUpdate({ target: recruitmentCandidateRestricted.candidateId, set: { ...v.value, updatedAt: sql`now()`, updatedByUserId: user } });
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.restricted-updated', { companyId: c.companyId, fields: changed });
  });
}

export async function addCandidateEntry(s: SessionContext, candidateId: unknown, input: Record<string, unknown>): Promise<{ id: string }> {
  const v = validateEntryInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const [row] = await tx.insert(recruitmentCandidateEntry).values({ tenantId: s.tenantId, companyId: c.companyId, candidateId: c.id, ...v.value, createdByUserId: user })
      .returning({ id: recruitmentCandidateEntry.id });
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.entry-added', { companyId: c.companyId, entryId: row.id, kind: v.value.kind });
    return row;
  });
}

export async function removeCandidateEntry(s: SessionContext, entryId: unknown): Promise<void> {
  if (!isUuid(entryId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [entry] = await tx.select({ candidateId: recruitmentCandidateEntry.candidateId, kind: recruitmentCandidateEntry.kind }).from(recruitmentCandidateEntry)
      .where(and(eq(recruitmentCandidateEntry.id, entryId), eq(recruitmentCandidateEntry.tenantId, s.tenantId)));
    if (!entry) throw new RecruitmentError('not_found');
    const c = await operatedCandidateTx(tx, s, entry.candidateId);
    await tx.delete(recruitmentCandidateEntry).where(eq(recruitmentCandidateEntry.id, entryId));
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.entry-removed', { companyId: c.companyId, entryId, kind: entry.kind });
  });
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Upload a resume or attachment: PDF, Word or image (the type is read from the file's own bytes and cross-checked with
 * its extension — core/employee-documents), at most 10 MB, and only with the uploader's confirmation that the
 * candidate permitted storing it. The event names the file id, kind and size — never the name or the bytes.
 */
export async function uploadCandidateFile(s: SessionContext, candidateId: unknown, input: { kind?: unknown; fileName?: unknown; content?: unknown; permissionConfirmed?: unknown }): Promise<{ id: string }> {
  const kind = typeof input.kind === 'string' && (FILE_KINDS as readonly string[]).includes(input.kind) ? input.kind as CandidateFileKind : null;
  if (!kind) throw new RecruitmentError('invalid_input', ['kind']);
  if (!(input.permissionConfirmed === true || input.permissionConfirmed === 'on' || input.permissionConfirmed === 'true')) throw new RecruitmentError('permission_required');
  const content = Buffer.isBuffer(input.content) ? input.content : null;
  const fileName = typeof input.fileName === 'string' ? input.fileName.trim().slice(-200) : '';
  if (!content || content.byteLength === 0 || !fileName) throw new RecruitmentError('missing_fields', ['file']);
  if (content.byteLength > CANDIDATE_FILE_MAX_BYTES) throw new RecruitmentError('file_too_large');
  let mimeType: string;
  try {
    ({ mimeType } = resolveDocumentUpload(fileName, content));
  } catch {
    throw new RecruitmentError('file_type');
  }
  if (!(CANDIDATE_FILE_MIME as readonly string[]).includes(mimeType)) throw new RecruitmentError('file_type');
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const [row] = await tx.insert(recruitmentCandidateFile).values({
      tenantId: s.tenantId, companyId: c.companyId, candidateId: c.id, kind, fileName, mimeType, sizeBytes: content.byteLength, content,
      permissionConfirmed: true, uploadedByUserId: user,
    }).returning({ id: recruitmentCandidateFile.id });
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.file-uploaded', { companyId: c.companyId, fileId: row.id, kind, sizeBytes: content.byteLength, permissionConfirmed: true });
    return row;
  });
}

/**
 * Download a file the viewer may read (row security: the resume for anyone who may read one of the candidate's
 * applications, attachments for administrators and operators). Every download appends an audit event with the file id,
 * kind and size. Null when the viewer may not see it.
 */
export async function getCandidateFile(s: SessionContext, fileId: unknown): Promise<{ fileName: string; mimeType: string; content: Buffer } | null> {
  if (!isUuid(fileId)) return null;
  return withRecruitmentTenant(s, async (tx) => {
    const [f] = await tx.select().from(recruitmentCandidateFile).where(and(eq(recruitmentCandidateFile.id, fileId), eq(recruitmentCandidateFile.tenantId, s.tenantId)));
    if (!f) return null;
    await candidateEvent(tx, s, f.candidateId, 'recruitment-candidate.file-downloaded', { companyId: f.companyId, fileId: f.id, kind: f.kind, sizeBytes: f.sizeBytes });
    return { fileName: f.fileName, mimeType: f.mimeType, content: f.content };
  });
}

export async function deleteCandidateFile(s: SessionContext, fileId: unknown): Promise<void> {
  if (!isUuid(fileId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [f] = await tx.select({ candidateId: recruitmentCandidateFile.candidateId, kind: recruitmentCandidateFile.kind, sizeBytes: recruitmentCandidateFile.sizeBytes })
      .from(recruitmentCandidateFile).where(and(eq(recruitmentCandidateFile.id, fileId), eq(recruitmentCandidateFile.tenantId, s.tenantId)));
    if (!f) throw new RecruitmentError('not_found');
    const c = await operatedCandidateTx(tx, s, f.candidateId);
    await tx.delete(recruitmentCandidateFile).where(eq(recruitmentCandidateFile.id, fileId));
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.file-deleted', { companyId: c.companyId, fileId, kind: f.kind, sizeBytes: f.sizeBytes });
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type TagCatalog = { groups: { id: string; name: string; enabled: boolean; tags: { id: string; name: string; enabled: boolean; used: number }[] }[] };
/** Settings › Tags: the company's groups and tags (administrators). */
export async function tagCatalog(s: SessionContext, companyId: string): Promise<TagCatalog> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const groups = await tx.select({ id: recruitmentTagGroup.id, name: recruitmentTagGroup.name, enabled: recruitmentTagGroup.enabled }).from(recruitmentTagGroup)
      .where(and(eq(recruitmentTagGroup.tenantId, s.tenantId), eq(recruitmentTagGroup.companyId, companyId))).orderBy(asc(recruitmentTagGroup.name));
    const tags = await tx.execute<{ id: string; group_id: string; name: string; enabled: boolean; used: number }>(sql`
      select t.id, t.group_id, t.name, t.enabled, (select count(*)::int from recruitment_candidate_tag ct where ct.tag_id = t.id) as used
      from recruitment_tag t where t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${companyId}::uuid order by t.name`);
    return { groups: groups.map((g) => ({ ...g, tags: tags.filter((t) => t.group_id === g.id).map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, used: t.used })) })) };
  });
}

const tagName = (value: unknown) => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new RecruitmentError('missing_fields', ['name']);
  if (name.length > 60) throw new RecruitmentError('invalid_input', ['name']);
  return name;
};
const enabledFlag = (value: unknown) => value === true || value === 'on' || value === 'true';
async function uniqueName<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (pgSqlState(e) === '23505') throw new RecruitmentError('invalid_input', ['name']);
    throw e;
  }
}

/** Create (no id) or rename / enable / disable a tag group (administrators). */
export async function saveTagGroup(s: SessionContext, input: { id?: unknown; companyId?: unknown; name?: unknown; enabled?: unknown }): Promise<void> {
  const name = tagName(input.name);
  const enabled = input.id == null || input.id === '' ? true : enabledFlag(input.enabled);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    if (input.id == null || input.id === '') {
      if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
      await assertCompanyTx(tx, input.companyId);
      const [row] = await uniqueName(() => tx.insert(recruitmentTagGroup).values({ tenantId: s.tenantId, companyId: input.companyId as string, name, enabled, createdByUserId: user, updatedByUserId: user })
        .returning({ id: recruitmentTagGroup.id }));
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-tag-group', aggregateId: row.id, eventType: 'recruitment-tag-group.created', actor: actorOf(s), payload: { companyId: input.companyId, name } });
      return;
    }
    if (!isUuid(input.id)) throw new RecruitmentError('not_found');
    const [g] = await tx.select().from(recruitmentTagGroup).where(and(eq(recruitmentTagGroup.id, input.id), eq(recruitmentTagGroup.tenantId, s.tenantId)));
    if (!g) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, g.companyId);
    await uniqueName(() => tx.update(recruitmentTagGroup).set({ name, enabled, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentTagGroup.id, g.id)));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-tag-group', aggregateId: g.id, eventType: 'recruitment-tag-group.updated', actor: actorOf(s),
      payload: { companyId: g.companyId, before: { name: g.name, enabled: g.enabled }, after: { name, enabled } } });
  });
}

/** Create (no id, in a group) or rename / enable / disable a tag (administrators). A disabled tag stays on candidates. */
export async function saveTag(s: SessionContext, input: { id?: unknown; groupId?: unknown; name?: unknown; enabled?: unknown }): Promise<void> {
  const name = tagName(input.name);
  const enabled = input.id == null || input.id === '' ? true : enabledFlag(input.enabled);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    if (input.id == null || input.id === '') {
      if (!isUuid(input.groupId)) throw new RecruitmentError('not_found');
      const [g] = await tx.select().from(recruitmentTagGroup).where(and(eq(recruitmentTagGroup.id, input.groupId), eq(recruitmentTagGroup.tenantId, s.tenantId)));
      if (!g) throw new RecruitmentError('not_found');
      await assertCompanyTx(tx, g.companyId);
      const [row] = await uniqueName(() => tx.insert(recruitmentTag).values({ tenantId: s.tenantId, companyId: g.companyId, groupId: g.id, name, enabled, createdByUserId: user, updatedByUserId: user })
        .returning({ id: recruitmentTag.id }));
      await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-tag', aggregateId: row.id, eventType: 'recruitment-tag.created', actor: actorOf(s), payload: { companyId: g.companyId, groupId: g.id, name } });
      return;
    }
    if (!isUuid(input.id)) throw new RecruitmentError('not_found');
    const [t] = await tx.select().from(recruitmentTag).where(and(eq(recruitmentTag.id, input.id), eq(recruitmentTag.tenantId, s.tenantId)));
    if (!t) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, t.companyId);
    await uniqueName(() => tx.update(recruitmentTag).set({ name, enabled, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentTag.id, t.id)));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-tag', aggregateId: t.id, eventType: 'recruitment-tag.updated', actor: actorOf(s),
      payload: { companyId: t.companyId, before: { name: t.name, enabled: t.enabled }, after: { name, enabled } } });
  });
}

/** Tag a candidate with an ENABLED tag of their company (administrators and the candidate's job operators). */
export async function addCandidateTag(s: SessionContext, candidateId: unknown, tagId: unknown): Promise<void> {
  if (!isUuid(tagId)) throw new RecruitmentError('invalid_input', ['tag']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const [tag] = await tx.execute<{ ok: boolean }>(sql`select t.enabled and g.enabled as ok from recruitment_tag t join recruitment_tag_group g on g.id = t.group_id
      where t.id = ${tagId}::uuid and t.tenant_id = ${s.tenantId}::uuid and t.company_id = ${c.companyId}::uuid`);
    if (!tag) throw new RecruitmentError('invalid_input', ['tag']);
    if (!tag.ok) throw new RecruitmentError('tag_disabled');
    const added = await tx.insert(recruitmentCandidateTag).values({ tenantId: s.tenantId, companyId: c.companyId, candidateId: c.id, tagId, createdByUserId: user })
      .onConflictDoNothing().returning({ id: recruitmentCandidateTag.id });
    if (added.length) await candidateEvent(tx, s, c.id, 'recruitment-candidate.tag-added', { companyId: c.companyId, tagId });
  });
}

export async function removeCandidateTag(s: SessionContext, candidateId: unknown, tagId: unknown): Promise<void> {
  if (!isUuid(tagId)) throw new RecruitmentError('invalid_input', ['tag']);
  await withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const removed = await tx.delete(recruitmentCandidateTag).where(and(eq(recruitmentCandidateTag.candidateId, c.id), eq(recruitmentCandidateTag.tagId, tagId)))
      .returning({ id: recruitmentCandidateTag.id });
    if (removed.length) await candidateEvent(tx, s, c.id, 'recruitment-candidate.tag-removed', { companyId: c.companyId, tagId });
  });
}

// ── Consent ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Record consent or its withdrawal, as a person was told (no candidate portal yet). History is kept; a withdrawal needs a
 * current consent. The event carries the entry id only.
 */
export async function recordConsent(s: SessionContext, candidateId: unknown, input: Record<string, unknown>): Promise<{ id: string }> {
  const today = todayInKualaLumpur();
  const v = validateConsentInput(input, today);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const c = await operatedCandidateTx(tx, s, candidateId);
    const history = await tx.select({ status: recruitmentCandidateConsent.status, effectiveOn: recruitmentCandidateConsent.effectiveOn, recordedAt: recruitmentCandidateConsent.recordedAt })
      .from(recruitmentCandidateConsent).where(eq(recruitmentCandidateConsent.candidateId, c.id));
    const current = currentConsent(history.map((h) => ({ ...h, recordedAt: iso(h.recordedAt) })));
    if (v.value.status === 'withdrawn' && current?.status !== 'consented') throw new RecruitmentError('consent_state');
    const [row] = await tx.insert(recruitmentCandidateConsent).values({ tenantId: s.tenantId, companyId: c.companyId, candidateId: c.id, ...v.value, recordedByUserId: user })
      .returning({ id: recruitmentCandidateConsent.id });
    await candidateEvent(tx, s, c.id, 'recruitment-candidate.consent-recorded', { companyId: c.companyId, consentId: row.id });
    return row;
  });
}

