import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { setEmploymentCardId } from '../core/attendance-card';
import { previewCardImport, commitCardImport, cardImportExisting } from '../core/attendance-card-import';
import { buildCardImportWorkbook } from '../lib/card-import-workbook';

let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });

async function employee(code: string, cardId: string | null = null, companyId = b.companyId, tenantId = b.tenantId) {
  const [p] = await owner.db.insert(schema.person).values({ tenantId, fullName: `Card fixture ${code}` }).returning();
  const [e] = await owner.db.insert(schema.employment).values({ tenantId, personId: p.id, companyId, employeeCode: code, cardId, hiredOn: '2020-01-01' }).returning();
  return e;
}
function workbook(rows: [string, string, string][]) {
  const wb = XLSX.read(buildCardImportWorkbook(), { type: 'buffer' });
  XLSX.utils.sheet_add_aoa(wb.Sheets['Card Assignments'], rows, { origin: 'A3' });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}
async function card(id: string) { return (await owner.db.select().from(schema.employment).where(eq(schema.employment.id, id)))[0].cardId; }
async function eventCount() { return (await owner.db.select().from(schema.domainEvent)).length; }

describe('Card Assignment import uses canonical assignments and audit', () => {
  it('preview and cancel are write-free; confirmed leading-zero assignments persist once', async () => {
    const e = await employee('0007'); const ctx = adminCtx(b), scope = [b.companyId];
    const bytes = workbook([['0007', '0010', 'assign']]), before = await eventCount();
    const preview = await previewCardImport(ctx, scope, bytes, 'cards.xlsx');
    expect(preview.rows[0].effect).toBe('assign'); expect(await card(e.id)).toBeNull(); expect(await eventCount()).toBe(before);
    const result = await commitCardImport(ctx, scope, bytes, 'cards.xlsx', preview.receipt, [3], false);
    expect(result.imported).toBe(1); expect(await card(e.id)).toBe('0010');
    const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, e.id));
    expect(events).toHaveLength(1); expect(events[0].actorId).toBe(ctx.userId);
    expect(events[0].payload).toMatchObject({ from: null, to: '0010', importSource: { fileName: 'cards.xlsx', row: 3 } });
    const replay = await commitCardImport(ctx, scope, bytes, 'cards.xlsx', preview.receipt, [3], false);
    expect(replay.failed).toBe(1); expect(await eventCount()).toBe(before + 1);
  });
  it('requires explicit replacement/reset confirmation, and blank cells do not clear', async () => {
    const e = await employee('E1', 'old'), ctx = adminCtx(b), scope = [b.companyId];
    const blank = workbook([['E1', '', 'assign']]), blankPreview = await previewCardImport(ctx, scope, blank, 'blank.xlsx');
    expect((await commitCardImport(ctx, scope, blank, 'blank.xlsx', blankPreview.receipt, [3], false)).unchanged).toBe(1);
    expect(await card(e.id)).toBe('old');
    const bytes = workbook([['e1', 'new', 'replace']]), preview = await previewCardImport(ctx, scope, bytes, 'replace.xlsx');
    expect((await commitCardImport(ctx, scope, bytes, 'replace.xlsx', preview.receipt, [3], false)).rows[0].issues).toContain('confirmationRequired');
    expect(await card(e.id)).toBe('old');
    expect((await commitCardImport(ctx, scope, bytes, 'replace.xlsx', preview.receipt, [3], true)).updated).toBe(1);
    const reset = workbook([['E1', '', 'reset']]), review = await previewCardImport(ctx, scope, reset, 'reset.xlsx');
    expect((await commitCardImport(ctx, scope, reset, 'reset.xlsx', review.receipt, [3], true)).updated).toBe(1);
    expect(await card(e.id)).toBeNull();
  });
  it('blocks every duplicate before import and accounts separately for valid, failed and skipped rows', async () => {
    const a = await employee('E1'), c = await employee('E2'), d = await employee('E3');
    const bytes = workbook([['E1', 'same', 'assign'], ['E2', 'SAME', 'assign'], ['E3', 'own', 'assign'], ['missing', 'unknown', 'assign']]);
    const ctx = adminCtx(b), scope = [b.companyId], preview = await previewCardImport(ctx, scope, bytes, 'mixed.xlsx');
    expect(preview.rows.slice(0, 2).every(row => row.issues.includes('duplicateCard'))).toBe(true);
    const result = await commitCardImport(ctx, scope, bytes, 'mixed.xlsx', preview.receipt, [], false);
    expect(result).toMatchObject({ total: 4, imported: 0, updated: 0, unchanged: 0, failed: 3, skipped: 1 });
    expect(await card(a.id)).toBeNull(); expect(await card(c.id)).toBeNull(); expect(await card(d.id)).toBeNull();
  });
  it('refuses stale card values and altered review/file/scope without overwriting', async () => {
    const e = await employee('E1'), ctx = adminCtx(b), scope = [b.companyId], bytes = workbook([['E1', 'first', 'assign']]);
    const preview = await previewCardImport(ctx, scope, bytes, 'cards.xlsx');
    await setEmploymentCardId(ctx, { employmentId: e.id, cardId: 'later' });
    expect((await commitCardImport(ctx, scope, bytes, 'cards.xlsx', preview.receipt, [3], false)).failed).toBe(1);
    expect(await card(e.id)).toBe('later');
    await expect(commitCardImport(ctx, scope, bytes, 'different.xlsx', preview.receipt, [3], false)).rejects.toThrow('invalidReview');
    await expect(commitCardImport(ctx, scope, bytes, 'cards.xlsx', preview.receipt + 'tamper', [3], false)).rejects.toThrow('invalidReview');
    await expect(commitCardImport(ctx, [randomUUID()], bytes, 'cards.xlsx', preview.receipt, [3], false)).rejects.toThrow('invalidReview');
  });
  it('a concurrent assignment has one winner, including different card letter case', async () => {
    const a = await employee('E1'), c = await employee('E2'), ctx = adminCtx(b);
    const outcomes = await Promise.allSettled([
      setEmploymentCardId(ctx, { employmentId: a.id, cardId: 'shared' }),
      setEmploymentCardId(ctx, { employmentId: c.id, cardId: 'SHARED' }),
    ]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect([await card(a.id), await card(c.id)].filter(Boolean)).toHaveLength(1);
  });
  it('guards direct Personnel/code/IC writers as well as workbook writes', async () => {
    const a = await employee('E1', '900101015555'), c = await employee('E2');
    await expect(owner.db.update(schema.employment).set({ employeeCode: '900101015555' }).where(eq(schema.employment.id, c.id))).rejects.toThrow();
    await expect(owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: c.personId, icNumber: '900101-01-5555' })).rejects.toThrow();
    expect(await card(a.id)).toBe('900101015555');
  });
  it('detects hidden-company conflicts without returning its holder; other tenants are independent', async () => {
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Hidden company', registrationNo: randomUUID() }).returning();
    await employee('HIDDEN-STAFF', 'private-card', other.id);
    await employee('VISIBLE');
    await owner.db.update(schema.roleAssignment).set({ companyId: b.companyId }).where(eq(schema.roleAssignment.appUserId, b.adminUserId));
    const ctx = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: b.companyId }] };
    const preview = await previewCardImport(ctx, [b.companyId], workbook([['VISIBLE', 'PRIVATE-CARD', 'assign']]), 'cards.xlsx');
    expect(preview.rows[0].issues).toContain('cardConflict'); expect(JSON.stringify(preview)).not.toContain('HIDDEN-STAFF');
    const foreign = await seedBase(), foreignCtx = adminCtx(foreign), e = await employee('FOREIGN', null, foreign.companyId, foreign.tenantId);
    await expect(setEmploymentCardId(foreignCtx, { employmentId: e.id, cardId: 'private-card' })).resolves.toBeUndefined();
    await expect(cardImportExisting(ctx, [foreign.companyId])).rejects.toThrow('scope');
  });
  it('a revoked or archived login cannot confirm an earlier preview', async () => {
    await employee('E1'); const ctx = adminCtx(b), scope = [b.companyId], bytes = workbook([['E1', 'C1', 'assign']]);
    const preview = await previewCardImport(ctx, scope, bytes, 'cards.xlsx');
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, b.adminUserId));
    await expect(commitCardImport(ctx, scope, bytes, 'cards.xlsx', preview.receipt, [3], false)).rejects.toThrow('scope');
  });
  it('an unauthorized direct setter cannot write or append a misleading audit', async () => {
    const e = await employee('E1'), before = await eventCount();
    const ctx: SessionContext = { ...adminCtx(b), roles: ['employee'] };
    await expect(withTenant(ctx, tx => setEmploymentCardId(ctx, { employmentId: e.id, cardId: 'C1' }, tx))).rejects.toThrow();
    expect(await card(e.id)).toBeNull(); expect(await eventCount()).toBe(before);
  });
});
