/**
 * Recruitment slice 18 — interview set-up (docs/recruitment-reconstruction/specification.md "Slice 18", D-058): interviewer groups, the
 * question bank linked to scorecard templates, and the company's interview addresses and meeting rooms. Reached from outside the pack
 * ONLY through ./service; ./interviews uses the *Tx helpers below when scheduling, adding interviewers and opening a feedback form.
 *
 * Who: recruitment administrators manage everything here (the service asks first; 5719 row security, CHECKs and guards refuse again).
 * Operators of the company's jobs read the groups when scheduling; the company's job teams read questions, addresses and rooms. A
 * group grants no access: it is a list the scheduler copies from. Nothing here calls a model or touches candidate data. Settings reads
 * are bounded (GROUPS_MAX, QUESTIONS_MAX, ADDRESSES_MAX with ROOMS_PER_ADDRESS_MAX) and set-based: a fixed number of statements per
 * read, never one per row. Reads write nothing. Events carry ids, names of set-up items and counts only.
 */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { withRecruitmentTenant } from '../../core/module-gate';
import { pgSqlState } from '../../lib/db-error';
import { RecruitmentError, isUuid } from './model';
import { actorId, assertCompanyTx, userLabelsTx, uuidArray } from './data';
import {
  ADDRESSES_MAX, FORM_QUESTIONS_MAX, GROUPS_MAX, QUESTIONS_MAX, ROOMS_PER_ADDRESS_MAX, guidanceQuestions, validateAddress, validateGroup, validateQuestion,
  validateRoom, type AddressInput, type GroupInput, type GuidanceQuestion, type QuestionInput, type RoomInput,
} from './interview-setup-model';

const iso = (d: Date | string) => new Date(d).toISOString();
const setupEvent = (tx: Tx, s: SessionContext, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendEvent(tx, { tenantId: s.tenantId, aggregateType: 'recruitment-interview-setup', aggregateId, eventType, actor: actorOf(s), payload });

const constraintOf = (e: unknown): string | undefined => {
  let cur = e as { constraint_name?: unknown; constraint?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 4; i++, cur = cur.cause as typeof cur) {
    if (typeof cur.constraint_name === 'string') return cur.constraint_name;
    if (typeof cur.constraint === 'string') return cur.constraint;
  }
  return undefined;
};

/** A database refusal of a set-up write or of an interview's place, as the service's code (never SQL or a bound value). */
export function interviewSetupError(e: unknown): never {
  if (e instanceof RecruitmentError) throw e;
  const named = constraintOf(e) ?? '';
  const code = pgSqlState(e);
  if (code === '23P01' && named === 'recruitment_interview_room_no_overlap') throw new RecruitmentError('room_booked', ['roomId']);
  if (named === 'recruitment_interview_room_enabled' || named === 'recruitment_interview_place_ck') throw new RecruitmentError('room_unavailable', ['roomId']);
  // The application closed while interviewers were being added (5719's interviewer guard).
  if (named === 'recruitment_interview_interviewer_application_active') throw new RecruitmentError('application_closed');
  if (code === '23505' && /_name_uq$/.test(named)) throw new RecruitmentError('name_taken', ['name']);
  if (named === 'recruitment_interviewer_group_member_access') throw new RecruitmentError('invalid_input', ['memberIds']);
  if (named === 'recruitment_interview_question_link_retired') throw new RecruitmentError('question_retired');
  if (named === 'recruitment_interview_address_map_https_ck') throw new RecruitmentError('map_link_https', ['mapUrl']);
  if (code === '23503') {
    if (named === 'recruitment_interview_question_link_question_fk') throw new RecruitmentError('question_in_use');
    // A member added to a group deleted meanwhile; a room added to an address deleted meanwhile (deleting an address maps its own
    // key refusal to address_in_use, deleteInterviewAddress).
    if (named === 'recruitment_interviewer_group_member_group_fk') throw new RecruitmentError('group_unavailable');
    if (named === 'recruitment_interview_room_address_fk') throw new RecruitmentError('not_found');
    if (named === 'recruitment_interview_address_fk') throw new RecruitmentError('address_in_use');
    if (named === 'recruitment_interview_room_fk') throw new RecruitmentError('room_in_use');
  }
  if (code === '42501') throw new RecruitmentError('forbidden');
  if (code === '23514' && named.startsWith('recruitment_interview')) throw new RecruitmentError('invalid_input');
  throw e;
}
/** As interviewSetupError, for scheduling and adding a place to an interview: a key the interview cannot point at is the place
 *  being unavailable (in the settings, the same key refusing a delete means the address or room is in use). */
export function interviewPlaceError(e: unknown): never {
  const named = constraintOf(e) ?? '';
  if (pgSqlState(e) === '23503' && (named === 'recruitment_interview_address_fk' || named === 'recruitment_interview_room_fk')) {
    throw new RecruitmentError('room_unavailable', [named === 'recruitment_interview_room_fk' ? 'roomId' : 'addressId']);
  }
  return interviewSetupError(e);
}

/** The company's set-up writer lock (transaction-scoped advisory lock; reads never take it): limits and replace-the-set writes. */
const setupLockTx = (tx: Tx, s: SessionContext, companyId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recruitment-interview-setup:${s.tenantId}:${companyId}`}, 0))`);

const refuse = (v: { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] }): never => {
  if (v.code === 'invalid_input' && v.fields.length === 1 && v.fields[0] === 'mapUrl') throw new RecruitmentError('map_link_https', ['mapUrl']);
  throw new RecruitmentError(v.code, v.fields);
};

