/**
 * Lifecycle IT requisitions and asset requests (ADR-0095).
 *
 * A requisition is the provisioning (or de-provisioning) checklist for one person, with an L1/L2 approval
 * chain by company. Onboarding creates one automatically, an accepted resignation creates a Return, and
 * staff can raise a Standalone. An asset request is the employee-facing "I need a monitor" flow with its own
 * approval and a forward-only fulfilment path.
 *
 * Decisions this file encodes (each is an ASSUMPTION where the handover is silent; see ADR-0095):
 *   - approval gates COMPLETION and the Issue Laptop item, not the other checklist items (work can start);
 *   - nobody decides their own record, and L2 must be a different person from L1;
 *   - an Issued asset can only be returned for the employee it is issued to, matched by employee number.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { employment, itAsset, itAssetCatalogue, itAssetRequest, itRequisition, itRequisitionItem, lcHistory, person } from '../db/schema';
import { PROVISION_ASSET_RETURN, PROVISION_LAPTOP_ISSUE } from './lifecycle-defaults';
import { issuedToTx, issueAssetTx, returnAssetTx, type Holder } from './lifecycle-assets';
import { loadCompanyConfigTx, loadProvisionListTx } from './lifecycle-config';
import { canAdvanceRequest, initialApprovalStatus, nextApproval, type ApprovalStatus } from './lifecycle-rules';
import { LEVEL, LifecycleError, clean, levelOf, nextNumber, recordChange, requireLevel, withTenant } from './lifecycle-base';

export type RequisitionKind = 'requisition' | 'return' | 'standalone';
export type RequisitionRow = typeof itRequisition.$inferSelect;
export type RequisitionItemRow = typeof itRequisitionItem.$inferSelect;

export type RequisitionInput = {
  kind: RequisitionKind; companyId: string; caseId?: string | null;
  fullName: string; employeeNo: string; jobTitle?: string | null; department?: string | null; costCentre?: string | null;
  workLocation?: string | null; contact?: string | null; username?: string | null;
  laptopRequired?: boolean; deviceType?: string | null; accessories?: string | null; accessSystems?: string[]; floorBuilding?: string | null;
  assignedToUserId?: string | null; notes?: string | null;
  returnDetails?: Record<string, unknown>;
};

/** Create a requisition inside the caller's transaction (onboarding / offboarding call this). */
export async function createRequisitionTx(tx: Tx, ctx: SessionContext, p: RequisitionInput): Promise<RequisitionRow> {
  const fullName = clean(p.fullName, 200);
  const employeeNo = clean(p.employeeNo, 60);
  if (!fullName || !employeeNo) throw new LifecycleError('Full name and employee number are required.');
  const cfg = await loadCompanyConfigTx(tx, p.companyId);
  const items = await loadProvisionListTx(tx, p.kind === 'return' ? 'return' : 'requisition', p.companyId);
  if (items.length === 0) throw new LifecycleError('No checklist is configured for this requisition type.');
  const number = await nextNumber(tx, 'ITR');
  const [r] = await tx.insert(itRequisition).values({
    tenantId: ctx.tenantId, number, kind: p.kind, companyId: p.companyId, caseId: p.caseId ?? null,
    fullName, employeeNo, jobTitle: clean(p.jobTitle, 200), department: clean(p.department, 200), costCentre: clean(p.costCentre, 100),
    workLocation: clean(p.workLocation, 200), contact: clean(p.contact, 100), username: clean(p.username, 200),
    laptopRequired: p.laptopRequired !== false, deviceType: clean(p.deviceType, 100), accessories: clean(p.accessories, 300),
    accessSystems: p.accessSystems ?? [], floorBuilding: clean(p.floorBuilding, 200), assignedToUserId: p.assignedToUserId ?? null,
    notes: clean(p.notes, 2000), returnDetails: p.returnDetails ?? {},
    approvalLevels: cfg.approvalLevels, approvalStatus: initialApprovalStatus(cfg.approvalLevels), createdBy: ctx.userId ?? null,
  }).returning();
  await tx.insert(itRequisitionItem).values(items.map((i) => ({ requisitionId: r!.id, tenantId: ctx.tenantId, itemKey: i.key, name: i.name, sort: i.sort })));
  await recordChange(tx, ctx, { refType: 'requisition', refId: r!.id, action: 'requisition.created', detail: { number, kind: p.kind, items: items.length }, eventType: 'lifecycle-requisition.created', eventRef: { number, kind: p.kind } });
  return r!;
}

