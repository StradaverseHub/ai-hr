/**
 * Recruitment slice 2 — interviews, evaluation forms and scorecards. Reached from outside the pack ONLY through
 * ./service.
 *
 * Every entry point runs inside `withRecruitmentTenant` and re-asks the database for the caller's authority:
 *   schedule / cancel / candidate response — operators of the job (recruiter, assistant, administrators);
 *   read an application's interviews        — anyone who may read the application (reviewers and its interviewers);
 *   write feedback                          — only the named interviewer, for themselves (5202 guard and policy);
 *   read a scorecard                        — its author, the job's reviewers and administrators, and other interviewers
 *                                             of the application only when the company makes scorecards shared.
 * Totals are sums of whole-number ratings (./hiring-model sectionTotals). No model is involved.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { RecruitmentError, isUuid, type ApplicationState, type JobMemberRole } from './model';
import {
  DEFAULT_ROUNDS, FEEDBACK_EDIT_LOCKS, INTERVIEW_TYPES, CANDIDATE_RESPONSES, feedbackEditable, interviewStatus, parseFormDefinition,
  formatFormDefinition, readFormDefinition, sectionTotals, validateInterviewInput, validateScorecard,
  type CandidateResponse, type EvaluationFormDefinition, type EvaluationResult, type FeedbackEditLock, type InterviewInput, type InterviewStatus,
  type InterviewType, type ScorecardInput,
} from './hiring-model';
import {
  recruitmentCompanySetting, recruitmentEvaluationForm, recruitmentInterview, recruitmentInterviewInterviewer, recruitmentScorecard,
} from './schema';
import {
  actorId, assertCompanyTx, assertJobLevelTx, assertSeeCompanyTx, ensureRecruitmentDefaultsTx, jobLevelTx, userLabelsTx, uuidArray, type UserLabel,
} from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const event = (tx: Tx, s: SessionContext, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-interview', aggregateId, eventType, actor: actorOf(s), payload });

export type CompanyInterviewSettings = { scorecardsPrivate: boolean; feedbackEditLock: FeedbackEditLock; resultRequired: boolean };
async function settingsTx(tx: Tx, companyId: string): Promise<CompanyInterviewSettings & { offerValidDays: number; offerAcceptMovesForward: boolean; offerDeclineArchives: boolean }> {
  const [row] = await tx.select().from(recruitmentCompanySetting).where(eq(recruitmentCompanySetting.companyId, companyId));
  return {
    scorecardsPrivate: row?.scorecardsPrivate ?? true, feedbackEditLock: row?.feedbackEditLock ?? 'until_stage_left', resultRequired: row?.resultRequired ?? true,
    offerValidDays: row?.offerValidDays ?? 15, offerAcceptMovesForward: row?.offerAcceptMovesForward ?? false, offerDeclineArchives: row?.offerDeclineArchives ?? false,
  };
}
export { settingsTx as companySettingsTx };

async function applicationRowTx(tx: Tx, s: SessionContext, applicationId: unknown) {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  const [row] = await tx.execute<{
    id: string; company_id: string; job_id: string; state: ApplicationState; current_stage_id: string; process_id: string; candidate_name: string;
    job_title: string; job_number: string; stage_name: string; stage_type: string; stage_system_key: string | null;
  }>(sql`
    select a.id, a.company_id, a.job_id, a.state, a.current_stage_id, j.process_id, c.full_name as candidate_name, j.title as job_title,
      j.job_number, st.name as stage_name, st.stage_type, st.system_key as stage_system_key
    from recruitment_application a
    join recruitment_job_opening j on j.id = a.job_id
    join recruitment_candidate c on c.id = a.candidate_id
    join recruitment_stage st on st.id = a.current_stage_id
    where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
  if (!row) throw new RecruitmentError('not_found');
  return row;
}
export { applicationRowTx };

async function stagePositionsTx(tx: Tx, processId: string): Promise<Map<string, number>> {
  const rows = await tx.execute<{ stage_id: string; position: number }>(sql`select stage_id, position from recruitment_process_stage where process_id = ${processId}::uuid`);
  return new Map(rows.map((r) => [r.stage_id, r.position]));
}

// ── Scheduling ───────────────────────────────────────────────────────────────────────────────────────────

export type InterviewFormOptions = {
  applicationId: string; candidateName: string; jobTitle: string; stageName: string;
  rounds: number[]; forms: { id: string; name: string; isDefault: boolean }[]; users: UserLabel[];
};
/** What the "Add an interview" form offers for one application. Operators only. */
export async function interviewFormOptions(s: SessionContext, applicationId: string): Promise<InterviewFormOptions> {
  return withRecruitmentTenant(s, async (tx) => {
    const app = await applicationRowTx(tx, s, applicationId);
    await assertJobLevelTx(tx, app.company_id, app.job_id, 'operate', app.id);
    const forms = await tx.select({ id: recruitmentEvaluationForm.id, name: recruitmentEvaluationForm.name, isDefault: recruitmentEvaluationForm.isDefault })
      .from(recruitmentEvaluationForm)
      .where(and(eq(recruitmentEvaluationForm.companyId, app.company_id), eq(recruitmentEvaluationForm.enabled, true)))
      .orderBy(sql`${recruitmentEvaluationForm.isDefault} desc`, asc(recruitmentEvaluationForm.name));
    const [maxRound] = await tx.execute<{ n: number }>(sql`select coalesce(max(round_no), 0)::int as n from recruitment_interview where application_id = ${app.id}::uuid`);
    const rounds = [...new Set([...DEFAULT_ROUNDS, ...Array.from({ length: Math.min(20, (maxRound?.n ?? 0) + 1) }, (_, i) => i + 1)])].sort((a, b) => a - b);
    const users = [...(await userLabelsTx(tx, app.company_id)).values()].filter((u) => u.active).sort((a, b) => a.name.localeCompare(b.name));
    return { applicationId: app.id, candidateName: app.candidate_name, jobTitle: app.job_title, stageName: app.stage_name, rounds, forms, users };
  });
}

