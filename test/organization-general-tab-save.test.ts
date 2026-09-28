/**
 * 65b22c00 part two — ONE "Save Changes" for Organization → a company → General, and the fence that
 * keeps it honest.
 *
 * docs/audits/65b22c00-organization-save-classification.md sorts all thirteen bindings on this screen
 * into (a) plain columns on the `company` row, which consolidate, and (b) record lifecycle — deleting
 * the company, archiving it, adding or removing a bank account, configuring or clearing a statutory
 * body, uploading or removing the logo. A tab-wide Save implies a tab-wide Discard, and a Discard that
 * appeared to undo a deleted company would be a control lying about what it does.
 *
 * THE AUDIT SAYS SO; THIS FILE IS WHAT MAKES IT FAIL IF IT STOPS BEING TRUE. The personnel audit's own
 * closing constraint is the reason it exists: "A later change that moves a money-affecting action from
 * (b) into (a) is exactly the regression that makes Discard lie, and it would be invisible in review."
 * So §3 renders the panel and asserts the marker set from the MARKUP — three sections, named, and every
 * other form still standing on its own with its own submit control.
 *
 * §1 and §2 RUN the action against a real database rather than scanning for it, because the two things
 * that can go quietly wrong here — a section writing the wrong company, and an untouched card being
 * written anyway — are both invisible to a source scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { SessionContext } from '../db/client';

let ADMIN: SessionContext;
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => ADMIN,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/organization/c1',
  useSearchParams: () => new URLSearchParams(),
}));

import { adminCtx, closeAll, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { saveCompanyGeneralTabAction } from '../app/admin/actions';
import { COMPANY_GENERAL_TAB_SECTION_ORDER } from '../lib/company-tab-sections';
// 15e5bd93 — the second vocabulary on this screen. Imported rather than hand-listed, so the exact-set
// marker assertion below cannot drift from the list the server actually validates against.
import { COMPANY_STATUTORY_TAB_SECTION_ORDER } from '../lib/company-statutory-tab-sections';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { SECTION_FIELD_PREFIX, SECTIONS_FIELD } from '../lib/tab-save-sections';
import { CompanyPanel, type PanelCompany } from '../components/company-panel';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let b: Base;
let other: string;

const key = (section: string, field: string) => `${SECTION_FIELD_PREFIX}.${section}.${field}`;

/** The payload the client scope builds: `sections` names the dirty ids, every field namespaced. */
function payload(companyId: string, sections: Record<string, Record<string, string>>): FormData {
  const f = new FormData();
  f.set('companyId', companyId);
  f.set('tab', 'general');
  f.set(SECTIONS_FIELD, Object.keys(sections).join(','));
  for (const [id, fields] of Object.entries(sections)) {
    for (const [name, value] of Object.entries(fields)) f.set(key(id, name), value);
  }
  return f;
}

