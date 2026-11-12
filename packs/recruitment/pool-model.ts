/**
 * Recruitment slice 13 rules — custom talent pools and the blocked list. Pure, deterministic and client-safe: no database, no
 * clock, no model.
 *
 * packs/recruitment/pools.ts and packs/recruitment/blocked-list.ts read under the viewer's own row security and hand rows to
 * these helpers; nothing here decides who may see or do what (the database does, 4413). Pools nest two levels and share with
 * all recruiters or listed users (D-050); the blocked list marks matching applications for an administrator's review (D-049).
 */
import { RecruitmentError, isUuid } from './model';
import { normEmail, normIdNumber, normMobile, normName } from './privacy-model';

export const POOL_NAME_MAX = 80;
export const POOL_DESCRIPTION_MAX = 500;
/** All recruiters: the company's recruiters and assistants of any job. Listed users: only the users named on the pool. */
export const POOL_SHARING = ['all_recruiters', 'listed_users'] as const;
export type PoolSharing = (typeof POOL_SHARING)[number];
/** At most this many users are listed on one pool. */
export const POOL_SHARE_MAX = 100;
/** The pool views show at most this many candidates (newest first); the counts are exact. */
export const POOL_LIST_LIMIT = 200;
export const BLOCKED_REASON_MAX = 500;
/** How an administrator resolves a mark: this application is someone else ("Not the same person"), or the entry goes. */
export const REVIEW_RESOLUTIONS = ['not_same_person', 'remove_from_list'] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];
export const BLOCKED_HISTORY_ACTIONS = ['added', 'removed', 'marked', 'mark_cleared'] as const;
export type BlockedHistoryAction = (typeof BLOCKED_HISTORY_ACTIONS)[number];
export const MARK_CLEARED_KINDS = ['not_same_person', 'entry_removed'] as const;
export type MarkClearedKind = (typeof MARK_CLEARED_KINDS)[number];
/** What a viewer of a marked application is told (D-049): administrators everything including the reason; the job's
 *  operators that the candidate is listed or matches the list (never why); anyone else who may read the application only
 *  "Needs an administrator's review". */
export const REVIEW_VIEWS = ['admin', 'operator', 'reader'] as const;
export type ReviewView = (typeof REVIEW_VIEWS)[number];

export type PoolInput = { name?: unknown; description?: unknown; sharing?: unknown; parentId?: unknown; sharedUserIds?: unknown };
export type ValidPool = { name: string; description: string | null; sharing: PoolSharing; parentId: string | null; sharedUserIds: string[] };

/** A pool as typed: name (1–80), description (≤500), sharing, an optional parent and the listed users (a sub-pool follows its
 *  pool's sharing, so its own sharing and list are ignored). */
export function validatePoolInput(input: PoolInput): { ok: true; value: ValidPool } | { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] } {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { ok: false, code: 'missing_fields', fields: ['name'] };
  const fields: string[] = [];
  if (name.length > POOL_NAME_MAX) fields.push('name');
  const description = input.description == null || (typeof input.description === 'string' && !input.description.trim()) ? null
    : typeof input.description === 'string' && input.description.trim().length <= POOL_DESCRIPTION_MAX ? input.description.trim() : undefined;
  if (description === undefined) fields.push('description');
  const parentId = input.parentId == null || input.parentId === '' ? null : isUuid(input.parentId) ? input.parentId : undefined;
  if (parentId === undefined) fields.push('parentId');
  const sharing = input.sharing == null || input.sharing === '' ? 'all_recruiters'
    : (POOL_SHARING as readonly unknown[]).includes(input.sharing) ? (input.sharing as PoolSharing) : undefined;
  if (sharing === undefined) fields.push('sharing');
  const listed = input.sharedUserIds == null || input.sharedUserIds === '' ? [] : Array.isArray(input.sharedUserIds) ? input.sharedUserIds : [input.sharedUserIds];
  const users = [...new Set(listed.filter((x) => x !== ''))];
  if (users.length > POOL_SHARE_MAX || !users.every(isUuid)) fields.push('sharedUserIds');
  if (fields.length) return { ok: false, code: 'invalid_input', fields };
  const sub = parentId !== null;
  return {
    ok: true,
    value: { name, description: description ?? null, parentId: parentId ?? null, sharing: sub ? 'all_recruiters' : sharing!, sharedUserIds: sub || sharing !== 'listed_users' ? [] : users as string[] },
  };
}

