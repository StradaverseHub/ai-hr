/**
 * 15e5bd93 REVISION 2 (r353) — SAVE ON ONE STATUTORY BODY'S CARD, and the fence that keeps it honest.
 *
 * ⚠️ THIS FILE WAS `test/organization-statutory-tab-save.test.ts` AND IT TESTED A CONSOLIDATED SAVE THAT NO
 * LONGER EXISTS. r352 gave the Statutory tab one "Save Changes" over nine sections; the reporter contested
 * the in-tab editing it depended on and asked for "a dedicated full-width screen" with Save and Cancel on
 * each card. `saveCompanyStatutoryTabAction` is retired, so every card posts to
 * `setCompanyStatutoryAuthorityAction` — the writer that has been bound since R46.
 *
 * NOTHING THAT FILE GUARDED IS DROPPED. Each of its claims is re-derived here against the action that now
 * does the work, and the ones that were ABOUT the consolidated payload (a section vocabulary, nine hidden
 * company ids, a declared write order) are replaced by the claim that still carries their risk. Case by
 * case, old → new, in order:
 *
 *   1. "writes the registrations card and two bodies, and reports each of them saved"
 *      → §1: saving a body writes BOTH of its halves — the payment row and, where it has one, the filing
 *        number in `company_statutory_my`. The registrations card is its own form again and is covered by
 *        test/organization-general-tab-save.test.ts and the layout guard.
 *   2. "saving ONE body cannot blank another body's filing number, or SSM, or MyInvois"
 *      → §1, UNCHANGED IN SUBSTANCE and still the most important case in the file. `company_statutory_my`
 *        is one row holding five numbers; an absent key must arrive as `undefined`, never as `''`. This is
 *        the r226 data loss and it is reachable from the per-card path exactly as it was from the tab save.
 *   3. "an UNTOUCHED body is never written — no row is created for it at all"
 *      → §1: one card's save creates one row. Under a consolidated save the risk was a section list that
 *        over-reached; here it is an action that upserts every authority it knows about.
 *   4. "a refused body names itself, and what committed before it stays committed"
 *      → §2: a refusal REDIRECTS now rather than returning, so the claim becomes "the refusal reaches the
 *        screen the form is on, and the body it refused has no row".
 *   5. "refuses a section this tab does not own, BEFORE writing a byte"
 *      → §2: there is no section vocabulary any more. The equivalent fence is the AUTHORITY vocabulary:
 *        `core/statutory-authority.ts` refuses a body outside the controlled set, and `koperasi` — removed
 *        from that set by efe424b0 — is the case that proves the list is really consulted.
 *   6. "a section cannot point its write at another company"
 *      → §2: one company id per request now, so the crafted-payload shape is gone; what remains, and is
 *        run, is that the id on the form is the company written and a DIFFERENT company is untouched.
 *   7. "takes the body from the validated section id, not from the posted `authority`"
 *      → §2: the section id is gone, so the posted `authority` IS the input. It is therefore VALIDATED
 *        rather than trusted, which is the same protection at a different layer, and that is asserted by
 *        running a bogus body rather than by reading source.
 *   8. "a body with no filing control writes nothing towards the identity row"
 *      → §1, UNCHANGED. A body like PTPTN posts none of the four filing names, so no identity row may be
 *        invented for it.
 *   9. "the declared order is the identity card then the controlled set"
 *      → retired with the vocabulary it asserted. One card per request has no order.
 *
 * §3 is NEW and is the reporter's fourth approved point: saving keeps the operator on the dedicated screen
 * and the confirmation NAMES the body. test/organization-stay-on-save.test.ts runs the same destination
 * beside the other twelve company actions; here it is asserted with the body's own catalogue string, which
 * is the half that file has no translator for.
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
}));
/**
 * A REAL translator over messages/en.json that THROWS on a missing message — the house pattern
 * (test/organization-stay-on-save.test.ts). It is what makes §3 a check on the CONFIRMATION and not only on
 * the address: `authoritySavedToast` takes a `{body}` argument, and a catalogue that lost either the key or
 * the placeholder would fail here rather than in a dev-server log.
 */
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
  removeCompanyStatutoryAuthorityAction,
  setCompanyStatutoryAuthorityAction,
} from '../app/admin/actions';
// 15e5bd93 rev 4 (r371) — the screen-wide Save, recovered from r352 (d991c149) and re-pointed. It RETURNS
// a TabSaveResult rather than redirecting, so §4 reads its answer instead of catching a RedirectError.
import { saveCompanyStatutoryTabAction } from '../app/admin/organization/statutory-tab-actions';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';