const companyRow = async (id: string) =>
  (await owner.db.select().from(schema.company).where(eq(schema.company.id, id)))[0];

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  const [c2] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
    .returning({ id: schema.company.id });
  other = c2.id;
  await owner.db
    .insert(schema.payrollCycle)
    .values([
      { tenantId: b.tenantId, companyId: b.companyId, name: 'Monthly', runType: 'regular' },
      { tenantId: b.tenantId, companyId: b.companyId, name: 'Fortnightly', runType: 'regular' },
    ]);
});
afterAll(async () => {
  await closeAll();
});

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§1 the one Save reaches each card’s own writer', () => {
  it('writes all three sections and reports each of them saved', async () => {
    const result = await saveCompanyGeneralTabAction(
      payload(b.companyId, {
        company: { legalName: 'Renamed Sdn Bhd', city: 'Ipoh', country: 'MY', currency: 'MYR' },
        cycle: { defaultPayrollCycle: 'Fortnightly' },
        parent: { parentCompanyId: other },
      }),
    );
    expect(result.ok).toBe(true);
    expect([...result.saved].sort()).toEqual(['company', 'cycle', 'parent']);
    const row = await companyRow(b.companyId);
    expect(row.legalName).toBe('Renamed Sdn Bhd');
    expect(row.city).toBe('Ipoh');
    expect(row.defaultPayrollCycle).toBe('Fortnightly');
    expect(row.parentCompanyId).toBe(other);
  });

  it('an UNTOUCHED card is never written — its service is not called at all', async () => {
    await saveCompanyGeneralTabAction(
      payload(b.companyId, { parent: { parentCompanyId: other } }),
    );
    const before = await companyRow(b.companyId);
    const result = await saveCompanyGeneralTabAction(
      payload(b.companyId, { company: { legalName: 'Only The Name', country: 'MY', currency: 'MYR' } }),
    );
    expect(result.saved).toEqual(['company']);
    const after = await companyRow(b.companyId);
    expect(after.legalName).toBe('Only The Name');
    expect(after.defaultPayrollCycle, 'the cycle card was not in `sections`').toBe(before.defaultPayrollCycle);
    expect(after.parentCompanyId, 'nor was the parent card').toBe(before.parentCompanyId);
  });

  /**
   * A PARTIAL FAILURE NAMES THE CARD AND KEEPS WHAT COMMITTED. A redirect could not have said which of
   * three writes broke, which is why this action returns instead — and the client marks exactly the
   * sections in `saved` clean and leaves the rest edited.
   */
  it('a refused section names itself, and what committed before it stays committed', async () => {
    const result = await saveCompanyGeneralTabAction(
      payload(b.companyId, {
        company: { legalName: 'Committed Sdn Bhd', country: 'MY', currency: 'MYR' },
        cycle: { defaultPayrollCycle: 'Not A Cycle' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failedSection).toBe('cycle');
    expect(result.saved).toEqual(['company']);
    expect(result.error).toMatch(/not an active payroll cycle/i);
    expect((await companyRow(b.companyId)).legalName).toBe('Committed Sdn Bhd');
  });
});

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§2 the fence on the server', () => {
  it('refuses a section this tab does not own, BEFORE writing a byte', async () => {
    for (const bogus of ['bank', 'statutory', 'delete', 'logo']) {
      const f = payload(b.companyId, { company: { legalName: 'Should Not Land', country: 'MY', currency: 'MYR' } });
      f.set(SECTIONS_FIELD, `company,${bogus}`);
      const result = await saveCompanyGeneralTabAction(f);
      expect(result.ok, bogus).toBe(false);
      expect(result.failedSection, bogus).toBe(bogus);
      expect(result.saved, 'nothing was written').toEqual([]);
      expect((await companyRow(b.companyId)).legalName, bogus).toBe('Acme Sdn Bhd');
    }
  });

  /**
   * THE IDENTITY IS FORCED FROM THE TOP LEVEL. Three hidden copies of a company id are three chances for
   * a crafted payload to point one write at a different company; this posts the OTHER company's id inside
   * the section and asserts it went nowhere near it.
   */
  it('a section cannot point its write at another company', async () => {
    const f = payload(b.companyId, {
      company: { id: other, companyId: other, legalName: 'Redirected Sdn Bhd', country: 'MY', currency: 'MYR' },
    });
    const result = await saveCompanyGeneralTabAction(f);
    expect(result.ok).toBe(true);
    expect((await companyRow(b.companyId)).legalName, 'the company the request named').toBe('Redirected Sdn Bhd');
    expect((await companyRow(other)).legalName, 'the one the section tried to name').toBe('Other Sdn Bhd');
  });

  it('every id in the declared order has a writer, and the order is the reading order', () => {
    expect([...COMPANY_GENERAL_TAB_SECTION_ORDER]).toEqual(['company', 'cycle', 'parent']);
    const src = read('app/admin/actions.ts');
    const map = src.slice(src.indexOf('const writers: Record<string'), src.indexOf('const saved: string[] = [];'));
    for (const id of COMPANY_GENERAL_TAB_SECTION_ORDER) expect(map, id).toMatch(new RegExp(`\\b${id}:`));
  });

  it('the per-card action and the one Save reach the SAME writer', () => {
    const src = read('app/admin/actions.ts');
    for (const [action, helper] of [
      ['updateCompanyAction', 'applyCompanyDetailsSection'],
      ['updateCompanyDefaultCycleAction', 'applyDefaultCycleSection'],
      ['setCompanyParentAction', 'applyParentSection'],
    ]) {
      const body = src.slice(src.indexOf(`export async function ${action}(`));
      expect(body.slice(0, body.indexOf('\n}\n')), action).toContain(`${helper}(s,`);
    }
  });
});

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────────────
describe('§3 the bucket, pinned from the RENDERED panel and not from the audit', () => {
  const noop = () => undefined;
  const actions = {
    saveGeneralTab: async () => ({ ok: true, saved: [] }),
    // 15e5bd93 — the STATUTORY tab got a consolidated Save of its own, so the panel this file renders has
    // two. Its own sections are declared in lib/company-statutory-tab-sections.ts and asserted below.
    saveStatutoryTab: async () => ({ ok: true, saved: [] }),
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
    hasLogo: true,
    defaultPayrollCycle: 'Monthly',
  };
  const props = (over: Record<string, unknown> = {}) => ({
    company,
    companies: [{ id: 'c1', name: 'Demo Sdn Bhd' }],
    statutory: null,
    bankProfiles: [],
    statutoryAuthorities: [],
    signatories: [],
    stateOptions: [],
    activeCycleNames: ['Monthly'],
    actions,
    ...over,
  });
  const markup = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages: JSON.parse(read('messages/en.json')),
        timeZone: 'Asia/Kuala_Lumpur',
        children: createElement(CompanyPanel, props(over) as never),
      }),
    );
  /** Forms are never nested on this screen, so a non-greedy pair-match is the whole parse. */
  const formsIn = (html: string) =>
    Array.from(html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)).map((m) => ({ attrs: m[1], body: m[2] }));

  /**
   * THE SHAPE THAT RENDERS EVERY FORM ON THE SCREEN, and it is not an optional nicety.
   *
   * The first version of the marker case rendered a company with NO bank accounts and NO configured
   * statutory bodies, so the bank-remove and authority-clear forms were not in the markup at all — and
   * adding `data-save-section="bank"` to the bank-remove form passed it. That is the exact regression
   * this file exists to catch, passing. Every case below therefore renders a company that has one of
   * each, so the marker set is measured against the whole screen rather than part of it.
   */
  const FULL = {
    bankProfiles: [
      {
        id: 'bp1',
        bank: 'maybank',
        corporateId: 'C',
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
  };

  /**
   * ⚠️ UPDATED BY 15e5bd93 (r352) — THE EXACT SET GREW, AND IT IS STILL AN EXACT SET.
   *
   * This asserted that the ONLY marked forms on the screen are General's three. That was the whole screen's
   * marker set because the Statutory tab had no scope — 65b22c00's finding 1 refused it one. The reporter's
   * approved statutory redesign gave that tab a consolidated Save, so the marker set is now General's three
   * followed by Statutory's nine, in document order, and it is asserted against the two DECLARED
   * vocabularies rather than a hand-written list. A marked form belonging to neither tab still fails.
   *
   * Bucket (b) has not moved: nothing that DELETES or ARCHIVES anything gained a marker (the case below).
   */
  it('EXACTLY the declared sections of the two tabs carry a marker, and nothing else does', () => {
    const all = formsIn(markup(FULL));
    // A company with one bank account and one configured body renders every kind of form this screen has.
    expect(all.length, 'the whole screen is in this markup').toBeGreaterThanOrEqual(11);
    const marked = all.filter((f) => f.attrs.includes('data-save-section'));
    const ids = marked.map((f) => /data-save-section="([^"]+)"/.exec(f.attrs)?.[1]);
    expect(ids).toEqual([...COMPANY_GENERAL_TAB_SECTION_ORDER, ...COMPANY_STATUTORY_TAB_SECTION_ORDER]);
    // The Statutory tab's sections are the identity card plus ONE PER BODY, so a partial failure can name
    // the body that failed rather than "the statutory tab".
    expect(COMPANY_STATUTORY_TAB_SECTION_ORDER).toEqual(['identity', ...STATUTORY_AUTHORITIES]);
  });

  /**
   * THE HALF THAT WOULD OTHERWISE ROT. Every form the classification put in bucket (b) — archive,
   * unarchive, delete, bank save, bank remove, authority clear — must still stand on its own with its own
   * submit control. A future round folding one of them in fails here.
   *
   * ⚠️ UPDATED BY 15e5bd93 (r352), AND THE BOUND IS NOW EXACT RATHER THAN A FLOOR. Two kinds of form left
   * this set and both left it legitimately: the eight authority-save forms and the statutory registrations
   * card joined the Statutory tab's consolidated Save. `>= 8` would now be satisfied by nothing at all
   * (there are five), so the case names the five it expects BY THE FIELD THAT IDENTIFIES EACH — which is
   * stronger than the count it replaces, because a bucket (b) form that lost its marker-free standing can
   * no longer hide behind a loose inequality.
   */
  it('every OTHER form still has its own submit control and no marker', () => {
    const forms = formsIn(markup(FULL));
    const unmarked = forms.filter((f) => !f.attrs.includes('data-save-section'));
    // Identified by a field only that form carries. `archived` is the archive/unarchive marker,
    // `debitAccountNo` a bank-account editor (one saved + one blank "add"), and a lone `id`+`companyId`
    // pair is a REMOVE form — one for the bank profile, one for "Clear this authority".
    const signature = (body: string) =>
      /name="archived"/.test(body)
        ? 'archive'
        : /name="debitAccountNo"/.test(body)
          ? 'bankEditor'
          : /name="id"/.test(body) && /name="companyId"/.test(body)
            ? 'remove'
            : 'other';
    expect(unmarked.map((f) => signature(f.body)).sort(), 'the bucket (b) bindings, rendered').toEqual([
      'archive',
      'bankEditor',
      'bankEditor',
      'remove',
      'remove',
    ]);
    for (const f of unmarked) expect(f.body, f.attrs.slice(0, 80)).toMatch(/<button\b/);
    // …and the three that ARE marked lost theirs: that is what "one Save" means.
    for (const f of forms.filter((x) => x.attrs.includes('data-save-section'))) {
      expect(f.body, 'a consolidated card keeps no Save button').not.toMatch(/<button[^>]*type="submit"/);
    }
  });

  it('the scope encloses a CONTIGUOUS run: the logo above it, archive/delete below it', () => {
    const html = markup();
    const scope = html.indexOf('data-tab-save-scope="general"');
    const bar = html.indexOf('data-tab-save-bar');
    const logo = html.indexOf('name="logo"');
    const del = html.indexOf('value="c1"', html.indexOf('data-tab-save-bar'));
    expect(scope, 'the scope is rendered').toBeGreaterThan(-1);
    expect(logo, 'the logo upload is OUTSIDE and above').toBeLessThan(scope);
    expect(bar, 'the Save bar is after the cards it owns').toBeGreaterThan(scope);
    expect(del, 'archive / delete come after the bar').toBeGreaterThan(bar);
  });

  it('the bar names the cards it owns — and drops the one a tenant without Payroll cannot see', () => {
    const en = JSON.parse(read('messages/en.json')).admin.organization as Record<string, string>;
    const coversOf = (html: string) => {
      const i = html.indexOf('data-tab-save-covers');
      return html.slice(i, html.indexOf('</p>', i));
    };
    const withPayroll = coversOf(markup());
    for (const k of ['sectionCompanyInfo', 'sectionContactInfo', 'defaultPayrollCycle', 'groupParent']) {
      expect(withPayroll, k).toContain(en[k]);
    }
    // r298: `activeCycleNames === null` means the tenant does not hold Payroll and the card is not drawn.
    const withoutPayroll = coversOf(markup({ activeCycleNames: null }));
    expect(withoutPayroll).toContain(en.sectionCompanyInfo);
    expect(withoutPayroll, 'a bar must not name a card the reader cannot find').not.toContain(
      en.defaultPayrollCycle,
    );
  });

  /**
   * FINDING 1 OF THE AUDIT — ⚠️ THE ONE CASE IN THIS FILE THAT 15e5bd93 (r352) REVERSES, AND IT IS
   * REWRITTEN RATHER THAN REMOVED, BECAUSE HALF OF IT IS STILL THE POINT.
   *
   * WHAT IT SAID: the SSM / MyInvois registrations form is bucket (a) and keeps its OWN button, because it
   * is drawn on the Statutory tab and a scope cannot span two panes; folding it in would mean moving the
   * card off a tab r226 put it on for a reason, and that is a decision for the reporter.
   *
   * WHAT IS TRUE NOW: the reporter made a decision that settles it, and it is not the one this case feared.
   * Their approved statutory redesign put the eight bodies in a permanent rail with one workspace and one
   * Save for the tab, so the Statutory tab has its own scope — and the registrations card is consolidated
   * INTO THAT, without moving. `saveStatutoryIdentity` is therefore gone from the screen.
   *
   * WHAT THIS CASE STILL GUARDS, unchanged and asserted harder: the card is on the STATUTORY tab. The
   * failure this was written against was the card drifting onto General as a side effect of a save-button
   * change, and that is still forbidden — so it is now pinned by POSITION relative to the General pane's
   * end marker, not merely by the absence of a marker it no longer lacks.
   */
  it('the statutory registrations card is consolidated on the STATUTORY tab, not moved to General', () => {
    const html = markup({ statutory: null });
    const en = JSON.parse(read('messages/en.json')).admin.organization as Record<string, string>;
    expect(html, 'the tab Save replaced its own button').not.toContain(en.saveStatutoryIdentity);
    const form = formsIn(html).find((f) => f.body.includes('name="ssmRegistrationNo"'));
    expect(form, 'the registrations form is rendered').toBeTruthy();
    expect(form!.attrs, 'and it IS a section of a consolidated Save now').toContain('data-save-section="identity"');
    // It is under the STATUTORY scope, not the General one. Both are in the markup, so the test is which.
    const general = html.indexOf('data-tab-save-scope="general"');
    const statutory = html.indexOf('data-tab-save-scope="statutory"');
    const ssm = html.indexOf('name="ssmRegistrationNo"');
    expect(general).toBeGreaterThan(-1);
    expect(statutory).toBeGreaterThan(general);
    expect(ssm, 'the card did not drift onto General').toBeGreaterThan(statutory);
    // And General's own vocabulary did not grow an identity section on the way past.
    expect(COMPANY_GENERAL_TAB_SECTION_ORDER as readonly string[]).not.toContain('identity');
  });
});
