/**
 * Employee ID Auto Running Number Setup (feedback 3d0031e6) — a configurable auto-numbering rule for the
 * employee_code assigned at hire. Modeled on core/payroll-policy.ts. A config carries a house prefix, a
 * starting number, a zero-pad width, an increment, and a running counter, at one of two scopes:
 *   • GLOBAL (companyId = null)  — one Employee-ID sequence shared across every company in the tenant.
 *   • COMPANY-SPECIFIC (companyId set) — an independent sequence per company.
 *
 * ONE ACTIVE config per scope is enforced both by two partial unique indexes (the race-safe net) and by a
 * friendly service pre-check. Two ACTIVE configs may never share a prefix (case-insensitive), because
 * employee_code is unique tenant-wide — two companies both starting at 0001 with the same prefix would clash.
 *
 * generateEmployeeCode(tx, tenantId, companyId) resolves the applicable ACTIVE config (company-specific first,
 * else global), atomically advances its running number (row-locked UPDATE ... RETURNING), and formats
 * prefix + zero-padded(number). The tenant-wide employment_employee_code_uq index is the ultimate collision net.
 *
 * NO-GAPS is NOT guaranteed; NO-DUPLICATES IS. The increment lives in the SAME transaction as the hire, so an
 * aborted hire rolls the number back — but deletions, manual-code interleaving, and inactivating/replacing a
 * config all leave gaps in the visible sequence. This mirrors the legacy nextEmployeeCode (tenant_counter)
 * behaviour and is called out on the admin screen.
 *
 * Substrate: every config write appends an employee-id-config.* DomainEvent before returning. The generation
 * counter-advance is plumbing (no per-generation event — the resulting employee_code already rides on the
 * existing employment.hired event), and is documented as such at the UPDATE below.
 */
