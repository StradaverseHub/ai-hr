/**
 * Recruitment slice 5 against Postgres: acceptance cases 19–27 (docs/recruitment-reconstruction/specification.md
 * "Slice 5 acceptance cases") through the service AND under row security: restricted values, files, duplicate detection
 * without disclosure, repeated applications, tags, consent, retention and destruction. Every person and value is
 * fictional; personal values carry the sentinel S5SENTINEL so the destruction test can prove none is left behind.
 * Dates that must be fixed are set on the fixture through the owner connection; every expected due day is computed
 * independently through the HR date owner (lib/hr-date).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, company, employment, jobGrade, person, roleAssignment } from '../db/schema';
import { pgSqlState } from '../lib/db-error';
import { addCalendarMonths, todayInKualaLumpur } from '../lib/hr-date';
import {
  addApplication, addCandidateEntry, addCandidateTag, addJobMember, addPoolCandidateToJob, candidateBoard, candidateProfile, checkDuplicateCandidate,
  createJob, decideOffer, deleteCandidateFile, destroyCandidates, dueForDestruction, getCandidateFile, markOfferSent, moveApplication, offerSettings,
  recordConsent, recordOfferDecision, recruitmentPipelineCounts, recruitmentSettings, rejectApplication, saveApprovalFlow, saveCandidateRestricted, saveOffer,
  saveTag, saveTagGroup, scheduleInterview, submitOffer, submitScorecard, tagCatalog, talentPool, updateCandidateProfile, updateOfferSettings,
  updatePrivacySettings, uploadCandidateFile, RecruitmentError,
} from '../packs/recruitment/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SENTINEL = 'S5SENTINEL';
let base: Base;
let admin: SessionContext;
let otherCompanyId: string;
let gradeId: string;

const code = async (operation: Promise<unknown>) => {
  const error = await operation.then(() => null, (e: unknown) => e);
  if (error === null) return 'ok';
  if (error instanceof RecruitmentError) return error.code;
  return pgSqlState(error) ?? String(error);
};
async function person_(name: string, companyId = base.companyId): Promise<SessionContext> {
  const [p] = await owner.db.insert(person).values({ tenantId: base.tenantId, fullName: name, primaryEmail: `${randomUUID()}@example.test` }).returning({ id: person.id });
  await owner.db.insert(employment).values({ tenantId: base.tenantId, companyId, personId: p.id, hiredOn: '2024-01-01' });
  const [u] = await owner.db.insert(appUser).values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: p.id }).returning({ id: appUser.id });
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { ...admin, userId: u.id, personId: p.id, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
}
async function partnerFor(companyId: string, name: string): Promise<SessionContext> {
  const ctx = await person_(name, companyId);
  await owner.db.insert(roleAssignment).values({ tenantId: base.tenantId, appUserId: ctx.userId!, companyId, role: 'recruiting_partner' });
  return { ...ctx, roles: ['recruiting_partner'], grants: [{ role: 'recruiting_partner', companyId }] };
}
const rows = (ctx: SessionContext, query: ReturnType<typeof sql>) => withTenant(ctx, (tx) => tx.execute(query));
const job = (over: Record<string, unknown> = {}) => ({
  companyId: base.companyId, title: 'Fictional data analyst', jobGradeIds: [gradeId], workLocation: 'Kuala Lumpur',
  recruitmentType: 'budgeted', employmentType: 'full_time', ...over,
});
const past = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000);
async function stageId(name: string) {
  return (await recruitmentSettings(admin, base.companyId)).stages.find((s) => s.name === name)!.id;
}
/** Fixture time travel: an archived (closed) application's closing instant, set by the owner past the closed-row guard. */
async function closedAt(applicationId: string, at: string) {
  await owner.client.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update recruitment_application set state_changed_at = ${at}::timestamptz where id = ${applicationId}::uuid`;
  });
}
async function reason() {
  return (await recruitmentSettings(admin, base.companyId)).reasons[0].id;
}
const pdf = (marker = 'fictional resume') => Buffer.from(`%PDF-1.4\n% ${marker}\n%%EOF\n`);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'recruitment', 'active');
  admin = { ...(await entitledCtx(base)), grants: [{ role: 'hr_admin', companyId: null }] };
  [{ id: gradeId }] = await owner.db.insert(jobGrade).values({ tenantId: base.tenantId, code: 'FG1', name: 'Fictional grade 1', rank: 1 }).returning({ id: jobGrade.id });
  [{ id: otherCompanyId }] = await owner.db.insert(company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd' }).returning({ id: company.id });
});

/** A job with a recruiter, a hiring manager and an interviewer scheduled on application X; an offer approver; bystanders. */
async function team() {
  const [recruiter, manager, interviewer, approver, bystander] = await Promise.all([
    person_('Fictional Recruiter'), person_('Fictional Manager'), person_('Fictional Interviewer'), person_('Fictional Approver'), person_('Fictional Bystander'),
  ]);
  const otherPartner = await partnerFor(otherCompanyId, 'Fictional Other Partner');
  const { id: jobId } = await createJob(admin, job({ recruiterUserId: recruiter.userId }));
  await addJobMember(admin, jobId, 'hiring_manager', manager.userId);
  const { applicationId: appX, candidateId: candX } = await addApplication(recruiter, {
    jobId, fullName: `${SENTINEL} Candidate X`, email: 's5sentinel.x@example.test', phone: '012-111 2222', idType: 'nric', idNumber: `${SENTINEL}-ID-X`,
  });
  const { applicationId: appY, candidateId: candY } = await addApplication(recruiter, { jobId, fullName: 'Fictional Candidate Y', email: 'y@example.test' });
  await moveApplication(recruiter, appX, await stageId('Interview'));
  const { id: interviewId } = await scheduleInterview(recruiter, { applicationId: appX, type: 'video', startsAt: past(3), durationMinutes: 60, interviewerIds: [interviewer.userId] });
  return { recruiter, manager, interviewer, approver, bystander, otherPartner, jobId, appX, candX, appY, candY, interviewId };
}

describe('case 19 — profile and restricted values', () => {
  it('an operator edits the profile and salary; the hiring manager, an interviewer, an approver and another company see no restricted value', async () => {
    const t = await team();
    await updateCandidateProfile(t.recruiter, t.candX, {
      fullName: `${SENTINEL} Candidate X`, email: 's5sentinel.x@example.test', phone: '012-111 2222', location: 'Fictional Petaling Jaya',
      currentCompany: 'Fictional Previous Sdn Bhd', currentTitle: 'Fictional analyst', highestEducation: 'bachelor', noticePeriod: '1 month', source: 'referral',
    });
    await saveCandidateRestricted(t.recruiter, t.candX, {
      currentSalaryAmount: '5000', currentSalaryCurrency: 'MYR', expectedSalaryAmount: '6500.5', expectedSalaryCurrency: 'myr', idType: 'nric', idNumber: `${SENTINEL}-ID-X`,
    });
    const mine = await candidateProfile(t.recruiter, t.appX);
    expect(mine).toMatchObject({ location: 'Fictional Petaling Jaya', highestEducation: 'bachelor', source: 'referral', can: { edit: true } });
    expect(mine.restricted).toEqual({ currentSalaryAmount: '5000.00', currentSalaryCurrency: 'MYR', expectedSalaryAmount: '6500.50', expectedSalaryCurrency: 'MYR', idType: 'nric', idNumber: `${SENTINEL}-ID-X` });

    // An approver of the candidate's offer: reads the offer, never the candidate's restricted row.
    await saveApprovalFlow(admin, base.companyId, 'offer', [t.approver.userId]);
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const { id: offerId } = await saveOffer(t.recruiter, t.appX, {
      [fields.find((f) => f.label === 'Job offered')!.id]: { text: 'Fictional data analyst' }, [fields.find((f) => f.label === 'Department')!.id]: { text: 'Finance' },
      [fields.find((f) => f.label === 'Commencement date')!.id]: { text: '2026-12-01' }, [fields.find((f) => f.label === 'Basic salary')!.id]: { amount: '5000', currency: 'MYR' },
    });
    expect(await submitOffer(t.recruiter, offerId)).toBe('pending');

    // The hiring manager and the interviewer read the non-restricted profile only; the approver and another company's
    // partner cannot read the candidate at all. Through the service AND the table.
    for (const ctx of [t.manager, t.interviewer]) {
      const seen = await candidateProfile(ctx, t.appX);
      expect(seen.restricted).toBeNull();
      expect(seen.location).toBe('Fictional Petaling Jaya');
      expect(seen.can.edit).toBe(false);
      expect(JSON.stringify(seen)).not.toContain('ID-X');
      expect(await code(saveCandidateRestricted(ctx, t.candX, { currentSalaryAmount: '1', currentSalaryCurrency: 'MYR' }))).toBe('forbidden');
      expect(await code(updateCandidateProfile(ctx, t.candX, { fullName: 'Changed' }))).toBe('forbidden');
    }
    for (const ctx of [t.approver, t.otherPartner, t.bystander]) {
      expect(await code(candidateProfile(ctx, t.appX))).toBe('not_found');
      expect(await code(saveCandidateRestricted(ctx, t.candX, { currentSalaryAmount: '1', currentSalaryCurrency: 'MYR' }))).toBe('not_found');
    }
    for (const ctx of [t.manager, t.interviewer, t.approver, t.otherPartner, t.bystander]) {
      expect(await rows(ctx, sql`select * from recruitment_candidate_restricted where tenant_id = ${base.tenantId}::uuid`), 'restricted rows').toHaveLength(0);
      // A direct write is refused or touches nothing.
      const write = await code(rows(ctx, sql`update recruitment_candidate_restricted set id_number = 'x' where candidate_id = ${t.candX}::uuid`));
      expect(['ok', '42501']).toContain(write);
    }
    const [{ id_number }] = await owner.db.execute<{ id_number: string }>(sql`select id_number from recruitment_candidate_restricted where candidate_id = ${t.candX}::uuid`);
    expect(id_number).toBe(`${SENTINEL}-ID-X`);
    // The hiring manager cannot rewrite the candidate row either (no update policy for reviewers).
    const touched = await rows(t.manager, sql`update recruitment_candidate set location = 'x' where id = ${t.candX}::uuid returning id`);
    expect(touched).toHaveLength(0);
    // Profile events name fields, never values.
    const events = await owner.db.execute<{ payload: unknown }>(sql`select payload from domain_event where aggregate_id = ${t.candX}::uuid and event_type like 'recruitment-candidate.%'`);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(JSON.stringify(events)).not.toContain('Petaling');
  });
});

describe('case 20 — resume and attachments', () => {
  it('admits allowed types and sizes with the permission confirmation; the interviewer downloads the resume only; every download is audited without name or bytes', async () => {
    const t = await team();
    const upload = (kind: string, fileName: string, content: Buffer, permissionConfirmed: unknown = true) =>
      uploadCandidateFile(t.recruiter, t.candX, { kind, fileName, content, permissionConfirmed });
    expect(await code(upload('resume', 'cv.pdf', pdf(), false))).toBe('permission_required');
    expect(await code(upload('resume', 'notes.txt', Buffer.from('plain text')))).toBe('file_type');
    expect(await code(upload('resume', 'cv.pdf', Buffer.from('not really a pdf')))).toBe('file_type');
    expect(await code(upload('resume', 'sheet.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])))).toBe('file_type');
    expect(await code(upload('resume', 'big.pdf', Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)])))).toBe('file_too_large');
    // The database refuses a file without the confirmation on its own.
    expect(await code(rows(t.recruiter, sql`insert into recruitment_candidate_file (tenant_id, company_id, candidate_id, kind, file_name, mime_type, size_bytes, content, permission_confirmed, uploaded_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.candX}::uuid, 'resume', 'x.pdf', 'application/pdf', 4, '\\x25504446'::bytea, false, ${t.recruiter.userId}::uuid)`))).toBe('23514');

    const { id: resumeId } = await upload('resume', `${SENTINEL}_cv.pdf`, pdf(`${SENTINEL} bytes`));
    const { id: attachmentId } = await upload('attachment', 'certificate.png', png());
    expect(await code(uploadCandidateFile(t.manager, t.candX, { kind: 'resume', fileName: 'cv.pdf', content: pdf(), permissionConfirmed: true }))).toBe('forbidden');

    // Listing: the operator sees both; the interviewer and the hiring manager see the resume only.
    expect((await candidateProfile(t.recruiter, t.appX)).files.map((f) => f.kind)).toEqual(['attachment', 'resume']);
    for (const ctx of [t.interviewer, t.manager]) expect((await candidateProfile(ctx, t.appX)).files.map((f) => f.id)).toEqual([resumeId]);
    // Downloads: the interviewer gets the resume bytes and not the attachment; a bystander gets nothing.
    const got = await getCandidateFile(t.interviewer, resumeId);
    expect(got?.content.toString('utf8')).toContain(`${SENTINEL} bytes`);
    expect(await getCandidateFile(t.interviewer, attachmentId)).toBeNull();
    expect(await getCandidateFile(t.bystander, resumeId)).toBeNull();
    expect(await getCandidateFile(t.otherPartner, attachmentId)).toBeNull();
    expect((await getCandidateFile(t.recruiter, attachmentId))?.mimeType).toBe('image/png');
    expect(await rows(t.interviewer, sql`select id from recruitment_candidate_file where candidate_id = ${t.candX}::uuid`)).toEqual([{ id: resumeId }]);

    // Exactly the two successful downloads are audited, with id, kind and size only.
    const events = await owner.db.execute<{ actor_id: string; payload: Record<string, unknown> }>(sql`
      select actor_id, payload from domain_event where event_type = 'recruitment-candidate.file-downloaded' and tenant_id = ${base.tenantId}::uuid order by occurred_at`);
    expect(events.map((e) => e.actor_id)).toEqual([t.interviewer.userId, t.recruiter.userId]);
    for (const e of events) expect(Object.keys(e.payload).sort()).toEqual(['companyId', 'fileId', 'kind', 'sizeBytes']);
    const all = JSON.stringify(await owner.db.execute(sql`select payload from domain_event where tenant_id = ${base.tenantId}::uuid and event_type like 'recruitment-candidate.file%'`));
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('certificate.png');

    // Delete: operators only, with an event.
    expect(await code(deleteCandidateFile(t.manager, attachmentId))).toBe('not_found');
    await deleteCandidateFile(t.recruiter, attachmentId);
    expect((await candidateProfile(t.recruiter, t.appX)).files.map((f) => f.id)).toEqual([resumeId]);
  });
});

describe('case 21 — duplicates', () => {
  it('finds an ID number match and a two-of-three match, not one-of-three; an operator learns only that one exists; an administrator sees it and adds to it', async () => {
    const t = await team();
    const recruiter2 = await person_('Fictional Recruiter Two');
    const { id: job2 } = await createJob(admin, job({ title: 'Fictional second job', recruiterUserId: recruiter2.userId }));
    // recruiter2 operates job 2 only, so cannot read candidate X.
    expect(await rows(recruiter2, sql`select id from recruitment_candidate where id = ${t.candX}::uuid`)).toHaveLength(0);

    const byId = await checkDuplicateCandidate(recruiter2, { jobId: job2, fullName: 'Fictional Someone Else', idType: 'passport', idNumber: `${SENTINEL.toLowerCase()} id x` });
    expect(byId).toEqual({ count: 1, matches: null });
    const twoOfThree = await checkDuplicateCandidate(recruiter2, { jobId: job2, fullName: `  ${SENTINEL.toLowerCase()}   candidate x`, phone: '+012 111 2222' });
    expect(twoOfThree).toEqual({ count: 1, matches: null });
    expect(JSON.stringify([byId, twoOfThree])).not.toMatch(/Candidate X|s5sentinel\.x|1112222/i);
    expect(await checkDuplicateCandidate(recruiter2, { jobId: job2, fullName: 'Fictional Different', email: 'S5SENTINEL.X@example.test' })).toEqual({ count: 0, matches: [] });

    // The operator is refused, even when asking to create a separate candidate; one-of-three goes through.
    expect(await code(addApplication(recruiter2, { jobId: job2, fullName: `${SENTINEL} Candidate X`, email: 's5sentinel.x@example.test' }))).toBe('possible_duplicate');
    expect(await code(addApplication(recruiter2, { jobId: job2, fullName: `${SENTINEL} Candidate X`, email: 's5sentinel.x@example.test', confirmSeparate: '1' }))).toBe('possible_duplicate');
    expect(await code(addApplication(recruiter2, { jobId: job2, fullName: 'Fictional Different', email: 's5sentinel.x@example.test' }))).toBe('ok');
    // The count function discloses a number only, and only to someone who may add candidates in the company.
    const [{ n }] = await rows(recruiter2, sql`select app.recruitment_candidate_duplicate_count(${base.companyId}::uuid, ${`${SENTINEL} Candidate X`}, 's5sentinel.x@example.test', null, null, null) as n`);
    expect(n).toBe(1);
    expect(await code(rows(t.bystander, sql`select app.recruitment_candidate_duplicate_count(${base.companyId}::uuid, 'x', 'x@example.test', null, null, null)`))).toBe('42501');
    expect(await code(rows(t.otherPartner, sql`select app.recruitment_candidate_duplicate_count(${base.companyId}::uuid, 'x', 'x@example.test', null, null, null)`))).toBe('42501');
    const [fn] = await owner.db.execute<{ definer: boolean; config: string[]; public_exec: boolean }>(sql`
      select p.prosecdef as definer, p.proconfig as config, has_function_privilege('public', p.oid, 'EXECUTE') as public_exec from pg_proc p
      where p.oid = 'app.recruitment_candidate_duplicate_count(uuid,text,text,text,text,uuid)'::regprocedure`);
    expect(fn.definer).toBe(true);
    expect(fn.config.some((c) => c.startsWith('search_path='))).toBe(true);
    expect(fn.public_exec).toBe(false);

    // The administrator sees the match and adds the application to the existing candidate.
    const seen = await checkDuplicateCandidate(admin, { jobId: job2, fullName: `${SENTINEL} candidate x`, email: 'S5SENTINEL.X@EXAMPLE.TEST' });
    expect(seen.count).toBe(1);
    expect(seen.matches).toEqual([expect.objectContaining({ candidateId: t.candX, matchedOn: ['email', 'name'] })]);
    const before = (await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`))[0].n;
    const { applicationId, candidateId } = await addApplication(admin, { jobId: job2, fullName: 'ignored', existingCandidateId: t.candX });
    expect(candidateId).toBe(t.candX);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate where tenant_id = ${base.tenantId}::uuid`))[0].n).toBe(before);
    expect((await owner.db.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_application where id = ${applicationId}::uuid`))[0].candidate_id).toBe(t.candX);
    // An operator cannot resolve onto an existing candidate; an administrator may confirm a separate one.
    expect(await code(addApplication(t.recruiter, { jobId: t.jobId, fullName: 'x', existingCandidateId: t.candY }))).toBe('forbidden');
    const separate = await addApplication(admin, { jobId: t.jobId, fullName: 'Fictional Candidate Y', email: 'y@example.test', confirmSeparate: '1' });
    expect(separate.candidateId).not.toBe(t.candY);
    // Every possible-duplicate result is audited with the job and the match count only — never what was typed.
    const flagged = await owner.db.execute<{ actor_id: string; aggregate_id: string; payload: Record<string, unknown> }>(sql`
      select actor_id, aggregate_id, payload from domain_event where event_type = 'recruitment-candidate.duplicate-flagged' and tenant_id = ${base.tenantId}::uuid`);
    expect(flagged.length).toBeGreaterThanOrEqual(5);
    for (const e of flagged) expect(Object.keys(e.payload).sort()).toEqual(['companyId', 'jobId', 'matches', 'via']);
    expect(flagged.filter((e) => e.actor_id === recruiter2.userId).map((e) => [e.aggregate_id, e.payload.matches, e.payload.via]))
      .toEqual(expect.arrayContaining([[job2, 1, 'check'], [job2, 1, 'add']]));
    expect(JSON.stringify(flagged)).not.toMatch(/S5SENTINEL|example\.test|Candidate|ID-X/i);
  });
});

