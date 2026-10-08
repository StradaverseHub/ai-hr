/**
 * Lifecycle asset register (ADR-0095) — the IT asset tracker.
 *
 * One owner of "who holds this device": the asset row's current-user fields. Issuing and returning are the
 * ONLY writers of those fields (register/update never set a holder by themselves except through the same
 * rule), and every change appends to the asset's history in the same transaction. The requisition and
 * asset-request flows reach the register through `issueAssetTx` / `returnAssetTx` below, never by editing
 * the row, so the holder cannot disagree with the history.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { company, itAsset, lcHistory } from '../db/schema';
import { ASSET_STATUSES, ASSET_TYPES, ASSET_TYPE_CODE, normaliseCompanyCode, type AssetStatus, type AssetType } from './lifecycle-defaults';
import { LEVEL, LifecycleError, clean, cleanDate, nextSeq, recordChange, requireLevel, todayUtc, withTenant } from './lifecycle-base';

export type AssetInput = {
  companyId: string; assetType: AssetType; status?: AssetStatus; assetTag?: string | null;
  manufacturer?: string | null; model?: string | null; serialNo?: string | null; hostname?: string | null; os?: string | null;
  cpu?: string | null; ram?: string | null; storage?: string | null; leased?: boolean; leaseEnd?: string | null;
  purchaseDate?: string | null; purchaseCost?: number | null; warrantyEnd?: string | null; location?: string | null;
  licence?: Record<string, unknown>; extra?: Record<string, unknown>;
  userName?: string | null; userEmployeeNo?: string | null; userDepartment?: string | null; userEmail?: string | null;
};

export type AssetRow = typeof itAsset.$inferSelect;

const SPEC_FIELDS = ['assetTag', 'manufacturer', 'model', 'serialNo', 'hostname', 'os', 'cpu', 'ram', 'storage', 'location'] as const;

async function companyPrefix(tx: Tx, companyId: string): Promise<string> {
  const [c] = await tx.select({ label: company.companyLabel, name: company.legalName }).from(company).where(eq(company.id, companyId)).limit(1);
  if (!c) throw new LifecycleError('Company not found.', 'not_found');
  const code = normaliseCompanyCode(c.label) || normaliseCompanyCode(c.name).slice(0, 4);
  return (code || 'CO').slice(0, 12);
}

/** `CHGP-LAP-0001`: company code, 3-letter type code, running number per prefix. Generated, never typed. */
export async function nextAssetCode(tx: Tx, companyId: string, type: AssetType): Promise<string> {
  const prefix = `${await companyPrefix(tx, companyId)}-${ASSET_TYPE_CODE[type]}`;
  const n = await nextSeq(tx, `ASSET:${prefix}`);
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

export async function registerAsset(ctx: SessionContext, p: AssetInput): Promise<{ id: string; code: string }> {
  if (!ASSET_TYPES.includes(p.assetType)) throw new LifecycleError('Unknown asset type.');
  const status = p.status ?? 'in_stock';
  if (!ASSET_STATUSES.includes(status)) throw new LifecycleError('Unknown asset status.');
  if (status === 'issued' && !clean(p.userName)) throw new LifecycleError('An issued asset needs a named user.');
  const warrantyEnd = cleanDate(p.warrantyEnd, 'Warranty end');
  const purchaseDate = cleanDate(p.purchaseDate, 'Purchase date');
  const leaseEnd = cleanDate(p.leaseEnd, 'Lease end');
  if (p.purchaseCost != null && (!Number.isFinite(p.purchaseCost) || p.purchaseCost < 0)) throw new LifecycleError('Purchase cost must be zero or more.');
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, p.companyId, LEVEL.agent, 'only IT staff register assets');
    const code = await nextAssetCode(tx, p.companyId, p.assetType);
    const [r] = await tx.insert(itAsset).values({
      tenantId: ctx.tenantId, code, companyId: p.companyId, assetType: p.assetType, status,
      assetTag: clean(p.assetTag, 60), manufacturer: clean(p.manufacturer, 100), model: clean(p.model, 100), serialNo: clean(p.serialNo, 100),
      hostname: clean(p.hostname, 100), os: clean(p.os, 100), cpu: clean(p.cpu, 100), ram: clean(p.ram, 50), storage: clean(p.storage, 50),
      leased: p.leased === true, leaseEnd, purchaseDate, purchaseCost: p.purchaseCost == null ? null : p.purchaseCost.toFixed(2), warrantyEnd,
      location: clean(p.location, 200), licence: p.licence ?? {}, extra: p.extra ?? {},
      userName: status === 'issued' ? clean(p.userName, 200) : null, userEmployeeNo: status === 'issued' ? clean(p.userEmployeeNo, 60) : null,
      userDepartment: status === 'issued' ? clean(p.userDepartment, 120) : null, userEmail: status === 'issued' ? clean(p.userEmail, 200) : null,
      issuedOn: status === 'issued' ? todayUtc() : null, createdBy: ctx.userId ?? null,
    }).returning({ id: itAsset.id });
    await recordChange(tx, ctx, { refType: 'asset', refId: r!.id, action: 'asset.registered', detail: { code, status }, eventType: 'lifecycle-asset.registered', eventRef: { code, status } });
    return { id: r!.id, code };
  });
}