export async function createStandaloneRequisition(ctx: SessionContext, p: Omit<RequisitionInput, 'kind' | 'caseId'>): Promise<{ id: string; number: string }> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, p.companyId, LEVEL.agent, 'only IT staff raise requisitions');
    const r = await createRequisitionTx(tx, ctx, { ...p, kind: 'standalone' });
    return { id: r.id, number: r.number };
  });
}

export async function listRequisitions(ctx: SessionContext, f: { companyId?: string; kind?: RequisitionKind; status?: string; approval?: string } = {}): Promise<RequisitionRow[]> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, f.companyId ?? null, LEVEL.agent, 'only IT staff read requisitions');
    const conds = [];
    if (f.companyId) conds.push(eq(itRequisition.companyId, f.companyId));
    if (f.kind) conds.push(eq(itRequisition.kind, f.kind));
    if (f.status) conds.push(eq(itRequisition.status, f.status));
    if (f.approval) conds.push(eq(itRequisition.approvalStatus, f.approval));
    return tx.select().from(itRequisition).where(conds.length ? and(...conds) : undefined).orderBy(desc(itRequisition.number)).limit(1000);
  });
}

async function loadReq(tx: Tx, number: string, lock = false): Promise<RequisitionRow> {
  const q = tx.select().from(itRequisition).where(eq(itRequisition.number, number)).limit(1);
  const [r] = lock ? await q.for('update') : await q;
  if (!r) throw new LifecycleError('Requisition not found.', 'not_found');
  return r;
}

export async function getRequisition(ctx: SessionContext, number: string): Promise<{ requisition: RequisitionRow; items: RequisitionItemRow[]; progress: { done: number; total: number } }> {
  return withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number);
    await requireLevel(tx, r.companyId, LEVEL.agent, 'only IT staff read requisitions');
    const items = await tx.select().from(itRequisitionItem).where(eq(itRequisitionItem.requisitionId, r.id)).orderBy(asc(itRequisitionItem.sort), asc(itRequisitionItem.itemKey));
    return { requisition: r, items, progress: { done: items.filter((i) => i.status !== 'pending').length, total: items.length } };
  });
}

export async function requisitionHistory(ctx: SessionContext, number: string) {
  return withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number);
    await requireLevel(tx, r.companyId, LEVEL.agent, 'only IT staff read requisitions');
    return tx.select().from(lcHistory).where(and(eq(lcHistory.refType, 'requisition'), eq(lcHistory.refId, r.id))).orderBy(desc(lcHistory.at), desc(lcHistory.id));
  });
}

export type RequisitionPatch = Partial<Pick<RequisitionInput, 'jobTitle' | 'department' | 'costCentre' | 'workLocation' | 'contact' | 'username' | 'laptopRequired' | 'deviceType' | 'accessories' | 'accessSystems' | 'floorBuilding' | 'assignedToUserId' | 'notes' | 'fullName'>> & {
  emailStatus?: string | null; adStatus?: string | null; device?: Record<string, unknown>; returnDetails?: Record<string, unknown>;
};

export async function updateRequisition(ctx: SessionContext, number: string, patch: RequisitionPatch): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.agent, 'only IT staff edit requisitions');
    if (r.status === 'cancelled') throw new LifecycleError('A cancelled requisition cannot be edited.', 'conflict');
    const set: Partial<typeof itRequisition.$inferInsert> = {};
    const txt = (k: keyof RequisitionPatch, col: keyof typeof itRequisition.$inferInsert, max = 300) => {
      if (patch[k] !== undefined) (set as Record<string, unknown>)[col] = clean(patch[k] as string, max);
    };
    txt('fullName', 'fullName', 200); txt('jobTitle', 'jobTitle', 200); txt('department', 'department', 200); txt('costCentre', 'costCentre', 100);
    txt('workLocation', 'workLocation', 200); txt('contact', 'contact', 100); txt('username', 'username', 200); txt('deviceType', 'deviceType', 100);
    txt('accessories', 'accessories', 300); txt('floorBuilding', 'floorBuilding', 200); txt('notes', 'notes', 2000); txt('emailStatus', 'emailStatus', 100); txt('adStatus', 'adStatus', 100);
    if (set.fullName === null) throw new LifecycleError('Full name cannot be blank.');
    if (patch.laptopRequired !== undefined) set.laptopRequired = patch.laptopRequired === true;
    if (patch.accessSystems !== undefined) set.accessSystems = patch.accessSystems;
    if (patch.assignedToUserId !== undefined) set.assignedToUserId = patch.assignedToUserId;
    if (patch.device !== undefined) set.device = { ...r.device, ...patch.device };
    if (patch.returnDetails !== undefined) set.returnDetails = { ...r.returnDetails, ...patch.returnDetails };
    if (Object.keys(set).length === 0) return;
    await tx.update(itRequisition).set(set).where(eq(itRequisition.id, r.id));
    await recordChange(tx, ctx, { refType: 'requisition', refId: r.id, action: 'requisition.edited', detail: { fields: Object.keys(set) }, eventType: 'lifecycle-requisition.edited', eventRef: { number } });
  });
}

