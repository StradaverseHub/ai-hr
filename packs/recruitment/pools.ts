/**
 * Recruitment slice 13 — custom talent pools (docs/recruitment-reconstruction/specification.md "Slice 13"). Reached from
 * outside the pack ONLY through ./service.
 *
 * Who does what (5213 row security answers every part; the service checks first for a clear refusal):
 *   create, edit, share, sub-pool, delete      — recruitment administrators (every pool of their companies);
 *   see a pool                                 — administrators; the company's recruiters and assistants when the pool is
 *                                                shared with all recruiters or its top-level pool lists them (D-050);
 *   add / remove a candidate                   — in a pool the caller sees, for a candidate the caller operates
 *                                                (administrators, and recruiters and assistants of one of the candidate's
 *                                                jobs);
 *   hiring managers, interviewers, others      — no pools.
 * Pools nest two levels; a sub-pool follows its pool's sharing. Deleting a pool removes its memberships, never candidates.
 * Read paths write nothing. Audit events carry ids only.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid, type ApplicationState, type RecruitmentErrorCode } from './model';
import { POOL_LIST_LIMIT, poolLabels, poolTree, validatePoolInput, type PoolInput, type PoolNode, type PoolSharing } from './pool-model';
import { actorId, assertCompanyTx, userLabelsTx, uuidArray } from './data';

const iso = (d: Date | string) => new Date(d).toISOString();
const poolEvent = (tx: Tx, s: SessionContext, poolId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-talent-pool', aggregateId: poolId, eventType, actor: actorOf(s), payload });

const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
  }
  return undefined;
};
const NAMED: Record<string, RecruitmentErrorCode> = {
  recruitment_talent_pool_name_uq: 'name_taken',
  recruitment_talent_pool_depth: 'pool_depth',
  recruitment_talent_pool_has_subpools: 'pool_has_subpools',
  recruitment_talent_pool_fixed: 'invalid_input',
  recruitment_candidate_removed: 'candidate_removed',
};
const asError = (e: unknown): never => {
  const named = constraintOf(e);
  if (named && NAMED[named]) throw new RecruitmentError(NAMED[named]);
  const code = pgSqlState(e);
  if (code === '42501') throw new RecruitmentError('forbidden');
  if (code === '23505') throw new RecruitmentError('name_taken');
  throw e;
};

// ── Settings › Talent pools (administrators) ─────────────────────────────────────────────────────────────────

export type PoolSettingsRow = {
  id: string; parentId: string | null; name: string; description: string | null; sharing: PoolSharing; members: number;
  sharedWith: { id: string; name: string | null }[]; updatedBy: string | null; updatedAt: string;
};
export type PoolSettings = {
  companyId: string; pools: PoolNode<PoolSettingsRow>[];
  /** The people a "listed users" pool may be shared with (the company's people and recruitment administrators). */
  users: { id: string; name: string }[];
};

/** Settings › Talent pools: the company's pools as a tree, with sharing, listed users and member counts. Read-only. */
export async function poolSettings(s: SessionContext, companyId: string): Promise<PoolSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const rows = await tx.execute<{ id: string; parent_id: string | null; name: string; description: string | null; sharing: PoolSharing; members: number;
      updated_by_user_id: string; updated_at: string | Date }>(sql`
      select p.id, p.parent_id, p.name, p.description, p.sharing, p.updated_by_user_id, p.updated_at,
        (select count(*)::int from recruitment_talent_pool_member m where m.pool_id = p.id) as members
      from recruitment_talent_pool p where p.tenant_id = ${s.tenantId}::uuid and p.company_id = ${companyId}::uuid`);
    const shares = rows.length ? await tx.execute<{ pool_id: string; app_user_id: string }>(sql`
      select pool_id, app_user_id from recruitment_talent_pool_share where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`) : [];
    const labels = await userLabelsTx(tx, companyId);
    const name = (id: string) => labels.get(id)?.name ?? null;
    return {
      companyId,
      users: [...labels.values()].filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name)),
      pools: poolTree(rows.map((r) => ({
        id: r.id, parentId: r.parent_id, name: r.name, description: r.description, sharing: r.sharing, members: r.members,
        sharedWith: shares.filter((x) => x.pool_id === r.id).map((x) => ({ id: x.app_user_id, name: name(x.app_user_id) }))
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
        updatedBy: name(r.updated_by_user_id), updatedAt: iso(r.updated_at),
      }))),
    };
  });
}

