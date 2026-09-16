/**
 * Company logo (feedback: Redesign Organization Management Screen) — a 1:1 branding logo in the company_logo
 * SIDE TABLE. CORRECTED security posture (the original plan's admin-only-read claim was FALSE):
 *   - READ is tenant-wide: any same-tenant member (admin OR non-admin) can read the logo, matching how the
 *     company row itself reads. Cross-tenant read is NULL (tenant isolation holds).
 *   - WRITE is admin-of-the-company only (RLS company_logo_rls WITH CHECK app.is_admin_for(company_id)).
 * The DomainEvent payload carries ONLY derived, non-PII fields — never the bytes, never the raw fileName.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
  harnessSnapshot,
} from './harness';
import {
  getCompanyLogo,
  removeCompanyLogo,
  setCompanyLogo,
} from '../core/admin';
import { hireEmployee } from '../core/org';
import { ALLOWED_RECEIPT_MIME } from '../core/claims';

// A 1x1 PNG's real magic bytes are irrelevant to the service (the action sniffs; the service trusts the
// passed mime), so any small buffer stands in for the content here.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe('company logo — storage, events, and RLS posture', () => {
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

  it('setCompanyLogo stores content+fileName+mime+size and appends company.logo.set (no bytes, no raw fileName in payload)', async () => {
    await setCompanyLogo(adminCtx(base), {
      companyId: base.companyId,
      content: PNG,
      fileName: 'acme-brand-logo.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });

    const stored = await getCompanyLogo(adminCtx(base), base.companyId);
    expect(stored).not.toBeNull();
    expect(stored!.mimeType).toBe('image/png');
    expect(stored!.fileName).toBe('acme-brand-logo.png');
    expect(Buffer.from(stored!.content).equals(PNG)).toBe(true);

    expect(await eventTypesFor(base.tenantId, base.companyId)).toContain('company.logo.set');
    const payload = await latestEventPayload(base.tenantId, base.companyId, 'company.logo.set');
    expect(payload).toEqual({ mimeType: 'image/png', sizeBytes: PNG.byteLength });
    // The payload must NOT leak the bytes or the raw user-supplied fileName (PDPA / ADR-0030).
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('fileName');
  });

  it('setCompanyLogo upserts on company_id (a second set REPLACES, not duplicates)', async () => {
    const a = adminCtx(base);
    await setCompanyLogo(a, { companyId: base.companyId, content: PNG, fileName: 'v1.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    await setCompanyLogo(a, { companyId: base.companyId, content: JPG, fileName: 'v2.jpg', mimeType: 'image/jpeg', sizeBytes: JPG.byteLength });

    const rows = await withTenant(a, (tx) =>
      tx.select().from(schema.companyLogo).where(eq(schema.companyLogo.companyId, base.companyId)),
    );
    expect(rows.length).toBe(1); // unique(company_id) → one row
    const stored = await getCompanyLogo(a, base.companyId);
    expect(stored!.mimeType).toBe('image/jpeg');
    expect(stored!.fileName).toBe('v2.jpg');
  });

  it('getCompanyLogo: same-tenant ADMIN reads bytes; same-tenant NON-ADMIN member reads bytes ALSO (real posture)', async () => {
    await setCompanyLogo(adminCtx(base), { companyId: base.companyId, content: PNG, fileName: 'logo.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });

    // A non-admin member of the same tenant.
    const E = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Emp One', primaryEmail: 'emp1@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };

    const asAdmin = await getCompanyLogo(adminCtx(base), base.companyId);
    const asMember = await getCompanyLogo(empCtx, base.companyId);
    expect(asAdmin).not.toBeNull();
    expect(asMember).not.toBeNull(); // <-- would have FAILED under the original admin-only-read plan
    expect(Buffer.from(asMember!.content).equals(PNG)).toBe(true);
  });

  it('cross-tenant read is NULL (tenant isolation holds)', async () => {
    await setCompanyLogo(adminCtx(base), { companyId: base.companyId, content: PNG, fileName: 'logo.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    const other = await seedBase();
    const seen = await getCompanyLogo(adminCtx(other), base.companyId);
    expect(seen).toBeNull();
  });

  it('setCompanyLogo from a NON-ADMIN same-tenant session is rejected by the WITH CHECK write gate', async () => {
    const E = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Emp Two', primaryEmail: 'emp2@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };

    await expect(
      setCompanyLogo(empCtx, { companyId: base.companyId, content: PNG, fileName: 'x.png', mimeType: 'image/png', sizeBytes: PNG.byteLength }),
    ).rejects.toThrow();
    // Nothing was written.
    expect(await getCompanyLogo(adminCtx(base), base.companyId)).toBeNull();
  });

  it('removeCompanyLogo deletes the row and appends company.logo.removed', async () => {
    const a = adminCtx(base);
    await setCompanyLogo(a, { companyId: base.companyId, content: PNG, fileName: 'logo.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    expect(await getCompanyLogo(a, base.companyId)).not.toBeNull();

    await removeCompanyLogo(a, { companyId: base.companyId });
    expect(await getCompanyLogo(a, base.companyId)).toBeNull();
    expect(await eventTypesFor(base.tenantId, base.companyId)).toContain('company.logo.removed');
  });

  it('oversized (>2MB) and non-image mime both throw with the shared logo error strings', async () => {
    const a = adminCtx(base);
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(
      setCompanyLogo(a, { companyId: base.companyId, content: big, fileName: 'big.png', mimeType: 'image/png', sizeBytes: big.byteLength }),
    ).rejects.toThrow(/2 MB/);

    await expect(
      setCompanyLogo(a, { companyId: base.companyId, content: PNG, fileName: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: PNG.byteLength }),
    ).rejects.toThrow(/PNG or JPG/);

    await expect(
      setCompanyLogo(a, { companyId: base.companyId, content: Buffer.alloc(0), fileName: 'empty.png', mimeType: 'image/png', sizeBytes: 0 }),
    ).rejects.toThrow(/Empty/);
  });

  it('claims still accept PDF (guard: claims MIME allowlist is untouched by the logo change)', () => {
    // The logo work must not regress claims. Claims deliberately trust PDF; logos deliberately do not.
    expect(ALLOWED_RECEIPT_MIME).toContain('application/pdf');
    expect(ALLOWED_RECEIPT_MIME).toContain('image/png');
    expect(ALLOWED_RECEIPT_MIME).toContain('image/jpeg');
  });
});