/** The row's company, for a write by id: `not_found` unless the caller may see it (row security), `forbidden` unless they administer. */
async function ownerCompanyTx(tx: Tx, s: SessionContext, table: 'recruitment_interviewer_group' | 'recruitment_interview_question' | 'recruitment_interview_address' | 'recruitment_interview_room', id: unknown): Promise<string> {
  if (!isUuid(id)) throw new RecruitmentError('not_found');
  const [row] = await tx.execute<{ company_id: string }>(sql`select company_id from ${sql.identifier(table)} where id = ${id}::uuid and tenant_id = ${s.tenantId}::uuid`);
  if (!row) throw new RecruitmentError('not_found');
  await assertCompanyTx(tx, row.company_id);
  return row.company_id;
}

// ── Interviewer groups ───────────────────────────────────────────────────────────────────────────────────────

export type GroupMemberView = { userId: string; name: string | null; hasAccess: boolean };
export type InterviewerGroupRow = { id: string; name: string; updatedAt: string; members: GroupMemberView[] };
export type InterviewerGroupSettings = { companyId: string; groups: InterviewerGroupRow[]; people: { id: string; name: string }[] };

/** Settings › Interviewer groups for one company. Administrators only. Read-only. */
export async function interviewerGroupSettings(s: SessionContext, companyId: string): Promise<InterviewerGroupSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const groups = await tx.execute<{ id: string; name: string; updated_at: string | Date }>(sql`
      select id, name, updated_at from recruitment_interviewer_group where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid
      order by lower(name), id limit ${GROUPS_MAX}`);
    const members = groups.length ? await tx.execute<{ group_id: string; app_user_id: string }>(sql`
      select group_id, app_user_id from recruitment_interviewer_group_member where group_id = any(${uuidArray(groups.map((g) => g.id))}::uuid[])
      order by created_at, id`) : [];
    const labels = await userLabelsTx(tx, companyId);
    return {
      companyId,
      groups: groups.map((g) => ({
        id: g.id, name: g.name, updatedAt: iso(g.updated_at),
        members: members.filter((m) => m.group_id === g.id).map((m) => ({ userId: m.app_user_id, name: labels.get(m.app_user_id)?.name ?? null, hasAccess: labels.get(m.app_user_id)?.active === true })),
      })),
      people: [...labels.values()].filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * Create (no id) or edit a group: its name and its member list, replaced as a set. A NEW member must be an active person of the
 * company (the people the team pickers offer; 5719's guard asks the database's own rule again); a member kept from before stays
 * even if they lost access since (they are skipped when the group is added to an interview). Interviews already scheduled are not
 * changed. Administrators only.
 */
export async function saveInterviewerGroup(s: SessionContext, input: GroupInput & { id?: unknown; companyId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateGroup(input);
  if (!v.ok) refuse(v);
  const { name, memberIds } = (v as Extract<typeof v, { ok: true }>).value;
  return withRecruitmentTenant(s, async (tx) => {
    const editing = input.id != null && input.id !== '';
    const companyId = editing ? await ownerCompanyTx(tx, s, 'recruitment_interviewer_group', input.id) : isUuid(input.companyId) ? input.companyId : null;
    if (!companyId) throw new RecruitmentError('forbidden');
    await assertCompanyTx(tx, companyId);
    await setupLockTx(tx, s, companyId);
    let id: string;
    let existing: string[] = [];
    if (editing) {
      id = input.id as string;
      existing = (await tx.execute<{ app_user_id: string }>(sql`select app_user_id from recruitment_interviewer_group_member where group_id = ${id}::uuid`)).map((r) => r.app_user_id);
      await tx.execute(sql`update recruitment_interviewer_group set name = ${name}, updated_by_user_id = ${user}::uuid where id = ${id}::uuid`).catch(interviewSetupError);
    } else {
      const [count] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_interviewer_group where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`);
      if ((count?.n ?? 0) >= GROUPS_MAX) throw new RecruitmentError('setup_limit');
      [{ id }] = await tx.execute<{ id: string }>(sql`insert into recruitment_interviewer_group (tenant_id, company_id, name, created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${companyId}::uuid, ${name}, ${user}::uuid, ${user}::uuid) returning id`).catch(interviewSetupError);
    }
    const added = memberIds.filter((m) => !existing.includes(m));
    if (added.length) {
      const labels = await userLabelsTx(tx, companyId);
      if (!added.every((m) => labels.get(m)?.active)) throw new RecruitmentError('invalid_input', ['memberIds']);
      await tx.execute(sql`insert into recruitment_interviewer_group_member (tenant_id, company_id, group_id, app_user_id, created_by_user_id)
        select ${s.tenantId}::uuid, ${companyId}::uuid, ${id}::uuid, u, ${user}::uuid from unnest(${uuidArray(added)}::uuid[]) as u`).catch(interviewSetupError);
    }
    const removed = existing.filter((m) => !memberIds.includes(m));
    if (removed.length) await tx.execute(sql`delete from recruitment_interviewer_group_member where group_id = ${id}::uuid and app_user_id = any(${uuidArray(removed)}::uuid[])`);
    await setupEvent(tx, s, id, editing ? 'recruitment-interviewer-group.updated' : 'recruitment-interviewer-group.created',
      { companyId, members: memberIds.length, added: added.length, removed: removed.length });
    return { id };
  });
}

/** Delete a group (its member list goes with it). Interviews keep their interviewers. Administrators only. */
export async function deleteInterviewerGroup(s: SessionContext, groupId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const companyId = await ownerCompanyTx(tx, s, 'recruitment_interviewer_group', groupId);
    await setupLockTx(tx, s, companyId);
    await tx.execute(sql`delete from recruitment_interviewer_group where id = ${groupId as string}::uuid`).catch(interviewSetupError);
    await setupEvent(tx, s, groupId as string, 'recruitment-interviewer-group.deleted', { companyId });
  });
}

export type SchedulingGroup = { id: string; name: string; members: number };
export type SchedulingAddress = { id: string; name: string; region: string; rooms: { id: string; name: string; capacity: number }[] };
/** What the scheduling forms offer: the company's groups (with member counts) and addresses with their ENABLED rooms. Read-only. */
export async function schedulingSetupTx(tx: Tx, companyId: string): Promise<{ groups: SchedulingGroup[]; addresses: SchedulingAddress[] }> {
  const groups = await tx.execute<{ id: string; name: string; members: number }>(sql`
    select g.id, g.name, (select count(*)::int from recruitment_interviewer_group_member m where m.group_id = g.id) as members
    from recruitment_interviewer_group g where g.company_id = ${companyId}::uuid order by lower(g.name), g.id limit ${GROUPS_MAX}`);
  const addresses = await tx.execute<{ id: string; name: string; region: string }>(sql`
    select id, name, region from recruitment_interview_address where company_id = ${companyId}::uuid order by lower(name), id limit ${ADDRESSES_MAX}`);
  const rooms = addresses.length ? await tx.execute<{ id: string; address_id: string; name: string; capacity: number }>(sql`
    select id, address_id, name, capacity from recruitment_interview_room where address_id = any(${uuidArray(addresses.map((a) => a.id))}::uuid[]) and enabled
    order by lower(name), id`) : [];
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name, members: g.members })),
    addresses: addresses.map((a) => ({ id: a.id, name: a.name, region: a.region, rooms: rooms.filter((r) => r.address_id === a.id).map((r) => ({ id: r.id, name: r.name, capacity: r.capacity })) })),
  };
}

/** The member lists of `groupIds`, which must all be groups of `companyId` the caller may read (`group_unavailable` otherwise). */
export async function groupMembersTx(tx: Tx, companyId: string, groupIds: readonly string[]): Promise<{ id: string; memberIds: string[] }[]> {
  if (!groupIds.length) return [];
  const ids = uuidArray([...new Set(groupIds)]);
  const groups = await tx.execute<{ id: string }>(sql`select id from recruitment_interviewer_group where id = any(${ids}::uuid[]) and company_id = ${companyId}::uuid`);
  if (groups.length !== new Set(groupIds).size) throw new RecruitmentError('group_unavailable', ['groupIds']);
  const members = await tx.execute<{ group_id: string; app_user_id: string }>(sql`
    select group_id, app_user_id from recruitment_interviewer_group_member where group_id = any(${ids}::uuid[]) order by created_at, id`);
  return groupIds.map((g) => ({ id: g, memberIds: members.filter((m) => m.group_id === g).map((m) => m.app_user_id) }));
}

/** A room of `companyId`: its address and whether it is enabled (null when there is none the caller may read). */
export async function roomOfCompanyTx(tx: Tx, companyId: string, roomId: string): Promise<{ addressId: string; enabled: boolean } | null> {
  const [row] = await tx.execute<{ address_id: string; enabled: boolean }>(sql`
    select address_id, enabled from recruitment_interview_room where id = ${roomId}::uuid and company_id = ${companyId}::uuid`);
  return row ? { addressId: row.address_id, enabled: row.enabled } : null;
}
/** Whether `addressId` is an address of `companyId` the caller may read. */
export async function addressOfCompanyTx(tx: Tx, companyId: string, addressId: string): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean }>(sql`select true as ok from recruitment_interview_address where id = ${addressId}::uuid and company_id = ${companyId}::uuid`);
  return !!row;
}

// ── Question bank ────────────────────────────────────────────────────────────────────────────────────────────

export type QuestionRow = GuidanceQuestion & { retiredAt: string | null; updatedAt: string; forms: { id: string; name: string }[] };
export type QuestionBankSettings = {
  companyId: string; questions: QuestionRow[];
  /** The company's scorecard templates (evaluation forms) with how many active questions each shows. */
  forms: { id: string; name: string; enabled: boolean; isDefault: boolean; questions: number }[];
};

/** Settings › Question bank for one company. Administrators only. Read-only. */
export async function questionBankSettings(s: SessionContext, companyId: string): Promise<QuestionBankSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const questions = await tx.execute<{ id: string; title: string; guidance: string | null; category: string | null; retired_at: string | Date | null; updated_at: string | Date }>(sql`
      select id, title, guidance, category, retired_at, updated_at from recruitment_interview_question
      where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid
      order by retired_at is not null, lower(coalesce(category, '')) = '', lower(coalesce(category, '')), lower(title), id limit ${QUESTIONS_MAX}`);
    const forms = await tx.execute<{ id: string; name: string; enabled: boolean; is_default: boolean }>(sql`
      select id, name, enabled, is_default from recruitment_evaluation_form where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid
      order by is_default desc, lower(name), id`);
    const links = await tx.execute<{ question_id: string; evaluation_form_id: string }>(sql`
      select question_id, evaluation_form_id from recruitment_interview_question_link where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`);
    const formName = new Map(forms.map((f) => [f.id, f.name]));
    const retired = new Set(questions.filter((q) => q.retired_at).map((q) => q.id));
    return {
      companyId,
      questions: questions.map((q) => ({
        id: q.id, title: q.title, guidance: q.guidance, category: q.category, retired: !!q.retired_at, retiredAt: q.retired_at ? iso(q.retired_at) : null,
        updatedAt: iso(q.updated_at),
        forms: links.filter((l) => l.question_id === q.id).map((l) => ({ id: l.evaluation_form_id, name: formName.get(l.evaluation_form_id) ?? '' })),
      })),
      forms: forms.map((f) => ({
        id: f.id, name: f.name, enabled: f.enabled, isDefault: f.is_default,
        questions: links.filter((l) => l.evaluation_form_id === f.id && !retired.has(l.question_id)).length,
      })),
    };
  });
}

/**
 * Create (no id) or edit a question and the scorecard templates it is linked to (replaced as a set). The templates must be the
 * company's; a template shows at most FORM_QUESTIONS_MAX questions; a retired question gains no link (`question_retired`; it may
 * keep its links). Administrators only.
 */
export async function saveInterviewQuestion(s: SessionContext, input: QuestionInput & { id?: unknown; companyId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateQuestion(input);
  if (!v.ok) refuse(v);
  const { title, guidance, category, formIds } = (v as Extract<typeof v, { ok: true }>).value;
  return withRecruitmentTenant(s, async (tx) => {
    const editing = input.id != null && input.id !== '';
    const companyId = editing ? await ownerCompanyTx(tx, s, 'recruitment_interview_question', input.id) : isUuid(input.companyId) ? input.companyId : null;
    if (!companyId) throw new RecruitmentError('forbidden');
    await assertCompanyTx(tx, companyId);
    await setupLockTx(tx, s, companyId);
    if (formIds.length) {
      const [found] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_evaluation_form
        where id = any(${uuidArray(formIds)}::uuid[]) and tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`);
      if ((found?.n ?? 0) !== formIds.length) throw new RecruitmentError('invalid_input', ['formIds']);
    }
    let id: string;
    let existing: string[] = [];
    if (editing) {
      id = input.id as string;
      const [q] = await tx.execute<{ retired: boolean }>(sql`select retired_at is not null as retired from recruitment_interview_question where id = ${id}::uuid`);
      existing = (await tx.execute<{ evaluation_form_id: string }>(sql`select evaluation_form_id from recruitment_interview_question_link where question_id = ${id}::uuid`))
        .map((r) => r.evaluation_form_id);
      if (q?.retired && formIds.some((f) => !existing.includes(f))) throw new RecruitmentError('question_retired', ['formIds']);
      await tx.execute(sql`update recruitment_interview_question set title = ${title}, guidance = ${guidance}, category = ${category}, updated_by_user_id = ${user}::uuid
        where id = ${id}::uuid`).catch(interviewSetupError);
    } else {
      const [count] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_interview_question where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`);
      if ((count?.n ?? 0) >= QUESTIONS_MAX) throw new RecruitmentError('setup_limit');
      [{ id }] = await tx.execute<{ id: string }>(sql`insert into recruitment_interview_question (tenant_id, company_id, title, guidance, category, created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${companyId}::uuid, ${title}, ${guidance}, ${category}, ${user}::uuid, ${user}::uuid) returning id`).catch(interviewSetupError);
    }
    const added = formIds.filter((f) => !existing.includes(f));
    if (added.length) {
      const full = await tx.execute<{ evaluation_form_id: string }>(sql`select evaluation_form_id from recruitment_interview_question_link
        where evaluation_form_id = any(${uuidArray(added)}::uuid[]) group by evaluation_form_id having count(*) >= ${FORM_QUESTIONS_MAX}`);
      if (full.length) throw new RecruitmentError('setup_limit', ['formIds']);
      await tx.execute(sql`insert into recruitment_interview_question_link (tenant_id, company_id, question_id, evaluation_form_id, created_by_user_id)
        select ${s.tenantId}::uuid, ${companyId}::uuid, ${id}::uuid, f, ${user}::uuid from unnest(${uuidArray(added)}::uuid[]) as f`).catch(interviewSetupError);
    }
    const removed = existing.filter((f) => !formIds.includes(f));
    if (removed.length) await tx.execute(sql`delete from recruitment_interview_question_link where question_id = ${id}::uuid and evaluation_form_id = any(${uuidArray(removed)}::uuid[])`);
    await setupEvent(tx, s, id, editing ? 'recruitment-interview-question.updated' : 'recruitment-interview-question.created',
      { companyId, templates: formIds.length, linked: added.length, unlinked: removed.length });
    return { id };
  });
}

/** Retire a question (hidden from every feedback form opened afterwards; it keeps its links) or bring it back. Administrators only. */
export async function setInterviewQuestionRetired(s: SessionContext, input: { id?: unknown; retired?: unknown }): Promise<void> {
  const user = actorId(s);
  const retired = input.retired === true || input.retired === 'true' || input.retired === 'on';
  await withRecruitmentTenant(s, async (tx) => {
    const companyId = await ownerCompanyTx(tx, s, 'recruitment_interview_question', input.id);
    // The same lock as saveInterviewQuestion, so a retirement and a new link cannot interleave (a link is checked against retirement).
    await setupLockTx(tx, s, companyId);
    await tx.execute(retired
      ? sql`update recruitment_interview_question set retired_at = now(), retired_by_user_id = ${user}::uuid, updated_by_user_id = ${user}::uuid where id = ${input.id as string}::uuid and retired_at is null`
      : sql`update recruitment_interview_question set retired_at = null, retired_by_user_id = null, updated_by_user_id = ${user}::uuid where id = ${input.id as string}::uuid and retired_at is not null`)
      .catch(interviewSetupError);
    await setupEvent(tx, s, input.id as string, retired ? 'recruitment-interview-question.retired' : 'recruitment-interview-question.restored', { companyId });
  });
}

/** Delete a question that no scorecard template links (`question_in_use` otherwise: unlink or retire it). Administrators only. */
export async function deleteInterviewQuestion(s: SessionContext, questionId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const companyId = await ownerCompanyTx(tx, s, 'recruitment_interview_question', questionId);
    const [linked] = await tx.execute<{ yes: boolean }>(sql`select exists (select 1 from recruitment_interview_question_link where question_id = ${questionId as string}::uuid) as yes`);
    if (linked?.yes) throw new RecruitmentError('question_in_use');
    await tx.execute(sql`delete from recruitment_interview_question where id = ${questionId as string}::uuid`).catch(interviewSetupError);
    await setupEvent(tx, s, questionId as string, 'recruitment-interview-question.deleted', { companyId });
  });
}

/**
 * The guidance questions a feedback form shows for scorecard template `formId`: its linked questions that are not retired, read
 * when the form is rendered (so a retirement hides the question from every form opened afterwards). Never answered, never scored.
 */
export async function formQuestionsTx(tx: Tx, formId: string): Promise<GuidanceQuestion[]> {
  const rows = await tx.execute<{ id: string; title: string; guidance: string | null; category: string | null; retired: boolean }>(sql`
    select q.id, q.title, q.guidance, q.category, q.retired_at is not null as retired
    from recruitment_interview_question_link l join recruitment_interview_question q on q.id = l.question_id
    where l.evaluation_form_id = ${formId}::uuid and q.retired_at is null
    order by lower(q.title), q.id limit ${FORM_QUESTIONS_MAX}`);
  return guidanceQuestions(rows.map((r) => ({ id: r.id, title: r.title, guidance: r.guidance, category: r.category, retired: r.retired })));
}

// ── Addresses and rooms ──────────────────────────────────────────────────────────────────────────────────────

export type RoomRow = { id: string; name: string; capacity: number; enabled: boolean; inUse: boolean };
export type AddressRow = { id: string; name: string; address: string; region: string; mapUrl: string | null; inUse: boolean; updatedAt: string; rooms: RoomRow[] };
export type InterviewPlaceSettings = { companyId: string; addresses: AddressRow[] };

/** Settings › Addresses and rooms for one company. Administrators only. Read-only. */
export async function interviewPlaceSettings(s: SessionContext, companyId: string): Promise<InterviewPlaceSettings> {
  return withRecruitmentTenant(s, async (tx) => {
    await assertCompanyTx(tx, companyId);
    const addresses = await tx.execute<{ id: string; name: string; address: string; region: string; map_url: string | null; in_use: boolean; updated_at: string | Date }>(sql`
      select a.id, a.name, a.address, a.region, a.map_url, a.updated_at,
        exists (select 1 from recruitment_interview i where i.address_id = a.id) as in_use
      from recruitment_interview_address a where a.tenant_id = ${s.tenantId}::uuid and a.company_id = ${companyId}::uuid
      order by lower(a.name), a.id limit ${ADDRESSES_MAX}`);
    const rooms = addresses.length ? await tx.execute<{ id: string; address_id: string; name: string; capacity: number; enabled: boolean; in_use: boolean }>(sql`
      select r.id, r.address_id, r.name, r.capacity, r.enabled, exists (select 1 from recruitment_interview i where i.room_id = r.id) as in_use
      from recruitment_interview_room r where r.address_id = any(${uuidArray(addresses.map((a) => a.id))}::uuid[]) order by lower(r.name), r.id`) : [];
    return {
      companyId,
      addresses: addresses.map((a) => ({
        id: a.id, name: a.name, address: a.address, region: a.region, mapUrl: a.map_url, inUse: a.in_use, updatedAt: iso(a.updated_at),
        rooms: rooms.filter((r) => r.address_id === a.id).map((r) => ({ id: r.id, name: r.name, capacity: r.capacity, enabled: r.enabled, inUse: r.in_use })),
      })),
    };
  });
}

/** Create (no id) or edit an interview address. The map link, when given, must be https. Administrators only. */
export async function saveInterviewAddress(s: SessionContext, input: AddressInput & { id?: unknown; companyId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateAddress(input);
  if (!v.ok) refuse(v);
  const { name, address, region, mapUrl } = (v as Extract<typeof v, { ok: true }>).value;
  return withRecruitmentTenant(s, async (tx) => {
    const editing = input.id != null && input.id !== '';
    const companyId = editing ? await ownerCompanyTx(tx, s, 'recruitment_interview_address', input.id) : isUuid(input.companyId) ? input.companyId : null;
    if (!companyId) throw new RecruitmentError('forbidden');
    await assertCompanyTx(tx, companyId);
    await setupLockTx(tx, s, companyId);
    let id: string;
    if (editing) {
      id = input.id as string;
      await tx.execute(sql`update recruitment_interview_address set name = ${name}, address = ${address}, region = ${region}, map_url = ${mapUrl},
        updated_by_user_id = ${user}::uuid where id = ${id}::uuid`).catch(interviewSetupError);
    } else {
      const [count] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_interview_address where tenant_id = ${s.tenantId}::uuid and company_id = ${companyId}::uuid`);
      if ((count?.n ?? 0) >= ADDRESSES_MAX) throw new RecruitmentError('setup_limit');
      [{ id }] = await tx.execute<{ id: string }>(sql`insert into recruitment_interview_address (tenant_id, company_id, name, address, region, map_url, created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${companyId}::uuid, ${name}, ${address}, ${region}, ${mapUrl}, ${user}::uuid, ${user}::uuid) returning id`).catch(interviewSetupError);
    }
    await setupEvent(tx, s, id, editing ? 'recruitment-interview-address.updated' : 'recruitment-interview-address.created', { companyId, name, mapLink: mapUrl !== null });
    return { id };
  });
}