/**
 * Schedule an interview of an ACTIVE application at its current stage. The interviewers must be people of the
 * company (the same population the team pickers offer). The form defaults to the company's default form.
 */
export async function scheduleInterview(s: SessionContext, input: InterviewInput): Promise<{ id: string }> {
  const valid = validateInterviewInput(input);
  if (!valid.ok) throw new RecruitmentError(valid.code, valid.fields);
  const v = valid.value;
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const app = await applicationRowTx(tx, s, v.applicationId);
    await assertJobLevelTx(tx, app.company_id, app.job_id, 'operate', app.id);
    if (app.state !== 'active') throw new RecruitmentError('application_closed');
    const labels = await userLabelsTx(tx, app.company_id);
    if (!v.interviewerIds.every((id) => labels.get(id)?.active)) throw new RecruitmentError('invalid_input', ['interviewers']);
    let formId = v.formId;
    if (!formId) {
      const [def] = await tx.select({ id: recruitmentEvaluationForm.id }).from(recruitmentEvaluationForm)
        .where(and(eq(recruitmentEvaluationForm.companyId, app.company_id), eq(recruitmentEvaluationForm.isDefault, true)));
      if (!def) throw new RecruitmentError('invalid_input', ['form']);
      formId = def.id;
    } else {
      const [form] = await tx.select({ id: recruitmentEvaluationForm.id }).from(recruitmentEvaluationForm)
        .where(and(eq(recruitmentEvaluationForm.id, formId), eq(recruitmentEvaluationForm.companyId, app.company_id), eq(recruitmentEvaluationForm.enabled, true)));
      if (!form) throw new RecruitmentError('invalid_input', ['form']);
    }
    const [row] = await tx.insert(recruitmentInterview).values({
      tenantId: s.tenantId, companyId: app.company_id, jobId: app.job_id, applicationId: app.id, stageId: app.current_stage_id,
      roundNo: v.roundNo, interviewType: v.type, startsAt: v.startsAt, durationMinutes: v.durationMinutes, site: v.site, meetingRoom: v.meetingRoom,
      evaluationFormId: formId, createdByUserId: user, updatedByUserId: user,
    }).returning({ id: recruitmentInterview.id });
    for (const interviewer of v.interviewerIds) {
      await tx.insert(recruitmentInterviewInterviewer).values({
        tenantId: s.tenantId, companyId: app.company_id, jobId: app.job_id, applicationId: app.id, interviewId: row.id, appUserId: interviewer, createdByUserId: user,
      });
    }
    await event(tx, s, row.id, 'recruitment-interview.scheduled', {
      companyId: app.company_id, applicationId: app.id, roundNo: v.roundNo, type: v.type, startsAt: iso(v.startsAt), interviewers: v.interviewerIds,
    });
    return row;
  });
}

async function interviewTx(tx: Tx, s: SessionContext, interviewId: unknown) {
  if (!isUuid(interviewId)) throw new RecruitmentError('not_found');
  const [row] = await tx.select().from(recruitmentInterview).where(and(eq(recruitmentInterview.id, interviewId), eq(recruitmentInterview.tenantId, s.tenantId)));
  if (!row) throw new RecruitmentError('not_found');
  return row;
}

