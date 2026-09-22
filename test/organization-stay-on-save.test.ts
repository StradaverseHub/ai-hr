/**
 * 65b22c00 — "Keep Organization Edit Screen Open After Save", the half the item is named for.
 *
 * Every save on `/admin/organization/<companyId>` used to end `ok('/admin/organization')` — the company
 * LIST — so an administrator correcting a company's address had to find the company again and reopen it
 * after every single save. `docs/audits/65b22c00-organization-save-classification.md` buckets all
 * thirteen bindings on that screen and records which of them may stay and which may not.
 *
 * WHAT IS RUN, NOT SCANNED. Every one of the twelve company actions is EXECUTED against a real database
 * and the address it redirected to is read and parsed, success path and refusal path. A source scan
 * asserting `okCompany(` appears would pass over the two defects this file is actually about:
 *
 *   · THE CONCATENATION DEFECT. `ok()`/`fail()` build `${path}?error=…` by plain concatenation, so a
 *     path already carrying `?tab=` yields `…?tab=statutory?toast=Saved` — `tab` read as
 *     "statutory?toast=Saved", the toast never parsed, and a REFUSED save showing no banner at all.
 *     That shipped twice on the attendance schedule screen (r287 → r301). §2 parses the target the way
 *     a browser does and asserts BOTH parameters come back, which a scan cannot.
 *   · THE SHARED ACTION. `archiveCompanyAction` is bound on the company panel AND on every row of the
 *     company LIST. §3 runs it both ways and asserts the two destinations differ.
 *
 * FILE-LEVEL MOCKS — the house pattern (test/r301-schedule-general.test.ts): getSession returns the
 * module-level ADMIN, redirect() throws a recognisable error carrying its path, revalidatePath is inert,
 * and getTranslations is a REAL translator over messages/en.json that THROWS on a missing message — so a
 * toast key absent from the catalogue fails HERE rather than in a dev-server log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
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
import {
  archiveCompanyAction,
  deleteCompanyAction,
  removeCompanyBankProfileAction,
  removeCompanyLogoAction,
  removeCompanyStatutoryAuthorityAction,
  setCompanyBankProfileAction,
  setCompanyLogoAction,
  setCompanyParentAction,
  setCompanyStatutoryAction,
  setCompanyStatutoryAuthorityAction,
  updateCompanyAction,
  updateCompanyDefaultCycleAction,
} from '../app/admin/actions';
import { listCompanyBankProfiles } from '../core/bank-profile';
import { listCompanyStatutoryAuthorities } from '../core/statutory-authority';
import { COMPANY_PANEL_TABS, isCompanyPanelTab } from '../lib/company-panel-tabs';
import { CompanyPanel, type PanelCompany } from '../components/company-panel';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const LIST = '/admin/organization';

let b: Base;
let secondCompany: string;

const fd = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Run something that ends in redirect() and return where it went. */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected a redirect, but none happened');
}

/** Split a redirect target the way a browser (and Next) does. */
const parse = (target: string) => {
  const u = new URL(target, 'http://x');
  return { pathname: u.pathname, q: u.searchParams };
};

