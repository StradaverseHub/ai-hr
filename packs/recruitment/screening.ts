/**
 * Recruitment slice 11 — resume screening by hiring managers (docs/recruitment-reconstruction/specification.md "Slice 11").
 * Reached from outside the pack ONLY through ./service.
 *
 * The job's recruiter and assistants, and recruitment administrators, send applications of one job to the job's hiring
 * managers (all of them by default), with an optional note and, optionally, a move to each application's next enabled stage
 * in the same transaction (through the slice 1 move: same access, plan, guards and history). They reassign (add reviewers)
 * and withdraw open requests. Each named reviewer answers Advance, Reject or Pending with an optional comment; Pending may be
 * followed by another answer, Advance or Reject closes the request. An answer never moves or rejects anything.
 *
 * Every entry point runs inside `withRecruitmentTenant` as the caller, under the caller's own row security (5711): operators
 * and administrators read every request and answer on the job; a reviewer reads their own requests and, like scorecards, the
 * job's answers; nobody else reads anything. The service checks first for a clear refusal; the 5711 guards refuse the same
 * again. The job's hiring managers are read through app.recruitment_job_hiring_managers (ids, to the job's operators only).
 * Audit events carry ids, counts and results — never a note or a comment. Nothing here calls a model or scores a résumé.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, planMoveForward, type ApplicationState, type RecruitmentErrorCode } from './model';
import {
  SCREENING_LIST_LIMIT, assignmentStatus, requestState, validateAnswerInput, validateSendInput,
  type AnswerInput, type AssignmentStatus, type RequestState, type ScreeningCloseReason, type ScreeningResult, type SendInput,
} from './screening-model';
import { actorId, applicationTx, jobLevelTx, jobTx, moveApplicationTx, processStagesTx, userLabelsTx, uuidArray } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const event = (tx: Tx, s: SessionContext, applicationId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: applicationId, eventType, actor: actorOf(s), payload });
/** A database refusal as a stable code (SQLSTATE only; the message carries bound values and is never shown or logged). */
const asError = (e: unknown, map: Record<string, RecruitmentErrorCode>): never => {
  const code = pgSqlState(e);
  if (code && map[code]) throw new RecruitmentError(map[code]);
  throw e;
};

/** The CHECK-style name a guard gave its refusal (RAISE … CONSTRAINT), from the error or its causes. */
const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};

/** The job's hiring managers (ids, oldest membership first) — for an operator or administrator of the job; else none. The
 *  5711 definer is STABLE and writes nothing, so this works in a read-only transaction. */
async function jobHiringManagersTx(tx: Tx, jobId: string): Promise<string[]> {
  const rows = await tx.execute<{ app_user_id: string }>(sql`select app_user_id from app.recruitment_job_hiring_managers(${jobId}::uuid)`);
  return rows.map((r) => r.app_user_id);
}
/**
 * The same, for a READ screen: inside a savepoint, so a database failure here (a statement timeout, a replica conflict)
 * leaves the page's transaction usable and the page renders without the reviewer choice (null), logged as the error's name
 * and SQLSTATE only.
 */
async function reviewerChoiceTx(tx: Tx, jobId: string): Promise<string[] | null> {
  try {
    return await tx.transaction((sp) => jobHiringManagersTx(sp, jobId));
  } catch (e) {
    if (e instanceof RecruitmentError) throw e;
    console.error('recruitment hiring managers unavailable', e instanceof Error ? e.name : typeof e, pgSqlState(e) ?? '');
    return null;
  }
}

// ── Sending, reassigning, withdrawing (the job's operators and administrators) ──────────────────────────────────