async function loadByCode(tx: Tx, code: string): Promise<AssetRow> {
  const [a] = await tx.select().from(itAsset).where(eq(itAsset.code, code)).limit(1).for('update');
  if (!a) throw new LifecycleError('Asset not found.', 'not_found');
  return a;
}

export async function updateAsset(ctx: SessionContext, code: string, patch: Partial<AssetInput> & { status?: AssetStatus }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const a = await loadByCode(tx, code);
    await requireLevel(tx, a.companyId, LEVEL.agent, 'only IT staff edit assets');
    const set: Partial<typeof itAsset.$inferInsert> = {};
    for (const f of SPEC_FIELDS) if (patch[f] !== undefined) (set as Record<string, unknown>)[f] = clean(patch[f], 200);
    if (patch.leased !== undefined) set.leased = patch.leased === true;
    if (patch.leaseEnd !== undefined) set.leaseEnd = cleanDate(patch.leaseEnd, 'Lease end');
    if (patch.purchaseDate !== undefined) set.purchaseDate = cleanDate(patch.purchaseDate, 'Purchase date');
    if (patch.warrantyEnd !== undefined) set.warrantyEnd = cleanDate(patch.warrantyEnd, 'Warranty end');
    if (patch.purchaseCost !== undefined) set.purchaseCost = patch.purchaseCost == null ? null : Number(patch.purchaseCost).toFixed(2);
    if (patch.licence !== undefined) set.licence = patch.licence;
    if (patch.extra !== undefined) set.extra = patch.extra;
    if (patch.status !== undefined && patch.status !== a.status) {
      if (!ASSET_STATUSES.includes(patch.status)) throw new LifecycleError('Unknown asset status.');
      if (patch.status === 'issued') {
        const name = clean(patch.userName);
        if (!name) throw new LifecycleError('An issued asset needs a named user.');
        Object.assign(set, { userName: name, userEmployeeNo: clean(patch.userEmployeeNo, 60), userDepartment: clean(patch.userDepartment, 120), userEmail: clean(patch.userEmail, 200), issuedOn: todayUtc() });
      } else {
        // Anything other than Issued means nobody holds it now; the history keeps who held it.
        Object.assign(set, { userName: null, userEmployeeNo: null, userDepartment: null, userEmail: null, issuedOn: null });
      }
      set.status = patch.status;
      await recordChange(tx, ctx, { refType: 'asset', refId: a.id, action: 'asset.status', detail: { from: a.status, to: patch.status, holder: patch.status === 'issued' ? clean(patch.userName) : a.userName }, eventType: 'lifecycle-asset.status-changed', eventRef: { code, from: a.status, to: patch.status } });
    }
    if (Object.keys(set).length === 0) return;
    await tx.update(itAsset).set(set).where(eq(itAsset.id, a.id));
    if (patch.status === undefined || patch.status === a.status) {
      await recordChange(tx, ctx, { refType: 'asset', refId: a.id, action: 'asset.edited', detail: { fields: Object.keys(set) }, eventType: 'lifecycle-asset.edited', eventRef: { code } });
    }
  });
}