export async function cancelInterview(s: SessionContext, interviewId: unknown): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const i = await interviewTx(tx, s, interviewId);
    await assertJobLevelTx(tx, i.companyId, i.jobId, 'operate', i.applicationId);
    if (i.cancelledAt) throw new RecruitmentError('interview_closed');
    await tx.update(recruitmentInterview).set({ cancelledAt: sql`now()`, cancelledByUserId: user, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentInterview.id, i.id));
    await event(tx, s, i.id, 'recruitment-interview.cancelled', { companyId: i.companyId, applicationId: i.applicationId });
  });
}

/** Record the candidate's response to the invitation (Pending, Accepted, Declined). A person records it. */
export async function setCandidateResponse(s: SessionContext, interviewId: unknown, response: unknown): Promise<void> {
  if (!(CANDIDATE_RESPONSES as readonly unknown[]).includes(response)) throw new RecruitmentError('invalid_input', ['response']);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const i = await interviewTx(tx, s, interviewId);
    await assertJobLevelTx(tx, i.companyId, i.jobId, 'operate', i.applicationId);
    if (i.cancelledAt) throw new RecruitmentError('interview_closed');
    await tx.update(recruitmentInterview).set({ candidateResponse: response as CandidateResponse, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentInterview.id, i.id));
    await event(tx, s, i.id, 'recruitment-interview.response-recorded', { companyId: i.companyId, applicationId: i.applicationId, response });
  });
}

// ── Reading interviews ───────────────────────────────────────────────────────────────────────────────────

export type InterviewerView = {
  userId: string; name: string | null; submitted: boolean; result: EvaluationResult | null; scorecardId: string | null;
  /** The viewer may open this scorecard (row security returned it). */
  visible: boolean; isViewer: boolean;
};
export type InterviewCard = {
  id: string; roundNo: number; type: InterviewType; startsAt: string; durationMinutes: number; site: string | null; meetingRoom: string | null;
  candidateResponse: CandidateResponse; cancelled: boolean; status: InterviewStatus; formName: string; stageName: string;
  interviewers: InterviewerView[]; submitted: number; total: number;
  /** The viewer is an interviewer here and has not yet given feedback. */
  canAddFeedback: boolean; canEditFeedback: boolean;
};

async function interviewCardsTx(tx: Tx, s: SessionContext, where: ReturnType<typeof sql>, now: Date, labelsByCompany: (companyId: string) => Promise<Map<string, UserLabel>>) {
  const rows = await tx.execute<{
    id: string; company_id: string; job_id: string; application_id: string; stage_id: string; round_no: number; interview_type: InterviewType; starts_at: string;
    duration_minutes: number; site: string | null; meeting_room: string | null; candidate_response: CandidateResponse; cancelled: boolean;
    form_name: string; stage_name: string; app_state: ApplicationState; app_stage_id: string; process_id: string;
  }>(sql`
    select i.id, i.company_id, i.job_id, i.application_id, i.stage_id, i.round_no, i.interview_type, to_char(i.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as starts_at,
      i.duration_minutes, i.site, i.meeting_room, i.candidate_response, i.cancelled_at is not null as cancelled, f.name as form_name, st.name as stage_name,
      a.state as app_state, a.current_stage_id as app_stage_id, j.process_id
    from recruitment_interview i
    join recruitment_evaluation_form f on f.id = i.evaluation_form_id
    join recruitment_stage st on st.id = i.stage_id
    join recruitment_application a on a.id = i.application_id
    join recruitment_job_opening j on j.id = i.job_id
    where i.tenant_id = ${s.tenantId}::uuid and ${where}
    order by i.starts_at, i.round_no, i.id`);
  if (!rows.length) return [];
  const ids = uuidArray(rows.map((r) => r.id));
  const interviewers = await tx.execute<{ interview_id: string; app_user_id: string }>(sql`
    select interview_id, app_user_id from recruitment_interview_interviewer where interview_id = any(${ids}::uuid[]) order by created_at, id`);
  const cards = await tx.execute<{ id: string; interview_id: string; interviewer_user_id: string; result: EvaluationResult | null }>(sql`
    select id, interview_id, interviewer_user_id, result from recruitment_scorecard where interview_id = any(${ids}::uuid[])`);
  const settingsByCompany = new Map<string, CompanyInterviewSettings>();
  const positionsByProcess = new Map<string, Map<string, number>>();
  const out: (InterviewCard & { companyId: string; jobId: string; applicationId: string })[] = [];
  for (const r of rows) {
    if (!settingsByCompany.has(r.company_id)) settingsByCompany.set(r.company_id, await settingsTx(tx, r.company_id));
    if (!positionsByProcess.has(r.process_id)) positionsByProcess.set(r.process_id, await stagePositionsTx(tx, r.process_id));
    const labels = await labelsByCompany(r.company_id);
    const mine = cards.filter((c) => c.interview_id === r.id);
    // An interviewer who is not a reviewer sees only their own interviewer row (5202 policy); the scorecards they
    // may read show their authors too, so the list is the union of both.
    const userIds = [...new Set([...interviewers.filter((v) => v.interview_id === r.id).map((v) => v.app_user_id), ...mine.map((c) => c.interviewer_user_id)])];
    const views: InterviewerView[] = userIds.map((uid) => {
      const card = mine.find((c) => c.interviewer_user_id === uid);
      return { userId: uid, name: labels.get(uid)?.name ?? null, submitted: !!card, result: card?.result ?? null, scorecardId: card?.id ?? null, visible: !!card, isViewer: uid === s.userId };
    });
    const submitted = views.filter((v) => v.submitted).length;
    const viewer = views.find((v) => v.isViewer);
    const positions = positionsByProcess.get(r.process_id)!;
    const editable = feedbackEditable(settingsByCompany.get(r.company_id)!.feedbackEditLock,
      { state: r.app_state, currentStageId: r.app_stage_id, currentPosition: positions.get(r.app_stage_id) ?? null },
      { stageId: r.stage_id, position: positions.get(r.stage_id) ?? null });
    out.push({
      id: r.id, companyId: r.company_id, jobId: r.job_id, applicationId: r.application_id, roundNo: r.round_no, type: r.interview_type, startsAt: r.starts_at,
      durationMinutes: r.duration_minutes, site: r.site, meetingRoom: r.meeting_room, candidateResponse: r.candidate_response, cancelled: r.cancelled,
      status: interviewStatus({ startsAt: r.starts_at, durationMinutes: r.duration_minutes, cancelled: r.cancelled, interviewers: views.length, submitted }, now),
      formName: r.form_name, stageName: r.stage_name, interviewers: views, submitted, total: views.length,
      canAddFeedback: !r.cancelled && !!viewer && !viewer.submitted,
      canEditFeedback: !r.cancelled && !!viewer?.submitted && editable,
    });
  }
  return out;
}