async function recomputeStatus(tx: Tx, ctx: SessionContext, r: RequisitionRow): Promise<void> {
  const items = await tx.select({ s: itRequisitionItem.status }).from(itRequisitionItem).where(eq(itRequisitionItem.requisitionId, r.id));
  const allResolved = items.length > 0 && items.every((i) => i.s !== 'pending');
  const anyTouched = items.some((i) => i.s !== 'pending');
  const approved = r.approvalStatus === 'approved';
  const next = allResolved && approved ? 'completed' : anyTouched || (r.approvalStatus !== 'pending' && r.approvalLevels > 0) ? 'in_progress' : 'open';
  if (next === r.status || r.status === 'cancelled') return;
  await tx.update(itRequisition).set({ status: next }).where(eq(itRequisition.id, r.id));
  await recordChange(tx, ctx, { refType: 'requisition', refId: r.id, action: next === 'completed' ? 'requisition.completed' : 'requisition.status', detail: { from: r.status, to: next }, eventType: next === 'completed' ? 'lifecycle-requisition.completed' : 'lifecycle-requisition.status-changed', eventRef: { number: r.number, to: next } });
}

const holderOf = (r: RequisitionRow): Holder => ({ name: r.fullName, employeeNo: r.employeeNo, department: r.department, email: r.username && r.username.includes('@') ? r.username : null });

export async function setProvision(
  ctx: SessionContext, number: string, key: string, status: 'pending' | 'done' | 'na',
  opts: { note?: string | null; assetCode?: string | null; assetCodes?: string[] } = {},
): Promise<{ issued?: string; returned?: string[] }> {
  if (!['pending', 'done', 'na'].includes(status)) throw new LifecycleError('Status must be pending, done or na.');
  return withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.agent, 'only IT staff work requisitions');
    if (r.status === 'cancelled') throw new LifecycleError('A cancelled requisition cannot be worked.', 'conflict');
    if (r.approvalStatus === 'rejected') throw new LifecycleError('A rejected requisition cannot be worked.', 'conflict');
    const [item] = await tx.select().from(itRequisitionItem).where(and(eq(itRequisitionItem.requisitionId, r.id), eq(itRequisitionItem.itemKey, key))).limit(1).for('update');
    if (!item) throw new LifecycleError('Checklist item not found.', 'not_found');
    const out: { issued?: string; returned?: string[] } = {};
    if (status === 'done' && key === PROVISION_LAPTOP_ISSUE && item.status !== 'done' && opts.assetCode) {
      if (r.approvalStatus !== 'approved') throw new LifecycleError('The requisition must be approved before a device is issued.', 'conflict');
      await issueAssetTx(tx, ctx, opts.assetCode, holderOf(r), { requisitionId: r.id, requisitionNumber: r.number });
      out.issued = opts.assetCode;
    }
    if (status === 'done' && key === PROVISION_ASSET_RETURN && r.kind === 'return' && item.status !== 'done') {
      const held = await issuedToTx(tx, r.employeeNo, r.companyId);
      let toReturn: string[];
      if (opts.assetCodes?.length) toReturn = opts.assetCodes;
      else if (held.length <= 1) toReturn = held.map((h) => h.code);
      else throw new LifecycleError(`${held.length} devices are issued to ${r.fullName}: choose which were received.`, 'conflict');
      for (const code of toReturn) {
        if (!held.some((h) => h.code === code)) throw new LifecycleError(`Asset ${code} is not issued to ${r.employeeNo}.`, 'conflict');
        await returnAssetTx(tx, ctx, code, { requisitionNumber: r.number });
      }
      out.returned = toReturn;
    }
    const done = status === 'pending' ? { doneBy: null, doneAt: null } : { doneBy: ctx.userId ?? null, doneAt: new Date() };
    await tx.update(itRequisitionItem).set({ status, ...done, note: opts.note !== undefined ? clean(opts.note, 500) : item.note })
      .where(and(eq(itRequisitionItem.requisitionId, r.id), eq(itRequisitionItem.itemKey, key)));
    await recordChange(tx, ctx, { refType: 'requisition', refId: r.id, action: 'requisition.provision', detail: { item: item.name, from: item.status, to: status }, eventType: 'lifecycle-requisition.provision-set', eventRef: { number, item: key, to: status } });
    await recomputeStatus(tx, ctx, r);
    return out;
  });
}

