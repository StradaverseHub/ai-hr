/**
 * M11 — the v2 claim routes (employee) and the D12 claim task (approver), through the REAL route handlers, core, the
 * claims kernel and RLS. Only bearer session resolution is injected (as test/mobile-v2-leave.test.ts does).
 *
 * Pinned, employee: own-selected-employment scoping (a manager cannot read a subordinate's claim through the own
 * endpoints although RLS shows it; another employee's claim and receipt are `not_found`); keyset paging that neither
 * repeats nor skips, the status filter and counts; detail facts; a receipt is sniffed by its bytes (wrong type, empty,
 * oversized are typed refusals that record nothing); a double submit with the same requestId replays and files once,
 * a different body under it is `request_conflict`; a draft reserves nothing; edit-draft-then-submit files the edits;
 * a limit lowered between draft and submit is refused by the kernel at submit with its own sentence; the mileage
 * preview is the kernel's figure and the stored one; delete replays after the row is gone; an offboarded caller and
 * a tenant without Claims are refused.
 * Pinned, approver (D12): the claim is a native task; admission is the canonical owner's; self-approval is refused;
 * a rejection needs a reason, which the employee then reads; a decided claim is `already_decided`; a receipt opens
 * through the task route for the assigned approver only.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { createClaimFormField, createClaimType, listClaimsForEmployment, setClaimPolicy, setMileageRateTable, submitClaimWithAttachment } from '../packs/claims/service';
import { ALLOWED_RECEIPT_MIME } from '../core/claims';
import { decodeCursor } from '../lib/mobile-api/v2/common';
import { CLAIM_RECEIPT_MAX_BYTES, CLAIM_RECEIPT_TYPES, CLAIMS_CURSOR, ClaimsCursor } from '../lib/mobile-api/v2/claims';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const list = await import('../app/api/mobile/v2/claims/route');
const form = await import('../app/api/mobile/v2/claims/form/route');
const preview = await import('../app/api/mobile/v2/claims/mileage-preview/route');
const drafts = await import('../app/api/mobile/v2/claims/drafts/route');
const draftsSubmit = await import('../app/api/mobile/v2/claims/drafts/submit/route');
const one = await import('../app/api/mobile/v2/claims/[id]/route');
const receiptRoute = await import('../app/api/mobile/v2/claims/[id]/receipt/route');
const del = await import('../app/api/mobile/v2/claims/[id]/delete/route');
const cancel = await import('../app/api/mobile/v2/claims/[id]/cancel/route');
const tasks = await import('../app/api/mobile/v2/tasks/route');
const task = await import('../app/api/mobile/v2/tasks/[kind]/[id]/route');
const decision = await import('../app/api/mobile/v2/tasks/[kind]/[id]/decision/route');
const taskDocument = await import('../app/api/mobile/v2/tasks/[kind]/[id]/document/route');

let base: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const RECENT = addDays(TODAY, -2);
const URL0 = 'https://hr.example.com/api/mobile/v2/claims';
const TASKS = 'https://hr.example.com/api/mobile/v2/tasks';
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'latin1');

async function hire(name: string, role: 'employee' | 'manager' | 'hr_admin' = 'employee') {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@m11.test' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
type Person = Awaited<ReturnType<typeof hire>>;
const as = (who: Person) => { caller = who.ctx; };
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const get = async (handler: (r: Request) => Promise<Response>, path: string) => json(await handler(new Request(URL0 + path)));
const postJson = async (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  json(await handler(new Request(URL0 + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
/** A multipart claim upload exactly as the app sends it: a JSON `command` part and an optional `receipt` file. */
const upload = async (handler: (r: Request) => Promise<Response>, path: string, command: Record<string, unknown>, receipt?: { bytes: Uint8Array; name: string; type: string }) => {
  const data = new FormData();
  data.append('command', JSON.stringify(command));
  if (receipt) data.append('receipt', new File([receipt.bytes], receipt.name, { type: receipt.type }));
  return json(await handler(new Request(URL0 + path, { method: 'POST', body: data })));
};
const recorded = () => owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded'));
const claimRows = (employmentId: string) => owner.db.select({ id: schema.claimRequest.id, status: schema.claimRequest.status, amount: schema.claimRequest.amount })
  .from(schema.claimRequest).where(eq(schema.claimRequest.employmentId, employmentId)).orderBy(schema.claimRequest.id);
