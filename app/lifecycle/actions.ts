'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { publicErrorMessage } from '@/lib/public-error';
import { getSession } from '@/lib/session';
import * as lc from '@/packs/lifecycle/service';
import type { CaseKind, ImportRow } from '@/packs/lifecycle/service';

/** Run a service call; on a refusal return to `back` with the sentence, on success go to the result (or back). */
async function run(back: string, fn: () => Promise<string | void>): Promise<never> {
  let to = back;
  try {
    const r = await fn();
    if (r) to = r;
  } catch (e) {
    redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(publicErrorMessage(e))}`);
  }
  revalidatePath('/lifecycle', 'layout');
  redirect(to);
}

const str = (f: FormData, k: string): string => String(f.get(k) ?? '').trim();
const opt = (f: FormData, k: string): string | null => str(f, k) || null;
const bool = (f: FormData, k: string): boolean => str(f, k) === 'Yes' || str(f, k) === 'on' || str(f, k) === 'true';
const kindOf = (f: FormData): CaseKind => (str(f, 'kind') === 'offboarding' ? 'offboarding' : 'onboarding');
const base = (k: CaseKind) => `/lifecycle/${k}`;

/** Custom-field values travel as `cf_<key>` inputs. */
function customOf(f: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of f.entries()) if (k.startsWith('cf_') && typeof v === 'string') out[k.slice(3)] = v;
  return out;
}

// ───────────── cases ─────────────
export async function createOnboardingAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/onboarding/new', async () => {
    const r = await lc.createOnboardingCase(s, {
      companyId: str(f, 'companyId'), fullName: str(f, 'fullName'), employeeNo: str(f, 'employeeNo'), joinDate: str(f, 'joinDate'),
      jobTitle: opt(f, 'jobTitle'), department: opt(f, 'department'), supervisor: opt(f, 'supervisor'), gbsTa: opt(f, 'gbsTa'),
      hireType: str(f, 'hireType') === 'replacement' ? 'replacement' : 'new_hire', replacedPerson: opt(f, 'replacedPerson'),
      laptopRequired: bool(f, 'laptopRequired'), deviceType: opt(f, 'deviceType'), carparkRequired: bool(f, 'carparkRequired'),
      floorBuilding: opt(f, 'floorBuilding'), accessSystems: f.getAll('accessSystems').map(String), emailRequired: bool(f, 'emailRequired'),
      costCentre: opt(f, 'costCentre'), nricPassport: opt(f, 'nricPassport'), newhireEmail: opt(f, 'newhireEmail'), notes: opt(f, 'notes'), custom: customOf(f),
    });
    return `/lifecycle/onboarding/${r.number}`;
  });
}

export async function createOffboardingAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/offboarding/new', async () => {
    const bal = opt(f, 'balanceLeave');
    const r = await lc.createOffboardingCase(s, {
      companyId: str(f, 'companyId'), fullName: str(f, 'fullName'), employeeNo: str(f, 'employeeNo'), resignationDate: str(f, 'resignationDate'),
      lastWorkingDay: opt(f, 'lastWorkingDay'), jobTitle: opt(f, 'jobTitle'), department: opt(f, 'department'), supervisor: opt(f, 'supervisor'),
      gbsTa: opt(f, 'gbsTa'), workLocation: opt(f, 'workLocation'), deviceName: opt(f, 'deviceName'), balanceLeave: bal == null ? null : Number(bal),
      notes: opt(f, 'notes'), custom: customOf(f),
    });
    return `/lifecycle/offboarding/${r.number}`;
  });
}

export async function updateCaseAction(f: FormData) {
  const s = await getSession(); const kind = kindOf(f); const number = str(f, 'number');
  return run(`${base(kind)}/${number}`, async () => {
    const patch: lc.CasePatch = {
      fullName: str(f, 'fullName'), jobTitle: opt(f, 'jobTitle'), department: opt(f, 'department'), supervisor: opt(f, 'supervisor'), gbsTa: opt(f, 'gbsTa'),
      costCentre: opt(f, 'costCentre'), notes: opt(f, 'notes'), custom: customOf(f),
    };
    if (kind === 'onboarding') {
      Object.assign(patch, {
        joinDate: str(f, 'joinDate'), hireType: str(f, 'hireType') === 'replacement' ? 'replacement' : 'new_hire', replacedPerson: opt(f, 'replacedPerson'),
        laptopRequired: bool(f, 'laptopRequired'), carparkRequired: bool(f, 'carparkRequired'), floorBuilding: opt(f, 'floorBuilding'), deviceType: opt(f, 'deviceType'),
        newhireEmail: opt(f, 'newhireEmail'), accessSystems: f.getAll('accessSystems').map(String), nricPassport: opt(f, 'nricPassport'),
      });
      const owner = str(f, 'itOwnerUserId'); patch.itOwnerUserId = owner || null;
    } else {
      const bal = opt(f, 'balanceLeave');
      Object.assign(patch, { resignationDate: str(f, 'resignationDate'), lastWorkingDay: opt(f, 'lastWorkingDay'), workLocation: opt(f, 'workLocation'), deviceName: opt(f, 'deviceName'), balanceLeave: bal == null ? null : Number(bal) });
    }
    await lc.updateCase(s, kind, number, patch);
  });
}

export async function tickStepAction(f: FormData) {
  const s = await getSession(); const kind = kindOf(f); const number = str(f, 'number');
  return run(`${base(kind)}/${number}`, async () => { await lc.tickStep(s, kind, number, str(f, 'key'), { reference: opt(f, 'reference'), notes: opt(f, 'notes') }); });
}
export async function undoStepAction(f: FormData) {
  const s = await getSession(); const kind = kindOf(f); const number = str(f, 'number');
  return run(`${base(kind)}/${number}`, async () => { await lc.undoStep(s, kind, number, str(f, 'key'), opt(f, 'reason')); });
}
export async function outcomeAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/offboarding/${number}`, async () => {
    const o = str(f, 'outcome');
    if (o !== 'accepted' && o !== 'rejected') throw new Error('Choose Accepted or Rejected.');
    await lc.setOutcome(s, number, o, opt(f, 'reason'));
  });
}
export async function cancelCaseAction(f: FormData) {
  const s = await getSession(); const kind = kindOf(f); const number = str(f, 'number');
  return run(`${base(kind)}/${number}`, async () => { await lc.cancelCase(s, kind, number, str(f, 'reason')); });
}
export async function reopenCaseAction(f: FormData) {
  const s = await getSession(); const kind = kindOf(f); const number = str(f, 'number');
  return run(`${base(kind)}/${number}`, async () => { await lc.reopenCase(s, kind, number); });
}
export async function commentAction(f: FormData) {
  const s = await getSession(); const kind = kindOf(f); const number = str(f, 'number');
  return run(`${base(kind)}/${number}`, async () => { await lc.addComment(s, kind, number, str(f, 'body')); });
}

