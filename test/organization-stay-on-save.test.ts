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
 * asserting `okCompany(` appears would pass over the three defects this file is actually about:
 *
 *   · THE CONCATENATION DEFECT. `ok()`/`fail()` build `${path}?error=…` by plain concatenation, so a
 *     path already carrying `?tab=` yields `…?tab=statutory?toast=Saved` — `tab` read as
 *     "statutory?toast=Saved", the toast never parsed, and a REFUSED save showing no banner at all.
 *     That shipped twice on the attendance schedule screen (r287 → r301). §2 parses the target the way
 *     a browser does and asserts BOTH parameters come back, which a scan cannot.
 *   · THE SHARED ACTION. `archiveCompanyAction` is bound on the company panel AND on every row of the
 *     company LIST. §3 runs it both ways and asserts the two destinations differ.
 *   · THE SECOND SHARED PAIR (15e5bd93 rev 2, r353). `setCompanyStatutoryAuthorityAction` and
 *     `removeCompanyStatutoryAuthorityAction` are now bound on the company panel AND on the dedicated
 *     Statutory Payment Setup screen, which is a DIFFERENT ROUTE rather than a different tab — so the
 *     capture-phase `?tab=` tracker the panel injects does not reach them there. §6 runs both bindings and
 *     asserts the two destinations differ, exactly as §3 does for archive. Getting this wrong is not a
 *     404: it is a save that works and drops the operator on a page with no card on it, which is the
 *     reporter's own words for what must stop happening.
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
  // §5 renders the panel, which now hosts components/tab-save-scope.tsx; its useRouter() throws outside
  // an App Router context.
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/organization/c1',
  useSearchParams: () => new URLSearchParams(),
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

// ── §6 ───────────────────────────────────────────────────────────────────────────────────
/**
 * 15e5bd93 REVISION 2 (r353) — THE THIRTEENTH DESTINATION.
 *
 * The reporter's fourth approved point, in their words: "Saving keeps the user on this page and shows a
 * confirmation naming what was saved. Never redirected to the Organization company list." The page is
 * `/admin/organization/<companyId>/statutory`, which is NOT the company panel — so the capture-phase
 * tracker at components/company-panel.tsx that injects `?tab=` into every form it hosts does not apply, and
 * `okCompany` cannot serve it (see the note on `okStatutorySetup` in app/admin/_redirects.ts).
 *
 * RUN, NOT SCANNED, for this file's own reason: the concatenation defect that shipped twice on the schedule
 * screen is a defect in how a path and a query string MEET, and only parsing the target the way a browser
 * does can see it.
 */
