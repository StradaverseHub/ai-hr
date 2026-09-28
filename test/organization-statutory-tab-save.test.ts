/**
 * 15e5bd93 (r352) — ONE "Save Changes" for Organization → a company → STATUTORY, and the fence that keeps
 * it honest.
 *
 * The sibling of test/organization-general-tab-save.test.ts, and it exists for the same reason that file
 * gives: the two things that can go quietly wrong in a consolidated save — a section writing the wrong
 * record, and an untouched card being written anyway — are both invisible to a source scan. This tab has a
 * third, which is why it gets its own file rather than a case in that one: NINE of its sections reach the
 * same `company_statutory_my` row through a PARTIAL PATCH, so a caller that reads an absent key as `''`
 * blanks another body's filing number with no error, a 200 and a green suite. That is the r226 data loss,
 * and it is re-armed the moment a second caller of that writer exists. This is the test for the second
 * caller.
 *
 * 65b22c00's Finding 1 refused this tab a scope because a bar here would have sat above eight body editors
 * it did not own. The reporter's approved redesign took the Save buttons off those editors, so it does own
 * them — see lib/company-statutory-tab-sections.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';

let ADMIN: SessionContext;
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => ADMIN,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { adminCtx, closeAll, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { saveCompanyStatutoryTabAction } from '../app/admin/organization/statutory-tab-actions';
import {
  COMPANY_STATUTORY_TAB_SECTION_ORDER,
  STATUTORY_IDENTITY_SECTION,
} from '../lib/company-statutory-tab-sections';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { SECTION_FIELD_PREFIX, SECTIONS_FIELD } from '../lib/tab-save-sections';

let b: Base;
let other: string;

const key = (section: string, field: string) => `${SECTION_FIELD_PREFIX}.${section}.${field}`;

/** The payload the client scope builds: `sections` names the dirty ids, every field namespaced. */
function payload(companyId: string, sections: Record<string, Record<string, string>>): FormData {
  const f = new FormData();
  f.set('companyId', companyId);
  f.set('tab', 'statutory');
  f.set(SECTIONS_FIELD, Object.keys(sections).join(','));
  for (const [id, fields] of Object.entries(sections)) {
    for (const [name, value] of Object.entries(fields)) f.set(key(id, name), value);
  }
  return f;
}

/** Exactly what one body's editor posts: 13 payment fields, plus its filing field where it has one. */
function bodyFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    authority: 'ignored-by-the-server',
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
  };
}

