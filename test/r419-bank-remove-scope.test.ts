/**
 * 48652e18 (r419) — what Remove says AFTER it removes, and what removeCompanyBankProfile actually refuses.
 *
 * The message names the bank and the last four characters of the number, read from the DELETED ROW, and
 * never the whole number (it travels in the URL as ?toast=). Its DOM half is
 * test/r419-bank-account-tab.dom.test.tsx.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';

let ADMIN: SessionContext;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => ADMIN,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new RedirectError(p);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e: unknown) => {
          throw e;
        },
      }),
  };
});

import { adminCtx, closeAll, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { removeCompanyBankProfileAction } from '../app/admin/actions';
import { listCompanyBankProfiles, upsertCompanyBankProfile } from '../core/bank-profile';
import { listCompanyStatutoryAuthorities, upsertCompanyStatutoryAuthority } from '../core/statutory-authority';

let b: Base;
const fd = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
async function toastOf(run: () => Promise<unknown>) {
  try { await run(); } catch (e) {
    if (e instanceof RedirectError) { const u = new URL(e.path, 'http://x'); return { pathname: u.pathname, toast: u.searchParams.get('toast'), error: u.searchParams.get('error'), raw: e.path }; }
    throw e;
  }
  throw new Error('expected a redirect');
}
let otherCompanyId: string;
let otherBpId: string;
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c2] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' }).returning({ id: schema.company.id });
  otherCompanyId = c2.id;
  const bp = await upsertCompanyBankProfile(adminCtx(b), { companyId: otherCompanyId, bank: 'maybank', corporateId: 'C9', debitAccountNo: '5140-9999-4321' });
  otherBpId = bp.id;
});
afterAll(async () => { await closeAll(); });
const scoped = (companyId: string): SessionContext => ({ tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId }], entitlements: adminCtx(b).entitlements });
const stillThere = async () => (await owner.db.select().from(schema.companyBankProfile).where(eq(schema.companyBankProfile.id, otherBpId))).length;

describe('r419v scope probe', () => {
  it('admin scoped to base company cannot remove other company account by posting its id with own companyId', async () => {
    ADMIN = scoped(b.companyId);
    const r = await toastOf(() => removeCompanyBankProfileAction(fd({ id: otherBpId, companyId: b.companyId, tab: 'bank' })));
    expect(await stillThere()).toBe(1);
    expect(r.toast).toBe('Removed');
    expect(r.raw).not.toContain('4321');
  });
  it('admin scoped to base company cannot remove it posting the other companyId either', async () => {
    ADMIN = scoped(b.companyId);
    await toastOf(() => removeCompanyBankProfileAction(fd({ id: otherBpId, companyId: otherCompanyId })));
    expect(await stillThere()).toBe(1);
  });
  it('positive control: admin scoped to the other company CAN remove it', async () => {
    ADMIN = scoped(otherCompanyId);
    const r = await toastOf(() => removeCompanyBankProfileAction(fd({ id: otherBpId, companyId: otherCompanyId })));
    expect(await stillThere()).toBe(0);
    expect(r.toast).toBe('Removed the Maybank account ending 4321');
  });
  it('PROBE: tenant-wide admin posting other company id with base companyId', async () => {
    ADMIN = adminCtx(b);
    const r = await toastOf(() => removeCompanyBankProfileAction(fd({ id: otherBpId, companyId: b.companyId })));
    expect(await stillThere(), 'DEFECT: deleted another company account').toBe(1); void r;
  });
});
