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
import { accountLast4 } from '../lib/bank-account-last4';

let b: Base;
const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function toastOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) {
      const u = new URL(e.path, 'http://x');
      return { pathname: u.pathname, toast: u.searchParams.get('toast'), error: u.searchParams.get('error'), raw: e.path };
    }
    throw e;
  }
  throw new Error('expected a redirect');
}

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});

describe('accountLast4', () => {
  it('drops separators, keeps the last four, and refuses to return a whole short number', () => {
    expect(accountLast4('5140-1234-5678')).toBe('5678');
    expect(accountLast4('512345678901')).toBe('8901');
    expect(accountLast4('12345')).toBe('2345');
    expect(accountLast4('1234'), 'four characters IS the whole number').toBeNull();
    expect(accountLast4('99')).toBeNull();
    expect(accountLast4('')).toBeNull();
    expect(accountLast4(null)).toBeNull();
  });
});

describe('after Remove: a message naming the bank and the last four', () => {
  it('names the bank and the last four, and never the full number', async () => {
    const bp = await upsertCompanyBankProfile(ADMIN, {
      companyId: b.companyId,
      bank: 'maybank',
      corporateId: 'C1',
      debitAccountNo: '5140-1234-5678',
    });
    const r = await toastOf(() => removeCompanyBankProfileAction(fd({ id: bp.id, companyId: b.companyId, tab: 'bank' })));
    expect(r.pathname).toBe(`/admin/organization/${b.companyId}`);
    expect(r.toast).toBe('Removed the Maybank account ending 5678');
    expect(r.raw, 'the URL carries no more of the number').not.toContain('1234');
    expect(await listCompanyBankProfiles(ADMIN, b.companyId), 'and it really went').toHaveLength(0);
    // The event log stays redacted (ADR-0030 Layer-0): the new return value is not a new payload field.
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, bp.id), eq(schema.domainEvent.eventType, 'company-bank-profile.removed')));
    expect(ev, 'the removal was logged').toBeTruthy();
    expect(JSON.stringify(ev.payload)).not.toContain('5678');
  });

  it('nothing matched (an id already gone) keeps the bare "Removed" rather than naming an account', async () => {
    const r = await toastOf(() =>
      removeCompanyBankProfileAction(fd({ id: '00000000-0000-0000-0000-000000000000', companyId: b.companyId })),
    );
    expect(r.toast).toBe('Removed');
  });
});

/**
 * FACT, recorded rather than decided: removeCompanyBankProfile REFUSES NOTHING. An account a statutory
 * body is paid from is removed and the body is UNROUTED (FK ON DELETE SET NULL, migration 0276); there is
 * no "paying account" reference to refuse on. The approved plan says the system refuses such a removal
 * "as it does today" — it does not, and this round deliberately did not add a refusal. If one is added,
 * this case is the one to update.
 */
describe('what Remove refuses today', () => {
  it('an account a statutory body is paid from is removed, and the body unrouted, not refused', async () => {
    const bp = await upsertCompanyBankProfile(ADMIN, {
      companyId: b.companyId,
      bank: 'rhb',
      corporateId: 'C1',
      debitAccountNo: '21234567890',
    });
    await upsertCompanyStatutoryAuthority(ADMIN, { companyId: b.companyId, authority: 'epf', bankProfileId: bp.id });
    const r = await toastOf(() => removeCompanyBankProfileAction(fd({ id: bp.id, companyId: b.companyId })));
    expect(r.error).toBeNull();
    expect(r.toast).toBe('Removed the RHB Bank account ending 7890');
    const [epf] = await listCompanyStatutoryAuthorities(ADMIN, b.companyId);
    expect(epf.bankProfileId).toBeNull();
  });
});