describe('§6 the Statutory Payment Setup flow keeps its own saves (15e5bd93 rev 2, split by rev 3)', () => {
  const SETUP = (id: string) => `${LIST}/${id}/statutory`;
  /**
   * ⚠️ 15e5bd93 REVISION 4 (r372) — THE FOURTEENTH DESTINATION IS REMOVED, AND THE SET IS NARROWED RATHER
   * THAN LOOSENED.
   *
   * r355 added `BODY = (id, a) => `${SETUP(id)}/${a}`` and split this flow's two outcomes across two
   * routes, on this reasoning, which was right for that shape:
   *
   *   SUCCESS  →  the LIST. "Save writes only that body and returns you to the list with its row
   *               refreshed."
   *   REFUSAL  →  the BODY's own edit screen, because "every refusal reachable from that form is about a
   *               box that exists only there", and sending it to the list would re-commit the mistake
   *               `failCompany`'s own note records: "a refused save … showed the refusal on a screen
   *               that no longer held the form it was about."
   *
   * The reporter has since called that per-body page "an unnecessary intermediate page" and it is
   * deleted. THE REASONING IS UNTOUCHED AND IS WHY THE SPLIT CAN GO: `…/statutory` now holds every
   * body's form, so it IS "the screen that holds the form the refusal is about". Both outcomes land
   * there, `failStatutoryBody` is gone from app/admin/_redirects.ts with the page, and no posted value
   * reaches a redirect path from this flow at all.
   *
   * ONE marker still chooses the flow (`returnTo=statutory-setup`); there is one screen for it to choose.
   */

  it('a card save returns to the LIST with a parseable toast, and no stray tab', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        setCompanyStatutoryAuthorityAction(
          fd({ companyId: b.companyId, authority: 'epf', accountNo: 'A-1', returnTo: 'statutory-setup' }),
        ),
      ),
    );
    expect(pathname, 'the screen the form is on').toBe(SETUP(b.companyId));
    // THE CONCATENATION DEFECT, on a new path: `…/statutory?toast=X` must parse as a toast, and nothing may
    // ever be appended in FRONT of the query key.
    expect(q.get('toast'), 'and it NAMES what was saved').toBe('EPF (KWSP) saved');
    expect(q.get('error')).toBeNull();
    expect(q.get('tab'), 'this screen has no tabs, so it carries none').toBeNull();
  });

  /**
   * ⚠️ REVERSED TWICE, AND THIS ROUND REVERSES IT BACK TO r353's ANSWER. r353 asserted
   * `expect(pathname, 'the refusal reaches the form it is about').toBe(SETUP(b.companyId))`. r355
   * changed it to `BODY(b.companyId, 'epf')` with `?mode=edit`, because the setup screen had become a
   * table of rows and "the form it is about" was on the per-body page. That page is deleted and every
   * body's form is back on `…/statutory`, so the ORIGINAL address is the one that satisfies the rule.
   *
   * ⚠️ AND THE MODE IS ASSERTED ABSENT, not merely unchecked: a `?mode=edit` left on this redirect would
   * point at a query parameter the surviving page does not read, which is how a dead contract survives a
   * deletion.
   */
  it('a REFUSED card save lands back on the statutory screen, with the message the service gave', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        setCompanyStatutoryAuthorityAction(
          fd({
            companyId: b.companyId,
            authority: 'epf',
            bankProfileId: '00000000-0000-4000-8000-000000000000',
            returnTo: 'statutory-setup',
          }),
        ),
      ),
    );
    expect(pathname, 'the refusal reaches the screen that holds the form it is about').toBe(
      SETUP(b.companyId),
    );
    expect(q.get('error')).toBeTruthy();
    expect(q.get('mode'), 'no mode survives the page that had one').toBeNull();
    expect(q.get('toast'), 'a refusal is not a success').toBeNull();
  });

  /**
   * ⚠️ NO POSTED BODY REACHES THE PATH AT ALL NOW, AND THE CASE IS KEPT RATHER THAN DELETED BECAUSE THAT
   * IS THE CLAIM WORTH PINNING.
   *
   * r355 built `…/statutory/<body>` out of the posted `authority`, so this case existed to prove the
   * value went through `isStatutoryAuthority` first — a body outside `STATUTORY_AUTHORITIES` had to fall
   * back to the list rather than build an address out of what was posted. The per-body page is deleted,
   * the redirect is `companyId`-only, and so the STRONGER claim is now true: a crafted body cannot reach
   * the path even if the check were removed. Run rather than scanned, because only the parsed target can
   * show it — and a future round re-introducing a per-body address fails here.
   */
  it('never lets a posted body reach the redirect path, whatever is posted', async () => {
    for (const bogus of ['koperasi', '../../evil', 'epf?mode=edit&x=1', 'EPF']) {
      const { pathname, q } = parse(
        await redirectOf(() =>
          setCompanyStatutoryAuthorityAction(
            fd({
              companyId: b.companyId,
              authority: bogus,
              bankProfileId: '00000000-0000-4000-8000-000000000000',
              returnTo: 'statutory-setup',
            }),
          ),
        ),
      );
      expect(pathname, bogus).toBe(SETUP(b.companyId));
      expect(pathname, 'nothing posted reached the path').not.toContain('evil');
      expect(q.get('mode'), 'and no mode is bolted on, because no screen reads one').toBeNull();
      expect(q.get('error'), 'the refusal is still shown').toBeTruthy();
    }
  });

  it('Clear this authority returns to the list on success, and to the body on a refusal', async () => {
    await setCompanyStatutoryAuthorityAction(
      fd({ companyId: b.companyId, authority: 'socso', accountNo: 'S-1' }),
    ).catch((e) => {
      if (!(e instanceof RedirectError)) throw e;
    });
    const [auth] = await listCompanyStatutoryAuthorities(ADMIN, b.companyId);
    expect(auth, 'fixture').toBeTruthy();
    const { pathname, q } = parse(
      await redirectOf(() =>
        removeCompanyStatutoryAuthorityAction(
          fd({ id: auth.id, companyId: b.companyId, returnTo: 'statutory-setup' }),
        ),
      ),
    );
    expect(pathname, 'a successful clear returns to the LIST, where the row now reads Not Configured').toBe(
      SETUP(b.companyId),
    );
    expect(q.get('toast')).toBe('Removed');

    /**
     * AND THE REFUSAL HALF, which is why `authority` rides on the Clear form at all: the delete is keyed off
     * the row ID, so the body is carried ONLY so that a refusal can be returned to the screen the button is on.
     *
     * ⚠️ AND THE FIRST WRITING OF THIS CASE WAS WRONG ABOUT WHAT IS REACHABLE, WHICH IS WORTH RECORDING.
     * "Clear a row that is already gone" is NOT a refusal: `core/statutory-authority.ts`
     * `removeCompanyStatutoryAuthority` returns `{ id: null }` for a missing row and does not throw, so that
     * path redirects as a success. What DOES throw is an `id` that is not a uuid, which Postgres refuses when
     * it casts the predicate — a crafted request rather than anything the form can post, and therefore the only
     * refusal this action has. A guard that cannot name a reachable refusal is a guard pinning nothing.
     */
    const refused = parse(
      await redirectOf(() =>
        removeCompanyStatutoryAuthorityAction(
          fd({ id: 'not-a-uuid', companyId: b.companyId, authority: 'socso', returnTo: 'statutory-setup' }),
        ),
      ),
    );
    /**
     * ⚠️ r355 EXPECTED `BODY(b.companyId, 'socso')` WITH `?mode=edit` HERE. That per-body page is deleted
     * (rev 4, r372) and the body's card is on `…/statutory`, so the button IS on the screen this lands
     * on — the claim is unchanged, the address is simpler, and the posted `authority` no longer reaches
     * a path at all.
     */
    expect(refused.pathname, 'the refusal reaches the screen the button is on').toBe(SETUP(b.companyId));
    expect(refused.q.get('mode'), 'and no mode, because no screen reads one').toBeNull();
    expect(refused.q.get('error')).toBeTruthy();
    expect(refused.q.get('toast'), 'a refusal is not a success').toBeNull();
  });

  /**
   * THE SAME SHAPE §3 GUARDS FOR ARCHIVE: two bindings, two destinations, and the marker is what chooses.
   * Without it the panel's behaviour is byte-identical to what §1 already asserts — which is the whole
   * reason the destination comes from the FORM rather than from a repointed action.
   */
  it('without the marker the very same action still returns to the company panel and its tab', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        setCompanyStatutoryAuthorityAction(
          fd({ companyId: b.companyId, authority: 'epf', accountNo: 'A-2', tab: 'statutory' }),
        ),
      ),
    );
    expect(pathname, 'the panel, not the setup screen').toBe(`${LIST}/${b.companyId}`);
    expect(q.get('tab')).toBe('statutory');
    expect(q.get('toast'), 'and the panel keeps the generic confirmation').toBe('Saved');
  });

  /**
   * THE MARKER IS A CLOSED-LIST LITERAL, NEVER A PATH. It decides which of two screens a redirect goes to,
   * so an arbitrary posted value must not be echoed anywhere — the same rule `companyTab` exists for, in the
   * one place a path and a query string meet. `okStatutorySetup` builds the address from the company id.
   */
  it('a returnTo that is not the closed-list value is ignored rather than echoed into the URL', async () => {
    for (const bogus of ['statutory-setup?toast=Pwned', '../../evil', 'company', 'STATUTORY-SETUP']) {
      const { pathname, q } = parse(
        await redirectOf(() =>
          setCompanyStatutoryAuthorityAction(
            fd({ companyId: b.companyId, authority: 'epf', accountNo: 'A-3', returnTo: bogus }),
          ),
        ),
      );
      expect(pathname, bogus).toBe(`${LIST}/${b.companyId}`);
      expect(q.get('toast'), bogus).toBe('Saved');
      expect(pathname, 'nothing posted reached the path').not.toContain('evil');
    }
  });

  /** An empty company id degrades to the LIST rather than emitting `/admin/organization//statutory`. */
  it('an empty company id degrades to the list rather than building a broken address', async () => {
    const { pathname } = parse(
      await redirectOf(() =>
        setCompanyStatutoryAuthorityAction(fd({ companyId: '', authority: 'epf', returnTo: 'statutory-setup' })),
      ),
    );
    expect(pathname).toBe(LIST);
  });
});

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§5 the panel posts what the actions read, and says it in six languages', () => {
  const noop = () => undefined;
  const actions = {
    saveGeneralTab: async () => ({ ok: true, saved: [] }),
    // 15e5bd93 rev 2 (r353) — `saveStatutoryTab` STOOD HERE. The note beside it said "there is no thirteenth
    // destination to pin", because the consolidated statutory Save RETURNED a result instead of redirecting.
    // There IS one now: the reporter contested that Save and asked for a dedicated screen, so the two
    // authority actions carry a second destination, and §6 below pins it.
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
    deleteBlockedBy: 'employees',
    canDelete: true,
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
   * `removeCompanyStatutoryAuthorityAction` read `companyId` to decide where to return, and their forms post
   * the ROW id. If the hidden field is ever dropped the action still SUCCEEDS — the delete works — and
   * silently lands the reader on the list again. §1 runs the actions; this pins the other half.
   *
   * ⚠️ RE-POINTED THREE TIMES, NEVER WEAKENED. "Clear this authority" moved to the dedicated Statutory
   * Payment Setup screen with the editor it belongs to (r353), then to the per-body page when the
   * reporter asked for one body at a time (r355), and BACK to the one screen when they contested that
   * page as "an unnecessary intermediate page" (r372) — so the authority half of this case reads
   * components/statutory-setup-screen.tsx again. Both halves are still asserted, and the authority form
   * still carries FOUR hidden fields: the row id, the company, the `returnTo` marker (its destination is
   * a different route rather than a different tab) and the `authority`, so a REFUSED clear can be
   * returned to the screen the button is on.
   *
   * ⚠️ AND ONE THING IS NEW AND IS THE REASON THIS CASE MATTERS MORE THAN IT DID. That screen now has a
   * consolidated Save. "Clear" DELETES a row — bucket (b) of
   * docs/audits/65b22c00-organization-save-classification.md — so it must stay OUTSIDE the section
   * marker, or a screen-wide "Save all changes" would appear to cover a deletion. Asserted below.
   */
  it('the remove forms carry the company id, not only the row id', () => {
    const html = markup('en');
    expect(html, "the bank profile's row id").toContain('value="bp1"');
    // One company-id input per form on the panel that needs one.
    const ids = html.match(/name="companyId" value="c1"/g) ?? [];
    expect(ids.length, 'every form that posts a row id also posts the company').toBeGreaterThanOrEqual(4);
    // The authority half, where it lives now. Source rather than render because the form only exists once a
    // card is in edit mode — which test/15e5bd93-statutory-screen.dom.test.tsx drives for real.
    const screen = read('components/statutory-setup-screen.tsx');
    const clear = screen.slice(screen.indexOf('action={actions.removeStatutoryAuthority}'), screen.indexOf('</form>', screen.indexOf('action={actions.removeStatutoryAuthority}')));
    expect(clear, 'the authority ROW id').toContain('name="id" value={r.id}');
    expect(clear, 'and the company it returns to').toContain('name="companyId" value={companyId}');
    expect(clear, 'and WHICH flow it belongs to').toContain('name="returnTo" value={RETURN_TO_SETUP}');
    expect(clear, 'and which BODY, so a refusal can return to this screen').toContain(
      'name="authority" value={authority}',
    );
    // ⚠️ AND IT IS NOT UNDER THE SCREEN'S SAVE. A `data-save-section` on this form would put a DELETE
    // inside "Save all changes" and, worse, inside the Discard the leave prompt offers.
    expect(clear, 'Clear is bucket (b) and stays outside the consolidated Save').not.toContain(
      'data-save-section',
    );
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
