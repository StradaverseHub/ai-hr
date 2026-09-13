/**
 * r266 · 6aee1d91 — BENEFIT-SCHEME VOCABULARY, and the apply refusal that finally says WHY the balance is 0.
 *
 * The reporter asked to "remove the Employee eligibility table" because the profile already showed a
 * Benefit Scheme. The profile's Benefit Scheme IS the eligibility rule under another name
 * (core/entitlement-scheme-view.ts), so the approved plan keeps the mechanism and makes the two screens
 * speak one language. Three things are pinned here, because each can silently regress on its own:
 *
 *   §A  THE WORDS. The renamed namespaces no longer say "eligibility rule"; the approved sentences exist in
 *       every locale (the explainer, the profile note, the refusal messages) and are not left in English.
 *   §B  THE MOUNTS. The explainer is rendered on BOTH mounts of the tables block from ONE key; the profile
 *       card renders the note in both of its states and the empty-state link.
 *   §C  THE REFUSAL — behavioural, against the engine. An employee two tables and no scheme reach applies
 *       for leave, is refused by the service exactly as before (`InsufficientLeaveBalanceOnSubmitError`),
 *       and the action layer turns that refusal into the scheme sentence rather than "Insufficient leave
 *       balance". No table at all gives the other sentence; a covered employee whose days are spent keeps
 *       the old one. Nothing in core/leave.ts's DECISION changes — the read happens after the throw.
 *
 * NON-VACUITY (§C): put `return t('insufficientBalance')` back in app/me/actions.ts's branch and
 * "no scheme covers this employee ⇒ the scheme sentence" fails on its `toContain`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

// ── the action file's framework edges, faked the way test/entitlement-save-stay.test.ts fakes them ────
let actionCtx: import('../db/client').SessionContext | null = null;
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// A REAL translator over the English catalogue, not a key echo: the assertions below are about the
// sentence the employee reads, and a key-echoing fake would pass with the placeholder unrendered.
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (ns: string) => (key: string, vals?: Record<string, unknown>) => {
    const node = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
    if (typeof node !== 'string') throw new Error(`MISSING_MESSAGE: ${ns}.${key}`);
    return node.replace(/\{(\w+)\}/g, (_, name) => {
      if (!vals || !(name in vals)) throw new Error(`FORMATTING_ERROR: ${ns}.${key} needs {${name}}`);
      return String(vals[name]);
    });
  },
}));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, entitlementCoverageFor, InsufficientLeaveBalanceOnSubmitError } from '../core/leave';
import { createEntitlementTemplate, createEligibilityRule } from '../core/entitlement-template';
import { localizeLeaveError } from '../app/me/actions';
import type { SessionContext } from '../db/client';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

/** The sentences the approved plan promised, verbatim, plus the keys this item minted. */
const NEW_KEYS = [
  'admin.entitlementTemplates.rulesIntro',
  'admin.entitlementTemplates.colSchemeName',
  'admin.entitlementTemplates.ruleNamePlaceholder',
  'admin.entitlementTemplates.ruleCoversTitle',
  'admin.entitlementTemplates.rulesNamingTip',
  'admin.personnel.benefitScheme.derivedNote',
  'admin.personnel.benefitScheme.derivedNoteEmpty',
  'admin.personnel.benefitScheme.setUpSchemes',
  'admin.leaveConfigTypes.entitlementStep.schemeExplainer',
  'leave.errors.insufficientBalanceNoScheme',
  'leave.errors.insufficientBalanceNoTable',
  'leave.errors.insufficientBalanceNoSchemeOther',
  'leave.errors.insufficientBalanceNoTableOther',
];