/** Choose which of the leaver's issued devices came back (on a Return). */
export async function returnAssets(ctx: SessionContext, number: string, codes: string[]): Promise<string[]> {
  if (codes.length === 0) throw new LifecycleError('Choose at least one device.');
  return withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.agent, 'only IT staff receive returned devices');
    if (r.kind !== 'return') throw new LifecycleError('Devices are returned on a Return requisition.', 'conflict');
    if (r.status === 'cancelled') throw new LifecycleError('Returns for a cancelled requisition are refused.', 'conflict');
    const held = await issuedToTx(tx, r.employeeNo, r.companyId);
    for (const code of codes) {
      if (!held.some((h) => h.code === code)) throw new LifecycleError(`Asset ${code} is not issued to ${r.employeeNo}.`, 'conflict');
      await returnAssetTx(tx, ctx, code, { requisitionNumber: r.number });
    }
    if (r.caseId) {
      await recordChange(tx, ctx, { refType: 'case', refId: r.caseId, action: 'case.devices_returned', detail: { requisition: r.number, assets: codes }, eventType: 'lifecycle-case.devices-returned', eventRef: { requisition: r.number, count: codes.length } });
    }
    return codes;
  });
}

export async function decideRequisition(ctx: SessionContext, number: string, decision: 'approve' | 'reject', notes?: string | null): Promise<ApprovalStatus> {
  return withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.manager, 'only a manager approves requisitions');
    if (r.status === 'cancelled') throw new LifecycleError('A cancelled requisition cannot be decided.', 'conflict');
    if (!ctx.userId) throw new LifecycleError('Not signed in.', 'forbidden');
    const n = nextApproval({ levels: r.approvalLevels, status: r.approvalStatus as ApprovalStatus, l1Action: r.l1Action, l2Action: r.l2Action, l1By: r.l1By }, decision, ctx.userId, r.createdBy);
    if (!n.ok) {
      const msg = { no_approval_needed: 'This requisition needs no approval.', already_decided: 'This requisition has already been decided.', self_approval: 'You cannot approve a requisition you raised.', same_approver: 'Level 2 must be approved by a different person from level 1.' }[n.error];
      throw new LifecycleError(msg, n.error === 'self_approval' || n.error === 'same_approver' ? 'forbidden' : 'conflict');
    }
    const act = decision === 'approve' ? 'approved' : 'rejected';
    const set = n.level === 1 ? { l1By: ctx.userId, l1At: new Date(), l1Action: act } : { l2By: ctx.userId, l2At: new Date(), l2Action: act };
    const [u] = await tx.update(itRequisition).set({ ...set, approvalStatus: n.status, approvalNotes: clean(notes, 1000) ?? r.approvalNotes }).where(eq(itRequisition.id, r.id)).returning();
    await recordChange(tx, ctx, { refType: 'requisition', refId: r.id, action: `requisition.${act}`, detail: { level: n.level, status: n.status, notes: clean(notes, 1000) }, eventType: `lifecycle-requisition.${act}`, eventRef: { number, level: n.level } });
    await recomputeStatus(tx, ctx, u!);
    return n.status;
  });
}