let b: Base;
let other: string;

const RETURN_TO_SETUP = 'statutory-setup';
const LIST = '/admin/organization';

/**
 * EXACTLY WHAT ONE CARD POSTS: the thirteen payment names, the return marker, and — where the body has a
 * filing control — `filingCountry` plus that control. Written out rather than partially specified, because
 * "a field that is always submitted cannot be read by presence" (CLAUDE.md §8) cuts both ways: a fixture
 * that omits a box the real form renders would let a presence-read defect pass.
 */
function cardPost(authority: string, over: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    companyId: b.companyId,
    authority,
    returnTo: RETURN_TO_SETUP,
    accountNo: '',
    bankProfileId: '',
    addressLine1: '',
    addressLine2: '',
    addressLine3: '',
    city: '',
    state: '',
    postcode: '',
    country: '',
    phone: '',
    email: '',
    signatoryPersonId: '',
    ...over,
  })) {
    f.set(k, v);
  }
  return f;
}

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
const parse = (target: string) => {
  const u = new URL(target, 'http://x');
  return { pathname: u.pathname, q: u.searchParams };
};

const identityRow = async (companyId: string) =>
  (await owner.db.select().from(schema.companyStatutoryMy).where(eq(schema.companyStatutoryMy.companyId, companyId)))[0];