describe('§A · one vocabulary: the renamed strings say "benefit scheme", in six locales', () => {
  it('the approved sentences are the English values', () => {
    const et = en.admin.entitlementTemplates;
    expect(et.rulesTitle).toBe('Benefit schemes');
    expect(et.ruleEveryoneTitle).toBe('One scheme for everyone this leave type is available to');
    expect(et.colSchemeName).toBe('Scheme name');
    expect(et.colCriteria).toBe('Covers');
    expect(et.colRules).toBe('Schemes');
    // r269 (76ffdcf2) REWROTE the second half. "Entitlement is decided by the benefit scheme that covers
    // the employee" is the prerequisite claim again: a scheme chooses BETWEEN tables where there is more
    // than one, and anyone no scheme covers now receives the leave type's default table. The first
    // sentence — eligibility versus entitlement, which is what r266 was for — is untouched.
    expect(en.admin.leaveConfigTypes.entitlementStep.schemeExplainer).toBe(
      'Eligibility (the Who is eligible tab) decides whether an employee can take this leave type. A benefit scheme decides WHICH entitlement table an employee receives where there is more than one; anyone no scheme covers receives the default entitlement table named here.',
    );
    expect(en.admin.leaveConfigTypes.entitlementStep.schemeExplainer).toMatch(
      /^Eligibility \(the Who is eligible tab\) decides whether an employee can take this leave type\./,
    );
    // Leave balance health: "no benefit scheme in force" where it said "no eligibility rule in force".
    expect(et.healthNoRuleInForce).toContain('no benefit scheme in force');
    expect(et.healthNoRuleInForce).not.toMatch(/eligibility rule/i);
    // The refusal sentence, with the leave type interpolated. r269 (76ffdcf2) REWROTE it: the r266 wording
    // said a missing scheme was the reason no days exist, which is the causal claim the engine never made
    // and the reporter objected to. What is true is that no TABLE reached them — and there are now two
    // remedies, so the sentence names both.
    //
    // r270 (65e4073a) REWROTE IT AGAIN, and this pin is UPDATED rather than dropped because the decision
    // it guards has been reversed by its own author. r266's "Ask HR to NAME you in a benefit scheme" used
    // *name* to mean *describe*; the reporter read it as *list by name* and filed a ticket asking us to
    // remove a mandatory per-employee assignment layer THAT DOES NOT EXIST — there is no benefit-scheme
    // field on an employment in this version. So the sentence now says what a scheme is (a description),
    // that it is optional, and what it is for. The three properties r266 and r269 pinned are pinned still:
    // the leave type is interpolated, the causal claim stays retired, and both remedies are named.
    expect(en.leave.errors.insufficientBalanceNoScheme).toContain('{typeName}');
    expect(en.leave.errors.insufficientBalanceNoScheme).toContain('No entitlement table reaches you');
    expect(en.leave.errors.insufficientBalanceNoScheme).not.toMatch(/No benefit scheme covers you/);
    // The word that caused the ticket, in the sense that caused it: never ask to "name" a person in a
    // scheme again, on any of the six screens that talk about one.
    expect(en.leave.errors.insufficientBalanceNoScheme).not.toMatch(/name (you|them|this employee) in a/i);
    expect(en.leave.errors.insufficientBalanceNoSchemeOther).not.toMatch(/name (you|them|this employee) in a/i);
  });

  it('no renamed namespace still says "eligibility rule" in English', () => {
    const namespaces = ['admin.entitlementTemplates', 'admin.personnel.benefitScheme'] as const;
    const leaves: string[] = [];
    const walk = (o: unknown, p: string) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Dict)) walk(v, `${p}.${k}`);
      else if (typeof o === 'string' && /eligibility rule/i.test(o)) leaves.push(p);
    };
    for (const ns of namespaces) walk(getPath(en, ns), ns);
    for (const k of ['statusNoEligibilityMatchTitle', 'statusNoEligibilityMatchBody', 'eligibilityNoRules', 'eligibilityRulesTitle'])
      walk(en.leave.breakdown[k as keyof typeof en.leave.breakdown], `leave.breakdown.${k}`);
    for (const k of ['statusNoEligibilityMatch', 'statusNoEligibilityMatchTip'])
      walk(en.me.leaveBalanceTable[k as keyof typeof en.me.leaveBalanceTable], `me.leaveBalanceTable.${k}`);
    expect(leaves).toEqual([]);
  });

  it('every new key exists in all six catalogues, and is not left in English outside en', () => {
    for (const key of NEW_KEYS) {
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        expect((v as string).length, `${loc} ${key}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${key} untranslated`).not.toBe(enValue);
      }
    }
  });

  it('M1 — the shared status label is impersonal: HR reads it about other people on three surfaces', () => {
    // `me.leaveBalanceTable.statusNoEligibilityMatch` is rendered through ENTITLEMENT_STATUS_LABEL_KEY on
    // the HR balance page, the personnel Leave tab and the CSV export as well as the employee's own
    // table, so "covers you" would have HR reading "you" about somebody else. The hover TIP is HR-voiced
    // ("this employee") and stays so.
    // r269 (76ffdcf2) — the label states the OUTCOME rather than blaming the absent scheme: with a default
    // entitlement table named, "not covered by a scheme" no longer means the figure is zero.
    const label = en.me.leaveBalanceTable.statusNoEligibilityMatch;
    expect(label).toBe('No entitlement table applies');
    expect(label).not.toMatch(/\byou\b/i);
    expect(en.me.leaveBalanceTable.statusNoEligibilityMatchTip).toContain('this employee');
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      const v = getPath(cat, 'me.leaveBalanceTable.statusNoEligibilityMatch') as string;
      expect(v, `${loc} label`).not.toMatch(/covers you|\byou\b/i);
      if (loc !== 'en') expect(v, `${loc} label untranslated`).not.toBe(label);
    }
    // The three HR surfaces and the employee table all read the SAME key through the shared map, so a
    // second, personal label cannot reappear on one of them without leaving this map.
    for (const rel of [
      'app/leave/employee-balances/page.tsx',
      'app/leave/employee-balances/export/route.ts',
      'app/admin/personnel/[employmentId]/page.tsx',
      'components/leave/leave-balance-table.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).toContain('ENTITLEMENT_STATUS_LABEL_KEY');
      expect(src, `${rel} carries a personal label`).not.toContain('covers you');
    }
    // m2 — the no-table copy names the Leave types screen, not a path that no longer exists.
    for (const [loc, cat] of Object.entries(CATALOGUES)) {
      for (const key of ['leave.breakdown.statusNoEntitlementTableBody', 'me.leaveBalanceTable.statusNoEntitlementTableTip']) {
        const v = getPath(cat, key) as string;
        expect(v, `${loc} ${key}`).not.toMatch(/Settings, Leave, Entitlements|Tetapan, Cuti, Kelayakan|设置、假期、额度|Cài đặt, Nghỉ phép, Định mức/);
      }
    }
    expect(en.leave.breakdown.statusNoEntitlementTableBody).toContain('on the Leave types screen');
    expect(en.me.leaveBalanceTable.statusNoEntitlementTableTip).toContain('on the Leave types screen');
  });

  it('the profile note has two states and both read as derived, never as a setting', () => {
    const ps = en.admin.personnel.benefitScheme;
    for (const v of [ps.derivedNote, ps.derivedNoteEmpty]) {
      expect(v).toMatch(/^Worked out automatically from the benefit schemes on the Leave types screen\./);
      expect(v).toContain('There is nothing to set here');
    }
    expect(ps.setUpSchemes).toBe('Set up benefit schemes on the Leave types screen');
    // r269 (76ffdcf2) — the sentence the reporter quoted. It claimed scheme ⇒ table ⇒ days, a chain the
    // engine does not follow. The replacement states both facts that are true of this state (no scheme AND
    // no default table) and says what a scheme actually decides.
    expect(ps.empty).toMatch(/^No benefit scheme covers this employee, and no leave type names a default entitlement table/);
    expect(ps.empty).toContain('it is not what decides whether they are entitled');
    expect(ps.empty).not.toMatch(/so no entitlement table reaches them and no days have been granted/);
  });
});