export type ScreeningReviewerOption = { id: string; name: string | null };
/** `reviewers` is null when the choice could not be read just now (the page renders without it). */
export type ScreeningSendOptions = { jobId: string; reviewers: ScreeningReviewerOption[] | null };
/** The reviewer choice for "Send to hiring manager" on a job: its hiring managers with their names (operators only). Read-only. */
export async function screeningSendOptions(s: SessionContext, jobId: unknown): Promise<ScreeningSendOptions> {
  return withRecruitmentTenant(s, (tx) => screeningSendOptionsTx(tx, s, jobId));
}
export async function screeningSendOptionsTx(tx: Tx, s: SessionContext, jobId: unknown): Promise<ScreeningSendOptions> {
  if (!isUuid(jobId)) throw new RecruitmentError('not_found');
  const job = await jobTx(tx, s, jobId, 'operate');
  const ids = await reviewerChoiceTx(tx, job.id);
  const labels = ids?.length ? await userLabelsTx(tx, job.companyId) : new Map();
  return { jobId: job.id, reviewers: ids ? ids.map((id) => ({ id, name: labels.get(id)?.name ?? null })) : null };
}

/** `held` (slice 13, present only when above zero): applications sent but NOT moved because they need an administrator's review. */
export type ScreeningSendResult = { sent: number; skipped: number; moved: number; held?: number };

async function sendTx(tx: Tx, s: SessionContext, input: SendInput): Promise<ScreeningSendResult> {
  const v = validateSendInput(input);
  // Locks each application (sorted, so two selections lock in one order), refuses an application the caller does not operate
  // (forbidden) or that is archived or hired (application_closed).
  const apps = [];
  for (const id of [...v.applicationIds].sort()) apps.push(await applicationTx(tx, s, id, 'operate'));
  const jobId = apps[0].app.jobId;
  if (apps.some((a) => a.app.jobId !== jobId)) throw new RecruitmentError('mixed_jobs');
  const managers = await jobHiringManagersTx(tx, jobId);
  if (!managers.length) throw new RecruitmentError('no_hiring_manager');
  const reviewers = v.reviewerUserIds ?? managers;
  if (reviewers.some((r) => !managers.includes(r))) throw new RecruitmentError('not_hiring_manager');
  const ids = apps.map((a) => a.app.id);
  // A reviewer with an open request on the application is not asked twice (the partial unique index agrees).
  const open = await tx.execute<{ application_id: string; reviewer_user_id: string }>(sql`
    select application_id, reviewer_user_id from recruitment_screening_request
    where application_id = any(${uuidArray(ids)}::uuid[]) and closed_at is null`);
  const asked = new Set(open.map((r) => `${r.application_id}|${r.reviewer_user_id}`));
  let sent = 0;
  let skipped = 0;
  let moved = 0;
  let held = 0;
  for (const { app, processId } of apps) {
    const created: string[] = [];
    for (const reviewer of reviewers) {
      if (asked.has(`${app.id}|${reviewer}`)) { skipped += 1; continue; }
      const rows = await tx.execute<{ id: string }>(sql`
        insert into recruitment_screening_request (tenant_id, company_id, job_id, application_id, reviewer_user_id, sent_by_user_id, note)
        values (${s.tenantId}::uuid, ${app.companyId}::uuid, ${app.jobId}::uuid, ${app.id}::uuid, ${reviewer}::uuid, ${actorId(s)}::uuid, ${v.note})
        on conflict (application_id, reviewer_user_id) where closed_at is null do nothing returning id`)
        .catch((e) => {
          // A refusal the checks above did not foresee is a race: the application was archived or hired, or the reviewer left
          // the job's hiring managers, after they ran. The guard names which.
          if (pgSqlState(e) === '23514') {
            const c = constraintOf(e);
            if (c === 'recruitment_screening_request_application_active') throw new RecruitmentError('application_closed');
            if (c === 'recruitment_screening_request_reviewer_hiring_manager') throw new RecruitmentError('not_hiring_manager');
          }
          return asError(e, { '42501': 'forbidden' });
        });
      if (rows.length) { created.push(rows[0].id); sent += 1; } else skipped += 1;
    }
    // The optional move: to the next ENABLED stage of the job's process, through the slice 1 move (history included), and only
    // for an application that got at least one NEW request here (spec: re-sending to reviewers already asked moves nothing).
    // From the last stage there is no next stage to offer, so the application stays (sending never hires anybody).
    let movedTo: string | null = null;
    if (v.move && created.length) {
      const plan = planMoveForward(await processStagesTx(tx, processId), app.currentStageId);
      // Slice 13: an application that needs an administrator's review is sent but stays where it is.
      const [review] = plan.kind === 'moved' ? await tx.execute<{ marked: boolean }>(sql`select app.recruitment_application_needs_review(${app.id}::uuid) as marked`) : [];
      if (review?.marked === true) held += 1;
      else if (plan.kind === 'moved') {
        movedTo = (await moveApplicationTx(tx, s, app.id, plan.to)).stageId;
        moved += 1;
      }
    }
    if (created.length || movedTo) {
      await event(tx, s, app.id, 'recruitment-application.screening-sent', { companyId: app.companyId, jobId: app.jobId, requestIds: created, movedToStageId: movedTo });
    }
  }
  return held ? { sent, skipped, moved, held } : { sent, skipped, moved };
}