export type ApplicationInterviews = {
  applicationId: string; candidateName: string; jobTitle: string; jobId: string; companyId: string; state: ApplicationState; stageName: string;
  canSchedule: boolean; interviews: InterviewCard[];
};
/** The application's Interview tab: every interview the viewer may read, with per-interviewer feedback state. */
export async function applicationInterviews(s: SessionContext, applicationId: string): Promise<ApplicationInterviews> {
  const now = new Date();
  return withRecruitmentTenant(s, async (tx) => {
    const app = await applicationRowTx(tx, s, applicationId);
    const access = await jobLevelTx(tx, app.company_id, app.job_id, app.id);
    if (!access.read) throw new RecruitmentError('not_found');
    const labels = await userLabelsTx(tx, app.company_id);
    const interviews = await interviewCardsTx(tx, s, sql`i.application_id = ${app.id}::uuid`, now, async () => labels);
    return {
      applicationId: app.id, candidateName: app.candidate_name, jobTitle: app.job_title, jobId: app.job_id, companyId: app.company_id, state: app.state,
      stageName: app.stage_name, canSchedule: access.operate && app.state === 'active', interviews,
    };
  });
}

export type ScheduleFilters = { jobId?: string; recruiterUserId?: string; interviewerUserId?: string; type?: string };
export type ScheduleRow = InterviewCard & {
  applicationId: string; candidateName: string; email: string | null; phone: string | null; jobId: string; jobTitle: string; jobNumber: string;
  recruiterName: string | null; group: 'today' | 'upcoming' | 'recent';
};
export type InterviewSchedule = {
  rows: ScheduleRow[]; counts: { today: number; upcoming: number; recent: number };
  jobs: { id: string; title: string; jobNumber: string }[]; recruiters: { id: string; name: string }[]; interviewers: { id: string; name: string }[];
};

/**
 * The interview schedule across the companies in view: Today, Upcoming and Recent (the last 30 days), each in time
 * order. Row security narrows it to the interviews the viewer may read. Recruiter is the job's recruiter where the
 * viewer can see that membership (administrators, and the recruiter themself).
 */
