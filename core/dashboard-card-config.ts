/**
 * HR-Admin Dashboard Card Master (feedback 1586d2f5) — the tenant-scoped catalog of dashboard cards HR can
 * maintain. This is the MASTER + service ONLY; the employee dashboard customizer (feedback 578a2fcf) reads
 * from it to decide which cards an employee may add, which show by default, and which are mandatory.
 *
 * Modeled on core/employee-id-config.ts: withTenant transaction wrapper, per-write DomainEvent
 * (dashboard-card-config.*), typed validation errors, and a friendly pre-check that mirrors the DB unique
 * index (the race-safe net). A card is keyed by a STABLE card_key that binds it to a concrete renderer
 * (the R39 block/card set); card_key is UNIQUE per tenant.
 *
 * Invariants enforced here:
 *   • card_key unique per tenant (partial-index net + friendly DuplicateCardKeyError)
 *   • card_type ∈ {information, action, shortcut}; status ∈ {active, inactive}
 *   • MANDATORY implies DEFAULT-DISPLAY: a card an employee cannot remove must be shown by default, so
 *     mandatory=true coerces default_display=true (a mandatory-but-hidden card is nonsensical).
 *
 * Substrate: every write appends a dashboard-card-config.* DomainEvent before returning. No subject
 * employment (tenant-level config) → admin-only to read the event, which is correct.
 */
import { and, count, eq, ne, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { dashboardCardConfig } from '../db/schema';

export const DASHBOARD_CARD_TYPES = ['information', 'action', 'shortcut'] as const;
export type DashboardCardType = (typeof DASHBOARD_CARD_TYPES)[number];

export const DASHBOARD_CARD_STATUSES = ['active', 'inactive'] as const;
export type DashboardCardStatus = (typeof DASHBOARD_CARD_STATUSES)[number];

/** Stable card_key shape: letters, digits and underscores (camelCase renderer ids like 'leaveBalance'). */
export const DASHBOARD_CARD_KEY_RE = /^[A-Za-z0-9_]+$/;

/** Thrown when a write would create a second row with the same card_key in a tenant. */
export class DuplicateCardKeyError extends Error {
  constructor(message = 'A dashboard card with this key already exists') {
    super(message);
    this.name = 'DuplicateCardKeyError';
  }
}

/** Postgres unique-violation (the tenant+card_key index). Walk the cause chain for code 23505. */
function isUniqueViolation(e: unknown): boolean {
  let cur = e as { code?: string; cause?: unknown } | null | undefined;
  for (let i = 0; cur && i < 4; i++) {
    if (cur.code === '23505') return true;
    cur = cur.cause as { code?: string; cause?: unknown } | null | undefined;
  }
  return false;
}

function cleanCardKey(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s) throw new Error('Card key is required');
  if (!DASHBOARD_CARD_KEY_RE.test(s)) throw new Error('Card key may only contain letters, numbers and underscores');
  return s;
}

function cleanName(v: string | undefined): string {
  const s = (v ?? '').trim();
  if (!s) throw new Error('Card name is required');
  return s;
}

function normalizeCardType(v: string | undefined): DashboardCardType {
  return (DASHBOARD_CARD_TYPES as readonly string[]).includes(v ?? '') ? (v as DashboardCardType) : 'information';
}

function normalizeStatus(v: string | undefined): DashboardCardStatus {
  return v === 'inactive' ? 'inactive' : 'active';
}