/** Bulk status change to any status except Issued (which needs a named user, one asset at a time). */
export async function bulkAssetStatus(ctx: SessionContext, codes: string[], status: AssetStatus): Promise<{ changed: number; skipped: string[] }> {
  if (status === 'issued') throw new LifecycleError('Issue assets one at a time: an issued asset needs a named user.');
  if (!ASSET_STATUSES.includes(status)) throw new LifecycleError('Unknown asset status.');
  if (codes.length === 0 || codes.length > 500) throw new LifecycleError('Choose between 1 and 500 assets.');
  return withTenant(ctx, async (tx) => {
    const rows = await tx.select().from(itAsset).where(inArray(itAsset.code, codes)).for('update');
    const skipped = codes.filter((c) => !rows.some((r) => r.code === c));
    let changed = 0;
    for (const a of rows) {
      await requireLevel(tx, a.companyId, LEVEL.agent, 'only IT staff change asset status');
      if (a.status === status) continue;
      await tx.update(itAsset).set({ status, userName: null, userEmployeeNo: null, userDepartment: null, userEmail: null, issuedOn: null }).where(eq(itAsset.id, a.id));
      await recordChange(tx, ctx, { refType: 'asset', refId: a.id, action: 'asset.status', detail: { from: a.status, to: status, bulk: true, holder: a.userName }, eventType: 'lifecycle-asset.status-changed', eventRef: { code: a.code, from: a.status, to: status } });
      changed++;
    }
    return { changed, skipped };
  });
}

export type AssetFilters = { companyId?: string; assetType?: AssetType; status?: AssetStatus; search?: string; expiringWarranty?: boolean; holderEmployeeNo?: string };

export async function listAssets(ctx: SessionContext, f: AssetFilters = {}): Promise<AssetRow[]> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, f.companyId ?? null, LEVEL.agent, 'only IT staff read the asset register');
    const conds = [];
    if (f.companyId) conds.push(eq(itAsset.companyId, f.companyId));
    if (f.assetType) conds.push(eq(itAsset.assetType, f.assetType));
    if (f.status) conds.push(eq(itAsset.status, f.status));
    if (f.holderEmployeeNo) conds.push(sql`lower(${itAsset.userEmployeeNo}) = lower(${f.holderEmployeeNo})`);
    if (f.expiringWarranty) {
      const today = todayUtc();
      const to = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
      conds.push(and(gte(itAsset.warrantyEnd, today), lte(itAsset.warrantyEnd, to))!);
    }
    if (f.search?.trim()) {
      const q = `%${f.search.trim().replace(/[%_]/g, '')}%`;
      conds.push(or(ilike(itAsset.code, q), ilike(itAsset.serialNo, q), ilike(itAsset.userName, q), ilike(itAsset.model, q), ilike(itAsset.assetTag, q), ilike(itAsset.hostname, q))!);
    }
    return tx.select().from(itAsset).where(conds.length ? and(...conds) : undefined).orderBy(asc(itAsset.code)).limit(2000);
  });
}

export async function getAsset(ctx: SessionContext, code: string): Promise<AssetRow> {
  return withTenant(ctx, async (tx) => {
    const [a] = await tx.select().from(itAsset).where(eq(itAsset.code, code)).limit(1);
    if (!a) throw new LifecycleError('Asset not found.', 'not_found');
    await requireLevel(tx, a.companyId, LEVEL.agent, 'only IT staff read the asset register');
    return a;
  });
}