beforeAll(async () => {
  b = await seedBase();
  ADMIN = adminCtx(b);
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Acme Holdings Sdn Bhd' })
    .returning({ id: schema.company.id });
  secondCompany = c2.id;
});

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 every save on a company lands back on THAT company', () => {
  it('updateCompany — the form the reporter was on when they raised it', async () => {
    const to = await redirectOf(() =>
      updateCompanyAction(fd({ id: b.companyId, legalName: 'Acme Renamed Sdn Bhd', city: 'Ipoh' })),
    );
    const { pathname, q } = parse(to);
    expect(pathname, 'the company, not the list').toBe(`${LIST}/${b.companyId}`);
    expect(q.get('toast')).toBe('Saved');
    const [row] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(row.legalName, 'and it actually saved').toBe('Acme Renamed Sdn Bhd');
  });

  it('setParent, setStatutory, setBankProfile, setStatutoryAuthority, logo set/remove', async () => {
    const stays: [string, () => Promise<unknown>][] = [
      ['setParent', () => setCompanyParentAction(fd({ companyId: b.companyId, parentCompanyId: secondCompany }))],
      [
        'setStatutory',
        () =>
          setCompanyStatutoryAction(
            fd({ companyId: b.companyId, country: 'MY', ssmRegistrationNo: '202301001234', myinvoisTin: 'C123' }),
          ),
      ],
      [
        'setBankProfile',
        () =>
          setCompanyBankProfileAction(
            fd({
              companyId: b.companyId,
              bank: 'maybank',
              corporateId: 'CORP1',
              debitAccountNo: '512345678901',
            }),
          ),
      ],
      [
        'setStatutoryAuthority',
        () => setCompanyStatutoryAuthorityAction(fd({ companyId: b.companyId, authority: 'epf', accountNo: 'A-1' })),
      ],
    ];
    for (const [name, run] of stays) {
      const { pathname, q } = parse(await redirectOf(run));
      expect(pathname, name).toBe(`${LIST}/${b.companyId}`);
      expect(q.get('toast'), name).toBe('Saved');
      expect(q.get('error'), name).toBeNull();
    }
  });

  it('the two removes — which post the ROW id, so the panel has to carry the company too', async () => {
    await setCompanyBankProfileAction(
      fd({ companyId: b.companyId, bank: 'cimb', corporateId: 'C2', debitAccountNo: '99' }),
    ).catch((e) => {
      if (!(e instanceof RedirectError)) throw e;
    });
    await setCompanyStatutoryAuthorityAction(fd({ companyId: b.companyId, authority: 'socso', accountNo: 'S-1' })).catch(
      (e) => {
        if (!(e instanceof RedirectError)) throw e;
      },
    );
    const [bank] = await listCompanyBankProfiles(ADMIN, b.companyId);
    const [auth] = await listCompanyStatutoryAuthorities(ADMIN, b.companyId);
    expect(bank, 'fixture').toBeTruthy();
    expect(auth, 'fixture').toBeTruthy();

    for (const [name, run] of [
      ['removeBankProfile', () => removeCompanyBankProfileAction(fd({ id: bank.id, companyId: b.companyId }))],
      [
        'removeStatutoryAuthority',
        () => removeCompanyStatutoryAuthorityAction(fd({ id: auth.id, companyId: b.companyId })),
      ],
    ] as [string, () => Promise<unknown>][]) {
      const { pathname, q } = parse(await redirectOf(run));
      expect(pathname, name).toBe(`${LIST}/${b.companyId}`);
      expect(q.get('toast'), name).toBe('Removed');
    }
  });

  it('removeCompanyLogo', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const set = new FormData();
    set.set('companyId', b.companyId);
    set.set('logo', new File([png], 'logo.png', { type: 'image/png' }));
    expect(parse(await redirectOf(() => setCompanyLogoAction(set))).pathname).toBe(`${LIST}/${b.companyId}`);
    const { pathname, q } = parse(await redirectOf(() => removeCompanyLogoAction(fd({ companyId: b.companyId }))));
    expect(pathname).toBe(`${LIST}/${b.companyId}`);
    expect(q.get('toast')).toBe('Removed');
  });

  /**
   * THE REFUSAL PATH IS THE ONE THAT HURT MOST, and it is asserted separately because `fail()` and
   * `ok()` are different helpers: a refused save used to show its message on the LIST, about a form the
   * reader could no longer see, with their typing gone.
   */
  it('a REFUSED save lands on the company too, with the message the service gave', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        setCompanyBankProfileAction(fd({ companyId: b.companyId, bank: 'not-a-bank', corporateId: 'x', debitAccountNo: '1' })),
      ),
    );
    expect(pathname, 'the screen that holds the form').toBe(`${LIST}/${b.companyId}`);
    expect(q.get('error')).toMatch(/Malaysian bank list/);
    expect(q.get('toast'), 'a refusal is not a success').toBeNull();
  });

  it('a refused default-cycle save keeps the reader on the company as well', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        updateCompanyDefaultCycleAction(fd({ companyId: b.companyId, defaultPayrollCycle: 'Nonexistent' })),
      ),
    );
    expect(pathname).toBe(`${LIST}/${b.companyId}`);
    expect(q.get('error')).toBeTruthy();
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 the tab survives the save, and it does not eat the toast (r287 → r301)', () => {
  it('carries the tab back AND still parses the toast beside it', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        setCompanyStatutoryAction(fd({ companyId: b.companyId, country: 'MY', ssmRegistrationNo: '1', tab: 'statutory' })),
      ),
    );
    expect(pathname).toBe(`${LIST}/${b.companyId}`);
    // THE DEFECT: `…?tab=statutory?toast=Saved` parses `tab` as "statutory?toast=Saved" and loses the
    // toast entirely. Both of these have to come back, separately.
    expect(q.get('tab')).toBe('statutory');
    expect(q.get('toast')).toBe('Saved');
  });

  it('carries the tab back on a REFUSAL too — the banner has to reach the tab it came from', async () => {
    const { q } = parse(
      await redirectOf(() =>
        setCompanyBankProfileAction(fd({ companyId: b.companyId, bank: 'zzz', corporateId: 'x', debitAccountNo: '1', tab: 'bank' })),
      ),
    );
    expect(q.get('tab')).toBe('bank');
    expect(q.get('error')).toBeTruthy();
  });

  it('a tab key that is not in the closed list is dropped rather than echoed into the URL', async () => {
    const { q } = parse(
      await redirectOf(() =>
        setCompanyParentAction(fd({ companyId: b.companyId, parentCompanyId: '', tab: 'general?toast=Pwned' })),
      ),
    );
    expect(q.get('tab'), 'never the posted string').toBeNull();
    expect(q.get('toast')).toBe('Saved');
  });

  it('the three tab keys have ONE declaration, and all three files read it', () => {
    expect([...COMPANY_PANEL_TABS]).toEqual(['general', 'bank', 'statutory']);
    expect(isCompanyPanelTab('statutory')).toBe(true);
    expect(isCompanyPanelTab('other')).toBe(false);
    for (const f of [
      'app/admin/actions.ts',
      'app/admin/organization/[companyId]/page.tsx',
      'components/company-panel.tsx',
    ]) {
      expect(read(f), f).toContain('company-panel-tabs');
    }
    // The page VALIDATES rather than trusting: `?tab=` is reader-supplied.
    expect(read('app/admin/organization/[companyId]/page.tsx')).toContain('isCompanyPanelTab(tab) ? tab : undefined');
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 archiveCompanyAction has two homes and two destinations', () => {
  it('from the company panel it stays; from the LIST row it stays on the list', async () => {
    const fromPanel = parse(
      await redirectOf(() => archiveCompanyAction(fd({ id: b.companyId, archived: 'true', returnTo: 'company' }))),
    );
    expect(fromPanel.pathname).toBe(`${LIST}/${b.companyId}`);
    expect(fromPanel.q.get('toast')).toBe('Company archived');

    // The listing's own form posts no marker — components/company-rows.tsx.
    const fromList = parse(await redirectOf(() => archiveCompanyAction(fd({ id: b.companyId, archived: 'false' }))));
    expect(fromList.pathname, 'archiving a ROW must not open that company').toBe(LIST);
  });

  it('unarchive from the panel says restored, not saved', async () => {
    await redirectOf(() => archiveCompanyAction(fd({ id: b.companyId, archived: 'true', returnTo: 'company' })));
    const { q } = parse(
      await redirectOf(() => archiveCompanyAction(fd({ id: b.companyId, archived: 'false', returnTo: 'company' }))),
    );
    expect(q.get('toast')).toBe('Company restored');
  });

  it('the marker is an EXPLICIT input in the panel and absent from the list rows', () => {
    const panel = read('components/company-panel.tsx');
    expect(panel.match(/name="returnTo" value="company"/g) ?? [], 'both archive forms').toHaveLength(2);
    expect(read('app/admin/organization/company-rows.tsx'), 'the list must not claim to be the panel').not.toContain(
      'returnTo',
    );
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§4 delete is the one that must NOT stay (classification finding 2)', () => {
  it('a successful delete returns to the LIST, because the record the screen reads is gone', async () => {
    const { pathname, q } = parse(await redirectOf(() => deleteCompanyAction(fd({ id: secondCompany }))));
    expect(pathname).toBe(LIST);
    expect(q.get('toast')).toBe('Company deleted');
    const rows = await owner.db.select().from(schema.company).where(eq(schema.company.id, secondCompany));
    expect(rows).toHaveLength(0);
  });

  it('a REFUSED delete returns to the company, where Archive is the next thing to press', async () => {
    // b.companyId is in use: seedBase hires into it.
    const { pathname, q } = parse(await redirectOf(() => deleteCompanyAction(fd({ id: b.companyId, tab: 'general' }))));
    expect(pathname).toBe(`${LIST}/${b.companyId}`);
    expect(q.get('error')).toBeTruthy();
  });
});

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§5 the panel posts what the actions read, and says it in six languages', () => {
  const noop = () => undefined;
  const actions = {
    updateCompany: noop,
    archiveCompany: noop,
    deleteCompany: noop,
    setParent: noop,
    setStatutory: noop,
    setBankProfile: noop,
    removeBankProfile: noop,
    setStatutoryAuthority: noop,
    removeStatutoryAuthority: noop,
    setCompanyLogo: noop,
    removeCompanyLogo: noop,
    updateCompanyDefaultCycle: noop,
  };
  const company: PanelCompany = {
    id: 'c1',
    name: 'Demo Sdn Bhd',
    country: 'MY',
    currency: 'MYR',
    registrationNo: null,
    companyLabel: null,
    industry: null,
    website: null,
    businessType: null,
    addressLine1: null,
    addressLine2: null,
    addressLine3: null,
    city: null,
    state: null,
    addressCountry: null,
    postcode: null,
    phone: null,
    fax: null,
    archivedAt: null,
    inUse: true,
    parentId: null,
    hasLogo: false,
    defaultPayrollCycle: 'Monthly',
  };
  const props = {
    company,
    companies: [{ id: 'c1', name: 'Demo Sdn Bhd' }],
    statutory: null,
    bankProfiles: [
      {
        id: 'bp1',
        bank: 'maybank',
        corporateId: 'CORP',
        debitAccountNo: '512345678901',
        orgName: null,
        txnType: 'IBG',
        accountLabel: null,
        accountName: null,
        accountType: null,
        branch: null,
        swiftCode: null,
        currency: 'MYR',
        isPrimary: true,
      },
    ],
    statutoryAuthorities: [
      {
        id: 'sa1',
        authority: 'epf',
        accountNo: 'A-1',
        bankProfileId: null,
        addressLine1: null,
        addressLine2: null,
        addressLine3: null,
        city: null,
        state: null,
        postcode: null,
        country: null,
        phone: null,
        email: null,
        signatoryPersonId: null,
      },
    ],
    signatories: [],
    stateOptions: [],
    activeCycleNames: ['Monthly'],
    actions,
  };

  const markup = (locale: string) =>
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        messages: JSON.parse(read(`messages/${locale}.json`)),
        timeZone: 'Asia/Kuala_Lumpur',
        children: createElement(CompanyPanel, props as never),
      }),
    );

  /**
   * THE CONTRACT ACROSS TWO FILES. `removeCompanyBankProfileAction` and
   * `removeCompanyStatutoryAuthorityAction` read `companyId` to decide where to return, and their forms
   * post the ROW id. If the hidden field is ever dropped the action still SUCCEEDS — the delete works —
   * and silently lands the reader on the list again. §1 runs the action; this pins the other half.
   */
  it('the remove forms carry the company id, not only the row id', () => {
    const html = markup('en');
    expect(html).toContain('value="bp1"');
    expect(html).toContain('value="sa1"');
    // One company-id input per form that needs one, across the whole rendered panel.
    const ids = html.match(/name="companyId" value="c1"/g) ?? [];
    expect(ids.length, 'every form that posts a row id also posts the company').toBeGreaterThanOrEqual(6);
  });

  it('renders the archive marker for a company in use', () => {
    expect(markup('en')).toContain('name="returnTo" value="company"');
  });

  it('the five toast strings exist in all six locales', () => {
    for (const loc of LOCALES) {
      const org = JSON.parse(read(`messages/${loc}.json`)).admin.organization as Record<string, string>;
      for (const k of ['savedToast', 'removedToast', 'archivedToast', 'unarchivedToast', 'deletedToast']) {
        expect(org[k], `${loc}: ${k}`).toBeTruthy();
      }
    }
  });
});