function cleanOrder(v: number | undefined, fallback: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Normalize a nullable free-text field to a trimmed value or null. */
function cleanOptText(v: string | undefined | null): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

/**
 * Guard the UNIQUE-card_key-per-tenant invariant BEFORE the write (the unique index is the race-safe net;
 * this raises a friendly typed error in the common case). `excludeId` skips the row being updated.
 */
async function assertKeyUnique(tx: Tx, tenantId: string, cardKey: string, excludeId?: string): Promise<void> {
  const notSelf = excludeId ? ne(dashboardCardConfig.id, excludeId) : undefined;
  const [{ n }] = await tx
    .select({ n: count() })
    .from(dashboardCardConfig)
    .where(and(eq(dashboardCardConfig.tenantId, tenantId), eq(dashboardCardConfig.cardKey, cardKey), notSelf));
  if (Number(n) > 0) throw new DuplicateCardKeyError();
}

// ─────────────────────────── Writes ───────────────────────────

export async function createCard(
  ctx: SessionContext,
  p: {
    cardKey: string;
    name: string;
    description?: string | null;
    cardType?: string;
    status?: string;
    employeeSelectable?: boolean;
    defaultDisplay?: boolean;
    mandatory?: boolean;
    displayOrder?: number;
    href?: string | null;
  },
): Promise<{ id: string }> {
  const cardKey = cleanCardKey(p.cardKey);
  const name = cleanName(p.name);
  const cardType = normalizeCardType(p.cardType);
  const status = normalizeStatus(p.status);
  const employeeSelectable = p.employeeSelectable ?? true;
  const mandatory = p.mandatory ?? false;
  // MANDATORY implies DEFAULT-DISPLAY: a non-removable card must appear by default.
  const defaultDisplay = mandatory ? true : (p.defaultDisplay ?? false);
  const displayOrder = cleanOrder(p.displayOrder, 0);
  const description = cleanOptText(p.description);
  const href = cleanOptText(p.href);

  return withTenant(ctx, async (tx) => {
    await assertKeyUnique(tx, ctx.tenantId, cardKey);
    let id: string;
    try {
      const [row] = await tx
        .insert(dashboardCardConfig)
        .values({
          tenantId: ctx.tenantId,
          cardKey,
          name,
          description,
          cardType,
          status,
          employeeSelectable,
          defaultDisplay,
          mandatory,
          displayOrder,
          href,
        })
        .returning({ id: dashboardCardConfig.id });
      id = row.id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateCardKeyError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'dashboard-card-config',
      aggregateId: id,
      eventType: 'dashboard-card-config.created',
      actor: actorOf(ctx),
      payload: { cardKey, name, cardType, status, employeeSelectable, defaultDisplay, mandatory, displayOrder, href },
    });
    return { id };
  });
}

export async function updateCard(
  ctx: SessionContext,
  p: {
    id: string;
    cardKey?: string;
    name?: string;
    description?: string | null;
    cardType?: string;
    status?: string;
    employeeSelectable?: boolean;
    defaultDisplay?: boolean;
    mandatory?: boolean;
    displayOrder?: number;
    href?: string | null;
  },
): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(dashboardCardConfig).where(eq(dashboardCardConfig.id, p.id)).limit(1);
    if (!before) throw new Error('Dashboard card not found');
    const cardKey = p.cardKey !== undefined ? cleanCardKey(p.cardKey) : before.cardKey;
    const name = p.name !== undefined ? cleanName(p.name) : before.name;
    const cardType = p.cardType !== undefined ? normalizeCardType(p.cardType) : (before.cardType as DashboardCardType);
    const status = p.status !== undefined ? normalizeStatus(p.status) : (before.status as DashboardCardStatus);
    const employeeSelectable = p.employeeSelectable !== undefined ? p.employeeSelectable : before.employeeSelectable;
    const mandatory = p.mandatory !== undefined ? p.mandatory : before.mandatory;
    // MANDATORY implies DEFAULT-DISPLAY.
    const defaultDisplayRaw = p.defaultDisplay !== undefined ? p.defaultDisplay : before.defaultDisplay;
    const defaultDisplay = mandatory ? true : defaultDisplayRaw;
    const displayOrder = p.displayOrder !== undefined ? cleanOrder(p.displayOrder, before.displayOrder) : before.displayOrder;
    const description = p.description !== undefined ? cleanOptText(p.description) : before.description;
    const href = p.href !== undefined ? cleanOptText(p.href) : before.href;

    if (cardKey !== before.cardKey) await assertKeyUnique(tx, ctx.tenantId, cardKey, p.id);
    try {
      await tx
        .update(dashboardCardConfig)
        .set({ cardKey, name, description, cardType, status, employeeSelectable, defaultDisplay, mandatory, displayOrder, href, updatedAt: sql`now()` })
        .where(eq(dashboardCardConfig.id, p.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateCardKeyError();
      throw e;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'dashboard-card-config',
      aggregateId: p.id,
      eventType: 'dashboard-card-config.updated',
      actor: actorOf(ctx),
      payload: {
        before: {
          cardKey: before.cardKey,
          name: before.name,
          cardType: before.cardType,
          status: before.status,
          employeeSelectable: before.employeeSelectable,
          defaultDisplay: before.defaultDisplay,
          mandatory: before.mandatory,
          displayOrder: before.displayOrder,
          href: before.href,
        },
        after: { cardKey, name, cardType, status, employeeSelectable, defaultDisplay, mandatory, displayOrder, href },
      },
    });
    return { id: p.id };
  });
}

