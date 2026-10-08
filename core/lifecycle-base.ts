/**
 * Lifecycle shared plumbing (ADR-0095): the module-gated tenant wrapper, authorization level checks,
 * display numbering, and the history-plus-audit write that every state change goes through.
 *
 * Authorization has two layers and both are real. RLS (migration 0516, `app.lc_level`) is the company wall
 * and holds for any path that reaches the table. The service applies the finer rules (undo, cancel,
 * approve, fulfil) with the SAME level function, so the two cannot disagree about who is staff.
 *
 *     level 0 none · 1 agent · 2 manager · 3 admin (hr_admin / super_admin, company-scoped)
 */
import { sql, eq } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { lcHistory, person } from '../db/schema';
import { withLifecycleTenant } from './module-gate';

export const withTenant = withLifecycleTenant;

export class LifecycleError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'forbidden' | 'not_found' | 'conflict' = 'invalid') {
    super(message);
    this.name = 'LifecycleError';
  }
}

export const LEVEL = { none: 0, agent: 1, manager: 2, admin: 3 } as const;

/** The caller's level for a company (null = the best level they hold anywhere). */
export async function levelOf(tx: Tx, companyId: string | null): Promise<number> {
  const rows = (await tx.execute(sql`select app.lc_level(${companyId}::uuid) as l`)) as unknown as { l: number }[];
  return Number(rows[0]?.l ?? 0);
}

export async function requireLevel(tx: Tx, companyId: string | null, min: number, what: string): Promise<number> {
  const l = await levelOf(tx, companyId);
  if (l < min) throw new LifecycleError(`Not permitted: ${what}.`, 'forbidden');
  return l;
}

/** Next display number for a prefix: `ONB-0001`. SECURITY DEFINER counter, safe for a plain requester. */
export async function nextNumber(tx: Tx, prefix: string, width = 4): Promise<string> {
  const rows = (await tx.execute(sql`select app.lc_next_number(${prefix}) as n`)) as unknown as { n: number }[];
  return `${prefix}-${String(rows[0]!.n).padStart(width, '0')}`;
}

/** The next per-prefix running number as a bare integer (asset codes: `CHGP-LAP-0001`). */
export async function nextSeq(tx: Tx, counterPrefix: string): Promise<number> {
  const rows = (await tx.execute(sql`select app.lc_next_number(${counterPrefix}) as n`)) as unknown as { n: number }[];
  return Number(rows[0]!.n);
}

export async function actorName(tx: Tx, ctx: SessionContext): Promise<string> {
  if (!ctx.personId) return ctx.userId ? 'User' : 'System';
  const [p] = await tx.select({ n: person.fullName }).from(person).where(eq(person.id, ctx.personId)).limit(1);
  return p?.n ?? 'User';
}

export type HistoryRef = 'case' | 'requisition' | 'asset' | 'asset_request';

/**
 * Record a state change: the readable timeline row AND the immutable domain event, in the caller's
 * transaction, so there is no change without a record and no record without its change. `detail` is
 * stored on the timeline only; the event carries references and field NAMES, never values (ADR-0030).
 */
export async function recordChange(
  tx: Tx,
  ctx: SessionContext,
  e: {
    refType: HistoryRef;
    refId: string;
    action: string;
    detail?: Record<string, unknown>;
    eventType: string;
    subjectEmploymentId?: string | null;
    eventRef?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  const name = await actorName(tx, ctx);
  await tx.insert(lcHistory).values({
    tenantId: ctx.tenantId,
    refType: e.refType,
    refId: e.refId,
    action: e.action,
    detail: e.detail ?? {},
    actorUserId: ctx.userId ?? null,
    actorName: name,
  });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: `lifecycle-${e.refType.replace('_', '-')}`,
    aggregateId: e.refId,
    eventType: e.eventType,
    actor: actorOf(ctx),
    subjectEmploymentId: e.subjectEmploymentId ?? null,
    payload: { action: e.action, ...(e.eventRef ?? {}) },
  });
}

/** A configuration change: audit ledger only (no timeline row — config is not a case). */
export async function recordConfig(
  tx: Tx,
  ctx: SessionContext,
  e: { eventType: string; aggregateId?: string; eventRef?: Record<string, string | number | boolean | null> },
): Promise<void> {
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'lifecycle-config',
    aggregateId: e.aggregateId ?? ctx.tenantId,
    eventType: e.eventType,
    actor: actorOf(ctx),
    payload: { ...(e.eventRef ?? {}) },
  });
}

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const clean = (v: unknown, max = 500): string | null => {
  const x = String(v ?? '').trim();
  return x === '' ? null : x.slice(0, max);
};
export const cleanDate = (v: unknown, what: string): string | null => {
  const x = String(v ?? '').trim();
  if (x === '') return null;
  if (!isIsoDate(x)) throw new LifecycleError(`${what} must be a valid date (YYYY-MM-DD).`);
  return x;
};
export const normEmail = (v: unknown): string | null => {
  const x = String(v ?? '').trim().toLowerCase();
  if (x === '') return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) throw new LifecycleError('Email address is not valid.');
  return x;
};
export const asBool = (v: unknown, dflt: boolean): boolean =>
  v === undefined || v === null || v === '' ? dflt : v === true || v === 'true' || v === 'Yes' || v === 'yes' || v === 'on' || v === '1' || v === 1;