/**
 * Create (with `companyId`) or edit (with `id`) a pool: name unique among its siblings (≤80), description (≤500), an
 * optional parent (a top-level pool of the company; fixed once created), sharing and the listed users (top-level pools; a
 * sub-pool follows its pool). Administrators only.
 */
export async function savePool(s: SessionContext, input: PoolInput & { id?: unknown; companyId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validatePoolInput(input);
  if (!v.ok) throw new RecruitmentError(v.code, v.fields);
  return withRecruitmentTenant(s, async (tx) => {
    let poolId: string; let companyId: string; let topLevel: boolean;
    if (input.id) {
      if (!isUuid(input.id)) throw new RecruitmentError('not_found');
      const [p] = await tx.execute<{ id: string; company_id: string; parent_id: string | null }>(sql`
        select id, company_id, parent_id from recruitment_talent_pool where id = ${input.id}::uuid and tenant_id = ${s.tenantId}::uuid`);
      if (!p) throw new RecruitmentError('not_found');
      await assertCompanyTx(tx, p.company_id);
      if ((v.value.parentId ?? null) !== (p.parent_id ?? null) && input.parentId !== undefined) throw new RecruitmentError('invalid_input', ['parentId']);
      await tx.execute(sql`update recruitment_talent_pool set name = ${v.value.name}, description = ${v.value.description},
        sharing = ${p.parent_id ? sql`sharing` : sql`${v.value.sharing}`}, updated_by_user_id = ${user}::uuid where id = ${p.id}::uuid`).catch(asError);
      poolId = p.id; companyId = p.company_id; topLevel = p.parent_id === null;
    } else {
      companyId = typeof input.companyId === 'string' ? input.companyId : '';
      await assertCompanyTx(tx, companyId);
      if (v.value.parentId) {
        const [parent] = await tx.execute<{ parent_id: string | null; company_id: string }>(sql`
          select parent_id, company_id from recruitment_talent_pool where id = ${v.value.parentId}::uuid and tenant_id = ${s.tenantId}::uuid`);
        if (!parent || parent.company_id !== companyId) throw new RecruitmentError('not_found');
        if (parent.parent_id) throw new RecruitmentError('pool_depth');
      }
      const [row] = await tx.execute<{ id: string }>(sql`insert into recruitment_talent_pool
        (tenant_id, company_id, parent_id, name, description, sharing, created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${companyId}::uuid, ${v.value.parentId}::uuid, ${v.value.name}, ${v.value.description}, ${v.value.sharing},
          ${user}::uuid, ${user}::uuid) returning id`).catch(asError);
      poolId = row.id; topLevel = v.value.parentId === null;
    }
    // Listed users: replace the set on a top-level pool (kept, unused, when it shares with all recruiters; cleared then).
    if (topLevel) {
      const wanted = v.value.sharing === 'listed_users' ? v.value.sharedUserIds : [];
      const labels = wanted.length ? await userLabelsTx(tx, companyId) : new Map();
      if (wanted.some((id) => !labels.has(id))) throw new RecruitmentError('invalid_input', ['sharedUserIds']);
      await tx.execute(sql`delete from recruitment_talent_pool_share where pool_id = ${poolId}::uuid
        ${wanted.length ? sql`and app_user_id <> all(${uuidArray(wanted)}::uuid[])` : sql``}`);
      if (wanted.length) {
        await tx.execute(sql`insert into recruitment_talent_pool_share (pool_id, app_user_id, tenant_id, company_id, created_by_user_id)
          select ${poolId}::uuid, u, ${s.tenantId}::uuid, ${companyId}::uuid, ${user}::uuid from unnest(${uuidArray(wanted)}::uuid[]) as u
          on conflict (pool_id, app_user_id) do nothing`).catch(asError);
      }
    }
    await poolEvent(tx, s, poolId, input.id ? 'recruitment-talent-pool.changed' : 'recruitment-talent-pool.created', {
      companyId, parentId: v.value.parentId, sharing: topLevel ? v.value.sharing : null, listedUsers: topLevel && v.value.sharing === 'listed_users' ? v.value.sharedUserIds.length : 0,
    });
    return { id: poolId };
  });
}

/** Delete a pool (administrators): its memberships go with it, never the candidates; a pool with sub-pools is refused. */
export async function deletePool(s: SessionContext, poolId: unknown): Promise<{ removedMembers: number }> {
  actorId(s);
  if (!isUuid(poolId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [p] = await tx.execute<{ id: string; company_id: string; members: number; children: number }>(sql`
      select p.id, p.company_id, (select count(*)::int from recruitment_talent_pool_member m where m.pool_id = p.id) as members,
        (select count(*)::int from recruitment_talent_pool c where c.parent_id = p.id) as children
      from recruitment_talent_pool p where p.id = ${poolId}::uuid and p.tenant_id = ${s.tenantId}::uuid`);
    if (!p) throw new RecruitmentError('not_found');
    await assertCompanyTx(tx, p.company_id);
    if (p.children > 0) throw new RecruitmentError('pool_has_subpools');
    await tx.execute(sql`delete from recruitment_talent_pool where id = ${p.id}::uuid`).catch(asError);
    await poolEvent(tx, s, p.id, 'recruitment-talent-pool.deleted', { companyId: p.company_id, removedMembers: p.members });
    return { removedMembers: p.members };
  });
}

// ── The talent pool page ─────────────────────────────────────────────────────────────────────────────────────

export type PoolNavRow = { id: string; parentId: string | null; name: string; companyId: string; count: number };
export type PoolNav = {
  pools: PoolNode<PoolNavRow>[];
  /** Active blocked-list entries the viewer can see (administrators: all; operators: the candidates they operate). */
  blockedCount: number;
};

/**
 * The viewer's pool list with counts, under their own row security: the pools they can see, each counting the members the
 * viewer can see; and the blocked list's count. Read-only.
 */
export async function poolNav(s: SessionContext, companyIds: readonly string[]): Promise<PoolNav> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) return { pools: [], blockedCount: 0 };
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ id: string; parent_id: string | null; name: string; company_id: string; n: number }>(sql`
      select p.id, p.parent_id, p.name, p.company_id, (select count(*)::int from recruitment_talent_pool_member m where m.pool_id = p.id) as n
      from recruitment_talent_pool p where p.tenant_id = ${s.tenantId}::uuid and p.company_id = any(${uuidArray(ids)}::uuid[])`);
    const [blocked] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_blocked_entry
      where tenant_id = ${s.tenantId}::uuid and company_id = any(${uuidArray(ids)}::uuid[]) and removed_at is null`);
    return {
      pools: poolTree(rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, companyId: r.company_id, count: r.n }))),
      blockedCount: blocked?.n ?? 0,
    };
  });
}

export type PoolMemberCard = {
  candidateId: string; candidateName: string; email: string | null; phone: string | null; companyId: string; removed: boolean;
  addedAt: string; addedBy: string | null;
  /** The candidate's latest application the viewer can read (title, number, state, stage), if any. */
  latest: { applicationId: string; jobTitle: string; jobNumber: string; state: ApplicationState; stageName: string } | null;
  /** "Pools: …" — every pool of the candidate the viewer can see. */
  pools: string[];
  /** On the blocked list (an entry the viewer can see). */
  blocked: boolean;
};
export type PoolMembers = { poolId: string; name: string; parentName: string | null; companyId: string; total: number; cards: PoolMemberCard[] };

/** One custom pool's candidates (the viewer can see the pool, and the candidates they operate), newest first. Read-only. */
export async function poolMembers(s: SessionContext, poolId: unknown): Promise<PoolMembers> {
  if (!isUuid(poolId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [p] = await tx.execute<{ id: string; name: string; parent_name: string | null; company_id: string }>(sql`
      select p.id, p.name, pp.name as parent_name, p.company_id from recruitment_talent_pool p left join recruitment_talent_pool pp on pp.id = p.parent_id
      where p.id = ${poolId}::uuid and p.tenant_id = ${s.tenantId}::uuid`);
    if (!p) throw new RecruitmentError('not_found');
    const [total] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_talent_pool_member where pool_id = ${p.id}::uuid`);
    const rows = await tx.execute<{ candidate_id: string; added_at: string | Date; added_by_user_id: string }>(sql`
      select candidate_id, added_at, added_by_user_id from recruitment_talent_pool_member where pool_id = ${p.id}::uuid
      order by added_at desc, candidate_id limit ${POOL_LIST_LIMIT}`);
    const cards = await candidateCardsTx(tx, s, rows.map((r) => r.candidate_id));
    const labels = rows.length ? await userLabelsTx(tx, p.company_id) : new Map();
    return {
      poolId: p.id, name: p.name, parentName: p.parent_name, companyId: p.company_id, total: total?.n ?? 0,
      cards: rows.flatMap((r) => {
        const c = cards.get(r.candidate_id);
        return c ? [{ ...c, addedAt: iso(r.added_at), addedBy: labels.get(r.added_by_user_id)?.name ?? null }] : [];
      }),
    };
  });
}