export async function cancelRequisition(ctx: SessionContext, number: string, reason: string): Promise<void> {
  const why = clean(reason, 500);
  if (!why) throw new LifecycleError('A reason is required to cancel.');
  await withTenant(ctx, async (tx) => {
    const r = await loadReq(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.manager, 'only a manager cancels requisitions');
    if (r.status === 'cancelled') return;
    if (r.status === 'completed') throw new LifecycleError('A completed requisition cannot be cancelled.', 'conflict');
    await tx.update(itRequisition).set({ status: 'cancelled', cancelReason: why }).where(eq(itRequisition.id, r.id));
    await recordChange(tx, ctx, { refType: 'requisition', refId: r.id, action: 'requisition.cancelled', detail: { reason: why }, eventType: 'lifecycle-requisition.cancelled', eventRef: { number } });
  });
}

/** Cancel the open Return of an offboarding case (outcome changed to Rejected). Idempotent. */
export async function cancelOpenReturnTx(tx: Tx, ctx: SessionContext, caseId: string, reason: string): Promise<string | null> {
  const [r] = await tx.select().from(itRequisition).where(and(eq(itRequisition.caseId, caseId), eq(itRequisition.kind, 'return'), sql`${itRequisition.status} <> 'cancelled'`)).limit(1).for('update');
  if (!r) return null;
  await tx.update(itRequisition).set({ status: 'cancelled', cancelReason: reason }).where(eq(itRequisition.id, r.id));
  await recordChange(tx, ctx, { refType: 'requisition', refId: r.id, action: 'requisition.cancelled', detail: { reason, automatic: true }, eventType: 'lifecycle-requisition.cancelled', eventRef: { number: r.number } });
  return r.number;
}

// ═══════════════════════════════ asset requests ═══════════════════════════════
export type AssetRequestRow = typeof itAssetRequest.$inferSelect;

export type AssetRequestInput = { catalogueId: string; companyId: string; justification?: string | null; quantity?: number; preferredDate?: string | null };

/** Any signed-in employee raises a request for themselves; identity details come from their own record. */
export async function createAssetRequest(ctx: SessionContext, p: AssetRequestInput): Promise<{ id: string; number: string }> {
  const qty = p.quantity ?? 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw new LifecycleError('Quantity must be a whole number from 1 to 999.');
  if (p.preferredDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.preferredDate)) throw new LifecycleError('Preferred date must be YYYY-MM-DD.');
  return withTenant(ctx, async (tx) => {
    if (!ctx.userId || !ctx.personId) throw new LifecycleError('This account is not linked to an employee profile.', 'forbidden');
    const [item] = await tx.select().from(itAssetCatalogue).where(eq(itAssetCatalogue.id, p.catalogueId)).limit(1);
    if (!item || !item.active) throw new LifecycleError('That catalogue item is not available.', 'not_found');
    // The requester may only raise a request in a company they are employed by (staff may raise for any they serve).
    const [emp] = await tx.select({ code: employment.employeeCode, id: employment.id }).from(employment).where(and(eq(employment.personId, ctx.personId), eq(employment.companyId, p.companyId))).limit(1);
    if (!emp && (await levelOf(tx, p.companyId)) < LEVEL.agent) throw new LifecycleError('You can only request equipment for a company you work for.', 'forbidden');
    const [pr] = await tx.select({ n: person.fullName }).from(person).where(eq(person.id, ctx.personId)).limit(1);
    const number = await nextNumber(tx, 'AR');
    const [r] = await tx.insert(itAssetRequest).values({
      tenantId: ctx.tenantId, number, catalogueId: item.id, companyId: p.companyId, requesterUserId: ctx.userId, fullName: pr?.n ?? 'Employee',
      employeeNo: emp?.code ?? null, justification: clean(p.justification, 2000), quantity: qty, preferredDate: p.preferredDate ?? null,
      approvalLevels: item.approvalLevels,
    }).returning({ id: itAssetRequest.id });
    await recordChange(tx, ctx, { refType: 'asset_request', refId: r!.id, action: 'request.created', detail: { number, item: item.itemName, quantity: qty }, eventType: 'lifecycle-asset-request.created', eventRef: { number } });
    return { id: r!.id, number };
  });
}