import { and, count, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { company, employeeIdConfig } from '../db/schema';
import { EMPLOYEE_CODE_MAX_LEN } from '../lib/employee-code';

export const EMPLOYEE_ID_CONFIG_STATUSES = ['active', 'inactive'] as const;
export type EmployeeIdConfigStatus = (typeof EMPLOYEE_ID_CONFIG_STATUSES)[number];

/** Allowed prefix shape: uppercase letters, digits and dashes (mirrors EMPLOYEE_CODE_RE without the length
 *  cap, which is enforced jointly with number_length instead). */
export const EMPLOYEE_ID_PREFIX_RE = /^[A-Z0-9-]+$/;

/** Thrown when a write would leave more than one ACTIVE config in the same scope (global, or a given company). */
export class DuplicateActiveConfigError extends Error {
  constructor(message = 'An active Employee ID setup already exists for this scope') {
    super(message);
    this.name = 'DuplicateActiveConfigError';
  }
}

/** Thrown when an ACTIVE config's prefix collides with another ACTIVE config's prefix (would break tenant-wide
 *  employee-code uniqueness across scopes). */
export class PrefixCollisionError extends Error {
  constructor(message = 'Another active Employee ID setup already uses this prefix') {
    super(message);
    this.name = 'PrefixCollisionError';
  }
}

/** Thrown when prefix length + number length exceeds the 9-character employee_code cap. */
export class EmployeeCodeTooLongError extends Error {
  constructor(message = `Prefix + number length must be at most ${EMPLOYEE_CODE_MAX_LEN} characters`) {
    super(message);
    this.name = 'EmployeeCodeTooLongError';
  }
}

/** Postgres unique-violation (the partial active-scope indexes). Walk the cause chain for code 23505. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

function cleanPrefix(v: string | undefined): string {
  const s = (v ?? '').trim().toUpperCase();
  if (!s) throw new Error('Prefix is required');
  if (!EMPLOYEE_ID_PREFIX_RE.test(s)) throw new Error('Prefix may only contain letters, numbers and dashes');
  return s;
}

/** Coerce to a positive integer with a floor (defaults kept in sync with the schema column defaults). */
function cleanPositiveInt(v: number | undefined, fallback: number, min: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Coerce to a non-negative integer (start/current running numbers). */
function cleanNonNegInt(v: number | undefined, fallback: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeStatus(v: string | undefined): EmployeeIdConfigStatus {
  return v === 'inactive' ? 'inactive' : 'active';
}

/** prefix.length + numberLength must fit inside the 9-char employee_code cap. */
function assertFits(prefix: string, numberLength: number): void {
  if (prefix.length + numberLength > EMPLOYEE_CODE_MAX_LEN) throw new EmployeeCodeTooLongError();
}

/**
 * Guard the ONE-ACTIVE-PER-SCOPE + NO-DUPLICATE-PREFIX invariants BEFORE the write (the partial unique index
 * is the race-safe net; this raises a friendly typed error in the common case). Only runs for status='active'
 * (an inactive config never conflicts). `excludeId` skips the row being updated.
 */
async function assertActiveInvariants(
  tx: Tx,
  tenantId: string,
  p: { companyId: string | null; prefix: string; excludeId?: string },
): Promise<void> {
  // Same scope: global (company null) vs a specific company. NULL = NULL must match, so use IS NULL explicitly.
  const scopePredicate = p.companyId == null ? isNull(employeeIdConfig.companyId) : eq(employeeIdConfig.companyId, p.companyId);
  const notSelf = p.excludeId ? ne(employeeIdConfig.id, p.excludeId) : undefined;
  const [{ n: sameScope }] = await tx
    .select({ n: count() })
    .from(employeeIdConfig)
    .where(and(eq(employeeIdConfig.tenantId, tenantId), eq(employeeIdConfig.status, 'active'), scopePredicate, notSelf));
  if (Number(sameScope) > 0) throw new DuplicateActiveConfigError();
  // Any active config (any scope) sharing this prefix would break tenant-wide employee-code uniqueness.
  const [{ n: samePrefix }] = await tx
    .select({ n: count() })
    .from(employeeIdConfig)
    .where(
      and(
        eq(employeeIdConfig.tenantId, tenantId),
        eq(employeeIdConfig.status, 'active'),
        eq(employeeIdConfig.prefix, p.prefix),
        notSelf,
      ),
    );
  if (Number(samePrefix) > 0) throw new PrefixCollisionError();
}

// ─────────────────────────── Writes ───────────────────────────

export async function createConfig(
  ctx: SessionContext,
  p: {
    companyId?: string | null;
    prefix: string;
    startNumber?: number;
    numberLength?: number;
    increment?: number;
    status?: string;
  },
): Promise<{ id: string }> {
  const companyId = p.companyId ?? null;
  const prefix = cleanPrefix(p.prefix);
  const startNumber = cleanNonNegInt(p.startNumber, 1);
  const numberLength = cleanPositiveInt(p.numberLength, 4, 1);
  const increment = cleanPositiveInt(p.increment, 1, 1);
  const status = normalizeStatus(p.status);
  assertFits(prefix, numberLength);
  return withTenant(ctx, async (tx) => {
    if (status === 'active') await assertActiveInvariants(tx, ctx.tenantId, { companyId, prefix });
    let id: string;
    try {
      const [row] = await tx
        .insert(employeeIdConfig)
        .values({
          tenantId: ctx.tenantId,
          companyId,
          prefix,
          startNumber,
          numberLength,
          increment,
          // current_running_number starts at 0 (nothing issued) → the first hire gets startNumber.
          currentRunningNumber: 0,
          status,
        })
        .returning({ id: employeeIdConfig.id });
      id = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateActiveConfigError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-id-config',
      aggregateId: id,
      eventType: 'employee-id-config.created',
      actor: actorOf(ctx),
      payload: { companyId, prefix, startNumber, numberLength, increment, status },
    });
    return { id };
  });
}

export async function updateConfig(
  ctx: SessionContext,
  p: {
    id: string;
    prefix?: string;
    startNumber?: number;
    numberLength?: number;
    increment?: number;
    currentRunningNumber?: number;
    status?: string;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(employeeIdConfig).where(eq(employeeIdConfig.id, p.id)).limit(1);
    if (!before) throw new Error('Employee ID setup not found');
    const prefix = p.prefix !== undefined ? cleanPrefix(p.prefix) : before.prefix;
    const startNumber = p.startNumber !== undefined ? cleanNonNegInt(p.startNumber, before.startNumber) : before.startNumber;
    const numberLength = p.numberLength !== undefined ? cleanPositiveInt(p.numberLength, before.numberLength, 1) : before.numberLength;
    const increment = p.increment !== undefined ? cleanPositiveInt(p.increment, before.increment, 1) : before.increment;
    const currentRunningNumber =
      p.currentRunningNumber !== undefined ? cleanNonNegInt(p.currentRunningNumber, before.currentRunningNumber) : before.currentRunningNumber;
    const status = p.status !== undefined ? normalizeStatus(p.status) : (before.status as EmployeeIdConfigStatus);
    assertFits(prefix, numberLength);
    if (status === 'active') {
      await assertActiveInvariants(tx, ctx.tenantId, { companyId: before.companyId, prefix, excludeId: p.id });
    }
    try {
      await tx
        .update(employeeIdConfig)
        .set({ prefix, startNumber, numberLength, increment, currentRunningNumber, status, updatedAt: sql`now()` })
        .where(eq(employeeIdConfig.id, p.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateActiveConfigError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-id-config',
      aggregateId: p.id,
      eventType: 'employee-id-config.updated',
      actor: actorOf(ctx),
      payload: {
        before: {
          prefix: before.prefix,
          startNumber: before.startNumber,
          numberLength: before.numberLength,
          increment: before.increment,
          currentRunningNumber: before.currentRunningNumber,
          status: before.status,
        },
        after: { prefix, startNumber, numberLength, increment, currentRunningNumber, status },
      },
    });
    return { id: p.id };
  });
}

export async function setStatus(ctx: SessionContext, p: { id: string; status: string }): Promise<{ id: string }> {
  const status = normalizeStatus(p.status);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(employeeIdConfig).where(eq(employeeIdConfig.id, p.id)).limit(1);
    if (!before) throw new Error('Employee ID setup not found');
    // Activating a config must not violate the one-active-per-scope / unique-prefix invariants.
    if (status === 'active') {
      await assertActiveInvariants(tx, ctx.tenantId, { companyId: before.companyId, prefix: before.prefix, excludeId: p.id });
    }
    try {
      await tx.update(employeeIdConfig).set({ status, updatedAt: sql`now()` }).where(eq(employeeIdConfig.id, p.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateActiveConfigError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-id-config',
      aggregateId: p.id,
      eventType: status === 'active' ? 'employee-id-config.activated' : 'employee-id-config.deactivated',
      actor: actorOf(ctx),
      payload: { status },
    });
    return { id: p.id };
  });
}

export async function deleteConfig(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    await tx.delete(employeeIdConfig).where(eq(employeeIdConfig.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-id-config',
      aggregateId: p.id,
      eventType: 'employee-id-config.deleted',
      actor: actorOf(ctx),
    });
    return { id: p.id };
  });
}