/**
 * "Send to hiring manager" (case 75): one or more applications of ONE job, to the chosen hiring managers of that job (none
 * chosen: all of them), with an optional note and optionally moving each to its next enabled stage — all in one transaction.
 * A reviewer who already has an open request on an application is skipped.
 */
export async function sendForScreening(s: SessionContext, input: SendInput): Promise<ScreeningSendResult> {
  actorId(s);
  return withRecruitmentTenant(s, (tx) => sendTx(tx, s, input));
}

/** "Reassign": ask more of the job's hiring managers about one application (no move). */
export async function reassignScreening(s: SessionContext, input: { applicationId?: unknown; reviewerUserIds?: unknown; note?: unknown }): Promise<ScreeningSendResult> {
  actorId(s);
  const reviewers = Array.isArray(input.reviewerUserIds) ? input.reviewerUserIds : input.reviewerUserIds ? [input.reviewerUserIds] : [];
  if (!reviewers.length) throw new RecruitmentError('missing_fields', ['reviewerUserIds']);
  return withRecruitmentTenant(s, (tx) => sendTx(tx, s, { applicationIds: [input.applicationId], reviewerUserIds: reviewers, note: input.note, move: false }));
}

/** "Withdraw": close an open request without an answer (the job's operators and administrators). */
export async function withdrawScreening(s: SessionContext, requestId: unknown): Promise<void> {
  const user = actorId(s);
  if (!isUuid(requestId)) throw new RecruitmentError('not_found');
  await withRecruitmentTenant(s, async (tx) => {
    const [q] = await tx.execute<{ id: string; company_id: string; job_id: string; application_id: string; closed_at: string | null }>(sql`
      select id, company_id, job_id, application_id, closed_at from recruitment_screening_request
      where id = ${requestId}::uuid and tenant_id = ${s.tenantId}::uuid for update`)
      .catch((e) => asError(e, { '42501': 'forbidden' }));
    if (!q) throw new RecruitmentError('not_found');
    const access = await jobLevelTx(tx, q.company_id, q.job_id);
    if (!access.operate) throw new RecruitmentError('forbidden');
    if (q.closed_at) throw new RecruitmentError('screening_closed');
    await tx.execute(sql`update recruitment_screening_request set closed_at = now(), closed_reason = 'withdrawn', closed_by_user_id = ${user}::uuid
      where id = ${q.id}::uuid`).catch((e) => asError(e, { '42501': 'forbidden', '23514': 'screening_closed' }));
    await event(tx, s, q.application_id, 'recruitment-application.screening-withdrawn', { companyId: q.company_id, jobId: q.job_id, requestId: q.id });
  });
}

// ── Answering (the named reviewer) ───────────────────────────────────────────────────────────────────────────────