export async function interviewSchedule(s: SessionContext, companyIds: readonly string[], filters: ScheduleFilters = {}): Promise<InterviewSchedule> {
  const empty: InterviewSchedule = { rows: [], counts: { today: 0, upcoming: 0, recent: 0 }, jobs: [], recruiters: [], interviewers: [] };
  if (!companyIds.length) return empty;
  const now = new Date();
  const today = todayInKualaLumpur(now);
  return withRecruitmentTenant(s, async (tx) => {
    for (const id of companyIds) await assertSeeCompanyTx(tx, id);
    const ids = uuidArray(companyIds);
    const job = filters.jobId && isUuid(filters.jobId) ? filters.jobId : null;
    const recruiter = filters.recruiterUserId && isUuid(filters.recruiterUserId) ? filters.recruiterUserId : null;
    const interviewer = filters.interviewerUserId && isUuid(filters.interviewerUserId) ? filters.interviewerUserId : null;
    const type = (INTERVIEW_TYPES as readonly unknown[]).includes(filters.type) ? filters.type! : null;
    const where = sql`i.company_id = any(${ids}::uuid[]) and i.starts_at >= (${today}::date - 30)::timestamp at time zone 'Asia/Kuala_Lumpur'
      and (${job}::uuid is null or i.job_id = ${job}::uuid)
      and (${type}::text is null or i.interview_type = ${type}::text)
      and (${recruiter}::uuid is null or exists (select 1 from recruitment_job_member m where m.job_id = i.job_id and m.member_role = 'recruiter' and m.app_user_id = ${recruiter}::uuid))
      and (${interviewer}::uuid is null or exists (select 1 from recruitment_interview_interviewer v where v.interview_id = i.id and v.app_user_id = ${interviewer}::uuid))`;
    const labelCache = new Map<string, Map<string, UserLabel>>();
    const labelsFor = async (companyId: string) => {
      if (!labelCache.has(companyId)) labelCache.set(companyId, await userLabelsTx(tx, companyId));
      return labelCache.get(companyId)!;
    };
    const cards = await interviewCardsTx(tx, s, where, now, labelsFor);
    const appIds = [...new Set(cards.map((c) => c.applicationId))];
    const apps = appIds.length ? await tx.execute<{ id: string; full_name: string; email: string | null; phone: string | null; job_id: string; title: string; job_number: string }>(sql`
      select a.id, c.full_name, c.email, c.phone, a.job_id, j.title, j.job_number from recruitment_application a
      join recruitment_candidate c on c.id = a.candidate_id join recruitment_job_opening j on j.id = a.job_id
      where a.id = any(${uuidArray(appIds)}::uuid[])`) : [];
    const recruiters = await tx.execute<{ job_id: string; app_user_id: string; company_id: string }>(sql`
      select m.job_id, m.app_user_id, m.company_id from recruitment_job_member m where m.company_id = any(${ids}::uuid[]) and m.member_role = 'recruiter'`);
    const rows: ScheduleRow[] = [];
    for (const c of cards) {
      const a = apps.find((x) => x.id === c.applicationId);
      if (!a) continue;
      const day = todayInKualaLumpur(new Date(c.startsAt));
      const rec = recruiters.find((r) => r.job_id === c.jobId);
      rows.push({
        ...c, candidateName: a.full_name, email: a.email, phone: a.phone, jobTitle: a.title, jobNumber: a.job_number,
        recruiterName: rec ? (await labelsFor(rec.company_id)).get(rec.app_user_id)?.name ?? null : null,
        group: day === today ? 'today' : new Date(c.startsAt).getTime() > now.getTime() ? 'upcoming' : 'recent',
      });
    }
    rows.sort((x, y) => (x.group === 'recent' && y.group === 'recent' ? y.startsAt.localeCompare(x.startsAt) : x.startsAt.localeCompare(y.startsAt)));
    const jobs = await tx.execute<{ id: string; title: string; job_number: string }>(sql`
      select j.id, j.title, j.job_number from recruitment_job_opening j where j.tenant_id = ${s.tenantId}::uuid and j.company_id = any(${ids}::uuid[]) order by j.title, j.job_number`);
    const recruiterOptions = new Map<string, string>();
    for (const r of recruiters) recruiterOptions.set(r.app_user_id, (await labelsFor(r.company_id)).get(r.app_user_id)?.name ?? '');
    const interviewerOptions = new Map<string, string>();
    for (const c of cards) for (const v of c.interviewers) interviewerOptions.set(v.userId, v.name ?? '');
    const byName = (m: Map<string, string>) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      rows, counts: { today: rows.filter((r) => r.group === 'today').length, upcoming: rows.filter((r) => r.group === 'upcoming').length, recent: rows.filter((r) => r.group === 'recent').length },
      jobs: jobs.map((j) => ({ id: j.id, title: j.title, jobNumber: j.job_number })), recruiters: byName(recruiterOptions), interviewers: byName(interviewerOptions),
    };
  });
}