describe('case 22 — repeated applications', () => {
  it('refuses the same job while active or archived within the window; allows after it, with the setting off, and for another job', async () => {
    const t = await team();
    const { id: job2 } = await createJob(admin, job({ title: 'Fictional second job' }));
    // Active: the same candidate and job is refused.
    expect(await code(addApplication(admin, { jobId: t.jobId, fullName: 'x', existingCandidateId: t.candY }))).toBe('duplicate_application');
    // Archived just now: refused within the 3-month default; another job is fine.
    await rejectApplication(t.recruiter, t.appY, await reason());
    expect(await code(addPoolCandidateToJob(admin, t.appY, t.jobId))).toBe('repeat_application');
    expect(await code(addApplication(admin, { jobId: t.jobId, fullName: 'x', existingCandidateId: t.candY }))).toBe('repeat_application');
    expect((await talentPool(admin, [base.companyId])).cards.find((c) => c.applicationId === t.appY)?.addable.map((j) => j.id)).toEqual([job2]);
    // The database refuses the same insert on its own.
    const [{ stage }] = await owner.db.execute<{ stage: string }>(sql`select current_stage_id as stage from recruitment_application where id = ${t.appY}::uuid`);
    expect(await code(rows(admin, sql`insert into recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, created_by_user_id, updated_by_user_id)
      values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.jobId}::uuid, ${t.candY}::uuid, ${stage}::uuid, ${admin.userId}::uuid, ${admin.userId}::uuid)`))).toBe('23505');
    // After the window (closed 4 months ago, Kuala Lumpur calendar): allowed.
    await closedAt(t.appY, `${addCalendarMonths(todayInKualaLumpur(), -4)}T12:00:00+08:00`);
    expect((await talentPool(admin, [base.companyId])).cards.find((c) => c.applicationId === t.appY)?.addable.map((j) => j.id).sort()).toEqual([t.jobId, job2].sort());
    const again = await addPoolCandidateToJob(admin, t.appY, t.jobId);
    expect(again.applicationId).toBeTruthy();
    // With the setting off, an application archived today does not block.
    const { applicationId: appZ, candidateId: candZ } = await addApplication(t.recruiter, { jobId: t.jobId, fullName: 'Fictional Candidate Z' });
    await rejectApplication(t.recruiter, appZ, await reason());
    expect(await code(addApplication(admin, { jobId: t.jobId, fullName: 'x', existingCandidateId: candZ }))).toBe('repeat_application');
    await updatePrivacySettings(admin, base.companyId, { monthsWithoutConsent: '6', monthsWithConsent: '24', repeatWindowMonths: '0' });
    expect(await code(addApplication(admin, { jobId: t.jobId, fullName: 'x', existingCandidateId: candZ }))).toBe('ok');
    // Another job is always allowed.
    expect(await code(addApplication(admin, { jobId: job2, fullName: 'x', existingCandidateId: t.candX }))).toBe('ok');
  });

  it('two concurrent "Add to job" for the same pooled candidate: one succeeds, the other is a duplicate_application', async () => {
    const t = await team();
    const { id: job2 } = await createJob(admin, job({ title: 'Fictional second job' }));
    await rejectApplication(t.recruiter, t.appY, await reason());
    const results = await Promise.all([addPoolCandidateToJob(admin, t.appY, job2), addPoolCandidateToJob(admin, t.appY, job2)].map(code));
    expect(results.sort()).toEqual(['duplicate_application', 'ok']);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application where candidate_id = ${t.candY}::uuid and job_id = ${job2}::uuid`))[0].n).toBe(1);
  });
});

describe('case 23 — tags', () => {
  it('administrators manage tags; operators tag; hiring managers see; interviewers do not; filters find the tagged; a disabled tag stays but is not offered', async () => {
    const t = await team();
    await saveTagGroup(admin, { companyId: base.companyId, name: 'Fictional skills' });
    expect(await code(saveTagGroup(admin, { companyId: base.companyId, name: 'fictional SKILLS' }))).toBe('invalid_input');
    expect(await code(saveTagGroup(t.recruiter, { companyId: base.companyId, name: 'Not allowed' }))).toBe('forbidden');
    const groupId = (await tagCatalog(admin, base.companyId)).groups[0].id;
    await saveTag(admin, { groupId, name: 'Fictional SQL' });
    await saveTag(admin, { groupId, name: 'Fictional Python' });
    expect(await code(saveTag(admin, { groupId, name: 'fictional sql' }))).toBe('invalid_input');
    expect(await code(saveTag(t.recruiter, { groupId, name: 'Fictional Excel' }))).toBe('forbidden');
    const catalog = (await tagCatalog(admin, base.companyId)).groups[0].tags;
    const sqlTag = catalog.find((x) => x.name === 'Fictional SQL')!.id;
    const pyTag = catalog.find((x) => x.name === 'Fictional Python')!.id;

    await addCandidateTag(t.recruiter, t.candY, sqlTag);
    await addCandidateTag(t.recruiter, t.candX, pyTag);
    expect(await code(addCandidateTag(t.manager, t.candY, pyTag))).toBe('forbidden');
    expect(await code(addCandidateTag(t.interviewer, t.candX, sqlTag))).toBe('forbidden');
    expect((await candidateProfile(t.manager, t.appY)).tags?.map((x) => x.name)).toEqual(['Fictional SQL']);
    expect((await candidateProfile(t.interviewer, t.appX)).tags).toBeNull();
    expect(await rows(t.interviewer, sql`select 1 from recruitment_candidate_tag where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);

    // Filters: the Candidates board (Application Review tab holds Y) and the talent pool.
    const reviewTab = await stageId('Application Review');
    const all = await candidateBoard(admin, [base.companyId], { tab: reviewTab });
    expect(all.cards.map((c) => c.id)).toEqual([t.appY]);
    expect((await candidateBoard(admin, [base.companyId], { tab: reviewTab, tagId: sqlTag })).cards.map((c) => c.id)).toEqual([t.appY]);
    expect((await candidateBoard(admin, [base.companyId], { tab: reviewTab, tagId: pyTag })).cards).toEqual([]);
    expect((await candidateBoard(admin, [base.companyId], { tab: await stageId('Interview'), tagId: pyTag })).cards.map((c) => c.id)).toEqual([t.appX]);
    expect((await candidateBoard(t.manager, [base.companyId], { tab: reviewTab })).cards[0].tags.map((x) => x.name)).toEqual(['Fictional SQL']);
    // The interviewer's view carries no tags and the filter finds nothing for them.
    const ivBoard = await candidateBoard(t.interviewer, [base.companyId], { tab: await stageId('Interview') });
    expect(ivBoard.cards.map((c) => c.tags)).toEqual([[]]);
    expect(ivBoard.tagOptions).toEqual([]);
    expect((await candidateBoard(t.interviewer, [base.companyId], { tab: await stageId('Interview'), tagId: pyTag })).cards).toEqual([]);
    await rejectApplication(t.recruiter, t.appY, await reason());
    expect((await talentPool(admin, [base.companyId], { tagId: sqlTag })).cards.map((c) => c.applicationId)).toEqual([t.appY]);
    expect((await talentPool(admin, [base.companyId], { tagId: pyTag })).cards).toEqual([]);

    // Disabling: the tag stays on Y (and still filters) but is no longer offered or addable.
    await saveTag(admin, { id: sqlTag, name: 'Fictional SQL', enabled: false });
    expect((await candidateProfile(t.recruiter, t.appY)).tags).toEqual([expect.objectContaining({ id: sqlTag, enabled: false })]);
    expect((await candidateProfile(t.recruiter, t.appX)).tagOptions.map((o) => o.id)).toEqual([]);
    expect(await code(addCandidateTag(t.recruiter, t.candX, sqlTag))).toBe('tag_disabled');
    expect((await talentPool(admin, [base.companyId], { tagId: sqlTag })).cards.map((c) => c.applicationId)).toEqual([t.appY]);
  });
});