// ─────────────────────────── Generation ───────────────────────────

/** Format an issued number: prefix + zero-padded number, guarding the 9-char employee_code cap (an overflowed
 *  numberLength, e.g. width 4 reaching 10000, would exceed the cap — throw rather than issue an invalid code). */
export function formatEmployeeCode(prefix: string, n: number, numberLength: number): string {
  const code = `${prefix}${String(n).padStart(numberLength, '0')}`;
  if (code.length > EMPLOYEE_CODE_MAX_LEN) {
    throw new EmployeeCodeTooLongError(
      `Generated Employee ID "${code}" exceeds ${EMPLOYEE_CODE_MAX_LEN} characters — widen the number length or reset the sequence`,
    );
  }
  return code;
}

/**
 * Resolve the applicable ACTIVE Employee-ID config (company-specific first, else global) and, if one exists,
 * atomically advance its running number and return the formatted code. Returns null when NO active config
 * applies, so the caller falls back to the legacy EMP-#### counter. Call INSIDE the hire transaction (Tx) so
 * the increment commits/aborts atomically with the hire.
 */
export async function generateEmployeeCode(
  tx: Tx,
  tenantId: string,
  companyId: string,
): Promise<string | null> {
  // Company-specific wins over global. One SELECT ordered so the company row (company_id = companyId) sorts
  // before the global row (company_id NULL); FOR UPDATE row-locks the chosen config so concurrent hires
  // serialize on it (belt-and-braces with the tenant-wide employee_code unique index).
  const rows = await tx
    .select({
      id: employeeIdConfig.id,
      prefix: employeeIdConfig.prefix,
      startNumber: employeeIdConfig.startNumber,
      numberLength: employeeIdConfig.numberLength,
      increment: employeeIdConfig.increment,
      currentRunningNumber: employeeIdConfig.currentRunningNumber,
      companyId: employeeIdConfig.companyId,
    })
    .from(employeeIdConfig)
    .where(
      and(
        eq(employeeIdConfig.tenantId, tenantId),
        eq(employeeIdConfig.status, 'active'),
        or(eq(employeeIdConfig.companyId, companyId), isNull(employeeIdConfig.companyId)),
      ),
    )
    // company-specific (companyId NOT NULL) first, then global.
    .orderBy(sql`${employeeIdConfig.companyId} is null`)
    .limit(1)
    .for('update');
  const cfg = rows[0];
  if (!cfg) return null;
  // Atomic advance (plumbing — no DomainEvent; the issued code rides on the existing employment.hired event).
  // next = startNumber on first issue (current < start), else current + increment. Row-locked by FOR UPDATE.
  const [advanced] = await tx
    .update(employeeIdConfig)
    .set({
      currentRunningNumber: sql`case
        when ${employeeIdConfig.currentRunningNumber} < ${cfg.startNumber} then ${cfg.startNumber}
        else ${employeeIdConfig.currentRunningNumber} + ${cfg.increment} end`,
      updatedAt: sql`now()`,
    })
    .where(eq(employeeIdConfig.id, cfg.id))
    .returning({ n: employeeIdConfig.currentRunningNumber });
  return formatEmployeeCode(cfg.prefix, advanced.n, cfg.numberLength);
}