// ── Feedback (scorecards) ────────────────────────────────────────────────────────────────────────────────

export type ScorecardForm = {
  interviewId: string; applicationId: string; candidateName: string; jobTitle: string; roundNo: number; formName: string;
  definition: EvaluationFormDefinition; resultRequired: boolean;
  existing: { ratings: Record<string, { rating: number; notes?: string }>; result: EvaluationResult | null; overview: string | null } | null;
  editable: boolean;
};

/** The viewer's OWN feedback form for an interview they are named on. Nobody opens another person's form. */
export async function scorecardForm(s: SessionContext, interviewId: unknown): Promise<ScorecardForm> {
  return withRecruitmentTenant(s, async (tx) => {
    const i = await interviewTx(tx, s, interviewId);
    const [me] = await tx.select({ id: recruitmentInterviewInterviewer.id }).from(recruitmentInterviewInterviewer)
      .where(and(eq(recruitmentInterviewInterviewer.interviewId, i.id), eq(recruitmentInterviewInterviewer.appUserId, actorId(s))));
    if (!me) throw new RecruitmentError('not_interviewer');
    if (i.cancelledAt) throw new RecruitmentError('interview_closed');
    const app = await applicationRowTx(tx, s, i.applicationId);
    const [form] = await tx.select().from(recruitmentEvaluationForm).where(eq(recruitmentEvaluationForm.id, i.evaluationFormId));
    const settings = await settingsTx(tx, i.companyId);
    const [existing] = await tx.select().from(recruitmentScorecard)
      .where(and(eq(recruitmentScorecard.interviewId, i.id), eq(recruitmentScorecard.interviewerUserId, actorId(s))));
    const positions = await stagePositionsTx(tx, app.process_id);
    const editable = !existing || feedbackEditable(settings.feedbackEditLock,
      { state: app.state, currentStageId: app.current_stage_id, currentPosition: positions.get(app.current_stage_id) ?? null },
      { stageId: i.stageId, position: positions.get(i.stageId) ?? null });
    return {
      interviewId: i.id, applicationId: i.applicationId, candidateName: app.candidate_name, jobTitle: app.job_title, roundNo: i.roundNo, formName: form.name,
      definition: readFormDefinition(form.definition), resultRequired: settings.resultRequired,
      existing: existing ? { ratings: existing.ratings, result: existing.result ?? null, overview: existing.overview ?? null } : null, editable,
    };
  });
}

/**
 * Submit (or, where the company's edit lock allows, edit) the viewer's own feedback. Validated against the
 * interview's form; the 5202 guard refuses another author, a cancelled interview and a locked edit independently.
 */
export async function submitScorecard(s: SessionContext, interviewId: unknown, input: ScorecardInput): Promise<void> {
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    const i = await interviewTx(tx, s, interviewId);
    const [me] = await tx.select({ id: recruitmentInterviewInterviewer.id }).from(recruitmentInterviewInterviewer)
      .where(and(eq(recruitmentInterviewInterviewer.interviewId, i.id), eq(recruitmentInterviewInterviewer.appUserId, user)));
    if (!me) throw new RecruitmentError('not_interviewer');
    if (i.cancelledAt) throw new RecruitmentError('interview_closed');
    const [form] = await tx.select().from(recruitmentEvaluationForm).where(eq(recruitmentEvaluationForm.id, i.evaluationFormId));
    const settings = await settingsTx(tx, i.companyId);
    const valid = validateScorecard(readFormDefinition(form.definition), input, settings.resultRequired);
    if (!valid.ok) throw new RecruitmentError(valid.code, valid.fields);
    const [existing] = await tx.select({ id: recruitmentScorecard.id }).from(recruitmentScorecard)
      .where(and(eq(recruitmentScorecard.interviewId, i.id), eq(recruitmentScorecard.interviewerUserId, user)));
    if (existing) {
      const app = await applicationRowTx(tx, s, i.applicationId);
      const positions = await stagePositionsTx(tx, app.process_id);
      if (!feedbackEditable(settings.feedbackEditLock,
        { state: app.state, currentStageId: app.current_stage_id, currentPosition: positions.get(app.current_stage_id) ?? null },
        { stageId: i.stageId, position: positions.get(i.stageId) ?? null })) throw new RecruitmentError('feedback_locked');
      await tx.update(recruitmentScorecard).set({ ratings: valid.value.ratings, result: valid.value.result, overview: valid.value.overview })
        .where(eq(recruitmentScorecard.id, existing.id));
    } else {
      await tx.insert(recruitmentScorecard).values({
        tenantId: s.tenantId, companyId: i.companyId, jobId: i.jobId, applicationId: i.applicationId, interviewId: i.id, interviewerUserId: user,
        evaluationFormId: i.evaluationFormId, ratings: valid.value.ratings, result: valid.value.result, overview: valid.value.overview,
      });
    }
    // The payload names the result only — never notes or ratings — so the domain log carries no assessment text.
    await event(tx, s, i.id, existing ? 'recruitment-interview.feedback-edited' : 'recruitment-interview.feedback-submitted',
      { companyId: i.companyId, applicationId: i.applicationId, result: valid.value.result });
  });
}