const identityRow = async (companyId: string) =>
  (
    await owner.db
      .select()
      .from(schema.companyStatutoryMy)
      .where(eq(schema.companyStatutoryMy.companyId, companyId))
  )[0];

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
describe('§1 the one Save reaches each card’s own writer', () => {
  it('writes the registrations card and two bodies, and reports each of them saved', async () => {
    const result = await saveCompanyStatutoryTabAction(
      payload(b.companyId, {
        [STATUTORY_IDENTITY_SECTION]: {
          filingCountry: 'MY',
          ssmRegistrationNo: '202301001234',
          myinvoisTin: 'C12345678900',
        },
        epf: bodyFields({ filingCountry: 'MY', epfEmployerNo: 'E 1234567890', accountNo: 'EPF-ACC' }),
        lhdn: bodyFields({ filingCountry: 'MY', lhdnEmployerNo: 'E 987654', accountNo: 'LHDN-ACC' }),
      }),
    );
    expect(result.ok).toBe(true);
    // The DECLARED order, not the order the client happened to name them in.
    expect(result.saved).toEqual([STATUTORY_IDENTITY_SECTION, 'epf', 'lhdn']);

    const identity = await identityRow(b.companyId);
    expect(identity.ssmRegistrationNo).toBe('202301001234');
    expect(identity.myinvoisTin).toBe('C12345678900');
    expect(identity.epfEmployerNo, 'the EPF body wrote its own filing number').toBe('E 1234567890');
    expect(identity.lhdnEmployerNo).toBe('E 987654');

    expect((await authorityRow(b.companyId, 'epf')).accountNo).toBe('EPF-ACC');
    expect((await authorityRow(b.companyId, 'lhdn')).accountNo).toBe('LHDN-ACC');
  });

  /**
   * THE r226 DATA-LOSS CASE, RE-ARMED FOR THE SECOND CALLER OF THE PARTIAL-PATCH WRITER.
   *
   * `company_statutory_my` is ONE row holding five numbers written by nine different sections of this tab.
   * Saving the EPF body must not blank SOCSO's, LHDN's, MyInvois's or SSM's number — and the only thing
   * standing between them is that an ABSENT key arrives as `undefined` rather than as `''`. A single
   * `formData.get(x) ?? ''` anywhere in this action's unpack path loses four customer values silently.
   */
  it('saving ONE body cannot blank another body’s filing number, or SSM, or MyInvois', async () => {
    await saveCompanyStatutoryTabAction(
      payload(b.companyId, {
        [STATUTORY_IDENTITY_SECTION]: { filingCountry: 'MY', ssmRegistrationNo: 'SSM-1', myinvoisTin: 'TIN-1' },
        epf: bodyFields({ filingCountry: 'MY', epfEmployerNo: 'EPF-1' }),
        socso: bodyFields({ filingCountry: 'MY', socsoEmployerCode: 'SOCSO-1' }),
        lhdn: bodyFields({ filingCountry: 'MY', lhdnEmployerNo: 'LHDN-1' }),
      }),
    );
    // Now touch EPF alone, exactly as the client would when only EPF is dirty.
    const result = await saveCompanyStatutoryTabAction(
      payload(b.companyId, { epf: bodyFields({ filingCountry: 'MY', epfEmployerNo: 'EPF-2' }) }),
    );
    expect(result.saved).toEqual(['epf']);
    const row = await identityRow(b.companyId);
    expect(row.epfEmployerNo, 'the one the operator edited').toBe('EPF-2');
    expect(row.socsoEmployerCode, 'SOCSO survives an EPF save').toBe('SOCSO-1');
    expect(row.lhdnEmployerNo, 'LHDN survives an EPF save').toBe('LHDN-1');
    expect(row.ssmRegistrationNo, 'SSM survives an EPF save').toBe('SSM-1');
    expect(row.myinvoisTin, 'MyInvois survives an EPF save').toBe('TIN-1');
  });

  it('an UNTOUCHED body is never written — no row is created for it at all', async () => {
    await saveCompanyStatutoryTabAction(
      payload(b.companyId, { epf: bodyFields({ filingCountry: 'MY', accountNo: 'ONLY-EPF' }) }),
    );
    const rows = await owner.db
      .select()
      .from(schema.companyStatutoryAuthority)
      .where(eq(schema.companyStatutoryAuthority.companyId, b.companyId));
    expect(
      rows.map((r) => r.authority),
      'a body not named in `sections` has no service call and therefore no row',
    ).toEqual(['epf']);
  });

  /**
   * A PARTIAL FAILURE NAMES THE BODY AND KEEPS WHAT COMMITTED. A redirect could not have said which of
   * nine writes broke, which is why this action returns instead — and the client marks exactly the
   * sections in `saved` clean and leaves the rest edited.
   */
  it('a refused body names itself, and what committed before it stays committed', async () => {
    const result = await saveCompanyStatutoryTabAction(
      payload(b.companyId, {
        epf: bodyFields({ filingCountry: 'MY', accountNo: 'COMMITTED' }),
        // A bank profile belonging to nobody: the service validates the reference rather than trusting it.
        lhdn: bodyFields({ bankProfileId: '00000000-0000-4000-8000-000000000000' }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failedSection).toBe('lhdn');
    expect(result.saved).toEqual(['epf']);
    expect((await authorityRow(b.companyId, 'epf')).accountNo).toBe('COMMITTED');
    expect(await authorityRow(b.companyId, 'lhdn')).toBeUndefined();
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 the fence on the server', () => {
  it('refuses a section this tab does not own, BEFORE writing a byte', async () => {
    for (const bogus of ['company', 'cycle', 'parent', 'bank', 'delete', 'logo', 'koperasi']) {
      const f = payload(b.companyId, { epf: bodyFields({ accountNo: 'SHOULD-NOT-LAND' }) });
      f.set(SECTIONS_FIELD, `epf,${bogus}`);
      const result = await saveCompanyStatutoryTabAction(f);
      expect(result.ok, bogus).toBe(false);
      expect(result.failedSection, bogus).toBe(bogus);
      expect(result.saved, 'nothing was written').toEqual([]);
      expect(await authorityRow(b.companyId, 'epf'), bogus).toBeUndefined();
    }
  });

  /**
   * THE COMPANY IS FORCED FROM THE TOP LEVEL. Nine hidden copies of a company id are nine chances for a
   * crafted payload to point one write at a different company; this posts the OTHER company's id inside
   * the section and asserts it went nowhere near it.
   */
  it('a section cannot point its write at another company', async () => {
    const result = await saveCompanyStatutoryTabAction(
      payload(b.companyId, {
        epf: bodyFields({ companyId: other, id: other, accountNo: 'MINE' }),
        [STATUTORY_IDENTITY_SECTION]: { filingCountry: 'MY', companyId: other, ssmRegistrationNo: 'MINE-TOO' },
      }),
    );
    expect(result.ok).toBe(true);
    expect((await authorityRow(b.companyId, 'epf')).accountNo).toBe('MINE');
    expect(await authorityRow(other, 'epf'), 'the company the section tried to name').toBeUndefined();
    expect((await identityRow(b.companyId)).ssmRegistrationNo).toBe('MINE-TOO');
    expect(await identityRow(other), 'nor did the identity card reach it').toBeUndefined();
  });

  /**
   * THE BODY IS THE SECTION ID, NOT THE FORM'S HIDDEN `authority`. Every `bodyFields()` above posts
   * `authority: 'ignored-by-the-server'`; if that value were trusted the service would have thrown
   * "Unknown statutory authority" on every case in this file. Here it is asserted directly: the row that
   * appears is the SECTION's body, and a payload naming a different real body in the hidden input cannot
   * redirect the write to it.
   */
  it('takes the body from the validated section id, not from the posted `authority`', async () => {
    const result = await saveCompanyStatutoryTabAction(
      payload(b.companyId, { zakat: bodyFields({ authority: 'epf', accountNo: 'ZAKAT-ACC' }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.saved).toEqual(['zakat']);
    expect((await authorityRow(b.companyId, 'zakat')).accountNo).toBe('ZAKAT-ACC');
    expect(await authorityRow(b.companyId, 'epf'), 'the body the payload tried to name').toBeUndefined();
  });

  /**
   * THE PACK FLAG IS `filingCountry`. A body whose form carried no filing control posts none of the four
   * filing names, so the identity row must not be touched at all — not created empty, not defaulted.
   */
  it('a body with no filing control writes nothing towards the identity row', async () => {
    const result = await saveCompanyStatutoryTabAction(
      payload(b.companyId, { ptptn: bodyFields({ accountNo: 'PTPTN-ACC' }) }),
    );
    expect(result.ok).toBe(true);
    expect((await authorityRow(b.companyId, 'ptptn')).accountNo).toBe('PTPTN-ACC');
    expect(await identityRow(b.companyId), 'no identity row was invented').toBeUndefined();
  });

  it('the declared order is the identity card then the controlled set, and it is what is written in', () => {
    expect([...COMPANY_STATUTORY_TAB_SECTION_ORDER]).toEqual([
      STATUTORY_IDENTITY_SECTION,
      ...STATUTORY_AUTHORITIES,
    ]);
  });
});