const attachmentsOf = (claimId: string) => owner.db.select({ id: schema.claimAttachment.id }).from(schema.claimAttachment).where(eq(schema.claimAttachment.claimRequestId, claimId));

let employee: Person, colleague: Person, manager: Person, meal: string, receiptType: string;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); blocked = false;
  employee = await hire('Aina Employee'); colleague = await hire('Badrul Colleague'); manager = await hire('Mohan Manager', 'manager');
  for (const p of [employee, colleague]) await setReportingLine(adminCtx(base), { subordinateEmploymentId: p.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
  ({ id: meal } = await createClaimType(adminCtx(base), { code: 'MEAL', name: 'Meals', defaultTaxable: false, requiresReceipt: false }));
  ({ id: receiptType } = await createClaimType(adminCtx(base), { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: true }));
});
const command = (over: Record<string, unknown> = {}) => ({ requestId: randomUUID(), claimTypeId: meal, amount: '42.50', incurredOn: RECENT, ...over });

describe('contract pins', () => {
  it('the receipt types and bound are the kernel’s', () => {
    expect([...CLAIM_RECEIPT_TYPES]).toEqual([...ALLOWED_RECEIPT_MIME]);
    expect(CLAIM_RECEIPT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('own selected employment only', () => {
  it('a manager cannot read a subordinate’s claim through the own endpoints; another employee gets not_found', async () => {
    const { id } = await submitClaimWithAttachment(employee.ctx, { employmentId: employee.employmentId, claimTypeId: meal, amount: 10, incurredOn: RECENT }, { fileName: 'r.png', mimeType: 'image/png', content: PNG });
    const [att] = await attachmentsOf(id);
    // Non-vacuity: RLS admits the manager to the subordinate's row through the canonical read.
    expect((await listClaimsForEmployment(manager.ctx, employee.employmentId)).map((c) => c.id)).toContain(id);
    as(manager);
    expect((await get(list.GET, '')).body).toMatchObject({ enabled: true, employmentId: manager.employmentId, items: [], nextCursor: null });
    expect((await get(one.GET, '/' + id)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await get(receiptRoute.GET, `/${id}/receipt?attachment=${att.id}`)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await postJson(cancel.POST, `/${id}/cancel`, { requestId: randomUUID() })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    // Naming the subordinate's employment answers "no claim-eligible employment of yours", never their rows.
    expect((await get(list.GET, `?employmentId=${employee.employmentId}`)).body).toMatchObject({ enabled: true, employmentId: null, items: [] });
    expect((await get(list.GET, '?employmentId=not-a-uuid')).status).toBe(400);
    as(colleague);
    expect((await get(one.GET, '/' + id)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await get(receiptRoute.GET, `/${id}/receipt?attachment=${att.id}`)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await get(one.GET, '/' + randomUUID())).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await get(one.GET, '/nope')).status).toBe(400);
    expect(await recorded()).toEqual([]);
    as(employee);
    const file = await receiptRoute.GET(new Request(`${URL0}/${id}/receipt?attachment=${att.id}`));
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await get(receiptRoute.GET, `/${id}/receipt?attachment=${randomUUID()}`)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    blocked = true;
    expect((await get(list.GET, '')).status).toBe(401);
  });

  it('pages newest first, neither repeating nor skipping; the status filter narrows; counts ignore it', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await submitClaimWithAttachment(employee.ctx, { employmentId: employee.employmentId, claimTypeId: meal, amount: 10 + i, incurredOn: addDays(RECENT, -i) }, null)).id);
    as(employee);
    expect((await postJson(cancel.POST, `/${ids[0]}/cancel`, { requestId: randomUUID() })).body).toEqual({ outcome: 'cancelled', id: ids[0] });
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page = await get(list.GET, '?limit=2' + (cursor ? '&cursor=' + cursor : ''));
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor; pages++;
      if (cursor) expect(decodeCursor(CLAIMS_CURSOR, cursor, ClaimsCursor)).not.toBeNull();
    } while (cursor && pages < 10);
    const canonical = (await listClaimsForEmployment(employee.ctx, employee.employmentId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1)).map((c) => c.id);
    expect(seen).toEqual(canonical);
    const pending = await get(list.GET, '?status=pending');
    expect(pending.body.items.map((i: { id: string }) => i.id).sort()).toEqual(ids.slice(1).sort());
    expect(pending.body.counts).toEqual({ draft: 0, pending: 4, approved: 0, rejected: 0, cancelled: 1, paid: 0 });
    expect(pending.body.items[0]).toMatchObject({ claimType: 'Meals', amountProvisional: false, status: 'pending', receiptCount: 0 });
    expect(pending.body.items.every((i: { amount: string }) => /^\d+\.\d{2}$/.test(i.amount))).toBe(true);
    expect((await get(list.GET, '?status=nope')).status).toBe(400);
    expect((await get(list.GET, '?cursor=garbage!')).status).toBe(400);
  });
});

describe('submit with a receipt', () => {
  it('files once: a replay returns the first answer, a different body under the same requestId is request_conflict', async () => {
    as(employee);
    const body = command();
    const first = await upload(list.POST, '', body, { bytes: PNG, name: 'lunch.png', type: 'application/octet-stream' });
    expect(first.body).toEqual({ outcome: 'submitted', id: expect.any(String) });
    expect((await upload(list.POST, '', body, { bytes: PNG, name: 'lunch.png', type: 'image/png' })).body, 'the declared type is never trusted, so it is not part of the intent').toEqual(first.body);
    expect((await upload(list.POST, '', { ...body, amount: '43.00' }, { bytes: PNG, name: 'lunch.png', type: 'image/png' })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect((await upload(list.POST, '', body, { bytes: PDF, name: 'lunch.png', type: 'image/png' })).body, 'other bytes under the same reference').toEqual({ outcome: 'refused', code: 'request_conflict' });
    const rows = await claimRows(employee.employmentId);
    expect(rows).toEqual([{ id: first.body.id, status: 'pending', amount: '42.50' }]);
    expect(await attachmentsOf(first.body.id)).toHaveLength(1);
    expect(await recorded()).toHaveLength(1);

    const [company] = await owner.db.select({ currency: schema.company.currency }).from(schema.company).where(eq(schema.company.id, base.companyId));
    const seen = await get(one.GET, '/' + first.body.id);
    expect(seen.body).toMatchObject({ outcome: 'found', claim: {
      id: first.body.id, claimType: 'Meals', amount: '42.50', amountProvisional: false, currency: company.currency, incurredOn: RECENT, status: 'pending',
      receipts: [{ fileName: 'lunch.png', sizeBytes: PNG.byteLength }], decision: null, payout: null,
      actions: { cancel: true, editDraft: false, deleteDraft: false, submitDraft: false },
    } });
    expect(seen.body.claim.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [stored] = await owner.db.select({ mime: schema.claimAttachment.mimeType }).from(schema.claimAttachment).where(eq(schema.claimAttachment.claimRequestId, first.body.id));
    expect(stored.mime, 'stored as SNIFFED, not as declared').toBe('image/png');
  });

  it('wrong type by its bytes, an empty file and an oversized one are typed refusals that record nothing', async () => {
    as(employee);
    expect((await upload(list.POST, '', command(), { bytes: Buffer.from('<html>not a receipt</html>'), name: 'r.pdf', type: 'application/pdf' })).body).toEqual({ outcome: 'refused', code: 'receipt_type' });
    expect((await upload(list.POST, '', command(), { bytes: new Uint8Array(), name: 'r.pdf', type: 'application/pdf' })).body).toEqual({ outcome: 'refused', code: 'receipt_empty' });
    const big = new Uint8Array(CLAIM_RECEIPT_MAX_BYTES + 1); big.set(PNG);
    expect((await upload(list.POST, '', command(), { bytes: big, name: 'r.png', type: 'image/png' })).body).toEqual({ outcome: 'refused', code: 'receipt_too_large' });
    expect(await claimRows(employee.employmentId)).toEqual([]);
    expect(await recorded()).toEqual([]);
    // A malformed command or an unknown part is a 400, never a guess.
    const bad = new FormData(); bad.append('command', '{"requestId":1}');
    expect((await list.POST(new Request(URL0, { method: 'POST', body: bad }))).status).toBe(400);
    const extra = new FormData(); extra.append('command', JSON.stringify(command())); extra.append('other', 'x');
    expect((await list.POST(new Request(URL0, { method: 'POST', body: extra }))).status).toBe(400);
  });

  it('the kernel’s refusal travels with its own sentence: a receipt-required type without one', async () => {
    as(employee);
    const out = await upload(list.POST, '', command({ claimTypeId: receiptType }));
    expect(out.body).toMatchObject({ outcome: 'refused', code: 'claim_refused' });
    expect(out.body.message).toMatch(/receipt is required/i);
    expect(await recorded()).toEqual([]);
    expect((await upload(list.POST, '', command({ claimTypeId: receiptType }), { bytes: PDF, name: 'ticket.pdf', type: 'application/pdf' })).body.outcome).toBe('submitted');
  });
});

describe('drafts (D11)', () => {
  it('a draft reserves nothing; edit then submit files the edits in one command', async () => {
    await setClaimPolicy(adminCtx(base), { claimTypeId: meal, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2024-01-01' });
    await createClaimFormField(adminCtx(base), { claimTypeId: meal, label: 'Client', kind: 'text', required: true });
    as(employee);
    const saved = await upload(drafts.POST, '', command({ amount: '80.00', fieldValues: {} }));
    expect(saved.body).toEqual({ outcome: 'saved', id: expect.any(String) });
    const options = await get(form.GET, '');
    const mealType = options.body.types.find((t: { id: string }) => t.id === meal);
    expect(mealType.balance).toMatchObject({ annualLimit: '1000.00', usedThisYear: '0.00', remainingThisYear: '1000.00' });
    expect(mealType.fields).toEqual([{ key: 'client', label: 'Client', kind: 'text', required: true, options: [] }]);
    expect(mealType).toMatchObject({ amountEntry: 'entered', fixedAmount: null, requiresReceipt: false });
    const draft = await get(one.GET, '/' + saved.body.id);
    expect(draft.body.claim).toMatchObject({ status: 'draft', amountProvisional: true, submittedAt: null, actions: { cancel: false, editDraft: true, deleteDraft: true, submitDraft: true } });

    // Submitting the draft as saved is the kernel's refusal (the required field), and nothing changes.
    const refused = await upload(list.POST, '', command({ draftId: saved.body.id, amount: '80.00' }));
    expect(refused.body).toMatchObject({ outcome: 'refused', code: 'claim_refused' });
    expect((await claimRows(employee.employmentId))[0]).toMatchObject({ status: 'draft', amount: '80.00' });
    // Edit then submit: the edited values are what is filed.
    const filed = await upload(list.POST, '', command({ draftId: saved.body.id, amount: '95.00', fieldValues: { client: 'Acme' } }), { bytes: PNG, name: 'r.png', type: 'image/png' });
    expect(filed.body).toEqual({ outcome: 'submitted', id: saved.body.id });
    expect(await claimRows(employee.employmentId)).toEqual([{ id: saved.body.id, status: 'pending', amount: '95.00' }]);
    const detail = await get(one.GET, '/' + saved.body.id);
    expect(detail.body.claim.fields).toEqual([{ key: 'client', label: 'Client', kind: 'text', value: 'Acme' }]);
    expect(detail.body.claim.receipts).toHaveLength(1);
    expect((await get(form.GET, '')).body.types.find((t: { id: string }) => t.id === meal).balance.usedThisYear).toBe('95.00');
  });

  it('a limit lowered between saving and submitting is refused by the kernel at submit', async () => {
    await setClaimPolicy(adminCtx(base), { claimTypeId: meal, annualBudget: 100, perClaimCap: null, effectiveFrom: '2024-01-01' });
    as(employee);
    const saved = await upload(drafts.POST, '', command({ amount: '80.00' }));
    await setClaimPolicy(adminCtx(base), { claimTypeId: meal, annualBudget: 50, perClaimCap: null, effectiveFrom: '2024-06-01' });
    const out = await postJson(draftsSubmit.POST, '/drafts/submit', { requestId: randomUUID(), ids: [saved.body.id] });
    expect(out.body).toMatchObject({ outcome: 'refused', code: 'claim_refused' });
    expect(out.body.message).toMatch(/annual limit/i);
    expect((await claimRows(employee.employmentId))[0].status).toBe('draft');
    expect(await recorded(), 'only the draft save was recorded').toHaveLength(1);
    await setClaimPolicy(adminCtx(base), { claimTypeId: meal, annualBudget: 200, perClaimCap: null, effectiveFrom: '2024-09-01' });
    const ok = await postJson(draftsSubmit.POST, '/drafts/submit', { requestId: randomUUID(), ids: [saved.body.id] });
    expect(ok.body).toEqual({ outcome: 'submitted', ids: [saved.body.id], submitted: 1 });
  });

  it('delete replays after the row is gone; another reference finds nothing; a colleague cannot touch it', async () => {
    as(employee);
    const saved = await upload(drafts.POST, '', command(), { bytes: PNG, name: 'r.png', type: 'image/png' });
    as(colleague);
    expect((await postJson(del.POST, `/${saved.body.id}/delete`, { requestId: randomUUID() })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await upload(drafts.POST, '', command({ draftId: saved.body.id }))).body).toEqual({ outcome: 'refused', code: 'not_found' });
    as(employee);
    const requestId = randomUUID();
    expect((await postJson(del.POST, `/${saved.body.id}/delete`, { requestId })).body).toEqual({ outcome: 'deleted', id: saved.body.id });
    expect((await postJson(del.POST, `/${saved.body.id}/delete`, { requestId })).body).toEqual({ outcome: 'deleted', id: saved.body.id });
    expect((await postJson(del.POST, `/${saved.body.id}/delete`, { requestId: randomUUID() })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect(await claimRows(employee.employmentId)).toEqual([]);
  });

  it('cancel releases a pending claim once; a second cancel is the kernel’s refusal', async () => {
    as(employee);
    const filed = await upload(list.POST, '', command());
    expect((await postJson(cancel.POST, `/${filed.body.id}/cancel`, { requestId: randomUUID() })).body).toEqual({ outcome: 'cancelled', id: filed.body.id });
    const again = await postJson(cancel.POST, `/${filed.body.id}/cancel`, { requestId: randomUUID() });
    expect(again.body).toMatchObject({ outcome: 'refused', code: 'claim_refused' });
    expect(again.body.message).toMatch(/pending/);
    expect((await get(one.GET, '/' + filed.body.id)).body.claim).toMatchObject({ status: 'cancelled', actions: { cancel: false } });
  });
});

describe('mileage', () => {
  it('the preview is the kernel’s figure and the amount submit stores', async () => {
    const { id: mile } = await createClaimType(adminCtx(base), { code: 'MILE', name: 'Mileage', defaultTaxable: false, requiresReceipt: false, isMileage: true });
    await setMileageRateTable(adminCtx(base), { claimTypeId: mile, effectiveFrom: '2024-01-01', bands: [{ fromKm: 0, toKm: 500, ratePerKm: 0.6 }, { fromKm: 500, toKm: null, ratePerKm: 0.45 }] });
    as(employee);
    expect((await get(form.GET, '')).body.types.find((t: { id: string }) => t.id === mile)).toMatchObject({ amountEntry: 'distance', fixedAmount: null });
    const priced = await get(preview.GET, `/mileage-preview?claimTypeId=${mile}&km=700&incurredOn=${RECENT}`);
    expect(priced.body).toEqual({ outcome: 'priced', amount: '390.00', tableValidFrom: '2024-01-01', bands: [
      { fromKm: '0', toKm: '500', ratePerKm: '0.6', km: '500', amount: '300.00' },
      { fromKm: '500', toKm: null, ratePerKm: '0.45', km: '200', amount: '90.00' },
    ] });
    const filed = await upload(list.POST, '', command({ claimTypeId: mile, amount: undefined, quantityKm: '700' }));
    expect(filed.body.outcome).toBe('submitted');
    const detail = await get(one.GET, '/' + filed.body.id);
    expect(detail.body.claim).toMatchObject({ amount: '390.00', quantityKm: '700', mileage: { tableValidFrom: '2024-01-01', bands: priced.body.bands } });
    expect((await get(preview.GET, `/mileage-preview?claimTypeId=${meal}&km=10&incurredOn=${RECENT}`)).body).toMatchObject({ outcome: 'refused', code: 'claim_refused' });
    expect((await get(preview.GET, `/mileage-preview?claimTypeId=${randomUUID()}&km=10&incurredOn=${RECENT}`)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await get(preview.GET, `/mileage-preview?claimTypeId=${mile}&km=-1&incurredOn=${RECENT}`)).status).toBe(400);
  });
});

describe('who may claim', () => {
  it('an offboarded caller has no claim-eligible employment: empty, and every command refused', async () => {
    as(employee);
    const saved = await upload(drafts.POST, '', command());
    await owner.db.update(schema.employment).set({ resignationDate: addDays(TODAY, -10), lastWorkingDate: addDays(TODAY, -5) }).where(eq(schema.employment.id, employee.employmentId));
    expect((await get(list.GET, '')).body).toMatchObject({ enabled: true, employmentId: null, items: [] });
    expect((await get(form.GET, '')).body).toMatchObject({ enabled: true, employmentId: null, types: [] });
    expect((await upload(list.POST, '', command())).body).toEqual({ outcome: 'refused', code: 'no_employment' });
    expect((await postJson(del.POST, `/${saved.body.id}/delete`, { requestId: randomUUID() })).body).toEqual({ outcome: 'refused', code: 'no_employment' });
    expect((await get(one.GET, '/' + saved.body.id)).body).toEqual({ outcome: 'refused', code: 'not_found' });
  });

  it('a tenant without Claims: disabled list and form, commands refused claims_off', async () => {
    await setModule(base.tenantId, 'claims', 'disabled');
    caller = { ...employee.ctx, entitlements: harnessSnapshot(base.tenantId) };
    expect((await get(list.GET, '')).body).toMatchObject({ enabled: false, employmentId: null, items: [] });
    expect((await get(form.GET, '')).body).toMatchObject({ enabled: false, types: [] });
    expect((await upload(list.POST, '', command())).body).toEqual({ outcome: 'refused', code: 'claims_off' });
    expect((await get(preview.GET, `/mileage-preview?claimTypeId=${meal}&km=10&incurredOn=${RECENT}`)).body).toEqual({ outcome: 'refused', code: 'claims_off' });
  });
});

describe('the approver’s claim task (D12)', () => {
  const taskGet = async (path: string) => json(await (path === '' || path.startsWith('?') ? tasks.GET : task.GET)(new Request(TASKS + path)));
  const decide = async (id: string, body: Record<string, unknown>) =>
    json(await decision.POST(new Request(`${TASKS}/claim/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
  async function filed(who: Person = employee) {
    as(who);
    await createClaimFormField(adminCtx(base), { claimTypeId: meal, label: 'Client', kind: 'text' });
    const out = await upload(list.POST, '', command({ fieldValues: { client: 'Acme' }, description: 'Team lunch' }), { bytes: PNG, name: 'lunch.png', type: 'image/png' });
    expect(out.body.outcome).toBe('submitted');
    return out.body.id as string;
  }

  it('is a native task with its facts and receipts; only the assigned approver opens a receipt', async () => {
    const id = await filed();
    as(manager);
    const items = (await taskGet('')).body.items as { id: string; kind: string; nativeDecision: boolean; webPath: string | null }[];
    expect(items).toContainEqual(expect.objectContaining({ id, kind: 'claim', nativeDecision: true, webPath: null }));
    const seen = await taskGet(`/claim/${id}`);
    expect(seen.body).toMatchObject({ outcome: 'found', task: {
      kind: 'claim', id, subject: { name: 'Aina Employee' }, claimType: 'Meals', amount: '42.50', incurredOn: RECENT, employeeReason: 'Team lunch',
      fields: [{ key: 'client', label: 'Client', kind: 'text', value: 'Acme' }], receipts: [{ fileName: 'lunch.png', sizeBytes: PNG.byteLength }],
      reasonRequiredToReject: true, expected: { status: 'pending' },
    } });
    const receiptId = seen.body.task.receipts[0].id;
    const file = await taskDocument.GET(new Request(`${TASKS}/claim/${id}/document?attachment=${receiptId}`));
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect(await (await taskDocument.GET(new Request(`${TASKS}/claim/${id}/document?attachment=${randomUUID()}`))).json()).toEqual({ outcome: 'refused', code: 'no_document' });
    expect((await taskDocument.GET(new Request(`${TASKS}/claim/${id}/document`))).status).toBe(400);
    as(colleague);
    expect((await taskGet(`/claim/${id}`)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect(await (await taskDocument.GET(new Request(`${TASKS}/claim/${id}/document?attachment=${receiptId}`))).json()).toEqual({ outcome: 'refused', code: 'not_assigned' });
    as(employee);
    expect((await taskGet(`/claim/${id}`)).body).toEqual({ outcome: 'refused', code: 'self_approval' });
    expect((await decide(id, { requestId: randomUUID(), decision: 'approve', expected: { status: 'pending' } })).body).toEqual({ outcome: 'refused', code: 'self_approval' });
  });

  it('a rejection needs a reason; with one it rejects, the employee reads it, and the claim is then already_decided', async () => {
    const id = await filed();
    as(manager);
    for (const reason of [undefined, '   ']) {
      expect((await decide(id, { requestId: randomUUID(), decision: 'reject', ...(reason === undefined ? {} : { reason }), expected: { status: 'pending' } })).body).toEqual({ outcome: 'refused', code: 'reason_required' });
    }
    expect((await decide(id, { requestId: randomUUID(), decision: 'reject', reason: 'x', expected: { stepIndex: 0 } })).status, 'another kind’s expected state').toBe(400);
    const before = (await recorded()).length;
    const body = { requestId: randomUUID(), decision: 'reject', reason: 'Personal meal', expected: { status: 'pending' } };
    expect((await decide(id, body)).body).toEqual({ outcome: 'accepted', status: 'rejected' });
    expect((await decide(id, body)).body, 'a lost answer replays').toEqual({ outcome: 'accepted', status: 'rejected' });
    expect((await recorded()).length).toBe(before + 1);
    expect((await taskGet(`/claim/${id}`)).body).toEqual({ outcome: 'refused', code: 'already_decided' });
    expect((await decide(id, { requestId: randomUUID(), decision: 'approve', expected: { status: 'pending' } })).body).toEqual({ outcome: 'refused', code: 'already_decided' });
    as(employee);
    expect((await get(one.GET, '/' + id)).body.claim).toMatchObject({ status: 'rejected', decision: { rejectReason: 'Personal meal' }, actions: { cancel: false, editDraft: false } });
    const [row] = await owner.db.select({ decidedBy: schema.claimRequest.decidedByEmploymentId }).from(schema.claimRequest).where(eq(schema.claimRequest.id, id));
    expect(row.decidedBy, 'the decider is the caller’s own employment').toBe(manager.employmentId);
  });

  it('an approval goes through decideClaim; the payout route follows; a draft is nobody’s task', async () => {
    const id = await filed();
    as(manager);
    expect((await decide(id, { requestId: randomUUID(), decision: 'approve', expected: { status: 'pending' } })).body).toEqual({ outcome: 'accepted', status: 'approved' });
    as(employee);
    expect((await get(one.GET, '/' + id)).body.claim).toMatchObject({ status: 'approved', payout: { route: 'reimbursement', scheduledInPayroll: false, paidAt: null } });
    const saved = await upload(drafts.POST, '', command());
    as(manager);
    expect((await taskGet(`/claim/${saved.body.id}`)).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    expect((await decide(saved.body.id, { requestId: randomUUID(), decision: 'approve', expected: { status: 'pending' } })).body).toEqual({ outcome: 'refused', code: 'not_assigned' });
    const [draftRow] = await owner.db.select({ s: schema.claimRequest.status }).from(schema.claimRequest).where(and(eq(schema.claimRequest.id, saved.body.id)));
    expect(draftRow.s).toBe('draft');
  });
});
