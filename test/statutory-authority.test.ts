/**
 * R46 orgbank (84719377) — per-authority statutory payment configuration.
 *
 * Covers the net-new service: upsert is keyed on (company, authority); the two cross-entity references
 * (bank account, signatory person) are validated server-side rather than trusted from the form; the FK
 * delete behaviour unroutes rather than destroys; and the payment account number stays OUT of the
 * append-only event payload (ADR-0030 Layer-0, mirroring core/bank-profile.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { upsertCompanyBankProfile, removeCompanyBankProfile } from '../core/bank-profile';
import {
  listCompanyStatutoryAuthorities,
  removeCompanyStatutoryAuthority,
  upsertCompanyStatutoryAuthority,
  STATUTORY_AUTHORITIES,
} from '../core/statutory-authority';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

/** An employed person in `companyId`, optionally already terminated. Returns the person id. */
async function seedEmployee(companyId: string, opts: { terminated?: boolean } = {}) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'Signatory One', primaryEmail: `sig_${randomUUID()}@acme.test` })
    .returning({ id: schema.person.id });
  await owner.db.insert(schema.employment).values({
    tenantId: b.tenantId,
    companyId,
    personId: p.id,
    hiredOn: '2024-01-01',
    terminatedOn: opts.terminated ? '2024-06-30' : null,
  });
  return p.id;
}