describe('case 24 — consent', () => {
  it('is recorded and withdrawn by people with history kept, and the due date moves as specified', async () => {
    const t = await team();
    await rejectApplication(t.recruiter, t.appY, await reason());
    const today = todayInKualaLumpur();
    const archivedOn = addCalendarMonths(today, -20);
    await closedAt(t.appY, `${archivedOn}T12:00:00+08:00`);
    const retention = async () => (await candidateProfile(admin, t.appY)).retention;
    expect(await retention()).toEqual({ dueOn: addCalendarMonths(archivedOn, 6), ended: true });
    expect((await candidateProfile(t.recruiter, t.appY)).consent).toEqual({ current: null, history: [] });

    expect(await code(recordConsent(t.recruiter, t.candY, { status: 'withdrawn', method: 'email', effectiveOn: today }))).toBe('consent_state');
    expect(await code(recordConsent(t.recruiter, t.candY, { status: 'consented', method: 'email', effectiveOn: addCalendarMonths(today, 1) }))).toBe('invalid_input');
    expect(await code(recordConsent(t.manager, t.candY, { status: 'consented', method: 'email', effectiveOn: today }))).toBe('forbidden');
    const consentedOn = addCalendarMonths(today, -10);
    await recordConsent(t.recruiter, t.candY, { status: 'consented', method: 'written_form', effectiveOn: consentedOn, noticeReference: `${SENTINEL}-NOTICE` });
    expect(await retention()).toEqual({ dueOn: addCalendarMonths(consentedOn, 24), ended: false });
    const withdrawnOn = addCalendarMonths(today, -2);
    await recordConsent(t.recruiter, t.candY, { status: 'withdrawn', method: 'verbal', effectiveOn: withdrawnOn });
    expect(await retention()).toEqual({ dueOn: addCalendarMonths(withdrawnOn, 6), ended: false });

    const view = await candidateProfile(t.recruiter, t.appY);
    expect(view.consent?.current).toEqual({ status: 'withdrawn', on: withdrawnOn });
    expect(view.consent?.history.map((h) => [h.status, h.effectiveOn, h.method, h.recordedBy])).toEqual([
      ['withdrawn', withdrawnOn, 'verbal', 'Fictional Recruiter'], ['consented', consentedOn, 'written_form', 'Fictional Recruiter'],
    ]);
    // History is kept: no update or delete, for anyone.
    for (const ctx of [t.recruiter, admin]) {
      expect(await code(rows(ctx, sql`update recruitment_candidate_consent set status = 'consented' where candidate_id = ${t.candY}::uuid`))).toBe('42501');
      expect(await code(rows(ctx, sql`delete from recruitment_candidate_consent where candidate_id = ${t.candY}::uuid`))).toBe('42501');
    }
    // Consent is for administrators and operators.
    expect((await candidateProfile(t.manager, t.appY)).consent).toBeNull();
    expect(await rows(t.manager, sql`select 1 from recruitment_candidate_consent where tenant_id = ${base.tenantId}::uuid`)).toHaveLength(0);
  });
});

