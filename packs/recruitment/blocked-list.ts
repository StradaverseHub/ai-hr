/**
 * Recruitment slice 13 — the blocked list (docs/recruitment-reconstruction/specification.md "Slice 13", D-049). Reached from
 * outside the pack ONLY through ./service.
 *
 * Who does what:
 *   add and remove entries (with a reason), read reasons and history, resolve marks
 *                                       — recruitment administrators, through 5713's owner-run functions only (the app role
 *                                         has no write grant on any blocked-list table);
 *   see THAT a candidate is listed or that an application matches the list, never why
 *                                       — the job's recruiter and assistants (operators of the candidate);
 *   "Needs an administrator's review"   — anyone else who may read the application (hiring managers, interviewers): a yes/no
 *                                         from app.recruitment_application_needs_review and nothing more.
 * Matching runs in the database for every channel at commit (5713's deferred trigger) and never changes what a channel
 * answers. A marked application cannot move, get or progress an offer, or be hired (./data, ./offers and 5713's guards).
 * Audit events carry ids, counts and fixed codes — never a reason or an identity value. Read paths write nothing.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type ApplicationState, type RecruitmentErrorCode } from './model';
import {
  parseResolution, reviewView, validateBlockedReason, type BlockedHistoryAction, type MarkClearedKind, type ReviewResolution, type ReviewView,
} from './pool-model';
import { actorId, assertCompanyTx, jobLevelTx, userLabelsTx, uuidArray } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};
const NAMED: Record<string, RecruitmentErrorCode> = {
  recruitment_blocked_entry_active_uq: 'already_blocked',
  recruitment_blocked_entry_removed: 'blocked_entry_removed',
  recruitment_review_mark_cleared: 'mark_cleared',
  recruitment_blocked_reason: 'reason_required',
  recruitment_candidate_removed: 'candidate_removed',
  // The entry or mark was deleted meanwhile (the listed person's data was removed).
  recruitment_blocked_entry_gone: 'not_found',
  recruitment_review_mark_gone: 'not_found',
  recruitment_review_mark_own_entry: 'own_entry_mark',
};
const asError = (e: unknown): never => {
  const named = constraintOf(e);
  if (named && NAMED[named]) throw new RecruitmentError(NAMED[named]);
  const code = pgSqlState(e);
  if (code === '42501') throw new RecruitmentError('forbidden');
  if (code === '23505') throw new RecruitmentError('already_blocked');
  if (code === '22023') throw new RecruitmentError('invalid_input', ['resolution']);
  throw e;
};

// ── Writes (administrators) ──────────────────────────────────────────────────────────────────────────────────

/**
 * Add a candidate to the blocked list with a reason (1–500). The database stores the identity values already on the record
 * (normalised) and marks the candidate's active applications and every matching active application of another candidate.
 */
export async function blockCandidate(s: SessionContext, candidateId: unknown, reason: unknown): Promise<{ entryId: string; marked: number }> {
  actorId(s);
  if (!isUuid(candidateId)) throw new RecruitmentError('not_found');
  const text = validateBlockedReason(reason);
  return withRecruitmentTenant(s, async (tx) => {
    const [c] = await tx.execute<{ company_id: string; removed: boolean }>(sql`select company_id, destroyed_at is not null as removed
      from recruitment_candidate where id = ${candidateId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!c) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, c.company_id);
    if (c.removed) throw new RecruitmentError('candidate_removed');
    const [row] = await tx.execute<{ id: string }>(sql`select app.recruitment_block_candidate(${candidateId}::uuid, ${text}) as id`).catch(asError);
    const [marked] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_application_review_mark where entry_id = ${row.id}::uuid`);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-candidate', aggregateId: candidateId, eventType: 'recruitment-candidate.blocked',
      actor: actorOf(s), payload: { companyId: c.company_id, entryId: row.id, marked: marked?.n ?? 0 } });
    return { entryId: row.id, marked: marked?.n ?? 0 };
  });
}