/**
 * The reviewer's answer (case 76): Advance, Reject or Pending with an optional comment, on their own OPEN request of an active
 * application while they are still a hiring manager of the job. Pending keeps the request open for another answer.
 */
export async function answerScreening(s: SessionContext, requestId: unknown, input: AnswerInput): Promise<{ answerId: string; closed: boolean }> {
  const user = actorId(s);
  if (!isUuid(requestId)) throw new RecruitmentError('not_found');
  const v = validateAnswerInput(input);
  return withRecruitmentTenant(s, async (tx) => {
    const [q] = await tx.execute<{ id: string; company_id: string; job_id: string; application_id: string; reviewer_user_id: string; closed_at: string | null; state: ApplicationState }>(sql`
      select q.id, q.company_id, q.job_id, q.application_id, q.reviewer_user_id, q.closed_at, a.state
      from recruitment_screening_request q join recruitment_application a on a.id = q.application_id
      where q.id = ${requestId}::uuid and q.tenant_id = ${s.tenantId}::uuid`);
    if (!q) throw new RecruitmentError('not_found');
    if (q.reviewer_user_id !== user) throw new RecruitmentError('not_your_request');
    if (q.closed_at) throw new RecruitmentError('screening_closed');
    if (q.state !== 'active') throw new RecruitmentError('application_closed');
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into recruitment_screening_answer (tenant_id, company_id, job_id, application_id, request_id, result, comment, answered_by_user_id)
      values (${s.tenantId}::uuid, ${q.company_id}::uuid, ${q.job_id}::uuid, ${q.application_id}::uuid, ${q.id}::uuid, ${v.result}, ${v.comment}, ${user}::uuid)
      returning id`).catch((e) => asError(e, { '42501': 'not_your_request', '23514': 'screening_closed' }));
    await event(tx, s, q.application_id, 'recruitment-application.screening-answered', { companyId: q.company_id, jobId: q.job_id, requestId: q.id, answerId: row.id, result: v.result });
    return { answerId: row.id, closed: v.result !== 'pending' };
  });
}

export type ScreeningAnswerView = {
  id: string; requestId: string; result: ScreeningResult; comment: string | null; answeredAt: string; answeredBy: string | null; byViewer: boolean;
};
export type ScreeningTodoRow = {
  requestId: string; applicationId: string; jobId: string; companyId: string; jobTitle: string | null; jobNumber: string | null;
  candidateName: string | null; candidateRemoved: boolean; sentAt: string; sentBy: string | null; note: string | null;
  /** The viewer's earlier Pending answers on this request, oldest first. */
  answers: ScreeningAnswerView[];
};

/**
 * The hiring manager's "To screen" list: their OPEN requests, newest first (at most SCREENING_LIST_LIMIT), in the companies
 * given (undefined: every company), with the job, the candidate, who sent it and when, the note, and their own earlier Pending
 * answers. A request closes by itself when its application is archived or hired or the reviewer leaves the job's hiring
 * managers (5711), so no application state is filtered here. Row security returns only the viewer's own requests while they
 * are a hiring manager of the job.
 */
export async function myScreeningRequests(s: SessionContext, companyIds?: readonly string[]): Promise<ScreeningTodoRow[]> {
  if (!s.userId) return [];
  const scope = companyIds ? companyIds.filter(isUuid) : undefined;
  if (scope && !scope.length) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{
      id: string; application_id: string; job_id: string; company_id: string; title: string | null; job_number: string | null; full_name: string | null;
      removed: boolean | null; sent_at: string | Date; sent_by_user_id: string; note: string | null;
    }>(sql`
      select q.id, q.application_id, q.job_id, q.company_id, j.title, j.job_number, c.full_name, c.destroyed_at is not null as removed,
        q.sent_at, q.sent_by_user_id, q.note
      from recruitment_screening_request q
      left join recruitment_application a on a.id = q.application_id
      left join recruitment_job_opening j on j.id = q.job_id
      left join recruitment_candidate c on c.id = a.candidate_id
      where q.tenant_id = ${s.tenantId}::uuid and q.reviewer_user_id = app.current_user_id() and q.closed_at is null
        ${scope ? sql`and q.company_id = any(${uuidArray(scope)}::uuid[])` : sql``}
      order by q.sent_at desc, q.id limit ${SCREENING_LIST_LIMIT}`);
    if (!rows.length) return [];
    const answers = await tx.execute<{ id: string; request_id: string; result: ScreeningResult; comment: string | null; answered_at: string | Date }>(sql`
      select id, request_id, result, comment, answered_at from recruitment_screening_answer
      where request_id = any(${uuidArray(rows.map((r) => r.id))}::uuid[]) and answered_by_user_id = app.current_user_id() order by answered_at, id`);
    const labels = new Map<string, string>();
    for (const companyId of new Set(rows.map((r) => r.company_id))) for (const [k, v] of await userLabelsTx(tx, companyId)) labels.set(k, v.name);
    return rows.map((r) => ({
      requestId: r.id, applicationId: r.application_id, jobId: r.job_id, companyId: r.company_id, jobTitle: r.title, jobNumber: r.job_number,
      candidateName: r.removed ? null : r.full_name, candidateRemoved: r.removed === true, sentAt: iso(r.sent_at), sentBy: labels.get(r.sent_by_user_id) ?? null,
      note: r.note,
      answers: answers.filter((x) => x.request_id === r.id).map((x) => ({
        id: x.id, requestId: x.request_id, result: x.result, comment: x.comment, answeredAt: iso(x.answered_at), answeredBy: labels.get(s.userId!) ?? null, byViewer: true,
      })),
    }));
  });
}

// ── An application's Screening section ──────────────────────────────────────────────────────────────────────────

export type ScreeningRequestView = {
  id: string; reviewerUserId: string; reviewerName: string | null; reviewerIsViewer: boolean; sentBy: string | null; sentAt: string; note: string | null;
  state: RequestState; closedAt: string | null; answers: ScreeningAnswerView[];
  canWithdraw: boolean; canAnswer: boolean;
};
export type ApplicationScreening = {
  applicationId: string; jobId: string; active: boolean;
  /** The viewer operates the job (recruiter, assistant) or administers recruitment: sends, reassigns, withdraws, sees all. */
  canOperate: boolean;
  /** Operators only: the derived assignment status. */
  status: AssignmentStatus | null;
  /** Operators only, on an active application: the job's hiring managers and whether each has an open request here; null when
   *  they could not be read just now (the section renders without the send form). */
  reviewers: (ScreeningReviewerOption & { asked: boolean })[] | null;
  /** Operators only: the stage a send would move the application to (null from the last stage). */
  nextStage: { stageId: string; name: string } | null;
  /** Operators: every request. A reviewer: their own requests. */
  requests: ScreeningRequestView[];
  /** A hiring manager: the answers on this application to requests they cannot see (other reviewers'), newest first. */
  otherAnswers: ScreeningAnswerView[];
};

/**
 * The Screening section of an application (cases 75–78) for its job's operators and administrators (everything) and its
 * hiring managers (their own requests and the answers on the application). Anyone else — an interviewer, an approver — is
 * refused (forbidden), so the page shows no Screening section.
 */
export async function applicationScreening(s: SessionContext, applicationId: unknown): Promise<ApplicationScreening> {
  return withRecruitmentTenant(s, (tx) => applicationScreeningTx(tx, s, applicationId));
}
/** The section's read inside the caller's transaction (read-only works: nothing here writes). */
export async function applicationScreeningTx(tx: Tx, s: SessionContext, applicationId: unknown): Promise<ApplicationScreening> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  const [a] = await tx.execute<{ id: string; company_id: string; job_id: string; state: ApplicationState; current_stage_id: string; process_id: string }>(sql`
    select a.id, a.company_id, a.job_id, a.state, a.current_stage_id, j.process_id from recruitment_application a
    join recruitment_job_opening j on j.id = a.job_id where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
  if (!a) throw new RecruitmentError('not_found');
  const access = await jobLevelTx(tx, a.company_id, a.job_id, a.id);
  const [hm] = await tx.execute<{ ok: boolean }>(sql`select app.recruitment_has_job_role(${a.job_id}::uuid, array['hiring_manager']) as ok`);
  if (!access.operate && hm?.ok !== true) throw new RecruitmentError('forbidden');
  const [requests, answers, labels] = [
    await tx.execute<{
      id: string; reviewer_user_id: string; sent_by_user_id: string; sent_at: string | Date; note: string | null; closed_at: string | Date | null;
      closed_reason: ScreeningCloseReason | null;
    }>(sql`select id, reviewer_user_id, sent_by_user_id, sent_at, note, closed_at, closed_reason from recruitment_screening_request
      where application_id = ${a.id}::uuid order by sent_at, id`),
    await tx.execute<{ id: string; request_id: string; result: ScreeningResult; comment: string | null; answered_at: string | Date; answered_by_user_id: string }>(sql`
      select id, request_id, result, comment, answered_at, answered_by_user_id from recruitment_screening_answer
      where application_id = ${a.id}::uuid order by answered_at, id`),
    await userLabelsTx(tx, a.company_id),
  ];
  const name = (id: string) => labels.get(id)?.name ?? null;
  const answerView = (x: (typeof answers)[number]): ScreeningAnswerView => ({
    id: x.id, requestId: x.request_id, result: x.result, comment: x.comment, answeredAt: iso(x.answered_at), answeredBy: name(x.answered_by_user_id),
    byViewer: x.answered_by_user_id === s.userId,
  });
  const active = a.state === 'active';
  const visible = new Set(requests.map((r) => r.id));
  let reviewers: ApplicationScreening['reviewers'] = [];
  let nextStage: ApplicationScreening['nextStage'] = null;
  if (access.operate && active) {
    const open = new Set(requests.filter((r) => !r.closed_at).map((r) => r.reviewer_user_id));
    const ids = await reviewerChoiceTx(tx, a.job_id);
    reviewers = ids ? ids.map((id) => ({ id, name: name(id), asked: open.has(id) })) : null;
    const stages = await processStagesTx(tx, a.process_id);
    const plan = planMoveForward(stages, a.current_stage_id);
    if (plan.kind === 'moved') nextStage = { stageId: plan.to, name: stages.find((x) => x.stageId === plan.to)?.name ?? '' };
  }
  return {
    applicationId: a.id, jobId: a.job_id, active, canOperate: access.operate,
    status: access.operate ? assignmentStatus(
      requests.map((r) => ({ closedAt: r.closed_at ? iso(r.closed_at) : null })),
      // Microsecond order comes from the database (the query is ordered by answered time, then id): rank stands in for time.
      answers.map((x, i) => ({ id: x.id, result: x.result, answeredAt: String(i).padStart(8, '0') })),
    ) : null,
    reviewers, nextStage,
    requests: requests.map((r) => ({
      id: r.id, reviewerUserId: r.reviewer_user_id, reviewerName: name(r.reviewer_user_id), reviewerIsViewer: r.reviewer_user_id === s.userId,
      sentBy: name(r.sent_by_user_id), sentAt: iso(r.sent_at), note: r.note, state: requestState(r.closed_reason), closedAt: r.closed_at ? iso(r.closed_at) : null,
      answers: answers.filter((x) => x.request_id === r.id).map(answerView),
      canWithdraw: access.operate && !r.closed_at,
      canAnswer: active && !r.closed_at && r.reviewer_user_id === s.userId && hm?.ok === true,
    })),
    otherAnswers: answers.filter((x) => !visible.has(x.request_id)).map(answerView).reverse(),
  };
}