/** Delete an address no interview names (`address_in_use` otherwise); its unused rooms go with it. Administrators only. */
export async function deleteInterviewAddress(s: SessionContext, addressId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const companyId = await ownerCompanyTx(tx, s, 'recruitment_interview_address', addressId);
    await setupLockTx(tx, s, companyId);
    const [used] = await tx.execute<{ yes: boolean }>(sql`select exists (select 1 from recruitment_interview where address_id = ${addressId as string}::uuid) as yes`);
    if (used?.yes) throw new RecruitmentError('address_in_use');
    const inUse = (e: unknown) => {
      if (pgSqlState(e) === '23503') throw new RecruitmentError('address_in_use');
      return interviewSetupError(e);
    };
    await tx.execute(sql`delete from recruitment_interview_room where address_id = ${addressId as string}::uuid`).catch(inUse);
    await tx.execute(sql`delete from recruitment_interview_address where id = ${addressId as string}::uuid`).catch(inUse);
    await setupEvent(tx, s, addressId as string, 'recruitment-interview-address.deleted', { companyId });
  });
}

/** Create (no id; needs `addressId`) or edit a meeting room: name, capacity, enabled. Administrators only. */
export async function saveInterviewRoom(s: SessionContext, input: RoomInput & { id?: unknown; addressId?: unknown }): Promise<{ id: string }> {
  const user = actorId(s);
  const v = validateRoom(input);
  if (!v.ok) refuse(v);
  const { name, capacity, enabled } = (v as Extract<typeof v, { ok: true }>).value;
  return withRecruitmentTenant(s, async (tx) => {
    let id: string;
    let companyId: string;
    if (input.id != null && input.id !== '') {
      companyId = await ownerCompanyTx(tx, s, 'recruitment_interview_room', input.id);
      id = input.id as string;
      await tx.execute(sql`update recruitment_interview_room set name = ${name}, capacity = ${capacity}, enabled = ${enabled}, updated_by_user_id = ${user}::uuid
        where id = ${id}::uuid`).catch(interviewSetupError);
      await setupEvent(tx, s, id, 'recruitment-interview-room.updated', { companyId, capacity, enabled });
    } else {
      companyId = await ownerCompanyTx(tx, s, 'recruitment_interview_address', input.addressId);
      await setupLockTx(tx, s, companyId);
      const [count] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from recruitment_interview_room where address_id = ${input.addressId as string}::uuid`);
      if ((count?.n ?? 0) >= ROOMS_PER_ADDRESS_MAX) throw new RecruitmentError('setup_limit');
      [{ id }] = await tx.execute<{ id: string }>(sql`insert into recruitment_interview_room (tenant_id, company_id, address_id, name, capacity, enabled, created_by_user_id, updated_by_user_id)
        values (${s.tenantId}::uuid, ${companyId}::uuid, ${input.addressId as string}::uuid, ${name}, ${capacity}, ${enabled}, ${user}::uuid, ${user}::uuid) returning id`)
        .catch(interviewSetupError);
      await setupEvent(tx, s, id, 'recruitment-interview-room.created', { companyId, addressId: input.addressId, capacity, enabled });
    }
    return { id };
  });
}

/** Delete a room no interview names (`room_in_use` otherwise: disable it instead). Administrators only. */
export async function deleteInterviewRoom(s: SessionContext, roomId: unknown): Promise<void> {
  await withRecruitmentTenant(s, async (tx) => {
    const companyId = await ownerCompanyTx(tx, s, 'recruitment_interview_room', roomId);
    const [used] = await tx.execute<{ yes: boolean }>(sql`select exists (select 1 from recruitment_interview where room_id = ${roomId as string}::uuid) as yes`);
    if (used?.yes) throw new RecruitmentError('room_in_use');
    await tx.execute(sql`delete from recruitment_interview_room where id = ${roomId as string}::uuid`).catch(interviewSetupError);
    await setupEvent(tx, s, roomId as string, 'recruitment-interview-room.deleted', { companyId });
  });
}