export type PoolRow = { id: string; parentId: string | null; name: string };
export type PoolNode<T extends PoolRow> = T & { children: T[] };
/**
 * The pool list as a two-level tree: top-level pools by name, each with its sub-pools by name. A sub-pool whose pool the
 * viewer cannot see does not happen (a sub-pool follows its pool's sharing, 4413); one would be listed at the top level.
 */
export function poolTree<T extends PoolRow>(rows: readonly T[]): PoolNode<T>[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  const ids = new Set(rows.map((r) => r.id));
  const tops = rows.filter((r) => r.parentId === null || !ids.has(r.parentId)).sort(byName);
  return tops.map((t) => ({ ...t, children: rows.filter((r) => r.parentId === t.id).sort(byName) }));
}

/** Which list the talent pool page shows: the public pool, the blocked list, or a custom pool (by id). Anything else: none. */
export type PoolKey = { kind: 'public' } | { kind: 'blocked' } | { kind: 'custom'; id: string };
export function parsePoolKey(value: unknown): PoolKey | null {
  if (value == null || value === '' || value === 'public') return { kind: 'public' };
  if (value === 'blocked') return { kind: 'blocked' };
  return isUuid(value) ? { kind: 'custom', id: value } : null;
}

/** "Pools: A, B › C" on a card — each membership as "pool" or "pool › sub-pool", in name order. */
export function poolLabels(memberships: readonly { name: string; parentName: string | null }[]): string[] {
  return memberships.map((m) => (m.parentName ? `${m.parentName} › ${m.name}` : m.name)).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/** A blocked-list reason (adding and removing): required, at most 500 characters. */
export function validateBlockedReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new RecruitmentError('reason_required');
  if (text.length > BLOCKED_REASON_MAX) throw new RecruitmentError('invalid_input', ['reason']);
  return text;
}

export function parseResolution(value: unknown): ReviewResolution {
  if ((REVIEW_RESOLUTIONS as readonly unknown[]).includes(value)) return value as ReviewResolution;
  throw new RecruitmentError('invalid_input', ['resolution']);
}

/** Identity values as the matching compares them: normalised by the slice 5 normalisers. */
export type Identity = { idNumber: string | null; name: string | null; email: string | null; mobile: string | null };
export function identityOf(values: { fullName?: string | null; email?: string | null; phone?: string | null; idNumber?: string | null }): Identity {
  return { idNumber: normIdNumber(values.idNumber), name: normName(values.fullName), email: normEmail(values.email), mobile: normMobile(values.phone) };
}
/**
 * The slice 13 match (app.recruitment_blocked_identity_match is the same rule): the same ID number; or the same name plus the
 * same e-mail or the same mobile; or the same e-mail and the same mobile. One item alone is not a match.
 */
export function blockedIdentityMatch(entry: Identity, candidate: Identity): boolean {
  if (entry.idNumber && entry.idNumber === candidate.idNumber) return true;
  const email = !!entry.email && entry.email === candidate.email;
  const mobile = !!entry.mobile && entry.mobile === candidate.mobile;
  if (email && mobile) return true;
  return !!entry.name && entry.name === candidate.name && (email || mobile);
}

/** What the viewer of an application is told about a mark, from their access to its job (the database's predicates). */
export function reviewView(access: { admin: boolean; operate: boolean; read: boolean }): ReviewView | null {
  return access.admin ? 'admin' : access.operate ? 'operator' : access.read ? 'reader' : null;
}