/** Candidate cards (name, contacts, latest readable application, pools, blocked) for the given candidates, as the viewer sees them. */
export async function candidateCardsTx(tx: Tx, s: SessionContext, candidateIds: readonly string[]): Promise<Map<string, Omit<PoolMemberCard, 'addedAt' | 'addedBy'>>> {
  if (!candidateIds.length) return new Map();
  const ids = uuidArray([...new Set(candidateIds)]);
  const people = await tx.execute<{ id: string; full_name: string; email: string | null; phone: string | null; company_id: string; removed: boolean }>(sql`
    select id, full_name, email, phone, company_id, destroyed_at is not null as removed from recruitment_candidate where id = any(${ids}::uuid[])`);
  const latest = await tx.execute<{ candidate_id: string; id: string; title: string; job_number: string; state: ApplicationState; stage_name: string }>(sql`
    select distinct on (a.candidate_id) a.candidate_id, a.id, j.title, j.job_number, a.state, st.name as stage_name
    from recruitment_application a join recruitment_job_opening j on j.id = a.job_id join recruitment_stage st on st.id = a.current_stage_id
    where a.candidate_id = any(${ids}::uuid[]) and a.tenant_id = ${s.tenantId}::uuid order by a.candidate_id, a.applied_at desc, a.id desc`);
  const pools = await tx.execute<{ candidate_id: string; name: string; parent_name: string | null }>(sql`
    select m.candidate_id, p.name, pp.name as parent_name from recruitment_talent_pool_member m
    join recruitment_talent_pool p on p.id = m.pool_id left join recruitment_talent_pool pp on pp.id = p.parent_id
    where m.candidate_id = any(${ids}::uuid[])`);
  const blocked = await tx.execute<{ candidate_id: string }>(sql`select candidate_id from recruitment_blocked_entry
    where candidate_id = any(${ids}::uuid[]) and removed_at is null`);
  const out = new Map<string, Omit<PoolMemberCard, 'addedAt' | 'addedBy'>>();
  for (const c of people) {
    const l = latest.find((x) => x.candidate_id === c.id);
    out.set(c.id, {
      candidateId: c.id, candidateName: c.full_name, email: c.email, phone: c.phone, companyId: c.company_id, removed: c.removed,
      latest: l ? { applicationId: l.id, jobTitle: l.title, jobNumber: l.job_number, state: l.state, stageName: l.stage_name } : null,
      pools: poolLabels(pools.filter((x) => x.candidate_id === c.id).map((x) => ({ name: x.name, parentName: x.parent_name }))),
      blocked: blocked.some((x) => x.candidate_id === c.id),
    });
  }
  return out;
}