describe('§B · the mounts: one explainer key on both tables-block mounts, the note in both card states', () => {
  it('tab 3 of the leave type renders the explainer; the Entitlement tables tab deliberately no longer does', () => {
    const tabs = read('app/admin/leave-config/types/leave-type-tabs.tsx');
    const page = read('app/admin/leave-config/entitlement-tables/page.tsx');
    expect(tabs).toContain("tTabs('entitlementStep.schemeExplainer')");
    /**
     * r270 (995387c6) — THE PAGE HALF OF THIS GUARD IS REVERSED, NOT DROPPED, and the reversal is the
     * point. 6aee1d91 pinned the explainer on BOTH screens because both screens carried a Benefit schemes
     * section and each had to say how eligibility differs from entitlement. The Entitlement tables tab has
     * no schemes section any more, so the note explained a section that is not on the page — and a note
     * describing an absent surface is the drift this guard exists to catch, pointing the other way.
     * Asserted as an ABSENCE so the note cannot be restored without this decision being re-read.
     *
     * The leave-type half above is untouched: that screen still carries the schemes, so it still explains
     * them, and the key stays live in all six catalogues for it (pinned in §A, line 86).
     */
    expect(page).not.toContain('entitlementStep.schemeExplainer');
    expect(page).not.toContain("getTranslations('admin.leaveConfigTypes')");
    expect(page).not.toContain('data-testid="scheme-explainer"');
    // …and the screen that kept the schemes is the screen that still asks for the key, so it is not dead.
    expect(en.admin.leaveConfigTypes.entitlementStep.schemeExplainer).toBeTruthy();
    // At the top of the tab: before the earning method (F9), which is the first control of tab 3.
    const explainerAt = tabs.indexOf("tTabs('entitlementStep.schemeExplainer')");
    const earningAt = tabs.indexOf("t('subStep.earning')");
    expect(explainerAt).toBeGreaterThan(-1);
    expect(explainerAt).toBeLessThan(earningAt);
  });

  it('the Benefit Scheme card renders the note in BOTH states and the empty-state link to the Leave types screen', () => {
    const src = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(src).toContain("tScheme('derivedNote')");
    expect(src).toContain("tScheme('derivedNoteEmpty')");
    expect(src).toContain("tScheme('setUpSchemes')");
    // m3 — both links to the Leave types screen resolve through the module's one list of addresses.
    const card = src.slice(src.indexOf('id="section-benefit-scheme"'), src.indexOf('const leaveBalanceCard'));
    expect((card.match(/href=\{leaveConfigScreenHref\('leaveTypes'\)\}/g) ?? []).length).toBe(2);
    expect(card).not.toContain('href="/admin/leave-config/types"');
    // Still read-only: no form, no action, no input on the card.
    expect(card).not.toMatch(/<form|<input|<select|action=/);
    expect((card.match(/data-testid="benefit-scheme-derived-note"/g) ?? []).length).toBe(2);
  });

  it('the schemes list has its own "Scheme name" header and the block carries the intro and the naming tip', () => {
    const src = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(src).toContain("t('colSchemeName')");
    expect(src).toContain("t('rulesIntro')");
    expect(src).toContain("t('rulesNamingTip')");
    const form = read('components/leave/eligibility-rule-form.tsx');
    expect(form).toContain("t('ruleCoversTitle')");
    expect(form).toContain("placeholder={t('ruleNamePlaceholder')}");
  });

  it('the breakdown panel passes the leave type name so the no-scheme body can name it', () => {
    const src = read('components/leave/LeaveDetailsPanel.tsx');
    expect(src).toContain('.body, { typeName: data.leaveType })');
    expect(en.leave.breakdown.statusNoEligibilityMatchBody).toContain('{typeName}');
  });

  it('the /me localizer consults the engine on the insufficient-balance branch, through the pack facade', () => {
    const src = read('app/me/actions.ts');
    const branch = src.slice(src.indexOf('if (e instanceof InsufficientLeaveBalanceOnSubmitError)'));
    const head = branch.slice(0, branch.indexOf("return t('insufficientBalance');"));
    expect(head).toContain('entitlementCoverageFor(');
    expect(head).toContain("'insufficientBalanceNoScheme'");
    expect(head).toContain("'insufficientBalanceNoTable'");
    expect(src).toContain("import { entitlementCoverageFor } from '@/packs/leave/service';");
    // Both /me apply paths hand the localizer the subject of the refusal.
    expect((src.match(/subject: 'self' \}/g) ?? []).length).toBe(2);
    // …and so does the /leave apply path, which is the only one that can refuse on somebody else's behalf.
    const leaveActions = read('app/leave/actions.ts');
    expect(leaveActions).toContain("subject: refusedOnBehalf ? 'other' : 'self'");
  });
});