/** Remove an entry with a reason (1–500): its identity values are cleared and every open mark it made is cleared. */
export async function unblockCandidate(s: SessionContext, entryId: unknown, reason: unknown): Promise<{ cleared: number }> {
  actorId(s);
  if (!isUuid(entryId)) throw new RecruitmentError('not_found');
  const text = validateBlockedReason(reason);
  return withRecruitmentTenant(s, async (tx) => {
    const [e] = await tx.execute<{ company_id: string; candidate_id: string; removed: boolean }>(sql`select company_id, candidate_id, removed_at is not null as removed
      from recruitment_blocked_entry where id = ${entryId}::uuid and tenant_id = ${s.tenantId}::uuid`);
    if (!e) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, e.company_id);
    if (e.removed) throw new RecruitmentError('blocked_entry_removed');
    const [row] = await tx.execute<{ n: number }>(sql`select app.recruitment_unblock_candidate(${entryId}::uuid, ${text}) as n`).catch(asError);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-candidate', aggregateId: e.candidate_id, eventType: 'recruitment-candidate.unblocked',
      actor: actorOf(s), payload: { companyId: e.company_id, entryId, cleared: row.n } });
    return { cleared: row.n };
  });
}

/**
 * Resolve a mark: "Not the same person" clears this mark only; "Remove from blocked list" removes the entry (a reason is
 * required) and so clears every mark it made. Audited with ids and the resolution code.
 */
export async function resolveReviewMark(s: SessionContext, markId: unknown, resolution: unknown, reason?: unknown): Promise<{ cleared: number }> {
  actorId(s);
  if (!isUuid(markId)) throw new RecruitmentError('not_found');
  const kind: ReviewResolution = parseResolution(resolution);
  const text = kind === 'remove_from_list' ? validateBlockedReason(reason) : null;
  return withRecruitmentTenant(s, async (tx) => {
    const [m] = await tx.execute<{ company_id: string; application_id: string; entry_id: string; cleared: boolean; own: boolean }>(sql`
      select m.company_id, m.application_id, m.entry_id, m.cleared_at is not null as cleared,
        exists (select 1 from recruitment_blocked_entry e where e.id = m.entry_id and e.candidate_id = m.candidate_id) as own
      from recruitment_application_review_mark m where m.id = ${markId}::uuid and m.tenant_id = ${s.tenantId}::uuid`);
    if (!m) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, m.company_id);
    if (m.cleared) throw new RecruitmentError('mark_cleared');
    // The listed person's own mark: only removing the entry resolves it (5713 refuses too).
    if (kind === 'not_same_person' && m.own) throw new RecruitmentError('own_entry_mark');
    const [row] = await tx.execute<{ n: number }>(sql`select app.recruitment_resolve_review_mark(${markId}::uuid, ${kind}, ${text}) as n`).catch(asError);
    await appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-application', aggregateId: m.application_id, eventType: 'recruitment-application.review-resolved',
      actor: actorOf(s), payload: { companyId: m.company_id, markId, entryId: m.entry_id, resolution: kind, cleared: row.n } });
    return { cleared: row.n };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReviewMarkView = {
  markId: string; markedAt: string;
  /** The mark comes from this candidate's own entry (otherwise: another listed person matched). */
  matchedSelf: boolean;
  /** Administrators only: the entry, the listed candidate and the reason. */
  entryId: string | null; blockedCandidateId: string | null; blockedCandidateName: string | null; reason: string | null;
};
export type ApplicationReview = {
  view: ReviewView; needsReview: boolean;
  /** Open marks: administrators and the job's operators (operators without entry, name or reason); empty for anyone else. */
  marks: ReviewMarkView[];
  /** The application's candidate on the blocked list: administrators and operators (the reason for administrators only). */
  candidate: { candidateId: string; entryId: string | null; reason: string | null; canBlock: boolean } | null;
};