// ── A candidate's pools (application page, board) ────────────────────────────────────────────────────────────

export type CandidatePools = {
  candidateId: string;
  /** The candidate's pools the viewer can see, and whether the viewer may add and remove (operators of the candidate). */
  member: { id: string; label: string }[]; addable: { id: string; label: string }[]; canEdit: boolean;
};

/** The candidate of an application: their pools and the pools they may be added to, for the viewer. Read-only. */
export async function applicationPools(s: SessionContext, applicationId: unknown): Promise<CandidatePools | null> {
  if (!isUuid(applicationId)) throw new RecruitmentError('not_found');
  return withRecruitmentTenant(s, async (tx) => {
    const [a] = await tx.execute<{ candidate_id: string; company_id: string; operate: boolean; removed: boolean }>(sql`
      select a.candidate_id, a.company_id, app.recruitment_operates_candidate(a.company_id, a.candidate_id) as operate,
        exists (select 1 from recruitment_candidate c where c.id = a.candidate_id and c.destroyed_at is not null) as removed
      from recruitment_application a where a.id = ${applicationId}::uuid and a.tenant_id = ${s.tenantId}::uuid`);
    if (!a) throw new RecruitmentError('not_found');
    // Hiring managers and interviewers have no pools (D: slice 13): nothing to show.
    if (!a.operate) return null;
    const visible = await tx.execute<{ id: string; parent_id: string | null; name: string; parent_name: string | null }>(sql`
      select p.id, p.parent_id, p.name, pp.name as parent_name from recruitment_talent_pool p left join recruitment_talent_pool pp on pp.id = p.parent_id
      where p.tenant_id = ${s.tenantId}::uuid and p.company_id = ${a.company_id}::uuid`);
    const mine = new Set((await tx.execute<{ pool_id: string }>(sql`select pool_id from recruitment_talent_pool_member
      where candidate_id = ${a.candidate_id}::uuid`)).map((r) => r.pool_id));
    const label = (r: (typeof visible)[number]) => poolLabels([{ name: r.name, parentName: r.parent_name }])[0];
    const sorted = [...visible].sort((x, y) => label(x).localeCompare(label(y), 'en', { sensitivity: 'base' }));
    return {
      candidateId: a.candidate_id, canEdit: !a.removed,
      member: sorted.filter((r) => mine.has(r.id)).map((r) => ({ id: r.id, label: label(r) })),
      addable: a.removed ? [] : sorted.filter((r) => !mine.has(r.id)).map((r) => ({ id: r.id, label: label(r) })),
    };
  });
}