export type ScorecardView = {
  id: string; interviewerName: string | null; roundNo: number; formName: string; result: EvaluationResult | null; overview: string | null;
  submittedAt: string; updatedAt: string;
  sections: { key: string; title: string; sum: number; max: number; criteria: { key: string; label: string; question?: string; rating: number | null; notes: string | null }[] }[];
};
/** One scorecard, if row security lets the viewer read it (author, reviewers, administrators; others when shared). */
export async function getScorecard(s: SessionContext, scorecardId: unknown): Promise<ScorecardView> {
  if (!isUuid(scorecardId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [row] = await tx.select().from(recruitmentScorecard).where(and(eq(recruitmentScorecard.id, scorecardId), eq(recruitmentScorecard.tenantId, s.tenantId)));
    if (!row) throw new RecruitmentError('not_found');
    await assertJobLevelTx(tx, row.companyId, row.jobId, 'read', row.applicationId).catch(async (e) => {
      // The author always reads their own.
      if (row.interviewerUserId !== s.userId) throw e;
    });
    const [i] = await tx.select({ roundNo: recruitmentInterview.roundNo }).from(recruitmentInterview).where(eq(recruitmentInterview.id, row.interviewId));
    const [form] = await tx.select().from(recruitmentEvaluationForm).where(eq(recruitmentEvaluationForm.id, row.evaluationFormId));
    const def = readFormDefinition(form.definition);
    const totals = sectionTotals(def, row.ratings);
    const labels = await userLabelsTx(tx, row.companyId);
    return {
      id: row.id, interviewerName: labels.get(row.interviewerUserId)?.name ?? null, roundNo: i?.roundNo ?? 1, formName: form.name, result: row.result ?? null,
      overview: row.overview ?? null, submittedAt: iso(row.submittedAt), updatedAt: iso(row.updatedAt),
      sections: def.sections.map((sec) => ({
        key: sec.key, title: sec.title, sum: totals.find((t) => t.key === sec.key)!.sum, max: totals.find((t) => t.key === sec.key)!.max,
        criteria: sec.criteria.map((c) => ({ key: c.key, label: c.label, question: c.question, rating: row.ratings[c.key]?.rating ?? null, notes: row.ratings[c.key]?.notes ?? null })),
      })),
    };
  });
}

// ── Settings: feedback rules and evaluation forms ────────────────────────────────────────────────────────

export type InterviewSettings = CompanyInterviewSettings & {
  forms: { id: string; name: string; isDefault: boolean; enabled: boolean; inUse: boolean; source: string; criteria: number }[];
};
export async function interviewSettings(s: SessionContext, companyId: string): Promise<InterviewSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, companyId);
    const settings = await settingsTx(tx, companyId);
    const forms = await tx.execute<{ id: string; name: string; is_default: boolean; enabled: boolean; definition: unknown; in_use: boolean }>(sql`
      select f.id, f.name, f.is_default, f.enabled, f.definition, exists (select 1 from recruitment_interview i where i.evaluation_form_id = f.id) as in_use
      from recruitment_evaluation_form f where f.tenant_id = ${s.tenantId}::uuid and f.company_id = ${companyId}::uuid order by f.is_default desc, f.name`);
    return {
      scorecardsPrivate: settings.scorecardsPrivate, feedbackEditLock: settings.feedbackEditLock, resultRequired: settings.resultRequired,
      forms: forms.map((f) => {
        const def = readFormDefinition(f.definition);
        return { id: f.id, name: f.name, isDefault: f.is_default, enabled: f.enabled, inUse: f.in_use, source: formatFormDefinition(def), criteria: def.sections.reduce((n, x) => n + x.criteria.length, 0) };
      }),
    };
  });
}