export async function assetHistory(ctx: SessionContext, code: string) {
  return withTenant(ctx, async (tx) => {
    const [a] = await tx.select({ id: itAsset.id, companyId: itAsset.companyId }).from(itAsset).where(eq(itAsset.code, code)).limit(1);
    if (!a) throw new LifecycleError('Asset not found.', 'not_found');
    await requireLevel(tx, a.companyId, LEVEL.agent, 'only IT staff read the asset register');
    return tx.select().from(lcHistory).where(and(eq(lcHistory.refType, 'asset'), eq(lcHistory.refId, a.id))).orderBy(desc(lcHistory.at), desc(lcHistory.id));
  });
}

export async function assetStatusCounts(ctx: SessionContext, companyId?: string): Promise<Record<string, number>> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, companyId ?? null, LEVEL.agent, 'only IT staff read the asset register');
    const rows = await tx.select({ s: itAsset.status, n: sql<number>`count(*)::int` }).from(itAsset).where(companyId ? eq(itAsset.companyId, companyId) : undefined).groupBy(itAsset.status);
    return Object.fromEntries(rows.map((r) => [r.s, r.n]));
  });
}

// ───────────── hand-offs used by requisitions and asset requests (same transaction as the caller) ─────────────
export type Holder = { name: string; employeeNo: string | null; department: string | null; email: string | null };

/** Issue an asset to a holder. Only a free asset (In Stock / Returned) can be issued. */
export async function issueAssetTx(
  tx: Tx, ctx: SessionContext, code: string, holder: Holder, link: { requisitionId?: string; requisitionNumber?: string; requestNumber?: string },
): Promise<AssetRow> {
  const a = await loadByCode(tx, code);
  await requireLevel(tx, a.companyId, LEVEL.agent, 'only IT staff issue assets');
  if (a.status !== 'in_stock' && a.status !== 'returned') {
    throw new LifecycleError(`Asset ${code} is ${a.status.replace('_', ' ')} and cannot be issued.`, 'conflict');
  }
  const issuedOn = todayUtc();
  const [u] = await tx.update(itAsset).set({
    status: 'issued', userName: holder.name, userEmployeeNo: holder.employeeNo, userDepartment: holder.department, userEmail: holder.email,
    issuedOn, requisitionId: link.requisitionId ?? a.requisitionId,
  }).where(eq(itAsset.id, a.id)).returning();
  await recordChange(tx, ctx, {
    refType: 'asset', refId: a.id, action: 'asset.issued',
    detail: { from: a.status, to: 'issued', holder: holder.name, requisition: link.requisitionNumber ?? null, request: link.requestNumber ?? null },
    eventType: 'lifecycle-asset.issued', eventRef: { code, requisition: link.requisitionNumber ?? null },
  });
  return u!;
}

/** Mark an Issued asset Returned. The holder is cleared; the history keeps who had it. */
export async function returnAssetTx(tx: Tx, ctx: SessionContext, code: string, link: { requisitionNumber?: string }): Promise<AssetRow> {
  const a = await loadByCode(tx, code);
  await requireLevel(tx, a.companyId, LEVEL.agent, 'only IT staff receive returned assets');
  if (a.status !== 'issued') throw new LifecycleError(`Asset ${code} is not issued, so it cannot be returned.`, 'conflict');
  const [u] = await tx.update(itAsset).set({ status: 'returned', userName: null, userEmployeeNo: null, userDepartment: null, userEmail: null, issuedOn: null }).where(eq(itAsset.id, a.id)).returning();
  await recordChange(tx, ctx, {
    refType: 'asset', refId: a.id, action: 'asset.returned',
    detail: { from: 'issued', to: 'returned', holder: a.userName, requisition: link.requisitionNumber ?? null },
    eventType: 'lifecycle-asset.returned', eventRef: { code, requisition: link.requisitionNumber ?? null },
  });
  return u!;
}

/** Assets currently Issued to an employee number (case-insensitive). */
export async function issuedToTx(tx: Tx, employeeNo: string, companyId: string): Promise<AssetRow[]> {
  return tx.select().from(itAsset).where(and(eq(itAsset.status, 'issued'), eq(itAsset.companyId, companyId), sql`lower(${itAsset.userEmployeeNo}) = lower(${employeeNo})`)).orderBy(asc(itAsset.code));
}