/** The pools the viewer can see in these companies, flat with labels (the board's "Add to pool" choice). Read-only. */
export async function poolChoices(s: SessionContext, companyIds: readonly string[]): Promise<{ id: string; label: string; companyId: string }[]> {
  const ids = companyIds.filter(isUuid);
  if (!ids.length) return [];
  return withRecruitmentTenant(s, async (tx) => {
    const rows = await tx.execute<{ id: string; name: string; parent_name: string | null; company_id: string }>(sql`
      select p.id, p.name, pp.name as parent_name, p.company_id from recruitment_talent_pool p left join recruitment_talent_pool pp on pp.id = p.parent_id
      where p.tenant_id = ${s.tenantId}::uuid and p.company_id = any(${uuidArray(ids)}::uuid[])`);
    return rows.map((r) => ({ id: r.id, label: poolLabels([{ name: r.name, parentName: r.parent_name }])[0], companyId: r.company_id }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }));
  });
}

async function poolAndCandidateTx(tx: Tx, s: SessionContext, poolId: unknown, candidateId: unknown) {
  if (!isUuid(poolId) || !isUuid(candidateId)) throw new RecruitmentError('not_found');
  const [p] = await tx.execute<{ id: string; company_id: string }>(sql`select id, company_id from recruitment_talent_pool
    where id = ${poolId}::uuid and tenant_id = ${s.tenantId}::uuid`);
  if (!p) throw new RecruitmentError('not_found');
  const [c] = await tx.execute<{ id: string; company_id: string; operate: boolean; removed: boolean }>(sql`
    select c.id, c.company_id, app.recruitment_operates_candidate(c.company_id, c.id) as operate, c.destroyed_at is not null as removed
    from recruitment_candidate c where c.id = ${candidateId}::uuid and c.tenant_id = ${s.tenantId}::uuid`);
  if (!c || c.company_id !== p.company_id) throw new RecruitmentError('not_found');
  if (!c.operate) throw new RecruitmentError('forbidden');
  return { pool: p, candidate: c };
}

/** Add a candidate the caller operates to a pool the caller can see (already there: nothing changes). */
export async function addCandidateToPool(s: SessionContext, poolId: unknown, candidateId: unknown): Promise<{ added: boolean }> {
  const user = actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const { pool, candidate } = await poolAndCandidateTx(tx, s, poolId, candidateId);
    if (candidate.removed) throw new RecruitmentError('candidate_removed');
    const inserted = await tx.execute<{ pool_id: string }>(sql`insert into recruitment_talent_pool_member (pool_id, candidate_id, tenant_id, company_id, added_by_user_id)
      values (${pool.id}::uuid, ${candidate.id}::uuid, ${s.tenantId}::uuid, ${pool.company_id}::uuid, ${user}::uuid)
      on conflict (pool_id, candidate_id) do nothing returning pool_id`).catch(asError);
    if (inserted.length) await poolEvent(tx, s, pool.id, 'recruitment-talent-pool.candidate-added', { companyId: pool.company_id, candidateId: candidate.id });
    return { added: inserted.length > 0 };
  });
}

/** Remove a candidate from a pool (same access as adding; not there: nothing changes). */
export async function removeCandidateFromPool(s: SessionContext, poolId: unknown, candidateId: unknown): Promise<{ removed: boolean }> {
  actorId(s);
  return withRecruitmentTenant(s, async (tx) => {
    const { pool, candidate } = await poolAndCandidateTx(tx, s, poolId, candidateId);
    const gone = await tx.execute<{ pool_id: string }>(sql`delete from recruitment_talent_pool_member
      where pool_id = ${pool.id}::uuid and candidate_id = ${candidate.id}::uuid returning pool_id`).catch(asError);
    if (gone.length) await poolEvent(tx, s, pool.id, 'recruitment-talent-pool.candidate-removed', { companyId: pool.company_id, candidateId: candidate.id });
    return { removed: gone.length > 0 };
  });
}