export async function listAssetRequests(ctx: SessionContext, f: { status?: string; mine?: boolean } = {}): Promise<(AssetRequestRow & { itemName: string; itemCode: string })[]> {
  return withTenant(ctx, async (tx) => {
    const conds = [];
    if (f.status) conds.push(eq(itAssetRequest.status, f.status));
    if (f.mine && ctx.userId) conds.push(eq(itAssetRequest.requesterUserId, ctx.userId));
    // RLS returns managers/admins every request and everyone else only their own.
    const rows = await tx.select({ r: itAssetRequest, itemName: itAssetCatalogue.itemName, itemCode: itAssetCatalogue.itemCode })
      .from(itAssetRequest).innerJoin(itAssetCatalogue, eq(itAssetCatalogue.id, itAssetRequest.catalogueId))
      .where(conds.length ? and(...conds) : undefined).orderBy(desc(itAssetRequest.number)).limit(1000);
    return rows.map((x) => ({ ...x.r, itemName: x.itemName, itemCode: x.itemCode }));
  });
}

async function loadReq2(tx: Tx, number: string, lock = false): Promise<AssetRequestRow> {
  const q = tx.select().from(itAssetRequest).where(eq(itAssetRequest.number, number)).limit(1);
  const [r] = lock ? await q.for('update') : await q;
  if (!r) throw new LifecycleError('Asset request not found.', 'not_found');
  return r;
}

export async function getAssetRequest(ctx: SessionContext, number: string) {
  return withTenant(ctx, async (tx) => {
    const r = await loadReq2(tx, number);
    const [item] = await tx.select().from(itAssetCatalogue).where(eq(itAssetCatalogue.id, r.catalogueId)).limit(1);
    const asset = r.assetId ? (await tx.select({ code: itAsset.code }).from(itAsset).where(eq(itAsset.id, r.assetId)).limit(1))[0] ?? null : null;
    const lvl = await levelOf(tx, r.companyId);
    const history = lvl >= LEVEL.agent
      ? await tx.select().from(lcHistory).where(and(eq(lcHistory.refType, 'asset_request'), eq(lcHistory.refId, r.id))).orderBy(desc(lcHistory.at), desc(lcHistory.id))
      : [];
    return { request: r, item: item!, assetCode: asset?.code ?? null, history };
  });
}

export async function decideAssetRequest(ctx: SessionContext, number: string, decision: 'approve' | 'reject', notes?: string | null): Promise<AssetRequestRow['status']> {
  return withTenant(ctx, async (tx) => {
    const r = await loadReq2(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.manager, 'only a manager approves asset requests');
    if (!ctx.userId) throw new LifecycleError('Not signed in.', 'forbidden');
    if (r.status !== 'requested' && r.status !== 'pending_approval') throw new LifecycleError('This request has already been decided.', 'conflict');
    const approvalStatus: ApprovalStatus = r.status === 'pending_approval' ? 'pending_l2' : 'pending';
    const n = nextApproval({ levels: r.approvalLevels, status: approvalStatus, l1Action: r.l1Action, l2Action: r.l2Action, l1By: r.l1By }, decision, ctx.userId, r.requesterUserId);
    if (!n.ok) {
      const msg = { no_approval_needed: 'This request needs no approval.', already_decided: 'This request has already been decided.', self_approval: 'You cannot approve your own request.', same_approver: 'Level 2 must be approved by a different person from level 1.' }[n.error];
      throw new LifecycleError(msg, n.error === 'self_approval' || n.error === 'same_approver' ? 'forbidden' : 'conflict');
    }
    const next = n.status === 'rejected' ? 'rejected' : n.status === 'pending_l2' ? 'pending_approval' : 'approved';
    const act = decision === 'approve' ? 'approved' : 'rejected';
    const set = n.level === 1 ? { l1By: ctx.userId, l1At: new Date(), l1Action: act } : { l2By: ctx.userId, l2At: new Date(), l2Action: act };
    await tx.update(itAssetRequest).set({ ...set, status: next, approvalNotes: clean(notes, 1000) ?? r.approvalNotes }).where(eq(itAssetRequest.id, r.id));
    await recordChange(tx, ctx, { refType: 'asset_request', refId: r.id, action: `request.${act}`, detail: { level: n.level, status: next, notes: clean(notes, 1000) }, eventType: `lifecycle-asset-request.${act}`, eventRef: { number, level: n.level } });
    return next;
  });
}

