/**
 * Enhance Company General Tab (bc5d4891) — Company Information + Contact Information master data.
 *
 * The General tab gains net-new nullable columns (company_label, industry, website, business_type, three
 * address lines, city, state, address_country, postcode, phone, fax) persisted through updateCompany. These
 * tests assert:
 *   1. every new field round-trips through updateCompany and reads back via listCompanies;
 *   2. a blank/whitespace value persists as NULL (empty -> cleared);
 *   3. a field the caller OMITS is left untouched (tri-state — no accidental wipe);
 *   4. an existing (never-edited) company reads the new fields as NULL — byte-identical to today;
 *   5. the display-only address country never overrides company.country (the holiday/statutory driver);
 *   6. an invalid Website is rejected;
 *   7. the write still appends a company.updated domain event (substrate discipline).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { updateCompany } from '../core/admin';
import { listCompanies } from '../core/read';

async function row(id: string) {
  const [r] = await owner.db.select().from(schema.company).where(eq(schema.company.id, id));
  return r;
}

describe('Enhance Company General Tab (bc5d4891)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('round-trips every new Company + Contact field through updateCompany', async () => {
    const ctx = adminCtx(base);
    await updateCompany(ctx, {
      id: base.companyId,
      legalName: 'Acme Holdings Sdn Bhd',
      registrationNo: '202001000001',
      companyLabel: 'ACME',
      industry: 'Manufacturing',
      website: 'https://acme.example.com',
      businessType: 'Sdn Bhd',
      addressLine1: 'Level 10, Tower A',
      addressLine2: 'Jalan Ampang',
      addressLine3: 'KLCC',
      city: 'Kuala Lumpur',
      state: 'Selangor',
      addressCountry: 'Singapore', // deliberately != MY to prove it does NOT touch company.country
      postcode: '50450',
      phone: '+60 3-1234 5678',
      fax: '+60 3-1234 5679',
    });
    const r = await row(base.companyId);
    expect(r.legalName).toBe('Acme Holdings Sdn Bhd');
    expect(r.registrationNo).toBe('202001000001');
    expect(r.companyLabel).toBe('ACME');
    expect(r.industry).toBe('Manufacturing');
    expect(r.website).toBe('https://acme.example.com');
    expect(r.businessType).toBe('Sdn Bhd');
    expect(r.addressLine1).toBe('Level 10, Tower A');
    expect(r.addressLine2).toBe('Jalan Ampang');
    expect(r.addressLine3).toBe('KLCC');
    expect(r.city).toBe('Kuala Lumpur');
    expect(r.state).toBe('Selangor');
    expect(r.addressCountry).toBe('Singapore');
    expect(r.postcode).toBe('50450');
    expect(r.phone).toBe('+60 3-1234 5678');
    expect(r.fax).toBe('+60 3-1234 5679');
    // The display-only address country must NOT clobber the ISO country that drives statutory/holiday logic.
    expect(r.country).toBe('MY');

    // And the read projection surfaces the new fields for the page.
    const listed = (await listCompanies(ctx, { includeArchived: true })).find((c) => c.id === base.companyId)!;
    expect(listed.companyLabel).toBe('ACME');
    expect(listed.addressLine1).toBe('Level 10, Tower A');
    expect(listed.phone).toBe('+60 3-1234 5678');
  });

  it('persists blank / whitespace-only inputs as NULL (empty clears)', async () => {
    const ctx = adminCtx(base);
    await updateCompany(ctx, {
      id: base.companyId,
      legalName: 'Acme',
      industry: 'Tech',
      city: 'Ipoh',
      website: 'https://x.example.com',
    });
    await updateCompany(ctx, {
      id: base.companyId,
      legalName: 'Acme',
      industry: '',
      city: '   ',
      website: '',
    });
    const r = await row(base.companyId);
    expect(r.industry).toBeNull();
    expect(r.city).toBeNull();
    expect(r.website).toBeNull();
  });

  it('leaves an OMITTED field untouched (tri-state — never a silent wipe)', async () => {
    const ctx = adminCtx(base);
    await updateCompany(ctx, { id: base.companyId, legalName: 'Acme', companyLabel: 'LBL', industry: 'Tech' });
    // A later save that omits companyLabel/industry entirely must not null them out.
    await updateCompany(ctx, { id: base.companyId, legalName: 'Acme Renamed' });
    const r = await row(base.companyId);
    expect(r.legalName).toBe('Acme Renamed');
    expect(r.companyLabel).toBe('LBL');
    expect(r.industry).toBe('Tech');
  });

  it('reads new fields as NULL for an existing, never-edited company', async () => {
    const listed = (await listCompanies(adminCtx(base), { includeArchived: true })).find(
      (c) => c.id === base.companyId,
    )!;
    expect(listed.companyLabel).toBeNull();
    expect(listed.industry).toBeNull();
    expect(listed.website).toBeNull();
    expect(listed.businessType).toBeNull();
    expect(listed.addressLine1).toBeNull();
    expect(listed.state).toBeNull();
    expect(listed.addressCountry).toBeNull();
    expect(listed.phone).toBeNull();
    expect(listed.fax).toBeNull();
  });

  it('rejects an invalid Website value', async () => {
    const ctx = adminCtx(base);
    await expect(
      updateCompany(ctx, { id: base.companyId, legalName: 'Acme', website: 'not a url' }),
    ).rejects.toThrow();
    await expect(
      updateCompany(ctx, { id: base.companyId, legalName: 'Acme', website: 'ftp://x.example.com' }),
    ).rejects.toThrow();
    // A valid http(s) URL is accepted.
    await updateCompany(ctx, { id: base.companyId, legalName: 'Acme', website: 'http://ok.example.com' });
    expect((await row(base.companyId)).website).toBe('http://ok.example.com');
  });

  it('still appends a company.updated domain event', async () => {
    const ctx = adminCtx(base);
    await updateCompany(ctx, { id: base.companyId, legalName: 'Acme', industry: 'Tech' });
    const types = await eventTypesFor(base.tenantId, base.companyId);
    expect(types).toContain('company.updated');
  });
});