describe('case 25 — retention', () => {
  it('computes due days from fixed dates through the HR date owner; active never due, hired excluded; the list and marker are for administrators only', async () => {
    const t = await team();
    const add = async (name: string) => addApplication(t.recruiter, { jobId: t.jobId, fullName: name });
    const r = await reason();
    // P: archived 31 Jan 2024, no consent → due 31 Jul 2024.
    const p = await add('Fictional Candidate P');
    await rejectApplication(t.recruiter, p.applicationId, r);
    await closedAt(p.applicationId, '2024-01-31T10:00:00+08:00');
    // Q: archived 31 Jan 2024, consented 15 Mar 2024 → due 15 Mar 2026.
    const q = await add('Fictional Candidate Q');
    await rejectApplication(t.recruiter, q.applicationId, r);
    await closedAt(q.applicationId, '2024-01-31T10:00:00+08:00');
    await recordConsent(t.recruiter, q.candidateId, { status: 'consented', method: 'email', effectiveOn: '2024-03-15' });
    // A: an old archived application AND an active one on another job → never due.
    const a = await add('Fictional Candidate A');
    await rejectApplication(t.recruiter, a.applicationId, r);
    await closedAt(a.applicationId, '2024-01-31T10:00:00+08:00');
    const { id: job2 } = await createJob(admin, job({ title: 'Fictional second job' }));
    await addApplication(admin, { jobId: job2, fullName: 'x', existingCandidateId: a.candidateId });
    // H: hired on another job, and an old archived application → excluded.
    const h = await add('Fictional Candidate H');
    await rejectApplication(t.recruiter, h.applicationId, r);
    await closedAt(h.applicationId, '2024-01-31T10:00:00+08:00');
    const { applicationId: hired } = await addApplication(admin, { jobId: job2, fullName: 'x', existingCandidateId: h.candidateId });
    await moveApplication(admin, hired, await stageId('Onboarding'));
    expect((await moveApplication(admin, hired)).state).toBe('hired');
    // F: archived today → not due.
    const f = await add('Fictional Candidate F');
    await rejectApplication(t.recruiter, f.applicationId, r);

    const expected = [
      { candidateId: p.candidateId, dueOn: addCalendarMonths('2024-01-31', 6) },
      { candidateId: q.candidateId, dueOn: addCalendarMonths('2024-03-15', 24) },
    ];
    expect(expected.map((e) => e.dueOn)).toEqual(['2024-07-31', '2026-03-15']);
    const list = await dueForDestruction(admin, base.companyId);
    expect(list.due.map((d) => ({ candidateId: d.candidateId, dueOn: d.dueOn }))).toEqual(expected);
    expect(list.due[1].consent).toEqual({ status: 'consented', on: '2024-03-15' });
    expect((await candidateProfile(admin, p.applicationId)).retention).toEqual({ dueOn: '2024-07-31', ended: true });
    expect((await candidateProfile(admin, a.applicationId)).retention).toEqual({ dueOn: null, ended: false });
    expect((await candidateProfile(admin, h.applicationId)).retention).toEqual({ dueOn: null, ended: false });
    expect((await candidateProfile(admin, f.applicationId)).retention?.ended).toBe(false);
    // Administrators only: the recruiter sees no marker and cannot list; neither can another company's partner.
    expect((await candidateProfile(t.recruiter, p.applicationId)).retention).toBeNull();
    expect(await code(dueForDestruction(t.recruiter, base.companyId))).toBe('forbidden');
    expect(await code(dueForDestruction(t.otherPartner, base.companyId))).toBe('forbidden');
    // A longer period moves P out of the list.
    await updatePrivacySettings(admin, base.companyId, { monthsWithoutConsent: '120', monthsWithConsent: '24', repeatWindowMonths: '3' });
    expect((await dueForDestruction(admin, base.companyId)).due.map((d) => d.candidateId)).toEqual([q.candidateId]);
  });
});