// ─────────────────────────── Reads ───────────────────────────

export type ConfigRow = {
  id: string;
  companyId: string | null;
  companyName: string | null;
  prefix: string;
  startNumber: number;
  numberLength: number;
  increment: number;
  currentRunningNumber: number;
  status: EmployeeIdConfigStatus;
  updatedAt: Date;
};

/** List all Employee-ID configs (optionally scoped to a set of companies — GLOBAL configs are always
 *  included). Joins the company name for display. */
export async function listConfigs(ctx: SessionContext, companyIds?: string[]): Promise<ConfigRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: employeeIdConfig.id,
        companyId: employeeIdConfig.companyId,
        companyName: company.legalName,
        prefix: employeeIdConfig.prefix,
        startNumber: employeeIdConfig.startNumber,
        numberLength: employeeIdConfig.numberLength,
        increment: employeeIdConfig.increment,
        currentRunningNumber: employeeIdConfig.currentRunningNumber,
        status: employeeIdConfig.status,
        updatedAt: employeeIdConfig.updatedAt,
      })
      .from(employeeIdConfig)
      .leftJoin(company, eq(company.id, employeeIdConfig.companyId))
      .orderBy(sql`${employeeIdConfig.companyId} is not null`, employeeIdConfig.prefix);
    return rows
      .filter((r) => r.companyId == null || !companyIds || companyIds.includes(r.companyId))
      .map((r) => ({
        ...r,
        status: r.status as EmployeeIdConfigStatus,
      }));
  });
}

export async function getConfig(ctx: SessionContext, id: string): Promise<ConfigRow | null> {
  const rows = await listConfigs(ctx);
  return rows.find((r) => r.id === id) ?? null;
}