const authorityRow = async (companyId: string, authority: string) =>
  (
    await owner.db
      .select()
      .from(schema.companyStatutoryAuthority)
      .where(
        and(
          eq(schema.companyStatutoryAuthority.companyId, companyId),
          eq(schema.companyStatutoryAuthority.authority, authority),
        ),
      )
  )[0];

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
    .returning({ id: schema.company.id });
  other = c2.id;
});
afterAll(async () => {
  await closeAll();
});

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 one card, one body, both of its halves', () => {
  it('writes the payment row AND the filing number, from the one form', async () => {
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(
        cardPost('epf', { filingCountry: 'MY', epfEmployerNo: 'E 1234567890', accountNo: 'EPF-ACC' }),
      ),
    );
    expect((await authorityRow(b.companyId, 'epf')).accountNo, 'company_statutory_authority').toBe('EPF-ACC');
    expect((await identityRow(b.companyId)).epfEmployerNo, 'company_statutory_my').toBe('E 1234567890');
  });

  /**
   * THE r226 DATA-LOSS CASE, CARRIED ACROSS FROM THE RETIRED TAB SAVE WITHOUT WEAKENING.
   *
   * `company_statutory_my` is ONE row holding five numbers written from five different forms. Saving the
   * EPF card must not blank SOCSO's, LHDN's, MyInvois's or SSM's number — and the only thing standing
   * between them is that an ABSENT key arrives as `undefined` rather than as `''`. A single
   * `formData.get(x) ?? ''` anywhere on this path loses four customer values with a 200 and a green suite.
   */
  it('saving ONE body cannot blank another body’s filing number, or SSM, or MyInvois', async () => {
    // Seed all five through the paths that own them.
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(cardPost('epf', { filingCountry: 'MY', epfEmployerNo: 'EPF-1' })),
    );
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(cardPost('socso', { filingCountry: 'MY', socsoEmployerCode: 'SOCSO-1' })),
    );
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(cardPost('lhdn', { filingCountry: 'MY', lhdnEmployerNo: 'LHDN-1' })),
    );
    await owner.db
      .update(schema.companyStatutoryMy)
      .set({ ssmRegistrationNo: 'SSM-1', myinvoisTin: 'TIN-1' })
      .where(eq(schema.companyStatutoryMy.companyId, b.companyId));

    // Now touch EPF alone, exactly as the screen does when only that card was edited.
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(cardPost('epf', { filingCountry: 'MY', epfEmployerNo: 'EPF-2' })),
    );
    const row = await identityRow(b.companyId);
    expect(row.epfEmployerNo, 'the one the operator edited').toBe('EPF-2');
    expect(row.socsoEmployerCode, 'SOCSO survives an EPF save').toBe('SOCSO-1');
    expect(row.lhdnEmployerNo, 'LHDN survives an EPF save').toBe('LHDN-1');
    expect(row.ssmRegistrationNo, 'SSM survives an EPF save').toBe('SSM-1');
    expect(row.myinvoisTin, 'MyInvois survives an EPF save').toBe('TIN-1');
  });

  /**
   * AN OPERATOR WHO CLEARS A BOX MEANS IT. The other half of the presence read, and the half a naive
   * "absent means leave alone" implementation gets wrong in the opposite direction: a filing number the
   * form carried as an EMPTY string must be written as empty, or the field becomes impossible to clear.
   */
  it('an EMPTY filing box clears the number rather than being read as "not submitted"', async () => {
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(cardPost('epf', { filingCountry: 'MY', epfEmployerNo: 'E-9' })),
    );
    expect((await identityRow(b.companyId)).epfEmployerNo).toBe('E-9');
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(cardPost('epf', { filingCountry: 'MY', epfEmployerNo: '' })),
    );
    expect((await identityRow(b.companyId)).epfEmployerNo, 'cleared, not left alone').toBeFalsy();
  });

  it('an UNTOUCHED body is never written — one card’s save creates exactly one row', async () => {
    await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost('epf', { accountNo: 'ONLY-EPF' })));
    const rows = await owner.db
      .select()
      .from(schema.companyStatutoryAuthority)
      .where(eq(schema.companyStatutoryAuthority.companyId, b.companyId));
    expect(
      rows.map((r) => r.authority),
      'the body whose card was saved, and no other',
    ).toEqual(['epf']);
  });

  /**
   * THE PACK FLAG IS `filingCountry`. A body whose card carried no filing control posts none of the four
   * filing names, so the identity row must not be touched at all — not created empty, not defaulted.
   */
  it('a body with no filing control writes nothing towards the identity row', async () => {
    await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost('ptptn', { accountNo: 'PTPTN-ACC' })));
    expect((await authorityRow(b.companyId, 'ptptn')).accountNo).toBe('PTPTN-ACC');
    expect(await identityRow(b.companyId), 'no identity row was invented').toBeUndefined();
  });

  /**
   * AND THE COLLISION THE RENAME EXISTS FOR, RUN RATHER THAN READ. The card posts a VISIBLE postal
   * `country` ("Malaysia", a name from the ISO list) and a HIDDEN `filingCountry` ("MY", an ISO code). If
   * the pack lookup ever read `country` again the save would die with "No statutory pack for Malaysia" —
   * which is exactly what happened during r352 and what the rename fixed. Both values on one payload is
   * the condition; this asserts the outcome.
   */
  it('a postal country of "Malaysia" on the same form does not poison the pack lookup', async () => {
    await redirectOf(() =>
      setCompanyStatutoryAuthorityAction(
        cardPost('lhdn', { filingCountry: 'MY', lhdnEmployerNo: 'E-777', country: 'Malaysia', city: 'Ipoh' }),
      ),
    );
    expect((await identityRow(b.companyId)).lhdnEmployerNo, 'the filing number landed').toBe('E-777');
    expect((await authorityRow(b.companyId, 'lhdn')).country, 'and the postal country is its own value').toBe(
      'Malaysia',
    );
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 the fence on the server', () => {
  /**
   * THE BODY IS VALIDATED, NOT TRUSTED. The retired tab save took the authority from a section id it had
   * already checked against a closed vocabulary; a per-card save has no such id, so the posted string IS
   * the input and the AUTHORITY vocabulary is the fence. `koperasi` is in this list deliberately: efe424b0
   * removed it from the controlled set, so a service that merely accepted any string would let a retired
   * body come back as a row nothing renders.
   */
  it('refuses a body outside the controlled set, and writes nothing', async () => {
    for (const bogus of ['koperasi', 'identity', 'company', 'bank', '', 'EPF']) {
      const { pathname, q } = parse(
        await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost(bogus, { accountNo: 'SHOULD-NOT-LAND' }))),
      );
      expect(q.get('error'), bogus).toBeTruthy();
      expect(q.get('toast'), 'a refusal is not a success').toBeNull();
      expect(pathname, 'and the refusal reaches the screen the form is on').toBe(
        `${LIST}/${b.companyId}/statutory`,
      );
      const rows = await owner.db
        .select()
        .from(schema.companyStatutoryAuthority)
        .where(eq(schema.companyStatutoryAuthority.companyId, b.companyId));
      expect(rows, `${bogus}: nothing was written`).toHaveLength(0);
    }
  });

  it('every body in the controlled set IS accepted — the fence is a list, not a blanket', async () => {
    for (const a of STATUTORY_AUTHORITIES) {
      const { q } = parse(await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost(a, { accountNo: `${a}-1` }))));
      expect(q.get('error'), a).toBeNull();
      expect((await authorityRow(b.companyId, a)).accountNo, a).toBe(`${a}-1`);
    }
  });

  /**
   * A REFUSAL NAMES ITSELF AND COMMITS NOTHING FOR THAT BODY. The retired tab save RETURNED a
   * `failedSection` because a redirect could not say which of nine writes broke; one card per request can,
   * because the screen the refusal lands on is the screen with that card open. The reachable refusal used
   * here is the same one the old case used: a bank profile reference belonging to nobody.
   */
  /**
   * ⚠️ RE-POINTED BY REVISION 3 (r355). r353 asserted
   * `expect(pathname).toBe(`${LIST}/${b.companyId}/statutory`)` — the setup screen WAS the form, because the
   * eight editors were on it. r355 sent the refusal to `…/statutory/<body>?mode=edit`, because the list
   * had become a table of rows and that page was the only one holding the boxes the message was about.
   *
   * ⚠️ REVERSED BY REVISION 4 (r371), AND THE RULE IS WHAT REVERSED IT. The reporter contested the
   * per-body page as "an unnecessary intermediate page"; every body's form is on `…/statutory` again, so
   * THAT is the screen that holds the boxes, and sending the refusal there satisfies exactly the
   * requirement r355's split was built for — app/admin/_redirects.ts's own record of `failCompany`
   * having "showed the refusal on a screen that no longer held the form it was about".
   */
  it('a refused save reaches the statutory screen with the message, and leaves no row behind', async () => {
    const { pathname, q } = parse(
      await redirectOf(() =>
        setCompanyStatutoryAuthorityAction(
          cardPost('lhdn', { bankProfileId: '00000000-0000-4000-8000-000000000000' }),
        ),
      ),
    );
    expect(pathname).toBe(`${LIST}/${b.companyId}/statutory`);
    expect(q.get('mode'), 'no mode survives the page that read one').toBeNull();
    expect(pathname, 'and no posted body reaches the path any more').not.toContain('/lhdn');
    expect(q.get('error')).toBeTruthy();
    expect(await authorityRow(b.companyId, 'lhdn'), 'the refused body has no row').toBeUndefined();
  });

  /**
   * THE COMPANY WRITTEN IS THE COMPANY ON THE FORM, AND A DIFFERENT COMPANY IS UNTOUCHED.
   *
   * The crafted-payload shape the old case defended against (nine hidden company ids in one request) does
   * not exist any more, but the claim underneath it does: this screen is a second door onto the same rows,
   * and a second door must not be an easier door. Out-of-scope refusal for the ROUTE is run by
   * test/organization-list-detail.test.ts; this runs the WRITE.
   */
  it('a card writes its own company and never the other one', async () => {
    await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost('epf', { accountNo: 'MINE' })));
    expect((await authorityRow(b.companyId, 'epf')).accountNo).toBe('MINE');
    expect(await authorityRow(other, 'epf'), 'the other company got nothing').toBeUndefined();
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 the reporter’s fourth approved point: stay here, and say what was saved', () => {
  it('a card save returns to the statutory screen, naming the body', async () => {
    const { pathname, q } = parse(
      await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost('epf', { accountNo: 'A-1' }))),
    );
    expect(pathname, 'never the company list, never the company panel').toBe(`${LIST}/${b.companyId}/statutory`);
    // The body's own catalogue string, so the toast and the card cannot call one body two different things.
    expect(q.get('toast')).toBe('EPF (KWSP) saved');
    expect(q.get('tab'), 'this screen has no tabs to carry').toBeNull();
  });

  it('every body’s confirmation names that body, and none of them says the bare word Saved', async () => {
    for (const a of STATUTORY_AUTHORITIES) {
      const { q } = parse(await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost(a, { accountNo: 'x' }))));
      expect(q.get('toast'), a).toMatch(/ saved$/);
      expect(q.get('toast'), `${a}: the bare fallback would answer the wrong question`).not.toBe('Saved');
    }
  });

  /**
   * WITHOUT THE MARKER, NOTHING CHANGES FOR THE TWELVE OTHER CALL SITES. The same action bound on the
   * company panel must still return to the company panel and still carry its tab — which is what makes
   * this a per-FORM destination rather than a repointed action. The full twelve are run in
   * test/organization-stay-on-save.test.ts; this is the pair that proves the marker is what switches.
   */
  it('the same action without the marker still returns to the company panel, with its tab', async () => {
    const f = cardPost('epf', { accountNo: 'A-2' });
    f.delete('returnTo');
    f.set('tab', 'statutory');
    const { pathname, q } = parse(await redirectOf(() => setCompanyStatutoryAuthorityAction(f)));
    expect(pathname).toBe(`${LIST}/${b.companyId}`);
    expect(q.get('tab')).toBe('statutory');
    expect(q.get('toast'), 'and the panel keeps the generic confirmation it always had').toBe('Saved');
  });

  /**
   * CLEAR IS THE ONE CONTROL ON THIS SCREEN THAT IS NOT A FIELD EDIT — it DELETES the body's row (bucket
   * (b) of docs/audits/65b22c00-organization-save-classification.md). It stays on the screen like
   * everything else, and it keeps the GENERIC confirmation: naming a body that no longer has a record
   * would read as a confirmation that it was saved.
   */
  it('Clear this authority returns to the list, and says Removed rather than naming the body', async () => {
    await redirectOf(() => setCompanyStatutoryAuthorityAction(cardPost('zakat', { accountNo: 'Z-1' })));
    const row = await authorityRow(b.companyId, 'zakat');
    expect(row, 'fixture').toBeTruthy();
    const f = new FormData();
    f.set('id', row.id);
    f.set('companyId', b.companyId);
    f.set('authority', 'zakat');
    f.set('returnTo', RETURN_TO_SETUP);
    const { pathname, q } = parse(await redirectOf(() => removeCompanyStatutoryAuthorityAction(f)));
    // rev 4 — the statutory screen, where the card the operator just cleared now reads "Not set up". That
    // visible change is the confirmation the toast cannot give, which is why the generic "Removed" is
    // enough here.
    expect(pathname).toBe(`${LIST}/${b.companyId}/statutory`);
    expect(q.get('toast')).toBe('Removed');
    expect(await authorityRow(b.companyId, 'zakat'), 'and it really cleared the row').toBeUndefined();
  });

  /**
   * AN EMPTY companyId DEGRADES TO THE LIST rather than emitting `/admin/organization//statutory`, which is
   * okCompany's rule and the reason these helpers exist at all (app/admin/_redirects.ts). A path this
   * screen can build wrong is a path a refusal can be lost on.
   */
  it('a marker with no company id falls back to the list rather than building a broken address', async () => {
    const f = cardPost('epf', { accountNo: 'A-3' });
    f.set('companyId', '');
    const { pathname } = parse(await redirectOf(() => setCompanyStatutoryAuthorityAction(f)));
    expect(pathname, 'no double slash, no empty segment').toBe(LIST);
  });
});

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ⚠️ THE ONE SAVE FOR THE WHOLE SCREEN, RUN AGAINST A REAL DATABASE — 15e5bd93 REVISION 4 (r371).
 *
 * The reporter has asked for this in every version of their request and we have never built it: "Provide
 * one Save button for the entire Statutory Payment Setup screen… Save all changes together… remain on the
 * same screen." `app/admin/organization/statutory-tab-actions.ts` is r352's writer, recovered from
 * d991c149 and re-pointed at the dedicated screen.
 *
 * ⚠️ THE LOAD-BEARING CLAIM OF THIS ROUND IS THAT IT WRITES ONLY THE BODIES THE OPERATOR TOUCHED, AND IT
 * IS ASSERTED HERE RATHER THAN DESCRIBED. A Save that wrote all eight would CREATE a
 * `company_statutory_authority` row for every body and flip every "Not set up" card to "Set up" — eight
 * statutory bodies registered because somebody fixed a postcode, with no error, a 200, and nothing on
 * screen saying it had happened. A test that passed while all eight were written would be the worst
 * outcome this round could ship, so the row COUNT is asserted, by body, not merely "the one I asked for
 * is there".
 *
 * The client half — that the payload names only the dirty sections — is driven through real events in
 * test/15e5bd93-statutory-screen.dom.test.tsx §2. This is the server refusing to over-reach even if that
 * half ever regressed, which is the whole reason the check exists twice.
 */
