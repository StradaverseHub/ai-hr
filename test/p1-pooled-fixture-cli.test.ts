/** Actual receipt publication/reuse/clear on a private clone, not just the transaction helper seam. */
import { it, expect, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID } from '../db/seed-guard';
import { todayInKualaLumpur } from '../lib/hr-date';
import { templateDb } from './db-names';
import { owner, closeAll } from './harness';
afterAll(closeAll);

it('real CLI receipt custody preserves unowned rows and refuses changed or publicly readable receipts', async () => {
  const name = 'ai_hr_fixture_pooled_leave', url = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
  url.pathname = '/' + name; url.search = '';
  const receipts = mkdtempSync(join(tmpdir(), 'pooled-cli-receipts-'));
  let created = false, fixture: ReturnType<typeof createDb> | undefined;
  try {
    await owner.client.unsafe(`create database "${name}" template "${templateDb()}"`); created = true;
    fixture = createDb(url.toString());
    const db = fixture.db;
    await db.insert(s.tenant).values({ id: DEMO_TENANT_ID, workosOrgId: 'org_pooled_cli', name: 'Fictional CLI demo' });
    const [company] = await db.insert(s.company).values({ tenantId: DEMO_TENANT_ID, legalName: 'Fictional fixture company' }).returning();
    const [person] = await db.insert(s.person).values({ tenantId: DEMO_TENANT_ID, fullName: 'Fictional fixture person' }).returning();
    const [employment] = await db.insert(s.employment).values({ tenantId: DEMO_TENANT_ID, companyId: company.id, personId: person.id, hiredOn: '2020-01-01' }).returning();
    const types = await db.insert(s.leaveType).values(['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY'].map(code => ({ tenantId: DEMO_TENANT_ID, code, name: code }))).returning();
    const pool = types.find(t => t.code === 'SICK')!, borrower = types.find(t => t.code === 'HOSPITALIZATION')!, prior = types.find(t => t.code === 'ANNUAL')!;
    await db.update(s.leaveType).set({ balanceSourceTypeId: prior.id }).where(eq(s.leaveType.id, borrower.id));
    const year = todayInKualaLumpur().slice(0, 4);
    await db.insert(s.leaveLedger).values({ tenantId: DEMO_TENANT_ID, employmentId: employment.id, leaveTypeId: pool.id, entryType: 'accrual', days: '14', effectiveOn: `${year}-01-01` });
    const [unowned] = await db.insert(s.leaveRequest).values({ tenantId: DEMO_TENANT_ID, employmentId: employment.id, leaveTypeId: pool.id, startDate: `${year}-01-12`, endDate: `${year}-01-13`, days: '1', status: 'approved' }).returning();
    const ledger = await db.select().from(s.leaveLedger).orderBy(s.leaveLedger.id);
    const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/dev-fixture-pooled-leave.ts'), ...args], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test',
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/no_database', MIGRATION_DATABASE_URL: url.toString(), AIHR_FIXTURE_RECEIPT_DIR: receipts },
    });
    const refused = run('--clear'); expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain('No owned fixture receipt');
    expect(await db.select().from(s.leaveRequest)).toEqual([unowned]);
    const prepared = run(); expect(prepared.error).toBeUndefined(); expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const file = join(receipts, readdirSync(receipts).find(file => file.endsWith('.json'))!);
    const receipt = JSON.parse(readFileSync(file, 'utf8')).receipt;
    expect(receipt.requests).toHaveLength(1); expect(receipt.requests[0].id).not.toBe(unowned.id);
    const rerun = run(); expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
    expect(await db.select().from(s.leaveRequest)).toHaveLength(2);
    chmodSync(file, 0o644);
    const publicReceipt = run('--clear'); expect(publicReceipt.status).toBe(1);
    expect(publicReceipt.stdout + publicReceipt.stderr).toContain('Invalid private fixture receipt');
    chmodSync(file, 0o600);
    const ownedId = receipt.requests[0].id;
    await db.update(s.leaveRequest).set({ reason: 'Later human edit' }).where(eq(s.leaveRequest.id, ownedId));
    const changed = run('--clear'); expect(changed.status).toBe(1); expect(changed.stdout + changed.stderr).toContain('rows changed');
    expect((await db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id, ownedId)))[0].reason).toBe('Later human edit');
    // The test owns this edit. Restore only its exact field before exercising the allowed cleanup.
    await db.update(s.leaveRequest).set({ reason: receipt.requests[0].reason }).where(eq(s.leaveRequest.id, ownedId));
    const cleared = run('--clear'); expect(cleared.status, cleared.stdout + cleared.stderr).toBe(0);
    expect(await db.select().from(s.leaveRequest)).toEqual([unowned]);
    expect(await db.select().from(s.leaveSharedGroup)).toEqual([]);
    expect((await db.select().from(s.leaveType).where(eq(s.leaveType.id, borrower.id)))[0].balanceSourceTypeId).toBe(prior.id);
    expect(await db.select().from(s.leaveLedger).orderBy(s.leaveLedger.id)).toEqual(ledger);
    expect(readdirSync(receipts)).toEqual([]);
  } finally {
    if (fixture) await fixture.client.end();
    if (created) await owner.client.unsafe(`drop database "${name}"`);
    rmSync(receipts, { recursive: true, force: true });
  }
}, 180000);