// ── §C · behavioural: the refusal, the read after it, and the sentence ───────────────────────────────
let b: Base;

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Scheme', primaryEmail: `scheme_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** Calendar-counted, refuses a negative balance — the shape the reporter's employees would hit. */
async function leaveTypeRow(extra: Partial<typeof schema.leaveType.$inferInsert> = {}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `SCH_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: `Scheme Leave ${randomUUID().slice(0, 4)}`,
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: false,
      accrualMethod: 'full_upfront',
      ...extra,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const band = [{ fromYears: 0, toYears: null, days: 14, carryForwardDays: 0, maxBalanceDays: null }];

async function refusal(ctx: SessionContext, employmentId: string, leaveTypeId: string): Promise<unknown> {
  // One calendar day, TODAY: never backdated, never next year (the leave-year gate), derived from the clock.
  const today = todayInKualaLumpur();
  try {
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: today, endDate: today, today });
  } catch (e) {
    return e;
  }
  throw new Error('expected the service to refuse');
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = adminCtx(b);
});

describe('§C · the apply refusal names the missing scheme, and the decision itself is unchanged', () => {
  it('no scheme covers this employee ⇒ the scheme sentence, not "Insufficient leave balance"', async () => {
    const typeId = await leaveTypeRow();
    // TWO tables and NO scheme: the sole-table shortcut does not apply, so nothing resolves for anybody.
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'Grade A', serviceBands: band, validFrom: '2020-01-01' });
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'Grade B', serviceBands: band, validFrom: '2020-01-01' });
    const emp = await hireEmployeeCtx();

    const e = await refusal(emp.ctx, emp.employmentId, typeId);
    // THE DECISION IS THE SAME ERROR AS BEFORE — the read below does not touch it.
    expect(e).toBeInstanceOf(InsufficientLeaveBalanceOnSubmitError);
    expect(await entitlementCoverageFor(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: typeId, asOf: todayInKualaLumpur() })).toBe('no_scheme');

    const msg = await localizeLeaveError(e, 'Annual Leave', { ctx: emp.ctx, employmentId: emp.employmentId, leaveTypeId: typeId, subject: 'self' });
    expect(msg).toContain('No entitlement table reaches you for Annual Leave, so no days have been granted.');
    expect(msg).toContain('or to set a default entitlement table for it.');
    expect(msg).not.toContain('Insufficient leave balance');
  });

  it('no entitlement table at all ⇒ the no-table sentence', async () => {
    const typeId = await leaveTypeRow();
    const emp = await hireEmployeeCtx();
    const e = await refusal(emp.ctx, emp.employmentId, typeId);
    expect(e).toBeInstanceOf(InsufficientLeaveBalanceOnSubmitError);
    expect(await entitlementCoverageFor(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: typeId, asOf: todayInKualaLumpur() })).toBe('no_table');
    const msg = await localizeLeaveError(e, 'Haji Leave', { ctx: emp.ctx, employmentId: emp.employmentId, leaveTypeId: typeId, subject: 'self' });
    expect(msg).toBe('Haji Leave has no entitlement table yet, so no days have been granted. Ask HR to set one up before you apply.');
  });

  it('a covered employee whose days are simply spent keeps the plain message — the sole table reaches them', async () => {
    const typeId = await leaveTypeRow();
    // ONE table, no scheme: r193 fault 3 — the table applies to everyone, so this employee IS covered.
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'Everyone', serviceBands: band, validFrom: '2020-01-01' });
    const emp = await hireEmployeeCtx();
    const e = await refusal(emp.ctx, emp.employmentId, typeId); // nothing generated yet ⇒ balance 0 ⇒ refused
    expect(e).toBeInstanceOf(InsufficientLeaveBalanceOnSubmitError);
    expect(await entitlementCoverageFor(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: typeId, asOf: todayInKualaLumpur() })).toBe('covered');
    const msg = await localizeLeaveError(e, 'Annual Leave', { ctx: emp.ctx, employmentId: emp.employmentId, leaveTypeId: typeId, subject: 'self' });
    expect(msg).toBe(en.leave.errors.insufficientBalance);
  });

  it('a scheme that names the table covers the employee; a scheme that excludes them does not', async () => {
    const typeId = await leaveTypeRow();
    const a = await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'A', serviceBands: band, validFrom: '2020-01-01' });
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'B', serviceBands: band, validFrom: '2020-01-01' });
    const emp = await hireEmployeeCtx();
    const asOf = todayInKualaLumpur();
    const ask = () => entitlementCoverageFor(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: typeId, asOf });
    expect(await ask()).toBe('no_scheme');
    // A scheme narrowed to a department this employee is NOT in: still nothing covers them.
    await createEligibilityRule(adminCtx(b), { name: 'Dept B only', templateLineageId: a.lineageId, criteria: { departmentIds: [b.deptB] }, validFrom: '2020-01-01' });
    expect(await ask()).toBe('no_scheme');
    // The one-click "everyone" scheme: now covered.
    await createEligibilityRule(adminCtx(b), { name: 'Everyone', templateLineageId: a.lineageId, criteria: {}, validFrom: '2020-01-01' });
    expect(await ask()).toBe('covered');
  });

  it('HR applying on somebody else’s behalf reads "this employee", never "you"', async () => {
    const typeId = await leaveTypeRow();
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'A', serviceBands: band, validFrom: '2020-01-01' });
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: typeId, name: 'B', serviceBands: band, validFrom: '2020-01-01' });
    const emp = await hireEmployeeCtx();
    const e = await refusal(emp.ctx, emp.employmentId, typeId);
    const msg = await localizeLeaveError(e, 'Annual Leave', { ctx: adminCtx(b), employmentId: emp.employmentId, leaveTypeId: typeId, subject: 'other' });
    expect(msg).toContain('No entitlement table reaches this employee for Annual Leave');
    expect(msg).not.toContain('reaches you');
  });

  it('a type that spends ANOTHER type’s balance is judged on that balance’s tables (cdf9ca48)', async () => {
    const source = await leaveTypeRow();
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: source, name: 'Src A', serviceBands: band, validFrom: '2020-01-01' });
    await createEntitlementTemplate(adminCtx(b), { leaveTypeId: source, name: 'Src B', serviceBands: band, validFrom: '2020-01-01' });
    const borrower = await leaveTypeRow({ balanceSourceTypeId: source });
    const emp = await hireEmployeeCtx();
    const asOf = todayInKualaLumpur();
    // The borrower has no table of its own, but "no table" would be the wrong remedy: the source has two.
    expect(await entitlementCoverageFor(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: borrower, asOf })).toBe('no_scheme');
  });

  it('without a subject the localizer answers exactly as before (approvals, cancellations, edits by id)', async () => {
    expect(await localizeLeaveError(new InsufficientLeaveBalanceOnSubmitError(), 'Annual Leave')).toBe(
      en.leave.errors.insufficientBalance,
    );
  });
});