export async function setStatus(ctx: SessionContext, p: { id: string; status: string }): Promise<{ id: string }> {
  const status = normalizeStatus(p.status);
  return withTenant(ctx, async (tx) => {
    const [before] = await tx.select().from(dashboardCardConfig).where(eq(dashboardCardConfig.id, p.id)).limit(1);
    if (!before) throw new Error('Dashboard card not found');
    await tx.update(dashboardCardConfig).set({ status, updatedAt: sql`now()` }).where(eq(dashboardCardConfig.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'dashboard-card-config',
      aggregateId: p.id,
      eventType: status === 'active' ? 'dashboard-card-config.activated' : 'dashboard-card-config.deactivated',
      actor: actorOf(ctx),
      payload: { status },
    });
    return { id: p.id };
  });
}

export async function deleteCard(ctx: SessionContext, p: { id: string }): Promise<{ id: string }> {
  return withTenant(ctx, async (tx) => {
    await tx.delete(dashboardCardConfig).where(eq(dashboardCardConfig.id, p.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'dashboard-card-config',
      aggregateId: p.id,
      eventType: 'dashboard-card-config.deleted',
      actor: actorOf(ctx),
    });
    return { id: p.id };
  });
}

// ─────────────────────────── Reads ───────────────────────────

export type DashboardCardRow = {
  id: string;
  cardKey: string;
  name: string;
  description: string | null;
  cardType: DashboardCardType;
  status: DashboardCardStatus;
  employeeSelectable: boolean;
  defaultDisplay: boolean;
  mandatory: boolean;
  displayOrder: number;
  href: string | null;
  updatedAt: Date;
};

/** List every dashboard card in the tenant catalog, ordered by display order then name. */
export async function listCards(ctx: SessionContext): Promise<DashboardCardRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: dashboardCardConfig.id,
        cardKey: dashboardCardConfig.cardKey,
        name: dashboardCardConfig.name,
        description: dashboardCardConfig.description,
        cardType: dashboardCardConfig.cardType,
        status: dashboardCardConfig.status,
        employeeSelectable: dashboardCardConfig.employeeSelectable,
        defaultDisplay: dashboardCardConfig.defaultDisplay,
        mandatory: dashboardCardConfig.mandatory,
        displayOrder: dashboardCardConfig.displayOrder,
        href: dashboardCardConfig.href,
        updatedAt: dashboardCardConfig.updatedAt,
      })
      .from(dashboardCardConfig)
      .orderBy(dashboardCardConfig.displayOrder, dashboardCardConfig.name);
    return rows.map((r) => ({
      ...r,
      cardType: r.cardType as DashboardCardType,
      status: r.status as DashboardCardStatus,
    }));
  });
}

export async function getCard(ctx: SessionContext, id: string): Promise<DashboardCardRow | null> {
  const rows = await listCards(ctx);
  return rows.find((r) => r.id === id) ?? null;
}

/**
 * The ACTIVE dashboard cards the employee customizer (feedback 578a2fcf) renders against: the flattened,
 * HR-configured catalog an employee may show / add / reorder. Read-only projection of listCards filtered
 * to status='active'. When a tenant has NO rows yet (provisioned after the 1586d2f5 seed migration), the
 * customizer falls back to lib/dashboard-layout BUILTIN_DASHBOARD_CARDS, so the dashboard never renders
 * blank. Read-only → no DomainEvent (substrate skip, per CLAUDE.md "When NOT to append": read operation).
 */
export type EmployeeDashboardCard = {
  cardKey: string;
  name: string;
  cardType: DashboardCardType;
  href: string | null;
  employeeSelectable: boolean;
  defaultDisplay: boolean;
  mandatory: boolean;
  displayOrder: number;
};

export async function listEmployeeDashboardCards(ctx: SessionContext): Promise<EmployeeDashboardCard[]> {
  const rows = await listCards(ctx);
  return rows
    .filter((r) => r.status === 'active')
    .map((r) => ({
      cardKey: r.cardKey,
      name: r.name,
      cardType: r.cardType,
      href: r.href,
      employeeSelectable: r.employeeSelectable,
      defaultDisplay: r.defaultDisplay,
      mandatory: r.mandatory,
      displayOrder: r.displayOrder,
    }));
}