export async function updateInterviewSettings(s: SessionContext, companyId: unknown, input: { scorecardsPrivate?: unknown; feedbackEditLock?: unknown; resultRequired?: unknown }): Promise<void> {
  if (!isUuid(companyId)) throw new RecruitmentError('forbidden');
  if (!(FEEDBACK_EDIT_LOCKS as readonly unknown[]).includes(input.feedbackEditLock)) throw new RecruitmentError('invalid_input', ['feedbackEditLock']);
  const on = (v: unknown) => v === true || v === 'on' || v === 'true';
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    await ensureRecruitmentDefaultsTx(tx, s, companyId);
    const before = await settingsTx(tx, companyId);
    const after = { scorecardsPrivate: on(input.scorecardsPrivate), feedbackEditLock: input.feedbackEditLock as FeedbackEditLock, resultRequired: on(input.resultRequired) };
    await tx.update(recruitmentCompanySetting).set({ ...after, updatedAt: sql`now()`, updatedByUserId: user }).where(eq(recruitmentCompanySetting.companyId, companyId));
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-setting', aggregateId: companyId, eventType: 'recruitment-setting.interviews-updated', actor: actorOf(s),
      payload: { companyId, before: { scorecardsPrivate: before.scorecardsPrivate, feedbackEditLock: before.feedbackEditLock, resultRequired: before.resultRequired }, after } });
  });
}

/** Create (no id) or edit an evaluation form. A form an interview uses keeps its questions (5202 guard). */
export async function saveEvaluationForm(s: SessionContext, input: { id?: unknown; companyId?: unknown; name?: unknown; source?: unknown; isDefault?: unknown; enabled?: unknown }): Promise<void> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) throw new RecruitmentError('missing_fields', ['name']);
  const definition = parseFormDefinition(input.source);
  const on = (v: unknown) => v === true || v === 'on' || v === 'true';
  const isDefault = on(input.isDefault);
  const enabled = isDefault || on(input.enabled);
  const user = actorId(s);
  await withRecruitmentTenant(s, async (tx) => {
    let companyId: string;
    let id: string;
    if (input.id == null || input.id === '') {
      if (!isUuid(input.companyId)) throw new RecruitmentError('forbidden');
      companyId = input.companyId;
      await assertCompanyTx(tx, companyId);
      if (isDefault) await tx.update(recruitmentEvaluationForm).set({ isDefault: false }).where(and(eq(recruitmentEvaluationForm.companyId, companyId), eq(recruitmentEvaluationForm.isDefault, true)));
      [{ id }] = await tx.insert(recruitmentEvaluationForm).values({ tenantId: s.tenantId, companyId, name, definition, isDefault, enabled, createdByUserId: user, updatedByUserId: user })
        .returning({ id: recruitmentEvaluationForm.id });
    } else {
      if (!isUuid(input.id)) throw new RecruitmentError('not_found');
      const [form] = await tx.select().from(recruitmentEvaluationForm).where(and(eq(recruitmentEvaluationForm.id, input.id), eq(recruitmentEvaluationForm.tenantId, s.tenantId)));
      if (!form) throw new RecruitmentError('not_found');
      companyId = form.companyId;
      id = form.id;
      await assertCompanyTx(tx, companyId);
      const [used] = await tx.execute<{ used: boolean }>(sql`select exists (select 1 from recruitment_interview where evaluation_form_id = ${form.id}::uuid) as used`);
      if (used?.used && JSON.stringify(readFormDefinition(form.definition)) !== JSON.stringify(definition)) throw new RecruitmentError('form_in_use');
      if (form.isDefault && !isDefault) throw new RecruitmentError('invalid_input', ['isDefault']);
      if (isDefault && !form.isDefault) await tx.update(recruitmentEvaluationForm).set({ isDefault: false }).where(and(eq(recruitmentEvaluationForm.companyId, companyId), eq(recruitmentEvaluationForm.isDefault, true)));
      await tx.update(recruitmentEvaluationForm).set({ name, definition: used?.used ? form.definition : definition, isDefault, enabled, updatedAt: sql`now()`, updatedByUserId: user })
        .where(eq(recruitmentEvaluationForm.id, form.id));
    }
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-evaluation-form', aggregateId: id, eventType: 'recruitment-evaluation-form.saved', actor: actorOf(s),
      payload: { companyId, name, isDefault, enabled, criteria: definition.sections.reduce((n, x) => n + x.criteria.length, 0) } });
  });
}

/** The roles the viewer holds on a job (for screens; the database predicates still decide every action). */
export async function myJobRoles(s: SessionContext, jobId: string): Promise<JobMemberRole[]> {
  if (!isUuid(jobId)) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ member_role: JobMemberRole }>(sql`
      select member_role from recruitment_job_member where job_id = ${jobId}::uuid and app_user_id = app.current_user_id()`);
    return rows.map((r) => r.member_role);
  });
}