/** What the viewer is told about the application's review state (D-049). Read-only; refused when the application is not readable. */
export async function applicationReview(s: SessionContext, applicationId: unknown): Promise<ApplicationReview> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, (tx) => applicationReviewTx(tx, s, applicationId));
}
export async function applicationReviewTx(tx: Tx, s: SessionContext, applicationId: string): Promise<ApplicationReview> {
  const [a] = await tx.execute<{ id: string; company_id: string; job_id: string; candidate_id: string; removed: boolean }>(sql`
    select a.id, a.company_id, a.job_id, a.candidate_id, exists (select 1 from recruitment_candidate c where c.id = a.candidate_id and c.destroyed_at is not null) as removed
    from recruitment_application a where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
  if (!a) throw new RecruitmentError('not_found');
  const view = reviewView(await jobLevelTx(tx, a.company_id, a.job_id, a.id));
  if (!view) throw new RecruitmentError('forbidden');
  const [r] = await tx.execute<{ marked: boolean }>(sql`select app.recruitment_application_needs_review(${a.id}::uuid) as marked`);
  const needsReview = r?.marked === true;
  if (view === 'reader') return { view, needsReview, marks: [], candidate: null };
  const admin = view === 'admin';
  const marks = await tx.execute<{ id: string; marked_at: string | Date; entry_id: string; entry_candidate: string | null }>(sql`
    select m.id, m.marked_at, m.entry_id, e.candidate_id as entry_candidate from recruitment_application_review_mark m
    left join recruitment_blocked_entry e on e.id = m.entry_id
    where m.application_id = ${a.id}::uuid and m.cleared_at is null order by m.marked_at, m.id`);
  const details = admin && marks.length ? await tx.execute<{ entry_id: string; reason: string; full_name: string; removed: boolean }>(sql`
    select x.entry_id, x.reason, c.full_name, c.destroyed_at is not null as removed from recruitment_blocked_entry_restricted x
    join recruitment_candidate c on c.id = x.candidate_id where x.entry_id = any(${uuidArray(marks.map((m) => m.entry_id))}::uuid[])`) : [];
  const [own] = await tx.execute<{ id: string }>(sql`select id from recruitment_blocked_entry where candidate_id = ${a.candidate_id}::uuid and removed_at is null`);
  const [ownReason] = admin && own ? await tx.execute<{ reason: string }>(sql`select reason from recruitment_blocked_entry_restricted where entry_id = ${own.id}::uuid`) : [];
  return {
    view, needsReview,
    marks: marks.map((m) => {
      const d = details.find((x) => x.entry_id === m.entry_id);
      return {
        markId: m.id, markedAt: iso(m.marked_at), matchedSelf: m.entry_candidate === a.candidate_id,
        entryId: admin ? m.entry_id : null, blockedCandidateId: admin ? m.entry_candidate : null,
        blockedCandidateName: admin && d && !d.removed ? d.full_name : null, reason: admin ? d?.reason ?? null : null,
      };
    }),
    candidate: { candidateId: a.candidate_id, entryId: own?.id ?? null, reason: ownReason?.reason ?? null, canBlock: admin && !own && !a.removed },
  };
}

export type BlockedEntryRow = {
  entryId: string; candidateId: string; candidateName: string; removed: boolean; companyId: string; addedAt: string; addedBy: string | null;
  /** Open marks the entry has made on applications the viewer operates. */
  openMarks: number;
  /** The candidate's latest application the viewer can read. */
  latest: { applicationId: string; jobTitle: string; jobNumber: string; state: ApplicationState } | null;
  /** Administrators only. */
  reason: string | null;
};
export type BlockedHistoryRow = {
  id: string; action: BlockedHistoryAction; detail: MarkClearedKind | null; occurredAt: string; actor: string | null; candidateName: string;
  application: { id: string; jobTitle: string; jobNumber: string } | null;
  /** The reason given with an "added" row and the removal reason with a "removed" row (administrators; not stored in history). */
  reason: string | null;
};
export type BlockedList = { entries: BlockedEntryRow[]; history: BlockedHistoryRow[] | null; isAdmin: boolean };

/**
 * The blocked list of these companies as the viewer sees it: administrators every active entry with its reason and the
 * history (newest 100); operators the entries of candidates they operate, without reasons or history. Read-only.
 */
export async function blockedList(s: SessionContext, companyIds: readonly string[]): Promise<BlockedList> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) return { entries: [], history: null, isAdmin: false };
  return withRecruitmentTenant(s, async (tx) => {
    const admins = new Set((await tx.execute<{ id: string; ok: boolean }>(sql`select x.id, app.can_admin_recruitment_for(x.id) as ok
      from unnest(${uuidArray(ids)}::uuid[]) as x(id)`)).filter((r) => r.ok).map((r) => r.id));
    const rows = await tx.execute<{ id: string; candidate_id: string; company_id: string; created_at: string | Date; created_by_user_id: string;
      full_name: string; removed: boolean; open_marks: number }>(sql`
      select e.id, e.candidate_id, e.company_id, e.created_at, e.created_by_user_id, c.full_name, c.destroyed_at is not null as removed,
        (select count(*)::int from recruitment_application_review_mark m where m.entry_id = e.id and m.cleared_at is null) as open_marks
      from recruitment_blocked_entry e join recruitment_candidate c on c.id = e.candidate_id
      where e.tenant_id = ${s.tenantId}::uuid and e.company_id = any(${uuidArray(ids)}::uuid[]) and e.removed_at is null
      order by e.created_at desc, e.id limit 500`);
    const reasons = admins.size && rows.length ? await tx.execute<{ entry_id: string; reason: string }>(sql`
      select entry_id, reason from recruitment_blocked_entry_restricted where entry_id = any(${uuidArray(rows.map((r) => r.id))}::uuid[])`) : [];
    const latest = rows.length ? await tx.execute<{ candidate_id: string; id: string; title: string; job_number: string; state: ApplicationState }>(sql`
      select distinct on (a.candidate_id) a.candidate_id, a.id, j.title, j.job_number, a.state from recruitment_application a
      join recruitment_job_opening j on j.id = a.job_id where a.candidate_id = any(${uuidArray(rows.map((r) => r.candidate_id))}::uuid[])
      order by a.candidate_id, a.applied_at desc, a.id desc`) : [];
    const labels = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.company_id))) for (const [k, v] of await userLabelsTx(tx, id)) labels.set(k, v.name);
    const history = admins.size ? await historyTx(tx, s, [...admins], labels) : null;
    return {
      isAdmin: admins.size > 0, history,
      entries: rows.map((r) => {
        const l = latest.find((x) => x.candidate_id === r.candidate_id);
        return {
          entryId: r.id, candidateId: r.candidate_id, candidateName: r.full_name, removed: r.removed, companyId: r.company_id, addedAt: iso(r.created_at),
          addedBy: labels.get(r.created_by_user_id) ?? null, openMarks: r.open_marks,
          latest: l ? { applicationId: l.id, jobTitle: l.title, jobNumber: l.job_number, state: l.state } : null,
          reason: admins.has(r.company_id) ? reasons.find((x) => x.entry_id === r.id)?.reason ?? null : null,
        };
      }),
    };
  });
}

async function historyTx(tx: Tx, s: SessionContext, companyIds: string[], labels: Map<string, string>): Promise<BlockedHistoryRow[]> {
  const rows = await tx.execute<{ id: string; action: BlockedHistoryAction; detail: MarkClearedKind | null; occurred_at: string | Date; actor_user_id: string | null;
    company_id: string; entry_id: string; full_name: string; application_id: string | null; title: string | null; job_number: string | null;
    reason: string | null; removal_reason: string | null }>(sql`
    select h.id, h.action, h.detail, h.occurred_at, h.actor_user_id, h.company_id, h.entry_id, c.full_name, h.application_id, j.title, j.job_number,
      x.reason, x.removal_reason
    from recruitment_blocked_history h join recruitment_candidate c on c.id = h.candidate_id
    left join recruitment_application a on a.id = h.application_id left join recruitment_job_opening j on j.id = a.job_id
    left join recruitment_blocked_entry_restricted x on x.entry_id = h.entry_id
    where h.tenant_id = ${s.tenantId}::uuid and h.company_id = any(${uuidArray(companyIds)}::uuid[])
    order by h.occurred_at desc, h.id limit 100`);
  const missing = new Set(rows.filter((r) => r.actor_user_id && !labels.has(r.actor_user_id)).map((r) => r.company_id));
  for (const id of missing) for (const [k, v] of await userLabelsTx(tx, id)) if (!labels.has(k)) labels.set(k, v.name);
  return rows.map((r) => ({
    id: r.id, action: r.action, detail: r.detail, occurredAt: iso(r.occurred_at), actor: r.actor_user_id ? labels.get(r.actor_user_id) ?? null : null,
    candidateName: r.full_name, application: r.application_id ? { id: r.application_id, jobTitle: r.title ?? '', jobNumber: r.job_number ?? '' } : null,
    reason: r.action === 'added' ? r.reason : r.action === 'removed' ? r.removal_reason : null,
  }));
}