describe('company statutory authority (R46 orgbank)', () => {
  it('creates a row per authority, lists it, and appends a set event', async () => {
    const ctx = adminCtx(b);
    const { id } = await upsertCompanyStatutoryAuthority(ctx, {
      companyId: b.companyId,
      authority: 'epf',
      accountNo: 'EPF-PAY-001',
      addressLine1: 'Bangunan KWSP',
      city: 'Kuala Lumpur',
      postcode: '50350',
      phone: '03-8922 6000',
    });
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ authority: 'epf', accountNo: 'EPF-PAY-001', city: 'Kuala Lumpur' });
    expect(await eventTypesFor(b.tenantId, id)).toContain('company-statutory-authority.set');
  });

  it('is keyed on (company, authority) — a second save updates rather than duplicating', async () => {
    const ctx = adminCtx(b);
    const first = await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'socso', phone: '03-1111' });
    const second = await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'socso', phone: '03-2222' });
    expect(second.id).toBe(first.id);
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list).toHaveLength(1);
    expect(list[0].phone).toBe('03-2222');
  });

  it('holds every authority in the controlled set side by side', async () => {
    const ctx = adminCtx(b);
    for (const a of STATUTORY_AUTHORITIES) {
      await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: a });
    }
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list.map((r) => r.authority).sort()).toEqual([...STATUTORY_AUTHORITIES].sort());
  });

  it('rejects an authority outside the controlled set', async () => {
    const ctx = adminCtx(b);
    await expect(
      upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'not_an_authority' }),
    ).rejects.toThrow(/authority/i);
  });

  it('routes payment to one of the company own bank accounts', async () => {
    const ctx = adminCtx(b);
    const bp = await upsertCompanyBankProfile(ctx, {
      companyId: b.companyId,
      bank: 'maybank',
      corporateId: 'C1',
      debitAccountNo: '111',
    });
    await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'lhdn', bankProfileId: bp.id });
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list[0].bankProfileId).toBe(bp.id);
  });

  it('refuses a bank account belonging to a different company', async () => {
    const ctx = adminCtx(b);
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    const foreign = await upsertCompanyBankProfile(ctx, {
      companyId: other.id,
      bank: 'cimb',
      corporateId: 'C2',
      debitAccountNo: '222',
    });
    await expect(
      upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'epf', bankProfileId: foreign.id }),
    ).rejects.toThrow(/belonging to this company/i);
  });

  // Deleting an account must UNROUTE the authority, not delete its address / contact / signatory setup.
  it('unroutes rather than deletes when the bank account is removed', async () => {
    const ctx = adminCtx(b);
    const bp = await upsertCompanyBankProfile(ctx, {
      companyId: b.companyId,
      bank: 'rhb',
      corporateId: 'C1',
      debitAccountNo: '111',
    });
    await upsertCompanyStatutoryAuthority(ctx, {
      companyId: b.companyId,
      authority: 'hrdf',
      bankProfileId: bp.id,
      phone: '03-3333',
    });
    await removeCompanyBankProfile(ctx, { id: bp.id });
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list).toHaveLength(1);
    expect(list[0].bankProfileId).toBeNull();
    expect(list[0].phone).toBe('03-3333');
  });

  it('accepts an active employee of the company as signatory', async () => {
    const ctx = adminCtx(b);
    const personId = await seedEmployee(b.companyId);
    await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'zakat', signatoryPersonId: personId });
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list[0].signatoryPersonId).toBe(personId);
  });

  it('refuses to newly appoint a terminated employee as signatory', async () => {
    const ctx = adminCtx(b);
    const personId = await seedEmployee(b.companyId, { terminated: true });
    await expect(
      upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'ptptn', signatoryPersonId: personId }),
    ).rejects.toThrow(/active employee/i);
  });

  // The archived-employee case: an incumbent who leaves must not block edits to the rest of the row, nor be
  // silently wiped from it.
  it('keeps an unchanged signatory editable after they leave', async () => {
    const ctx = adminCtx(b);
    const personId = await seedEmployee(b.companyId);
    await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'eis', signatoryPersonId: personId });
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2024-06-30' })
      .where(eq(schema.employment.personId, personId));
    await upsertCompanyStatutoryAuthority(ctx, {
      companyId: b.companyId,
      authority: 'eis',
      signatoryPersonId: personId,
      phone: '03-9999',
    });
    const list = await listCompanyStatutoryAuthorities(ctx, b.companyId);
    expect(list[0]).toMatchObject({ signatoryPersonId: personId, phone: '03-9999' });
  });

  it('refuses an employee of a different company as signatory', async () => {
    const ctx = adminCtx(b);
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    const personId = await seedEmployee(other.id);
    await expect(
      upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'epf', signatoryPersonId: personId }),
    ).rejects.toThrow(/active employee/i);
  });

  it('keeps the payment account number OUT of the event payload (ADR-0030 Layer-0)', async () => {
    const ctx = adminCtx(b);
    const { id } = await upsertCompanyStatutoryAuthority(ctx, {
      companyId: b.companyId,
      authority: 'epf',
      accountNo: 'SECRETEPFACCT',
    });
    const rows = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const blob = JSON.stringify(rows.map((r) => r.payload));
    expect(blob).not.toContain('SECRETEPFACCT');
    expect(blob).toContain('epf'); // the authority reference itself is fine to log
    expect(blob).toContain('hasAccountNo');
  });

  it('removes a row and appends a removed event', async () => {
    const ctx = adminCtx(b);
    // efe424b0 (r327) — this fixture was 'koperasi' until that authority was retired. The authority is
    // INCIDENTAL to what the case tests (a row goes, an event is appended), so it takes another small
    // one rather than the case being weakened.
    const { id } = await upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority: 'ptptn' });
    await removeCompanyStatutoryAuthority(ctx, { id });
    expect(await listCompanyStatutoryAuthorities(ctx, b.companyId)).toHaveLength(0);
    expect(await eventTypesFor(b.tenantId, id)).toContain('company-statutory-authority.removed');
  });

  /**
   * efe424b0 (r327) — RETIRING AN AUTHORITY MUST MAKE IT UNWRITABLE, and that is the property this case
   * exists for rather than 'koperasi' in particular.
   *
   * Removing a body from STATUTORY_AUTHORITIES is a one-line change with no migration (the list is
   * controlled in code, not a pgEnum — see lib/statutory-authorities.ts). What makes that safe is that
   * `isStatutoryAuthority` then rejects the string at the service door, so a stale value from an old
   * form post, a bookmark or an import cannot write a row nothing can render. The gate found this the
   * moment koperasi went: a fixture using it stopped working, which is the guard doing its job.
   */
  it('refuses an authority that is not in the controlled set', async () => {
    const ctx = adminCtx(b);
    for (const authority of ['koperasi', 'nonsense', '']) {
      await expect(
        upsertCompanyStatutoryAuthority(ctx, { companyId: b.companyId, authority }),
        `${authority || '(empty)'} must be refused at the door`,
      ).rejects.toThrow(/Unknown statutory authority/i);
    }
    expect(await listCompanyStatutoryAuthorities(ctx, b.companyId), 'and nothing was written').toHaveLength(0);
  });
});