// ───────────── import (called from the client island with plain arguments) ─────────────
export type ImportState = { preview?: lc.ImportPreview; result?: lc.CommitResult; error?: string };
export async function importPreviewAction(_prev: ImportState, f: FormData): Promise<ImportState> {
  const s = await getSession();
  try {
    const file = f.get('file');
    if (!(file instanceof File) || file.size === 0) return { error: 'Choose an .xlsx file first.' };
    const preview = await lc.previewOnboardingImport(s, Buffer.from(await file.arrayBuffer()), { fileName: file.name, defaultCompanyId: opt(f, 'defaultCompanyId') });
    return { preview };
  } catch (e) { return { error: publicErrorMessage(e) }; }
}
export async function importCommitAction(_prev: ImportState, f: FormData): Promise<ImportState> {
  const s = await getSession();
  try {
    const rows = JSON.parse(str(f, 'rows')) as ImportRow[];
    const result = await lc.commitOnboardingRows(s, rows);
    revalidatePath('/lifecycle', 'layout');
    return { result };
  } catch (e) { return { error: publicErrorMessage(e) }; }
}

// ───────────── requisitions ─────────────
export async function createRequisitionAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/requisitions/new', async () => {
    const r = await lc.createStandaloneRequisition(s, {
      companyId: str(f, 'companyId'), fullName: str(f, 'fullName'), employeeNo: str(f, 'employeeNo'), jobTitle: opt(f, 'jobTitle'), department: opt(f, 'department'),
      workLocation: opt(f, 'workLocation'), contact: opt(f, 'contact'), username: opt(f, 'username'), laptopRequired: bool(f, 'laptopRequired'),
      deviceType: opt(f, 'deviceType'), accessories: opt(f, 'accessories'), accessSystems: f.getAll('accessSystems').map(String), notes: opt(f, 'notes'),
    });
    return `/lifecycle/requisitions/${r.number}`;
  });
}
export async function provisionAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/requisitions/${number}`, async () => {
    const st = str(f, 'status');
    if (st !== 'pending' && st !== 'done' && st !== 'na') throw new Error('Unknown status.');
    await lc.setProvision(s, number, str(f, 'key'), st, { note: opt(f, 'note'), assetCode: opt(f, 'assetCode'), assetCodes: f.getAll('assetCodes').map(String).filter(Boolean) });
  });
}
export async function returnAssetsAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/requisitions/${number}`, async () => { await lc.returnAssets(s, number, f.getAll('assetCodes').map(String).filter(Boolean)); });
}
export async function decideRequisitionAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/requisitions/${number}`, async () => { await lc.decideRequisition(s, number, str(f, 'decision') === 'reject' ? 'reject' : 'approve', opt(f, 'notes')); });
}
export async function cancelRequisitionAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/requisitions/${number}`, async () => { await lc.cancelRequisition(s, number, str(f, 'reason')); });
}
export async function updateRequisitionAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/requisitions/${number}`, async () => {
    const owner = str(f, 'assignedToUserId');
    await lc.updateRequisition(s, number, {
      jobTitle: opt(f, 'jobTitle'), department: opt(f, 'department'), workLocation: opt(f, 'workLocation'), contact: opt(f, 'contact'), username: opt(f, 'username'),
      accessories: opt(f, 'accessories'), emailStatus: opt(f, 'emailStatus'), adStatus: opt(f, 'adStatus'), notes: opt(f, 'notes'), assignedToUserId: owner || null,
      device: { manufacturer: opt(f, 'dev_manufacturer'), model: opt(f, 'dev_model'), serial: opt(f, 'dev_serial'), hostname: opt(f, 'dev_hostname') },
    });
  });
}

// ───────────── assets ─────────────
const ASSET_TYPES = new Set(['laptop', 'desktop', 'tablet', 'monitor', 'printer', 'mobile', 'peripheral', 'other']);
export async function registerAssetAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/assets/new', async () => {
    const type = str(f, 'assetType');
    if (!ASSET_TYPES.has(type)) throw new Error('Choose an asset type.');
    const cost = opt(f, 'purchaseCost');
    const r = await lc.registerAsset(s, {
      companyId: str(f, 'companyId'), assetType: type as lc.AssetInput['assetType'], assetTag: opt(f, 'assetTag'), manufacturer: opt(f, 'manufacturer'),
      model: opt(f, 'model'), serialNo: opt(f, 'serialNo'), hostname: opt(f, 'hostname'), os: opt(f, 'os'), cpu: opt(f, 'cpu'), ram: opt(f, 'ram'),
      storage: opt(f, 'storage'), leased: bool(f, 'leased'), leaseEnd: opt(f, 'leaseEnd'), purchaseDate: opt(f, 'purchaseDate'),
      purchaseCost: cost == null ? null : Number(cost), warrantyEnd: opt(f, 'warrantyEnd'), location: opt(f, 'location'),
    });
    return `/lifecycle/assets/${r.code}`;
  });
}
export async function updateAssetAction(f: FormData) {
  const s = await getSession(); const code = str(f, 'code');
  return run(`/lifecycle/assets/${code}`, async () => {
    const status = opt(f, 'status') as lc.AssetStatus | null;
    const cost = opt(f, 'purchaseCost');
    await lc.updateAsset(s, code, {
      assetTag: opt(f, 'assetTag'), manufacturer: opt(f, 'manufacturer'), model: opt(f, 'model'), serialNo: opt(f, 'serialNo'), hostname: opt(f, 'hostname'),
      os: opt(f, 'os'), cpu: opt(f, 'cpu'), ram: opt(f, 'ram'), storage: opt(f, 'storage'), location: opt(f, 'location'), leased: bool(f, 'leased'),
      leaseEnd: opt(f, 'leaseEnd'), purchaseDate: opt(f, 'purchaseDate'), warrantyEnd: opt(f, 'warrantyEnd'), purchaseCost: cost == null ? null : Number(cost),
      ...(status ? { status, userName: opt(f, 'userName'), userEmployeeNo: opt(f, 'userEmployeeNo'), userDepartment: opt(f, 'userDepartment'), userEmail: opt(f, 'userEmail') } : {}),
    });
  });
}
export async function bulkAssetStatusAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/assets', async () => { await lc.bulkAssetStatus(s, f.getAll('codes').map(String), str(f, 'status') as lc.AssetStatus); });
}

// ───────────── asset requests ─────────────
export async function createAssetRequestAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/asset-requests/new', async () => {
    const r = await lc.createAssetRequest(s, { catalogueId: str(f, 'catalogueId'), companyId: str(f, 'companyId'), justification: opt(f, 'justification'), quantity: Number(str(f, 'quantity') || '1'), preferredDate: opt(f, 'preferredDate') });
    return `/lifecycle/asset-requests/${r.number}`;
  });
}
export async function decideAssetRequestAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/asset-requests/${number}`, async () => { await lc.decideAssetRequest(s, number, str(f, 'decision') === 'reject' ? 'reject' : 'approve', opt(f, 'notes')); });
}
export async function advanceAssetRequestAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/asset-requests/${number}`, async () => {
    const next = str(f, 'next');
    if (!['procured', 'tagged', 'assigned', 'completed'].includes(next)) throw new Error('Unknown stage.');
    await lc.advanceAssetRequest(s, number, next as 'procured', { assetCode: opt(f, 'assetCode') });
  });
}
export async function handlerAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/asset-requests/${number}`, async () => { await lc.setAssetRequestHandler(s, number, opt(f, 'handler')); });
}
export async function cancelAssetRequestAction(f: FormData) {
  const s = await getSession(); const number = str(f, 'number');
  return run(`/lifecycle/asset-requests/${number}`, async () => { await lc.cancelAssetRequest(s, number, opt(f, 'reason')); });
}

// ───────────── new-hire acknowledgement ─────────────
export async function acknowledgeAction(f: FormData) {
  const s = await getSession();
  return run('/lifecycle/me', async () => {
    await lc.submitMyAcknowledgement(s, {
      contactNumber: str(f, 'contactNumber'), accessories: opt(f, 'accessories'), pcType: opt(f, 'pcType'), serialNumber: str(f, 'serialNumber'),
      hasMonitor: bool(f, 'hasMonitor'), monitorSerial: opt(f, 'monitorSerial'), acknowledged: bool(f, 'acknowledged'), receiptEmail: opt(f, 'receiptEmail'),
    });
  });
}

export async function loadCatalogueAction() {
  const s = await getSession();
  return run('/lifecycle/asset-requests/new', async () => { await lc.ensureCatalogue(s); });
}