describe('§4 the screen-wide Save writes only what was touched', () => {
  /** One section's contribution to the consolidated payload, in the wire format lib/tab-save-dom.ts builds. */
  function section(f: FormData, authority: string, fields: Record<string, string>): void {
    for (const [k, v] of Object.entries(fields)) f.append(`section.${authority}.${k}`, v);
  }
  /** Everything one card posts, namespaced — including the absences, which are the r226 contract. */
  function cardSection(f: FormData, authority: string, over: Record<string, string> = {}): void {
    section(f, authority, {
      companyId: b.companyId,
      authority,
      returnTo: RETURN_TO_SETUP,
      accountNo: '',
      bankProfileId: '',
      addressLine1: '',
      addressLine2: '',
      addressLine3: '',
      city: '',
      state: '',
      postcode: '',
      country: '',
      phone: '',
      email: '',
      signatoryPersonId: '',
      ...over,
    });
  }
  const screenPost = (sections: string[]) => {
    const f = new FormData();
    f.set('companyId', b.companyId);
    f.set('tab', 'statutory');
    f.set('sections', sections.join(','));
    return f;
  };
  const allRows = async (companyId: string) =>
    (
      await owner.db
        .select()
        .from(schema.companyStatutoryAuthority)
        .where(eq(schema.companyStatutoryAuthority.companyId, companyId))
    )
      .map((r) => r.authority)
      .sort();

  it('creates a row for the ONE body named, and for no other body at all', async () => {
    const f = screenPost(['epf']);
    cardSection(f, 'epf', { accountNo: 'EPF-ACC', filingCountry: 'MY', epfEmployerNo: 'E-1' });
    const result = await saveCompanyStatutoryTabAction(f);
    expect(result.ok, result.error).toBe(true);
    expect(result.saved, 'and it reports what it wrote').toEqual(['epf']);
    expect((await authorityRow(b.companyId, 'epf')).accountNo).toBe('EPF-ACC');
    expect((await identityRow(b.companyId)).epfEmployerNo, 'both halves, from one Save').toBe('E-1');
    /**
     * ⚠️ THE ASSERTION THAT FAILS IF THE SAVE EVER WRITES EVERYTHING. Not "socso is absent" — the whole
     * table for this company, as an exact list, so seven invented rows cannot hide behind a spot check.
     */
    expect(await allRows(b.companyId), 'exactly one row exists').toEqual(['epf']);
  });

  it('writes two bodies when two are named, and still creates nothing for the other six', async () => {
    const f = screenPost(['epf', 'lhdn']);
    cardSection(f, 'epf', { accountNo: 'EPF-ACC' });
    cardSection(f, 'lhdn', { city: 'Putrajaya', filingCountry: 'MY', lhdnEmployerNo: 'E-777' });
    const result = await saveCompanyStatutoryTabAction(f);
    expect(result.ok, result.error).toBe(true);
    expect(await allRows(b.companyId)).toEqual(['epf', 'lhdn']);
    expect((await authorityRow(b.companyId, 'lhdn')).city).toBe('Putrajaya');
    expect((await identityRow(b.companyId)).lhdnEmployerNo).toBe('E-777');
  });

  /**
   * ⚠️ THE NAMED SET IS THE FENCE, NOT THE PACKED SET. A payload that CARRIES a section's fields but does
   * not NAME it in `sections` must not write it — which is the shape a future client bug would take
   * (packing every section, naming only the dirty ones), and the one that would silently register seven
   * bodies.
   */
  it('ignores a section whose fields are present but which the client did not name', async () => {
    const f = screenPost(['epf']);
    cardSection(f, 'epf', { accountNo: 'EPF-ACC' });
    cardSection(f, 'socso', { accountNo: 'SHOULD-NOT-BE-WRITTEN' });
    const result = await saveCompanyStatutoryTabAction(f);
    expect(result.ok, result.error).toBe(true);
    expect(result.saved).toEqual(['epf']);
    expect(await allRows(b.companyId), 'SOCSO was carried, not named, and not written').toEqual(['epf']);
  });

  /**
   * THE r226 DATA LOSS, ON THE CONSOLIDATED PATH. `company_statutory_my` is ONE row holding five numbers
   * and the writer is a PARTIAL PATCH: an ABSENT key means "leave the stored value alone". Saving EPF
   * must not blank SOCSO's or LHDN's number, or SSM, or MyInvois — and on THIS screen that is reachable
   * on every single Save, because all eight cards are in one payload's reach.
   */
  it('saving one body cannot blank another body’s filing number, or SSM, or MyInvois', async () => {
    await owner.db.insert(schema.companyStatutoryMy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      epfEmployerNo: 'E-OLD',
      socsoEmployerCode: 'S-KEEP',
      lhdnEmployerNo: 'L-KEEP',
      myinvoisTin: 'TIN-KEEP',
      ssmRegistrationNo: 'SSM-KEEP',
    });
    const f = screenPost(['epf']);
    cardSection(f, 'epf', { accountNo: 'A', filingCountry: 'MY', epfEmployerNo: 'E-NEW' });
    expect((await saveCompanyStatutoryTabAction(f)).ok).toBe(true);
    const row = await identityRow(b.companyId);
    expect(row.epfEmployerNo, 'the one that was on the card').toBe('E-NEW');
    expect(row.socsoEmployerCode, 'absent means leave alone, never ""').toBe('S-KEEP');
    expect(row.lhdnEmployerNo).toBe('L-KEEP');
    expect(row.myinvoisTin).toBe('TIN-KEEP');
    expect(row.ssmRegistrationNo).toBe('SSM-KEEP');
  });

  /**
   * THE VOCABULARY IS THE EIGHT BODIES AND NOTHING ELSE. r352's order opened with an `identity` section
   * for the SSM / MyInvois card; this screen prints that identity READ-ONLY and those two numbers keep
   * their one editor on the company panel, so the section id is not in the vocabulary and a crafted
   * payload naming it is refused BEFORE anything is written.
   */
  it('refuses a section this screen does not own, before writing a byte', async () => {
    for (const bogus of ['identity', 'company', 'bank', 'delete', 'koperasi', '']) {
      const f = screenPost(['epf', bogus].filter(Boolean));
      cardSection(f, 'epf', { accountNo: 'EPF-ACC' });
      section(f, bogus, { companyId: b.companyId, ssmRegistrationNo: 'PWNED' });
      const result = await saveCompanyStatutoryTabAction(f);
      if (bogus === '') {
        // An empty name is filtered out of the list rather than refused; EPF still writes.
        expect(result.ok, 'an empty section name is not a section').toBe(true);
        expect(await allRows(b.companyId)).toEqual(['epf']);
        continue;
      }
      expect(result.ok, bogus).toBe(false);
      expect(result.failedSection, bogus).toBe(bogus);
      expect(result.saved, 'and nothing was written before the refusal').toEqual([]);
      expect(await allRows(b.companyId), `${bogus}: no row was created`).toEqual([]);
      expect(await identityRow(b.companyId), `${bogus}: and no identity row either`).toBeUndefined();
    }
  });

  /**
   * THE COMPANY IS FORCED FROM THE ONE TRUSTED TOP-LEVEL VALUE. Eight hidden `companyId` copies in one
   * payload are eight chances for a crafted request to point one body's write at another company's row,
   * so `statutorySectionFormData` drops every section-level copy and sets the top-level one.
   */
  it('writes the top-level company even when a section claims a different one', async () => {
    const f = screenPost(['epf']);
    cardSection(f, 'epf', { companyId: other, accountNo: 'MINE' });
    expect((await saveCompanyStatutoryTabAction(f)).ok).toBe(true);
    expect((await authorityRow(b.companyId, 'epf')).accountNo).toBe('MINE');
    expect(await authorityRow(other, 'epf'), 'the other company got nothing').toBeUndefined();
  });

  /**
   * THE BODY IS THE SECTION ID, NEVER THE FORM'S OWN HIDDEN COPY — the same move, for the same reason.
   * The card really does carry `name="authority"` (a refused Clear needs it), so this is reachable.
   */
  it('writes the body the SECTION names, not the one the section’s hidden input claims', async () => {
    const f = screenPost(['epf']);
    cardSection(f, 'epf', { authority: 'socso', accountNo: 'EPF-ACC' });
    expect((await saveCompanyStatutoryTabAction(f)).ok).toBe(true);
    expect(await allRows(b.companyId), 'the section id decided it').toEqual(['epf']);
  });

  /**
   * A REFUSAL RETURNS RATHER THAN REDIRECTING, and it NAMES the body that did not commit — which is the
   * whole reason this action returns a `TabSaveResult`: a redirect cannot say which of eight writes
   * failed, and the client marks exactly the committed sections clean so the rest stay edited on screen.
   * Written as `order`-first so a body earlier in the controlled set really does commit before the one
   * that fails.
   */
  it('reports which body failed, keeps what committed, and stays out of the redirect business', async () => {
    const f = screenPost(['epf', 'socso']);
    cardSection(f, 'epf', { accountNo: 'EPF-OK' });
    cardSection(f, 'socso', { bankProfileId: '00000000-0000-4000-8000-000000000000' });
    const result = await saveCompanyStatutoryTabAction(f);
    expect(result.ok).toBe(false);
    expect(result.failedSection).toBe('socso');
    expect(result.saved, 'EPF committed before it').toEqual(['epf']);
    expect(result.error, 'with the message the service gave').toBeTruthy();
    expect(await allRows(b.companyId), 'and the refused body has no row').toEqual(['epf']);
  });

  /** A body with no filing control posts no pack flag, so no identity row may be invented for it. */
  it('writes nothing towards the identity row for a body with no filing control', async () => {
    const f = screenPost(['ptptn']);
    cardSection(f, 'ptptn', { accountNo: 'PTPTN-ACC' });
    expect((await saveCompanyStatutoryTabAction(f)).ok).toBe(true);
    expect((await authorityRow(b.companyId, 'ptptn')).accountNo).toBe('PTPTN-ACC');
    expect(await identityRow(b.companyId), 'no identity row was invented').toBeUndefined();
  });

  /**
   * AND THE COLLISION THE RENAME EXISTS FOR, ON THE CONSOLIDATED PATH. The card posts a VISIBLE postal
   * `country` ("Malaysia") and a HIDDEN `filingCountry` ("MY"). If the pack lookup ever read `country`
   * again the Save would die with "No statutory pack for Malaysia" — which is what happened in r352,
   * and this screen puts EIGHT visible postal `country` selects into one scope.
   */
  it('a postal country of "Malaysia" in the same section does not poison the pack lookup', async () => {
    const f = screenPost(['lhdn']);
    cardSection(f, 'lhdn', {
      filingCountry: 'MY',
      lhdnEmployerNo: 'E-888',
      country: 'Malaysia',
      city: 'Ipoh',
    });
    const result = await saveCompanyStatutoryTabAction(f);
    expect(result.ok, result.error).toBe(true);
    expect((await identityRow(b.companyId)).lhdnEmployerNo).toBe('E-888');
    expect((await authorityRow(b.companyId, 'lhdn')).country).toBe('Malaysia');
  });
});