describe('case 26 — destruction', () => {
  it('is administrator-only and confirmed, refuses active or hired, leaves no sentinel in any recruitment table or event, and keeps every count', async () => {
    const t = await team();
    // A fully populated candidate X: profile, restricted, entries, files, tags, consent, feedback notes, offer values and comments.
    await updateCandidateProfile(t.recruiter, t.candX, {
      fullName: `${SENTINEL} Candidate X`, email: 's5sentinel.x@example.test', phone: '012-111 2222', location: `${SENTINEL} town`, currentCompany: `${SENTINEL} employer`,
      currentTitle: `${SENTINEL} title`, noticePeriod: `${SENTINEL} notice`, highestEducation: 'master', source: 'agency',
    });
    await saveCandidateRestricted(t.recruiter, t.candX, { currentSalaryAmount: '4321', currentSalaryCurrency: 'MYR', idType: 'passport', idNumber: `${SENTINEL}-ID-X` });
    await addCandidateEntry(t.recruiter, t.candX, { kind: 'work', organisation: `${SENTINEL} past employer`, title: `${SENTINEL} role`, fromMonth: '2020-01', toMonth: '2023-06' });
    await addCandidateEntry(t.recruiter, t.candX, { kind: 'education', organisation: `${SENTINEL} university`, title: `${SENTINEL} degree` });
    await uploadCandidateFile(t.recruiter, t.candX, { kind: 'resume', fileName: `${SENTINEL}_cv.pdf`, content: pdf(`${SENTINEL} resume bytes`), permissionConfirmed: true });
    await uploadCandidateFile(t.recruiter, t.candX, { kind: 'attachment', fileName: `${SENTINEL}.png`, content: png(), permissionConfirmed: true });
    await saveTagGroup(admin, { companyId: base.companyId, name: 'Fictional group' });
    await saveTag(admin, { groupId: (await tagCatalog(admin, base.companyId)).groups[0].id, name: 'Fictional tag' });
    await addCandidateTag(t.recruiter, t.candX, (await tagCatalog(admin, base.companyId)).groups[0].tags[0].id);
    await recordConsent(t.recruiter, t.candX, { status: 'consented', method: 'email', effectiveOn: '2024-01-02', noticeReference: `${SENTINEL}-NOTICE` });
    const notes = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => [k, { rating: '4', notes: `${SENTINEL} note ${k}` }]));
    await submitScorecard(t.interviewer, t.interviewId, { ratings: notes, result: 'recommended', overview: `${SENTINEL} overview` });
    // Offer: an approver rejects with a comment, then approves; sent; the candidate declines and the application is archived.
    await saveApprovalFlow(admin, base.companyId, 'offer', [t.approver.userId]);
    const fields = (await offerSettings(admin, base.companyId)).fields;
    const fid = (label: string) => fields.find((f) => f.label === label)!.id;
    const values = {
      [fid('Job offered')]: { text: `${SENTINEL} offer text` }, [fid('Department')]: { text: 'Finance' }, [fid('Commencement date')]: { text: '2026-12-01' },
      [fid('Basic salary')]: { amount: '4321', currency: 'MYR' },
    };
    const { id: offerId } = await saveOffer(t.recruiter, t.appX, values);
    await submitOffer(t.recruiter, offerId);
    await decideOffer(t.approver, offerId, 'reject', `${SENTINEL} rejection comment`);
    await submitOffer(t.recruiter, offerId);
    await decideOffer(t.approver, offerId, 'approve');
    await markOfferSent(t.recruiter, offerId, 'email');
    await updateOfferSettings(admin, base.companyId, { validDays: '15', acceptMovesForward: false, declineArchives: true });
    expect(await recordOfferDecision(t.recruiter, offerId, 'declined')).toEqual({ moved: false, archived: true });
    // A free-text application source naming a referrer.
    const { applicationId: appSrc } = await addApplication(admin, { jobId: (await createJob(admin, job({ title: 'Fictional third job' }))).id, fullName: 'x', existingCandidateId: t.candX, source: `${SENTINEL} referrer` });
    await rejectApplication(admin, appSrc, await reason());
    // Both closed two years ago: due (consented on 2 Jan 2024 → 2 Jan 2026).
    for (const id of [t.appX, appSrc]) await closedAt(id, `${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`);
    expect((await dueForDestruction(admin, base.companyId)).due.map((d) => d.candidateId)).toEqual([t.candX]);
    const present = async () => (await owner.db.execute<{ n: number }>(sql`
      select count(*)::int as n from (select to_jsonb(d.*)::text as txt from domain_event d where d.tenant_id = ${base.tenantId}::uuid) e where e.txt like ${`%${SENTINEL}%`}`))[0].n;
    // Precondition for the event check below: nothing personal was ever written to an event payload.
    expect(await present()).toBe(0);

    const counts = async () => ({
      board: (await candidateBoard(admin, [base.companyId])).tabs.map((x) => [x.key, x.count]),
      pipeline: (await recruitmentPipelineCounts(admin)).rows,
      pool: (await talentPool(admin, [base.companyId])).totals,
      applications: (await owner.db.execute(sql`select id, job_id, candidate_id, current_stage_id, state, archive_reason_id, stage_left_at_archive, applied_at, state_changed_at
        from recruitment_application where tenant_id = ${base.tenantId}::uuid order by id`)),
    });
    const before = await counts();

    // Refusals: not an administrator; no confirmation; an active candidate (Y); a hired one; another company.
    expect(await code(destroyCandidates(t.recruiter, base.companyId, [t.candX], 'on'))).toBe('forbidden');
    expect(await code(destroyCandidates(t.otherPartner, base.companyId, [t.candX], 'on'))).toBe('forbidden');
    expect(await code(destroyCandidates(admin, base.companyId, [t.candX], undefined))).toBe('confirm_required');
    expect(await code(destroyCandidates(admin, base.companyId, [t.candY], 'on'))).toBe('not_due');
    expect(await code(destroyCandidates(admin, base.companyId, [t.candX, t.candY], 'on'))).toBe('not_due'); // all or nothing
    expect(await code(rows(admin, sql`select app.recruitment_destroy_candidate(${t.candY}::uuid)`))).toBe('23514');
    expect(await code(rows(t.recruiter, sql`select app.recruitment_destroy_candidate(${t.candX}::uuid)`))).toBe('42501');
    // The destroy-context exemption cannot be borrowed by setting the transaction-local value directly.
    const forged = await withTenant(admin, async (tx) => {
      await tx.execute(sql`select set_config('app.recruitment_candidate_destroy', ${t.candX}::text, true)`);
      return tx.execute(sql`update recruitment_scorecard set overview = null where interview_id = ${t.interviewId}::uuid returning id`);
    }).catch((e: unknown) => pgSqlState(e));
    // Row security admits no admin update of another person's feedback: nothing is touched.
    expect(Array.isArray(forged) ? forged.length : forged).toBe(0);
    expect((await owner.db.execute<{ overview: string }>(sql`select overview from recruitment_scorecard where interview_id = ${t.interviewId}::uuid`))[0].overview).toBe(`${SENTINEL} overview`);

    // Only the destroy function can open the destroy branches: the app role can neither read nor write the marker,
    // and no session setting makes app.recruitment_destroying true.
    expect(await code(rows(admin, sql`select * from app.recruitment_destroy_marker`))).toBe('42501');
    expect(await code(rows(admin, sql`insert into app.recruitment_destroy_marker (txid, candidate_id, tenant_id) values (txid_current(), ${t.candX}::uuid, ${base.tenantId}::uuid)`))).toBe('42501');
    const [probe] = await withTenant(admin, async (tx) => {
      await tx.execute(sql`select set_config('app.recruitment_candidate_destroy', ${t.candX}::text, true)`);
      return tx.execute<{ on: boolean }>(sql`select app.recruitment_destroying(${t.candX}::uuid) as on`);
    });
    expect(probe.on).toBe(false);
    // Even inside a destruction the candidate branch only clears: moving its creator or company is refused.
    // (X was created by the recruiter; the manager is a different user.)
    for (const change of [`created_by_user_id = '${t.manager.userId}'::uuid`, `company_id = '${otherCompanyId}'::uuid`]) {
      const refused = await owner.client.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${admin.userId!}, true), set_config('app.tenant_id', ${base.tenantId}, true)`;
        await tx`insert into app.recruitment_destroy_marker (txid, candidate_id, tenant_id) values (txid_current(), ${t.candX}::uuid, ${base.tenantId}::uuid)`;
        await tx.unsafe(`update recruitment_candidate set ${change}, full_name = 'Removed candidate ' || upper(substr(replace(id::text, '-', ''), 1, 8)),
          email = null, phone = null, location = null, current_company = null, current_title = null, highest_education = null, notice_period = null,
          source = null, destroyed_at = now(), destroyed_by_user_id = '${admin.userId}'::uuid where id = '${t.candX}'::uuid`);
        return 'not refused';
      }).catch((e: unknown) => pgSqlState(e));
      expect(refused, change).toBe('42501');
    }

    expect(await destroyCandidates(admin, base.companyId, [t.candX], 'on')).toEqual({ removed: 1 });

    // No sentinel anywhere in any recruitment table (rows as text; file bytes searched as bytes) or in any event.
    const tables = await owner.db.execute<{ relname: string }>(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'recruitment\\_%' order by c.relname`);
    expect(tables.length).toBe(31); // slice 7 (4407) adds recruitment_referral
    for (const { relname } of tables) {
      const [hit] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(relname)} r where to_jsonb(r.*)::text ilike ${`%${SENTINEL}%`}`);
      expect(hit.n, `${relname} still holds personal data`).toBe(0);
    }
    const [bytes] = await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate_file where position(convert_to(${SENTINEL}, 'UTF8') in content) > 0`);
    expect(bytes.n).toBe(0);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate_file where candidate_id = ${t.candX}::uuid`))[0].n).toBe(0);
    expect(await present()).toBe(0);
    const [cand] = await owner.db.execute<{ full_name: string; email: string | null; destroyed: boolean }>(sql`
      select full_name, email, destroyed_at is not null as destroyed from recruitment_candidate where id = ${t.candX}::uuid`);
    expect(cand).toMatchObject({ email: null, destroyed: true });
    expect(cand.full_name).toMatch(/^Removed candidate [0-9A-F]{8}$/);
    // Ratings stay, notes go; the offer skeleton stays without values or comments.
    const [card] = await owner.db.execute<{ ratings: Record<string, { rating: number; notes?: string }>; overview: string | null; result: string }>(sql`
      select ratings, overview, result from recruitment_scorecard where interview_id = ${t.interviewId}::uuid`);
    expect(card).toEqual({ ratings: Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => [k, { rating: 4 }])), overview: null, result: 'recommended' });
    expect((await owner.db.execute(sql`select status, candidate_decision, last_rejection_comment from recruitment_offer where id = ${offerId}::uuid`))[0])
      .toEqual({ status: 'approved', candidate_decision: 'declined', last_rejection_comment: null });
    expect(await owner.db.execute(sql`select decision, comment from recruitment_offer_approval where offer_id = ${offerId}::uuid order by acted_at`))
      .toEqual([{ decision: 'rejected', comment: '—' }, { decision: 'approved', comment: null }]);

    // Every count is unchanged; the one event carries counts only.
    expect(await counts()).toEqual(before);
    const [event] = await owner.db.execute<{ payload: Record<string, unknown> }>(sql`
      select payload from domain_event where event_type = 'recruitment-candidate.personal-data-removed' and aggregate_id = ${t.candX}::uuid`);
    expect(event.payload).toEqual({ companyId: base.companyId, files: 2, restricted: 1, entries: 2, tags: 1, consents: 1, scorecards: 1, offerValues: 4, referrals: 0, applications: 2, offers: 1 });

    // The record is closed afterwards, and a second removal finds nothing to remove.
    expect(await code(updateCandidateProfile(admin, t.candX, { fullName: 'Fictional again' }))).toBe('candidate_removed');
    expect(await code(addPoolCandidateToJob(admin, t.appX, t.jobId))).toBe('candidate_removed');
    expect(await code(rows(admin, sql`update recruitment_candidate set email = 'again@example.test' where id = ${t.candX}::uuid`))).toBe('23514');
    expect(await code(destroyCandidates(admin, base.companyId, [t.candX], 'on'))).toBe('not_found');
    expect((await candidateProfile(admin, t.appX))).toMatchObject({ removed: true, can: { edit: false }, files: [], entries: [] });
  });
});

describe('case 26 — destruction waits for a concurrent write to the same candidate', () => {
  it('a consent being recorded when the removal starts is waited for and seen by the due check, so the candidate is not removed', async () => {
    const t = await team();
    await rejectApplication(t.recruiter, t.appY, await reason());
    await closedAt(t.appY, `${addCalendarMonths(todayInKualaLumpur(), -30)}T09:00:00+08:00`);
    expect((await dueForDestruction(admin, base.companyId)).due.map((d) => d.candidateId)).toEqual([t.candY]);
    let settled = false;
    let destroy!: Promise<string>;
    // An in-flight consent write to Y: its guard takes the candidate lock shared (as every 4405 guard does) and holds it
    // until it commits. The removal starts while it is in flight and must wait for it, then see it.
    await owner.client.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${t.recruiter.userId!}, true), set_config('app.tenant_id', ${base.tenantId}, true)`;
      await tx`insert into recruitment_candidate_consent (tenant_id, company_id, candidate_id, status, effective_on, method, recorded_by_user_id)
        values (${base.tenantId}::uuid, ${base.companyId}::uuid, ${t.candY}::uuid, 'consented', ${todayInKualaLumpur()}::date, 'email', ${t.recruiter.userId!}::uuid)`;
      destroy = code(destroyCandidates(admin, base.companyId, [t.candY], 'on')).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled, 'the removal must wait for the in-flight write').toBe(false);
    });
    expect(await destroy).toBe('not_due');
    expect((await owner.db.execute<{ destroyed: boolean }>(sql`select destroyed_at is not null as destroyed from recruitment_candidate where id = ${t.candY}::uuid`))[0].destroyed).toBe(false);
    expect((await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_candidate_consent where candidate_id = ${t.candY}::uuid`))[0].n).toBe(1);
  });
});

describe('case 27 — row security on every new table; the AI Centre read stays counts-only', () => {
  it('forces row security, grants to the app role, none to PUBLIC; consent history cannot be rewritten', async () => {
    const tables = ['recruitment_candidate_restricted', 'recruitment_candidate_entry', 'recruitment_candidate_file', 'recruitment_tag_group', 'recruitment_tag',
      'recruitment_candidate_tag', 'recruitment_candidate_consent'];
    const found = await owner.db.execute<{ relname: string; rls: boolean; forced: boolean; app: boolean; public_grants: number; policies: number }>(sql`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, has_table_privilege('ai_hr_app', c.oid, 'SELECT') as app,
        (select count(*)::int from information_schema.role_table_grants g where g.table_name = c.relname and g.grantee = 'PUBLIC') as public_grants,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(${`{${tables.join(',')}}`}::text[]) order by c.relname`);
    expect(found.map((r) => r.relname)).toEqual([...tables].sort());
    expect(found.every((r) => r.rls && r.forced && r.app && r.public_grants === 0 && r.policies > 0)).toBe(true);
    const [priv] = await owner.db.execute<{ cupd: boolean; cdel: boolean; fupd: boolean; destroy_public: boolean }>(sql`select
      has_table_privilege('ai_hr_app', 'public.recruitment_candidate_consent', 'UPDATE') as cupd,
      has_table_privilege('ai_hr_app', 'public.recruitment_candidate_consent', 'DELETE') as cdel,
      has_table_privilege('ai_hr_app', 'public.recruitment_candidate_file', 'UPDATE') as fupd,
      has_function_privilege('public', 'app.recruitment_destroy_candidate(uuid)', 'EXECUTE') as destroy_public`);
    expect(priv).toEqual({ cupd: false, cdel: false, fupd: false, destroy_public: false });
  });

  it('the AI Centre recruitment read still returns per-company counts only', async () => {
    const t = await team();
    await saveCandidateRestricted(t.recruiter, t.candX, { idType: 'nric', idNumber: `${SENTINEL}-ID-X` });
    const read = await recruitmentPipelineCounts(admin);
    for (const row of read.rows) {
      expect(Object.keys(row).sort()).toEqual(['activeApplications', 'archived', 'company', 'hired', 'interview', 'offer', 'onHoldJobs', 'onboarding', 'openJobs', 'toScreen']);
      for (const [k, v] of Object.entries(row)) if (k !== 'company') expect(Number.isInteger(v)).toBe(true);
    }
    expect(JSON.stringify(read)).not.toMatch(new RegExp(`${SENTINEL}|example\\.test|Candidate`, 'i'));
  });
});