/** Move a request forward through fulfilment. Only after approval, one step at a time. */
export async function advanceAssetRequest(ctx: SessionContext, number: string, next: 'procured' | 'tagged' | 'assigned' | 'completed', opts: { assetCode?: string | null } = {}): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const r = await loadReq2(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.manager, 'only a manager fulfils asset requests');
    if (!canAdvanceRequest(r.status, next)) throw new LifecycleError(`A ${r.status.replace('_', ' ')} request cannot move to ${next}.`, 'conflict');
    const set: Partial<typeof itAssetRequest.$inferInsert> = { status: next };
    if (next === 'assigned') {
      const [item] = await tx.select().from(itAssetCatalogue).where(eq(itAssetCatalogue.id, r.catalogueId)).limit(1);
      const code = clean(opts.assetCode, 60);
      if (!code && item?.category === 'hardware') throw new LifecycleError('Assigning hardware needs the asset code.');
      if (code) {
        const holder: Holder = { name: r.fullName, employeeNo: r.employeeNo, department: r.department, email: null };
        const a = await issueAssetTx(tx, ctx, code, holder, { requestNumber: r.number });
        set.assetId = a.id;
      }
    }
    await tx.update(itAssetRequest).set(set).where(eq(itAssetRequest.id, r.id));
    await recordChange(tx, ctx, { refType: 'asset_request', refId: r.id, action: `request.${next}`, detail: { from: r.status, to: next, asset: opts.assetCode ?? null }, eventType: `lifecycle-asset-request.${next}`, eventRef: { number, to: next } });
  });
}

export async function setAssetRequestHandler(ctx: SessionContext, number: string, userId: string | null): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const r = await loadReq2(tx, number, true);
    await requireLevel(tx, r.companyId, LEVEL.manager, 'only a manager assigns the handler');
    if (userId) {
      const dir = (await tx.execute(sql`select user_id from app.lc_staff_directory(${r.companyId}::uuid)`)) as unknown as { user_id: string }[];
      if (!dir.some((d) => d.user_id === userId)) throw new LifecycleError('The handler must be an active member of the module staff.', 'conflict');
    }
    await tx.update(itAssetRequest).set({ handlerUserId: userId }).where(eq(itAssetRequest.id, r.id));
    await recordChange(tx, ctx, { refType: 'asset_request', refId: r.id, action: 'request.handler', detail: { handler: userId }, eventType: 'lifecycle-asset-request.handler-set', eventRef: { number } });
  });
}

/** The requester cancels their own (until it is assigned); a manager may cancel any not yet completed. */
export async function cancelAssetRequest(ctx: SessionContext, number: string, reason?: string | null): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const r = await loadReq2(tx, number, true);
    const own = ctx.userId != null && r.requesterUserId === ctx.userId;
    const mgr = (await levelOf(tx, r.companyId)) >= LEVEL.manager;
    if (!own && !mgr) throw new LifecycleError('Not permitted: only the requester or a manager cancels a request.', 'forbidden');
    if (['cancelled', 'rejected'].includes(r.status)) return;
    if (r.status === 'completed' || (own && !mgr && r.status === 'assigned')) throw new LifecycleError('This request can no longer be cancelled.', 'conflict');
    await tx.update(itAssetRequest).set({ status: 'cancelled', cancelReason: clean(reason, 500) }).where(eq(itAssetRequest.id, r.id));
    await recordChange(tx, ctx, { refType: 'asset_request', refId: r.id, action: 'request.cancelled', detail: { reason: clean(reason, 500), by: own ? 'requester' : 'manager' }, eventType: 'lifecycle-asset-request.cancelled', eventRef: { number } });
  });
}

/** Pending-approval items for the approver's worklist (requisitions and asset requests). */
export async function pendingApprovals(ctx: SessionContext): Promise<{ requisitions: RequisitionRow[]; assetRequests: AssetRequestRow[] }> {
  return withTenant(ctx, async (tx) => {
    if ((await levelOf(tx, null)) < LEVEL.manager) return { requisitions: [], assetRequests: [] };
    const requisitions = await tx.select().from(itRequisition).where(and(inArray(itRequisition.approvalStatus, ['pending', 'pending_l2']), sql`${itRequisition.status} <> 'cancelled'`)).orderBy(asc(itRequisition.number));
    const assetRequests = await tx.select().from(itAssetRequest).where(inArray(itAssetRequest.status, ['requested', 'pending_approval'])).orderBy(asc(itAssetRequest.number));
    return { requisitions, assetRequests };
  });
}
