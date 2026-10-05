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
// 15e5bd93 rev 2 (r353) — `COMPANY_STATUTORY_TAB_SECTION_ORDER` WAS IMPORTED HERE and the module is
// retired: the reporter contested r352's consolidated statutory Save along with the in-tab editing it
// depended on, so this screen is back to ONE scope. The exact-set marker assertion below is therefore
// back to General's three, which is what it asserted before r352 — tightened, not loosened.
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
   * ⚠️ UPDATED TWICE AND IT IS AN EXACT SET AGAIN — THE SAME EXACT SET IT STARTED AS.
   *
   * 65b22c00: the ONLY marked forms on this screen are General's three, because the Statutory tab had no
   * scope (finding 1 refused it one). r352: the reporter's approved redesign gave that tab a consolidated
   * Save, so the set grew to General's three plus Statutory's nine. 15e5bd93 REVISION 2 (r353): the
   * reporter contested that redesign — "Do not expand the statutory settings directly within the existing
   * Statutory tab" — the eight body editors moved to a dedicated screen, and the registrations card left
   * alone on the tab took its own Save button back. So the set is General's three once more.
   *
   * ⚠️ THE ASSERTION IS `toEqual`, NOT A SUPERSET CHECK, and the return to three is a TIGHTENING: a marked
   * form belonging to neither vocabulary fails here, and so would a statutory section marker that came
   * back without a scope to own it. Bucket (b) has not moved through any of the three rounds: nothing
   * that DELETES or ARCHIVES anything has a marker (the case below).
   */
  it('EXACTLY the declared General sections carry a marker, and nothing else on the screen does', () => {
    const all = formsIn(markup(FULL));
    // A company with one bank account and one configured body renders every kind of form this screen has.
    expect(all.length, 'the whole screen is in this markup').toBeGreaterThanOrEqual(8);
    const marked = all.filter((f) => f.attrs.includes('data-save-section'));
    const ids = marked.map((f) => /data-save-section="([^"]+)"/.exec(f.attrs)?.[1]);
    expect(ids).toEqual([...COMPANY_GENERAL_TAB_SECTION_ORDER]);
    // The statutory bodies still exist and are still eight; what changed is where they are EDITED. Their
    // read-only rows are on this panel, and every body's FIELDS are a card on the dedicated statutory
    // screen, under a save scope of that screen's own (15e5bd93 rev 4, r372 — r355's per-body page was
    // contested as "an unnecessary intermediate page" and is deleted). None of that is a section of a
    // scope HERE, which is all this case claims: the General tab's scope owns three sections and no more.
    // test/company-panel-bank-statutory-layout.test.ts and test/statutory-body-screen-render.test.ts own
    // that half. (This comment once named test/statutory-setup-screen.test.ts, a file that never existed.)
    expect(STATUTORY_AUTHORITIES.length, 'the controlled set is untouched by this move').toBe(8);
    for (const a of STATUTORY_AUTHORITIES) {
      expect(ids, `no statutory section marker survives on this screen: ${a}`).not.toContain(a);
    }
    expect(ids, 'and neither does the registrations card\'s old section id').not.toContain('identity');
  });

  /**
   * THE HALF THAT WOULD OTHERWISE ROT. Every form the classification put in bucket (b) — archive,
   * unarchive, delete, bank save, bank remove, authority clear — must still stand on its own with its own
   * submit control. A future round folding one of them in fails here.
   *
   * ⚠️ UPDATED BY 15e5bd93 (r352), AND THE BOUND IS EXACT RATHER THAN A FLOOR. `>= 8` would be satisfied
   * by nothing at all, so the case names the forms it expects BY THE FIELD THAT IDENTIFIES EACH — which is
   * stronger than the count it replaces, because a bucket (b) form that lost its marker-free standing can
   * no longer hide behind a loose inequality.
   *
   * ⚠️ UPDATED AGAIN BY 15e5bd93 REVISION 2 (r353), AND THE SET IS STILL EXACT. Two forms came BACK to
   * this panel unmarked, and one left it entirely:
   *   · the SSM / MyInvois registrations card is `statutoryIdentity` again — marker gone, own Save back,
   *     because it is alone on the Statutory tab and a sticky bar over one two-field card is the "worse
   *     than none" 65b22c00's finding 1 named;
   *   · "Clear this authority" is no longer rendered by this panel at all — it moved with the editor to
   *     /admin/organization/[companyId]/statutory, so one of the two `remove` signatures is gone.
   * Both changes are asserted here rather than absorbed, because a bucket (b) form that silently stopped
   * being rendered ANYWHERE is a capability lost, and this exact list is what would catch it.
   */
  it('every OTHER form still has its own submit control and no marker', () => {
    const forms = formsIn(markup(FULL));
    const unmarked = forms.filter((f) => !f.attrs.includes('data-save-section'));
    // Identified by a field only that form carries. `archived` is the archive/unarchive marker,
    // `debitAccountNo` a bank-account editor (one saved + one blank "add"), `ssmRegistrationNo` the
    // registrations card, and a lone `id`+`companyId` pair is a REMOVE form (the bank profile's; the
    // authority's "Clear" went to the dedicated statutory screen with the editor it belongs to, and is
    // still outside that screen's Save — bucket (b) on both surfaces).
    const signature = (body: string) =>
      /name="archived"/.test(body)
        ? 'archive'
        : /name="debitAccountNo"/.test(body)
          ? 'bankEditor'
          : /name="ssmRegistrationNo"/.test(body)
            ? 'statutoryIdentity'
            : /name="id"/.test(body) && /name="companyId"/.test(body)
              ? 'remove'
              : 'other';
    expect(unmarked.map((f) => signature(f.body)).sort(), 'the bucket (b) bindings, rendered').toEqual([
      'archive',
      'bankEditor',
      'bankEditor',
      'remove',
      'statutoryIdentity',
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
   * FINDING 1 OF THE AUDIT — ⚠️ THE ONE CASE IN THIS FILE THAT HAS NOW BEEN REWRITTEN TWICE, AND BOTH
   * TIMES REWRITTEN RATHER THAN REMOVED, BECAUSE THE HALF IT WAS WRITTEN FOR NEVER STOPPED BEING THE POINT.
   *
   * 65b22c00 SAID: the SSM / MyInvois registrations form is bucket (a) and keeps its OWN button, because it
   * is drawn on the Statutory tab, a scope cannot span two panes, and folding it in would mean moving the
   * card off a tab r226 put it on for a reason — a decision for the reporter.
   *
   * r352 SAID: the reporter settled it the other way. Their approved redesign put the eight bodies in a
   * rail with one workspace and one Save for the tab, so the tab had a scope the card could join without
   * moving, and `saveStatutoryIdentity` left the screen.
   *
   * r353 SAYS: the reporter CONTESTED that redesign — "Do not expand the statutory settings directly
   * within the existing Statutory tab" — and the eight editors went to a dedicated screen. That takes the
   * scope with them: a sticky Save/Discard bar above ONE two-field card is exactly the "worse than none"
   * finding 1 named. So the card has its own Save button again and 65b22c00's original sentence is true
   * once more, by the reporter's own instruction rather than by us reverting them.
   *
   * WHAT THIS CASE HAS GUARDED THROUGH ALL THREE, unchanged and asserted by POSITION: the card is on the
   * STATUTORY tab. The failure it was written against is the card drifting onto General as a side effect
   * of a save-button change, and every round has had a save-button change in it.
   */
  it('the statutory registrations card keeps its own Save, on the STATUTORY tab, never moved to General', () => {
    const html = markup({ statutory: null });
    const en = JSON.parse(read('messages/en.json')).admin.organization as Record<string, string>;
    // Its OWN button is back — the retired caption returning to service, not a new string.
    expect(html, 'bucket (a) with its own control, as finding 1 left it').toContain(en.saveStatutoryIdentity);
    const form = formsIn(html).find((f) => f.body.includes('name="ssmRegistrationNo"'));
    expect(form, 'the registrations form is rendered').toBeTruthy();
    expect(form!.attrs, 'and it is NOT a section of a consolidated Save any more').not.toContain('data-save-section');
    expect(form!.body, 'it submits itself').toMatch(/<button[^>]*type="submit"/);
    // THERE IS ONE SCOPE ON THIS SCREEN AGAIN, and the card is outside it — which is the position claim.
    // Pinned against the General pane's own end marker so it cannot be satisfied by ordering luck.
    const panel = read('components/company-panel.tsx');
    const generalPane = panel.slice(
      panel.indexOf("cn('space-y-4', tab === 'general'"),
      panel.indexOf('{/* end General tab */}'),
    );
    expect(generalPane, 'the card did not drift onto General').not.toContain('name="ssmRegistrationNo"');
    const statutoryPane = panel.slice(
      panel.indexOf("cn('space-y-4', tab === 'statutory'"),
      panel.indexOf('{/* end Statutory tab */}'),
    );
    expect(statutoryPane, 'it is still where r226 put it').toContain('name="ssmRegistrationNo"');
    expect(html.indexOf('data-tab-save-scope="general"'), 'the General scope is rendered').toBeGreaterThan(-1);
    expect(html, 'and the statutory scope is gone with the editors it owned').not.toContain(
      'data-tab-save-scope="statutory"',
    );
    // And General's own vocabulary never grew an identity section on the way past.
    expect(COMPANY_GENERAL_TAB_SECTION_ORDER as readonly string[]).not.toContain('identity');
  });
});
